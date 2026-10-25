//! spawn — run one sub-agent in a workspace of its own. Contract: ARCHITECTURE.md, "Spawn".
//!
//!   "$SPORE_SPAWN" --precursor summarize --ws data/sub/1 --prompt in.md --answer data/out.json
//!
//! This process stays outside the sub-agent's confinement so it can host the enzyme broker: a
//! precursor's enzymes live in the parent's tree, which the child cannot reach.
//! `bin/spawn-worker.js` is the confined half.

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spore_runner::broker::{self, Served};
use spore_runner::enzymes::{hash_enzyme, Enzyme, Enzymes};
use spore_runner::host::{HostArgs, Models};
use spore_runner::model::{self, Model};
use spore_runner::plan::{dream_for, plan_spawn, Asked, Plan};
use spore_runner::supervise::{
    confined, kept_refusal, owner_token, owners_with, supervise, Kept, GRACE, OWNERS,
};
use spore_workspace::{
    acquire_lock, agent_env, begin_turn, broker_socket_path, end_channel, finalize_turn,
    granted_path_containing, hand_over, iso_now, leave_wal, provision_modules, read_paths_refusal,
    release_lock, serve, spore_socket_path, turn_state, unanswered, write_outcome, write_tree_key,
    Acquired, Unanswered, HOME_DIR, STATE_FD, TREE_KEY_FILE,
};
use tokio::process::Command;
use tokio::signal::unix::{signal, SignalKind};

/// Under the 120 s a command may go silent before exec kills it as idle.
const HEARTBEAT: Duration = Duration::from_secs(60);

const HELP: &str = "spawn — run one sub-agent in a workspace of its own

Usage:
  spawn --precursor <name> --ws <dir> --prompt <rel> --answer <rel>

  --precursor  a definition in the spore's precursors/<name>.cmk
  --ws         directory the child lives in; refused if it already holds spawn.json
  --prompt     material for the child, relative to --ws
  --answer     where the child's result is written, relative to --ws; must be
               somewhere the child can write, which means under its data/
  --detach     return as soon as the cell has started, printing where it is and
               what its pid is. <ws>/spawn.json says \"running\":true until the
               cell ends and then holds its last frame, so the caller polls the
               workspace instead of waiting on this
  --debug      the cell's agent logs at debug level

  --standalone with --node: a cell outside any turn, for a host that is not one.
               It reaches the models under a key of its own and the precursor's hard
               cost, instead of through its parent's, and counts what the cell spent on
               the cell's own record — through a model session it starts with --session
               and --chatgpt-helper, or, on a host whose model calls go through a mohdel
               gate, through --gate under the spore's --auth; --no-contain when the
               operator turned containment off
  --super      with --standalone: a super cell, which reaches what the spore's root
               agent reaches one notch lower — its writes grants and its precursors
               read and never written — as spore/. Run from the spore's workspace,
               for its dream: only the precursor dream.precursor names, under the
               lower of that precursor's limits and dream.cost and dream.wall

The spore is $SPORE_WS in a turn and the working directory outside one; --ws
is the caller's, from where it is. The sub-agent runs on the cell model its
precursor's model: names among the spore's cell-models, or, when it names
none, on the spore's own model:. There is no flag for it: choosing a model is
configuration, not something a caller decides.";

#[derive(Default)]
struct Args {
    precursor: Option<String>,
    ws: Option<String>,
    prompt: Option<String>,
    answer: Option<String>,
    debug: bool,
    detach: bool,
    help: bool,
    standalone: bool,
    dream: bool,
    host: HostArgs,
    auth: Option<String>,
}

/// What a cell outside any turn reaches the models through — a session of its own, or the
/// host's gate under the spore's `auth` — and how it is contained.
struct Standalone {
    node: String,
    models: Models,
    auth: Option<String>,
    contain: bool,
    kept: Vec<Kept>,
    call_ceiling: Duration,
}

fn fail(problem: impl std::fmt::Display) -> ! {
    eprintln!("spawn: {problem}");
    std::process::exit(2)
}

fn parse_args(given: &[String]) -> Args {
    let mut args = Args::default();
    let mut rest = given.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| rest.next().cloned())
                .unwrap_or_else(|| fail(format!("{name} needs a value")))
        };
        match args.host.take(name, &mut value) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(problem) => fail(problem),
        }
        match name {
            "--precursor" => args.precursor = Some(value()),
            "--ws" => args.ws = Some(value()),
            "--prompt" => args.prompt = Some(value()),
            "--answer" => args.answer = Some(value()),
            "--debug" => args.debug = true,
            "--detach" => args.detach = true,
            "--standalone" => args.standalone = true,
            "--super" => args.dream = true,
            "--auth" => args.auth = Some(value()),
            "--help" | "-h" => args.help = true,
            "-m" | "--model" => fail(format!(
                "unknown option {name} — the model comes from the precursor's model: or its spore's, never from a flag"
            )),
            other if other.starts_with('-') => fail(format!("unknown option {other}")),
            other => fail(format!("unexpected argument {other}")),
        }
    }
    args
}

/// The spore root: this binary sits in `<root>/native/`.
fn root() -> PathBuf {
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .unwrap_or_else(|e| fail(format!("cannot find this binary — {e}")));
    exe.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| fail("this binary is not in <spore>/native/"))
}

fn relative(from: &Path, to: &Path) -> PathBuf {
    let (from, to): (Vec<Component>, Vec<Component>) =
        (from.components().collect(), to.components().collect());
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for part in &to[common..] {
        out.push(part.as_os_str());
    }
    out
}

/// Detaching hands the whole job to a copy of this process that the invoking shell is not
/// waiting on — a copy rather than an unattached worker, because the supervisor is what hosts
/// the enzyme broker and what a `kill` should reach.
fn detach(given: &[String], plan: &Plan, cwd: &Path) -> ! {
    let exe =
        std::env::current_exe().unwrap_or_else(|e| fail(format!("cannot find this binary — {e}")));
    let mut command = std::process::Command::new(exe);
    command
        .args(given.iter().filter(|a| *a != "--detach"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let supervisor = command
        .spawn()
        .unwrap_or_else(|e| fail(format!("cannot start the detached supervisor — {e}")));
    println!(
        "{}",
        json!({
            "precursor": plan.precursor.name,
            "ws": relative(cwd, &plan.ws),
            "pid": supervisor.id(),
            "startedAt": iso_now(),
            "detached": true
        })
    );
    std::process::exit(0)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let given: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&given);
    if args.help {
        println!("{HELP}");
        std::process::exit(0)
    }

    // One level of fan-out is the design: the spore spawns cells, a cell does the work. A parent
    // wanting two levels flattens them, which it can see and account for.
    if let Some(cell) = std::env::var("SPORE_CELL").ok().filter(|c| !c.is_empty()) {
        fail(format!("a cell cannot spawn — this is already the sub-agent \"{cell}\". Flatten the fan-out in the workspace that owns it."))
    }

    // Inside a turn everything carries its supervisor's token. A turn's cells go through its own
    // socket, where they are counted against its limits; a session of their own would not be.
    // A guard, not the boundary — that is a turn holding no credential to start one with.
    if args.standalone && std::env::var(OWNERS).is_ok_and(|owners| !owners.is_empty()) {
        fail("--standalone is a host's, run outside any turn — a turn's cells go through its own model socket, where what they spend is counted");
    }
    if args.dream && !args.standalone {
        fail("--super is a dream's, run outside any turn — it needs --standalone");
    }
    if !args.standalone && (args.host.gate.is_some() || args.auth.is_some()) {
        fail("--gate and --auth are a cell's outside any turn — a turn's cells reach the gate through its own model socket");
    }
    if let (Some(gate), None) = (&args.host.gate, &args.auth) {
        fail(format!(
            "this host calls its models through the gate at {}, and the spore names no auth — add auth: <id> to its spore.cmk, whom its model calls are for",
            gate.display()
        ));
    }
    let root = root();
    let cwd = std::env::current_dir()
        .unwrap_or_else(|e| fail(format!("cannot read the working directory — {e}")));
    let spore = if args.standalone {
        cwd.clone()
    } else {
        PathBuf::from(std::env::var("SPORE_WS").unwrap_or_else(|_| {
            fail("SPORE_WS is not set — spawn runs under a spore, whose runner names its workspace")
        }))
    };
    let mut plan = plan_spawn(
        &Asked {
            precursor: args.precursor.as_deref(),
            ws: args.ws.as_deref(),
            prompt: args.prompt.as_deref(),
            answer: args.answer.as_deref(),
        },
        &cwd,
        &spore,
        |ws, reads| granted_path_containing(&root, ws, reads).ok().flatten(),
    )
    .unwrap_or_else(|problem| fail(problem));
    if args.dream {
        dream_for(&spore, &mut plan).unwrap_or_else(|problem| fail(problem));
    }
    let (super_reads, super_writes) = plan
        .super_reach
        .as_ref()
        .map_or((0, 0), |reach| (1 + reach.reads.len(), reach.writes.len()));
    if let Some(problem) = read_paths_refusal(
        &root,
        plan.precursor.reads.len() + super_reads,
        super_writes,
        0,
    ) {
        fail(format!(
            "precursor {} {problem}",
            plan.precursor_path.display()
        ));
    }

    let standalone = args.standalone.then(|| {
        Standalone {
            node: args.host.node.clone().unwrap_or_else(|| {
                fail("--standalone needs --node — the Node a cell outside any turn runs its worker and its model session on")
            }),
            models: args
                .host
                .models()
                .unwrap_or_else(|problem| fail(format!("--standalone: {problem}"))),
            auth: args.auth.clone(),
            contain: !args.host.no_contain,
            kept: args.host.kept.clone(),
            call_ceiling: args.host.call_ceiling(),
        }
    });
    if let Some(problem) = standalone
        .as_ref()
        .and_then(|own| kept_refusal(&own.kept, own.contain))
    {
        fail(problem);
    }
    // A cell reaches a model only through its parent's socket, or — outside any turn — through
    // the one this process serves: one that could call a provider directly could spend without
    // anything counting it.
    let model_socket = match &standalone {
        Some(_) => None,
        None => Some(std::env::var("SPORE_MODEL_SOCKET").unwrap_or_else(|_| {
            fail("SPORE_MODEL_SOCKET is not set — spawn runs under a spore, which is what serves the model socket a cell calls through")
        })),
    };
    let node = match &standalone {
        Some(own) => own.node.clone(),
        None => std::env::var("SPORE_NODE").unwrap_or_else(|_| {
            fail("SPORE_NODE is not set — spawn runs under a spore, whose runner names the Node a cell runs on")
        }),
    };
    if standalone.is_some() && !plan.precursor.sources.is_empty() {
        fail(format!(
            "precursor {} names sources, and a cell outside any turn reaches none — its tree's sources are served by a turn",
            plan.precursor.name
        ));
    }
    // Under a turn, a cell's grants sit inside its agent's confinement; outside one, no agent
    // stands above it, so an enzyme would run in this unconfined broker and a read would
    // be the cell's own grant over the host.
    if standalone.is_some()
        && !(plan.precursor.enzymes.is_empty() && plan.precursor.reads.is_empty())
    {
        fail(format!(
            "precursor {} declares {}, and a cell outside any turn is refused both — nothing above it bounds what they would reach",
            plan.precursor.name,
            match (plan.precursor.enzymes.is_empty(), plan.precursor.reads.is_empty()) {
                (false, false) => "enzymes and reads",
                (false, true) => "enzymes",
                _ => "reads",
            }
        ));
    }

    if args.detach {
        if standalone.is_some() {
            fail("--standalone runs in the foreground — whoever started it waits for its answer");
        }
        detach(&given, &plan, &cwd)
    }

    // A cell takes a lock for the same reason the spore does: a caller polling from outside can
    // tell a live cell from one that died without writing its turn record.
    let lock = match acquire_lock(&plan.ws) {
        Ok(Acquired::Held(file, _)) => file,
        Ok(Acquired::Taken(problem)) => fail(problem),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => fail(format!(
            "cannot write {} — spawn stages a workspace for the cell before it starts, so it has to run under wsexec. exec is read-only.",
            plan.ws.display()
        )),
        Err(e) => fail(format!("cannot take {}'s lock — {e}", plan.ws.display())),
    };
    // Hooked as soon as the lock is held: a signal during staging would otherwise leave the
    // lock naming a dead pid, which reads as a crash.
    let mut sigterm = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
    let mut sigint = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));

    let staged = async {
        provision_modules(&plan.ws, &root)
            .map_err(|refused| format!("{} — {}", refused.message, refused.detail))?;
        // Copied rather than granted: the client is generic, so a copy teaches the child
        // nothing and needs no hole in its ruleset.
        let client = plan.ws.join("enzyme.js");
        std::fs::copy(root.join("bin").join("enzyme.js"), &client)
            .map_err(|e| format!("cannot stage enzyme.js — {e}"))?;
        // The tree's key, staged the same way: a cell is part of the agent that spawned it
        // and answers to the same sockets. A cell outside any turn is its own tree.
        let key = match &standalone {
            Some(_) => write_tree_key(&plan.ws)
                .map_err(|e| format!("cannot write the cell's key — {e}"))?,
            None => {
                let key = std::fs::read_to_string(spore.join(TREE_KEY_FILE))
                    .map(|k| k.trim().to_string())
                    .map_err(|e| format!("no {TREE_KEY_FILE} in {} — the runner writes the tree's key there for each turn ({e})", spore.display()))?;
                std::fs::write(plan.ws.join(TREE_KEY_FILE), &key)
                    .map_err(|e| format!("cannot stage the tree's key — {e}"))?;
                key
            }
        };
        let own_model = match &standalone {
            None => None,
            Some(own) => {
                let chosen = plan
                    .precursor
                    .model
                    .clone()
                    .expect("the plan settles the model");
                let allowed = vec![chosen.clone()];
                let upstream = match &own.models {
                    Models::Gate(gate) => {
                        model::reach_gate(
                            gate,
                            own.auth.clone().expect("checked above"),
                            allowed,
                            vec![plan.ws.clone()],
                            Some(&chosen),
                        )
                        .await?
                    }
                    Models::Session {
                        program,
                        chatgpt_helper,
                    } => {
                        std::env::set_var("MOHDEL_MEDIA_ROOTS", plan.ws.display().to_string());
                        model::Upstream::Pool(model::start_pool(
                            own.node.clone(),
                            program.clone(),
                            chatgpt_helper.clone(),
                            1,
                            allowed,
                        ))
                    }
                };
                let model = Model::new(
                    key.clone(),
                    plan.precursor.limits.cost.hard,
                    own.call_ceiling,
                    upstream,
                );
                let path = broker_socket_path("model")
                    .map_err(|e| format!("cannot make the model socket's directory — {e}"))?
                    .map_err(|refused| format!("{} — {}", refused.message, refused.detail))?;
                let served = model::serve(model.clone(), Path::new(&path))
                    .map_err(|e| format!("cannot bind {path} — {e}"))?;
                Some((model, served, path))
            }
        };

        // Taken once, at cell start: what the cell is told about is the program there now,
        // and the broker refuses a call once that stops being true.
        let mut enzymes = Vec::new();
        for enzyme in &plan.enzymes {
            let hash = hash_enzyme(&enzyme.command, &enzyme.with).ok_or_else(|| {
                format!(
                    "cannot read {} or what it needs to hash it",
                    enzyme.command.display()
                )
            })?;
            enzymes.push(Enzyme {
                name: enzyme.name.clone(),
                command: enzyme.command.clone(),
                with: enzyme.with.clone(),
                hash,
            });
        }
        let hashes: Vec<String> = enzymes.iter().map(|e| e.hash.clone()).collect();
        let hosted = if enzymes.is_empty() {
            None
        } else {
            let broker = Enzymes::new(enzymes, plan.ws.clone());
            let dir = std::env::var("SPORE_SOCKET_DIR").map_err(|_| {
                "SPORE_SOCKET_DIR is not set — a cell with enzymes is spawned by a spore's agent, whose runner names the directory its sockets go in".to_string()
            })?;
            let path = spore_socket_path(Path::new(&dir), "enzymes")
                .map_err(|e| format!("cannot make the enzymes socket's directory — {e}"))?
                .map_err(|refused| format!("{} — {}", refused.message, refused.detail))?;
            let serving = broker.clone();
            let served = broker::serve(Path::new(&path), key.clone(), move |req| {
                serving.clone().route(req)
            })
            .map_err(|e| format!("cannot bind {path} — {e}"))?;
            Some((broker, served))
        };

        let env: Vec<(String, String)> = std::env::vars().collect();
        let mut passed = agent_env(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        passed.insert("HOME".into(), plan.ws.join(HOME_DIR).display().to_string());
        passed.insert("SPORE_WS".into(), plan.ws.display().to_string());
        passed.insert(
            "SPORE_PLAN".into(),
            plan.for_worker(args.answer.as_deref().expect("planned"), &hashes)
                .to_string(),
        );
        passed.insert("SPORE_ENZYME".into(), client.display().to_string());
        let socket = match (&own_model, &model_socket) {
            (Some((_, _, path)), _) => path.clone(),
            (None, Some(given)) => given.clone(),
            (None, None) => unreachable!("a cell has its parent's socket or its own"),
        };
        passed.insert("SPORE_MODEL_SOCKET".into(), socket);
        // The cell's view of the tree's sources, not a boundary: the tree is one trust unit.
        // Checked here so a precursor naming more than the tree was granted fails at spawn
        // rather than at the cell's first call.
        if !plan.precursor.sources.is_empty() {
            let name = &plan.precursor.name;
            let socket = std::env::var("SPORE_SOURCE_SOCKET").map_err(|_| {
                format!("precursor {name} names sources, and this spore was granted none")
            })?;
            let view =
                json!({ "sources": plan.precursor.sources, "scopes": plan.precursor.scopes });
            broker::ask(Path::new(&socket), &key, "/list", &json!({ "view": view }))
                .await
                .map_err(|refused| {
                    format!("precursor {name}: {} — {}", refused.message, refused.detail)
                })?;
            passed.insert("SPORE_SOURCE_SOCKET".into(), socket);
            passed.insert("SPORE_SOURCES".into(), view.to_string());
        }
        // Inherited by everything the cell runs, which is what makes the refusal above
        // reach a grandchild: `wsexec` hands the whole environment to its shell.
        passed.insert("SPORE_CELL".into(), plan.precursor.name.clone());
        if let Some((_, served)) = &hosted {
            passed.insert("SPORE_ENZYMES".into(), served.path.display().to_string());
        }
        if args.debug {
            passed.insert("SPORE_DEBUG".into(), "1".into());
        }
        let token = owner_token();
        passed.insert(OWNERS.into(), owners_with(&token));
        passed.insert("SPORE_STATE_FD".into(), STATE_FD.to_string());

        // The cell's records go through this, as the root's do through its runner's.
        let turn_started = iso_now();
        let turn_id = begin_turn(&plan.ws, &turn_started, None)?;
        let (ours, theirs) =
            UnixStream::pair().map_err(|e| format!("cannot open the cell's channel — {e}"))?;
        let watcher = ours
            .try_clone()
            .map_err(|e| format!("cannot open the cell's channel — {e}"))?;
        let serving = serve(&plan.ws, turn_id.clone(), ours);
        let fd = theirs.as_raw_fd();
        let mut command = match &standalone {
            Some(own) => confined(&root, &node, own.contain, &own.kept),
            None => Command::new(&node),
        };
        command
            .arg(root.join("bin").join("spawn-worker.js"))
            .env_clear()
            .envs(passed);
        // SAFETY: between fork and exec only `dup2` and `fcntl` run, both async-signal-safe.
        unsafe {
            command.pre_exec(move || hand_over(fd, STATE_FD));
        }
        let worker = command.spawn();
        drop(theirs);
        let worker = match worker {
            Ok(worker) => worker,
            Err(e) => {
                let problem = format!("cannot start the worker — {e}");
                let _ = end_channel(watcher, serving);
                record_unstarted(&plan.ws, &turn_id, &turn_started, &problem);
                return Err(problem);
            }
        };
        Ok::<_, String>((
            worker,
            hosted,
            token,
            turn_id,
            turn_started,
            watcher,
            serving,
            own_model,
        ))
    };

    let (mut worker, hosted, token, turn_id, turn_started, watcher, serving, own_model) = tokio::select! {
        biased;
        _ = sigterm.recv() => leave(lock, None, 143),
        _ = sigint.recv() => leave(lock, None, 143),
        staged = staged => match staged {
            Ok(staged) => staged,
            Err(problem) => {
                let _ = release_lock(lock);
                fail(problem)
            }
        },
    };

    let shown = relative(&cwd, &plan.ws).display().to_string();
    let heartbeat = tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT);
        tick.tick().await;
        loop {
            tick.tick().await;
            eprintln!("spawn: {shown} still running");
        }
    });
    // Detached, this process is what a caller has a pid for, so a signal takes the cell
    // with it rather than leaving it running with its broker pulled out from under it.
    let ended = supervise(
        &mut worker,
        &token,
        Duration::from_millis(plan.precursor.limits.wall.hard as u64),
        None,
        GRACE,
        &mut sigterm,
        &mut sigint,
        "spawn",
    )
    .await;
    heartbeat.abort();
    let code = if ended.signalled {
        143
    } else {
        ended
            .status
            .as_ref()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1)
    };
    if let Err(e) = end_channel(watcher, serving) {
        eprintln!("spawn: the cell's channel failed — {e}");
    }
    // A worker that could not say how its cell ended leaves that to this process, as an agent
    // leaves it to its runner.
    match turn_state(&plan.ws, &turn_id) {
        Ok(Some(state)) if state == "running" => {
            let (stop_reason, error, detail) =
                ended.account("its stderr went to whoever ran spawn");
            let turn = Unanswered {
                started_at: &turn_started,
                stop_reason,
                error,
                detail: &detail,
            };
            if let Err(e) = write_outcome(&plan.ws, &turn_id, &unanswered(&turn)) {
                eprintln!("spawn: cannot record the cell's turn — {e}");
            }
        }
        Ok(_) => {}
        Err(e) => eprintln!("spawn: cannot read the cell's turn — {e}"),
    }
    // The cell's calls went to its root's runner, which counts them for the tree, and its own
    // record stands as the worker left it — unless this process served them, and counts them.
    let settled = match own_model {
        None => None,
        Some((model, served, _)) => {
            served.stop();
            model.drained().await;
            Some(model.settled())
        }
    };
    if let Err(e) = finalize_turn(&plan.ws, &turn_id, settled.as_ref()) {
        eprintln!("spawn: cannot record the cell's turn — {e}");
    }
    if let Err(e) = leave_wal(&plan.ws) {
        eprintln!("spawn: {e}");
    }
    leave(lock, hosted, code)
}

/// A cell whose worker never started, written down as refused.
fn record_unstarted(ws: &Path, turn_id: &str, started_at: &str, problem: &str) {
    let turn = Unanswered {
        started_at,
        stop_reason: "error",
        error: "START_FAILED",
        detail: problem,
    };
    let recorded = write_outcome(ws, turn_id, &unanswered(&turn))
        .and_then(|()| finalize_turn(ws, turn_id, None).map(|_| ()));
    if let Err(e) = recorded {
        eprintln!("spawn: cannot record the cell's turn — {e}");
    }
    if let Err(e) = leave_wal(ws) {
        eprintln!("spawn: {e}");
    }
}

fn leave(lock: std::fs::File, hosted: Option<(Arc<Enzymes>, Served)>, code: i32) -> ! {
    if let Some((broker, served)) = hosted {
        broker.stop();
        served.stop();
    }
    let _ = release_lock(lock);
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_path_from_where_the_caller_stands() {
        assert_eq!(
            relative(Path::new("/w/root"), Path::new("/w/root/data/parts/1")),
            PathBuf::from("data/parts/1")
        );
        assert_eq!(
            relative(Path::new("/w/root"), Path::new("/w/other")),
            PathBuf::from("../other")
        );
    }
}

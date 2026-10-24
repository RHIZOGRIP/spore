//! The runner: one turn of one spore, holding the workspace lock and an admission slot, and
//! waiting on the confined agent it starts. Contract: ARCHITECTURE.md §The spore command.
//!
//! Started detached by `send()` or `fork()`, with its streams on `spore.out` and `spore.err`
//! and its admission slot on fd 3. It holds the provider keys and serves the model path
//! (`model.rs`) unless a model socket is given, which is how a test or an embedder that keeps
//! its own keys runs a turn. It serves the store (`store.rs`) for `memory: vectors`, holding
//! the vector store's credential, and the source broker (`source.rs`) for granted `sources`,
//! holding their secrets.

use std::collections::BTreeMap;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spore_definition::{parse_definition, Definition, Options, TOOL_NAMES};
use spore_runner::broker::Served;
use spore_runner::host::HostArgs;
use spore_runner::supervise::{
    confined, contain_refused, kept_refusal, owner_token, owners_with, supervise, uncontained,
    GRACE, OWNERS,
};
use spore_runner::{broker, job, model, source, store, trace, vectors};
use spore_workspace::{
    acquire_lock, agent_env, begin_turn, crash_at, end_channel, finalize_turn, free_bytes,
    hand_over, iso_now, leave_wal, limit_file_size, make_spore_socket_dir, prune_trail,
    read_paths_refusal, record_unanswered, recover, release_lock, serve, spore_socket_dir,
    spore_socket_path, start_limits, turn_limits, turn_state, unanswered, unanswered_traceparents,
    unread, write_lock, write_model_key, write_outcome, writes_refusal, yield_to_host, Acquired,
    Unanswered, CELL_MODELS_ENV, DEFAULT_FREE_FLOOR, DEFAULT_LARGEST_FILE, DEFAULT_MODEL_SESSIONS,
    DEFINITION_FILE, HOME_DIR, MODEL_KEY_FILE, PLUGIN_ENV, PLUGIN_READS, STATE_FD,
};
use tokio::process::Command;
use tokio::signal::unix::{signal, Signal, SignalKind};
use tokio::sync::watch;

struct Args {
    ws: PathBuf,
    slot: Option<String>,
    host: HostArgs,
    sources: Option<PathBuf>,
    plugin_sources: serde_json::Map<String, serde_json::Value>,
    memory: Option<PathBuf>,
    env: Vec<(String, String)>,
    largest_file: u64,
    free_floor: u64,
    model_sessions: usize,
    reply_to: Option<String>,
    debug: bool,
    unsafe_: bool,
    continuing: bool,
    dream: bool,
}

fn fail(problem: impl std::fmt::Display) -> ! {
    eprintln!("spore: {problem}");
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut args = Args {
        ws: PathBuf::from("."),
        slot: None,
        host: HostArgs::default(),
        sources: None,
        plugin_sources: serde_json::Map::new(),
        memory: None,
        env: Vec::new(),
        largest_file: DEFAULT_LARGEST_FILE,
        free_floor: DEFAULT_FREE_FLOOR,
        model_sessions: DEFAULT_MODEL_SESSIONS as usize,
        reply_to: None,
        debug: false,
        unsafe_: false,
        continuing: false,
        dream: false,
    };
    let mut given = std::env::args().skip(1);
    while let Some(arg) = given.next() {
        let mut value = |name: &str| {
            given
                .next()
                .unwrap_or_else(|| fail(format!("{name} needs a value")))
        };
        match args.host.take(&arg, || value(&arg)) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(problem) => fail(problem),
        }
        match arg.as_str() {
            "--ws" => args.ws = PathBuf::from(value("--ws")),
            "--slot" => args.slot = Some(value("--slot")),
            "--sources" => args.sources = Some(PathBuf::from(value("--sources"))),
            "--plugin-sources" => {
                let given = value("--plugin-sources");
                args.plugin_sources = match serde_json::from_str(&given) {
                    Ok(serde_json::Value::Object(described)) => described,
                    _ => fail(format!(
                        "--plugin-sources is a JSON object of named sources — got {given}"
                    )),
                }
            }
            "--memory" => args.memory = Some(PathBuf::from(value("--memory"))),
            "--largest-file" => {
                args.largest_file = bytes("--largest-file", &value("--largest-file"))
            }
            "--free-floor" => args.free_floor = bytes("--free-floor", &value("--free-floor")),
            "--model-sessions" => {
                let given = value("--model-sessions");
                args.model_sessions = match given.parse::<usize>() {
                    Ok(n) if n >= 1 => n,
                    _ => fail(format!("--model-sessions is a count from 1 — got {given}")),
                }
            }
            "--reply-to" => args.reply_to = Some(value("--reply-to")),
            "--debug" => args.debug = true,
            "--unsafe" => args.unsafe_ = true,
            "--continue" => args.continuing = true,
            "--dream" => args.dream = true,
            other => fail(format!("unknown argument {other}")),
        }
    }
    if let Ok(given) = std::env::var(PLUGIN_ENV) {
        match serde_json::from_str::<BTreeMap<String, String>>(&given) {
            Ok(env) => args.env = env.into_iter().collect(),
            Err(_) => fail(format!(
                "{PLUGIN_ENV} is not a JSON object of variable to string"
            )),
        }
        std::env::remove_var(PLUGIN_ENV);
    }
    args
}

fn bytes(name: &str, given: &str) -> u64 {
    given
        .parse()
        .unwrap_or_else(|_| fail(format!("{name} is a number of bytes — got {given}")))
}

/// The admission slot, handed over by `send()` or `fork()` as fd 3 and held until this exits.
fn check_slot(slot: Option<&str>) {
    let held = std::fs::read_link("/proc/self/fd/3").ok();
    let named = slot.and_then(|s| std::fs::canonicalize(s).ok());
    if held.is_none() || held != named {
        fail("a runner holds an admission slot on fd 3 — start it through send() or fork(), which take one")
    }
    // Inherited without close-on-exec, and a spawned process inherits whatever lacks it: the
    // agent and every tool it runs would hold the slot, and one left running would keep it.
    if unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        fail(format!(
            "cannot keep the admission slot to this process — {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn definition(ws: &Path) -> Result<Definition, String> {
    let path = ws.join(DEFINITION_FILE);
    let source = std::fs::read_to_string(&path).map_err(|_| {
        format!("{} has no {DEFINITION_FILE} — spore define makes a spore, and this directory is not one yet", ws.display())
    })?;
    let known: Vec<String> = TOOL_NAMES.iter().map(|t| t.to_string()).collect();
    parse_definition(
        &source,
        &Options {
            known_tools: &known,
            cell: false,
            seed: false,
        },
    )
    .map_err(|error| format!("{} {error}", path.display()))
}

/// A turn the agent never recorded, recorded by the runner so it does not read as idle.
fn record(ws: &Path, started_at: &str, stop_reason: &str, error: &str, detail: &str, tree: f64) {
    let turn = Unanswered {
        started_at,
        stop_reason,
        error,
        detail,
        tree,
    };
    if let Err(e) = record_unanswered(ws, &turn) {
        eprintln!("spore: cannot record the turn — {e}");
    }
}

/// A turn begun and not started: written down as its runner saw it, and made final.
fn unrecorded(
    ws: &Path,
    turn_id: &str,
    started_at: &str,
    stop_reason: &str,
    error: &str,
    detail: &str,
) {
    let turn = Unanswered {
        started_at,
        stop_reason,
        error,
        detail,
        tree: 0.0,
    };
    let recorded = write_outcome(ws, turn_id, &unanswered(&turn))
        .and_then(|()| finalize_turn(ws, turn_id, None).map(|_| ()));
    if let Err(e) = recorded {
        eprintln!("spore: cannot record the turn — {e}");
    }
}

fn close_channel(watcher: UnixStream, serving: std::thread::JoinHandle<Result<(), String>>) {
    if let Err(e) = end_channel(watcher, serving) {
        eprintln!("spore: the turn's channel failed — {e}");
    }
}

/// Refused after the lock was taken, so the turn a `send` started is recorded as refused.
fn refuse(ws: &Path, lock: std::fs::File, started_at: &str, problem: &str) -> ! {
    record(ws, started_at, "error", "START_FAILED", problem, 0.0);
    let_go(ws, lock);
    fail(problem)
}

/// Where a session may read a `file://` image from: the workspace and what it may reach.
fn media_root_paths(ws: &Path, def: &Definition) -> Vec<PathBuf> {
    std::iter::once(ws.to_path_buf())
        .chain(
            def.reads
                .iter()
                .chain(&def.writes)
                .map(|grant| PathBuf::from(&grant.path)),
        )
        .collect()
}

fn media_roots(ws: &Path, def: &Definition) -> String {
    media_root_paths(ws, def)
        .iter()
        .map(|root| root.display().to_string())
        .collect::<Vec<_>>()
        .join(":")
}

fn socket(dir: &Path, kind: &str) -> Result<String, String> {
    spore_socket_path(dir, kind)
        .map_err(|e| format!("cannot make the {kind} socket's directory — {e}"))?
        .map_err(|refused| format!("{} — {}", refused.message, refused.detail))
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

const ROOT_REFUSED_DETAIL: &str = "spore runs no turn as root: an agent's commands would hold every right on the host — run it as an ordinary user (in a container, USER or --user)";

/// How often a running turn's limits are read again, for a change its owner made.
const LIMITS_EVERY: Duration = Duration::from_secs(2);

/// Carries a raised hard wall to the supervisor and a raised hard cost to the broker, for as
/// long as the turn runs.
async fn follow_limits(
    ws: PathBuf,
    turn: String,
    raise_wall: watch::Sender<Duration>,
    model: Option<Arc<model::Model>>,
) {
    let mut cost = None;
    loop {
        tokio::time::sleep(LIMITS_EVERY).await;
        let (ws, turn) = (ws.clone(), turn.clone());
        let read = tokio::task::spawn_blocking(move || turn_limits(&ws, &turn)).await;
        let limits = match read {
            Ok(Ok(limits)) => limits,
            Ok(Err(e)) => {
                eprintln!("spore: cannot read the turn's limits — {e}; a change to them waits for the next look");
                continue;
            }
            Err(e) => {
                eprintln!("spore: cannot read the turn's limits — {e}; a change to them waits for the next look");
                continue;
            }
        };
        for (dimension, _, hard) in limits {
            match dimension.as_str() {
                "wall" => {
                    let raised = Duration::from_millis(hard as u64);
                    raise_wall.send_if_modified(|wall| {
                        let changed = *wall != raised;
                        *wall = raised;
                        changed
                    });
                }
                "cost" if cost != Some(hard) => {
                    if let Some(model) = &model {
                        model.raise_limit(hard);
                    }
                    cost = Some(hard);
                }
                _ => {}
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = parse_args();
    check_slot(args.slot.as_deref());
    let node = args.host.node.clone().unwrap_or_else(|| fail("a runner is told which node to start the agent with — start it through send() or fork()"));
    let ws = std::path::absolute(&args.ws)
        .unwrap_or_else(|e| fail(format!("{} — {e}", args.ws.display())));
    let given = std::env::var("SPORE_MODEL_SOCKET").ok();
    if given.is_none() && (args.host.session.is_none() || args.host.chatgpt_helper.is_none()) {
        fail("a runner is told mohdel's session program and its ChatGPT helper — start it through send() or fork()")
    }
    if !ws.is_dir() {
        fail(format!(
            "{} is not a directory — spore define makes a spore",
            ws.display()
        ))
    }

    // Whoever takes the lock is the runner. Losing the race is not a failure: the message is
    // already in the inbox and the winner reads it. Taken before anything that can refuse,
    // so every refusal after a `send` is recorded where `stateOf` and `runBatch` see it.
    let lock = match acquire_lock(&ws) {
        Ok(Acquired::Held(file, _)) => file,
        Ok(Acquired::Taken(_)) => std::process::exit(0),
        Err(e) => fail(format!("cannot take {}'s lock — {e}", ws.display())),
    };
    // Hooked as soon as the lock is held: before the agent exists a signal releases the lock
    // rather than leaving it naming a dead pid, which reads as a crash.
    let mut sigterm = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
    let mut sigint = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));
    let started_at = iso_now();
    // Left by a runner that died before letting go: each turn it had begun is written down,
    // as its agent left it or as one that ended in error, and never twice.
    if let Err(e) = recover(&ws) {
        let_go(&ws, lock);
        fail(format!("cannot carry over the turns a runner left — {e}"));
    }

    // A dream holds the lock as a turn does, so what is said meanwhile waits for it; once it
    // ends, anything said is read by a turn under the same lock, as after a turn.
    let mut lock = lock;
    let started_at = if args.dream {
        let (code, stopped) = dream(&ws, &node, &lock, &mut sigterm, &mut sigint).await;
        match unread(&ws) {
            Ok(true) if !stopped => {}
            _ => {
                let_go(&ws, lock);
                if stopped || !matches!(unread(&ws), Ok(true)) {
                    std::process::exit(code)
                }
                lock = match acquire_lock(&ws) {
                    Ok(Acquired::Held(file, _)) => file,
                    _ => std::process::exit(code),
                };
            }
        }
        iso_now()
    } else {
        started_at
    };

    let def = match definition(&ws) {
        Ok(def) => def,
        Err(problem) => refuse(&ws, lock, &started_at, &problem),
    };
    let writes: Vec<(String, PathBuf)> = def
        .writes
        .iter()
        .map(|grant| (grant.name.clone(), PathBuf::from(&grant.path)))
        .collect();
    let reads: Vec<PathBuf> = def
        .reads
        .iter()
        .map(|grant| PathBuf::from(&grant.path))
        .collect();
    if let Some(problem) = writes_refusal(&root(), &ws, &writes, &reads) {
        refuse(
            &ws,
            lock,
            &started_at,
            &format!("{} {problem}", ws.display()),
        );
    }
    let plugin_reads = match args.env.iter().find(|(name, _)| name == PLUGIN_READS) {
        None => 0,
        Some((_, given)) => match serde_json::from_str::<Vec<String>>(given) {
            Ok(paths) => paths.len(),
            Err(_) => refuse(
                &ws,
                lock,
                &started_at,
                &format!("{PLUGIN_READS} is not a JSON array of paths"),
            ),
        },
    };
    if let Some(problem) = read_paths_refusal(&root(), reads.len(), writes.len(), plugin_reads) {
        refuse(
            &ws,
            lock,
            &started_at,
            &format!("{} {problem}", ws.display()),
        );
    }

    // Credentials of the runner's own: they stay in this process and never reach the agent.
    let vectors = match def.memory.as_ref().filter(|m| m.backend == "vectors") {
        None => None,
        Some(memory) => {
            let made = args
                .memory
                .as_deref()
                .ok_or_else(|| {
                    format!(
                        "{} keeps its memory in a vector store, and this runner was not told where the host describes it — start it through send()",
                        ws.display()
                    )
                })
                .and_then(|file| {
                    if !file.exists() {
                        return Err(format!(
                            "{} keeps its memory in a vector store, and there is no {} to say where it is",
                            ws.display(),
                            file.display()
                        ));
                    }
                    vectors::Config::load(file, |name| std::env::var(name).ok())
                });
            match made {
                Ok(config) => {
                    let embedding = memory
                        .embedding
                        .clone()
                        .expect("the parser requires an embedding beside memory: vectors");
                    Some((vectors::VectorStore::new(config), embedding))
                }
                Err(problem) => refuse(&ws, lock, &started_at, &problem),
            }
        }
    };
    let sources = if def.sources.is_empty() && args.plugin_sources.is_empty() {
        None
    } else {
        let host_described = def
            .sources
            .iter()
            .any(|name| !args.plugin_sources.contains_key(name));
        let file = if !host_described {
            Ok(None)
        } else {
            args.sources.as_deref().map(Some).ok_or_else(|| {
                format!(
                    "{} grants sources, and this runner was not told where the host describes them — start it through send()",
                    ws.display()
                )
            })
        };
        let spore = ws
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| fail(format!("{} has no name to send as {{name}}", ws.display())));
        let loaded = file.and_then(|file| {
            source::Sources::load(
                spore,
                file,
                &def.sources,
                &def.scopes,
                &args.plugin_sources,
                |name| std::env::var(name).ok(),
            )
            .map_err(|refused| format!("{} — {}", refused.message, refused.detail))
        });
        match loaded {
            Ok(sources) => Some(sources),
            Err(problem) => refuse(&ws, lock, &started_at, &problem),
        }
    };

    trace::init();

    // Once per runner: the session pool or the gate, the vector store, the sources. What a turn is
    // given to reach them — its sockets and its key — is made again for every turn.
    let start = async {
        let allowed: Vec<String> = def
            .model
            .iter()
            .chain(&def.models)
            .chain(def.cell_models.iter().map(|named| &named.model))
            .cloned()
            .collect();
        let upstream = match (&given, &args.host.gate) {
            (Some(_), _) => None,
            (None, Some(gate)) => {
                let Some(auth) = def.auth.clone() else {
                    return Err(format!(
                        "this host calls its models through the gate at {}, and spore.cmk names no auth — add auth: <id>, whom its model calls are for",
                        gate.display()
                    ));
                };
                Some(
                    model::reach_gate(
                        gate,
                        auth,
                        allowed,
                        media_root_paths(&ws, &def),
                        def.model.as_deref(),
                    )
                    .await?,
                )
            }
            (None, None) => {
                std::env::set_var("MOHDEL_MEDIA_ROOTS", media_roots(&ws, &def));
                let session = args.host.session.clone().expect("checked above");
                let helper = args.host.chatgpt_helper.clone().expect("checked above");
                Some(model::Upstream::Pool(model::start_pool(
                    node.clone(),
                    session,
                    helper,
                    args.model_sessions,
                    allowed,
                )))
            }
        };
        let store = match vectors {
            None => None,
            Some((vectors, embedding)) => {
                if !vectors.ready().await {
                    return Err(format!(
                        "the vector store at {} is not ready — start it before spending a turn on it",
                        vectors.url()
                    ));
                }
                Some(store::Store::new(vectors, &ws, &embedding))
            }
        };
        // A supplied model socket is its supplier's, and so is its key: kept as found, or
        // minted once when the supplier keeps none, and not turned over between turns.
        let supplied_key = match &given {
            None => None,
            Some(_) => Some(match std::fs::read_to_string(ws.join(MODEL_KEY_FILE)) {
                Ok(key) => key.trim().to_string(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    write_model_key(&ws).map_err(|e| format!("cannot write the model key — {e}"))?
                }
                Err(e) => return Err(format!("cannot read {MODEL_KEY_FILE} — {e}")),
            }),
        };
        Ok::<_, String>((upstream, store, supplied_key))
    };

    let (upstream, store, supplied_key) = tokio::select! {
        biased;
        _ = sigterm.recv() => leave(&ws, lock, &started_at),
        _ = sigint.recv() => leave(&ws, lock, &started_at),
        started = start => match started {
            Ok(started) => started,
            Err(problem) => refuse(&ws, lock, &started_at, &problem),
        },
    };

    let jobs = def.jobs.as_ref().map(|grant| {
        Arc::new(job::Jobs {
            ws: ws.clone(),
            node: PathBuf::from(&node),
            supervisor: root().join("bin").join("spore-job.js"),
            count: grant.count,
            wall_ms: grant.wall,
            env: job::supervisor_env(std::env::vars()),
            largest_file: args.largest_file,
        })
    });

    // A turn's own key and sockets. When the turn ends they are stopped: a cell it detached
    // holds this key and these paths, and its next call fails rather than spending the next
    // turn's allowance.
    let open_turn = || -> Result<(BTreeMap<String, String>, Option<Arc<model::Model>>, Vec<Served>), String> {
        let key = match &supplied_key {
            Some(key) => key.clone(),
            None => write_model_key(&ws).map_err(|e| format!("cannot write the model key — {e}"))?,
        };
        let env: Vec<(String, String)> = std::env::vars().collect();
        let mut passed = agent_env(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        // What the plugins this spore uses give its agent, resolved and checked by `send`; set
        // before the runtime's own, so a value of the runtime's always wins.
        passed.extend(args.env.iter().cloned());
        passed.insert("HOME".into(), ws.join(HOME_DIR).display().to_string());
        let sockets = spore_socket_dir(&ws).map_err(|e| format!("cannot resolve {} — {e}", ws.display()))?;
        make_spore_socket_dir(&sockets)
            .map_err(|e| format!("cannot make {} — {e}", sockets.display()))?
            .map_err(|refused| format!("{} — {}", refused.message, refused.detail))?;
        passed.insert("SPORE_SOCKET_DIR".into(), sockets.display().to_string());
        if !def.cell_models.is_empty() {
            let named: BTreeMap<&str, &str> = def
                .cell_models
                .iter()
                .map(|named| (named.name.as_str(), named.model.as_str()))
                .collect();
            passed.insert(
                CELL_MODELS_ENV.into(),
                serde_json::to_string(&named).expect("a map of strings serializes"),
            );
        }
        let mut served = Vec::new();
        let bind = |kind: &str, served: &mut Vec<Served>, serving: Result<Served, std::io::Error>, path: &str| {
            serving
                .map(|handle| served.push(handle))
                .map_err(|e| format!("cannot bind the {kind} socket {path} — {e}"))
        };
        let model = match &upstream {
            Some(upstream) => {
                let model = model::Model::new(key.clone(), def.limits.cost.hard, upstream.clone());
                let path = socket(&sockets, "model")?;
                bind("model", &mut served, model::serve(model.clone(), Path::new(&path)), &path)?;
                passed.insert("SPORE_MODEL_SOCKET".into(), path);
                Some(model)
            }
            None => {
                passed.insert("SPORE_MODEL_SOCKET".into(), given.clone().expect("supplied"));
                None
            }
        };
        if let Some(store) = &store {
            let path = socket(&sockets, "store")?;
            let store = store.clone();
            bind("store", &mut served, broker::serve(Path::new(&path), key.clone(), move |req| store.clone().route(req)), &path)?;
            passed.insert("SPORE_STORE_SOCKET".into(), path);
        }
        if let Some(sources) = &sources {
            let path = socket(&sockets, "source")?;
            let sources = sources.clone();
            bind("source", &mut served, broker::serve(Path::new(&path), key.clone(), move |req| sources.clone().route(req)), &path)?;
            passed.insert("SPORE_SOURCE_SOCKET".into(), path);
        }
        if let Some(jobs) = &jobs {
            let path = socket(&sockets, "job")?;
            let jobs = jobs.clone();
            bind("job", &mut served, broker::serve(Path::new(&path), key.clone(), move |req| jobs.clone().route(req)), &path)?;
            passed.insert("SPORE_JOB_SOCKET".into(), path);
        }
        Ok((passed, model, served))
    };

    let run_turn = |passed: &BTreeMap<String, String>,
                    token: &str,
                    continuing: bool,
                    traceparent: Option<String>,
                    channel: &UnixStream| {
        let mut command = if args.unsafe_ {
            Command::new(&node)
        } else {
            confined(&root(), &node, !args.host.no_contain, &args.host.kept)
        };
        command
            .arg(root().join("bin").join("spore-agent.js"))
            .arg("--ws")
            .arg(&ws);
        if args.unsafe_ {
            command.arg("--unsafe");
        }
        if args.debug {
            command.arg("--debug");
        }
        if continuing {
            command.arg("--continue");
        }
        let mut env = passed.clone();
        env.insert(OWNERS.into(), owners_with(token));
        // The agent's parent is this turn's span or nothing; what the runner inherited is the
        // context of whoever started it.
        env.remove("TRACEPARENT");
        if let Some(traceparent) = traceparent {
            env.insert("TRACEPARENT".into(), traceparent);
        }
        env.insert("SPORE_STATE_FD".into(), STATE_FD.to_string());
        let fd = channel.as_raw_fd();
        let largest_file = args.largest_file;
        // SAFETY: between fork and exec only `dup2`, `fcntl`, `setrlimit`, `setpriority` and
        // `open`/`read`/`write` on procfs run, all async-signal-safe, with nothing allocated.
        unsafe {
            command.pre_exec(move || {
                hand_over(fd, STATE_FD)?;
                limit_file_size(largest_file)?;
                yield_to_host()
            });
        }
        command
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot start the agent — {e}"))
    };
    // A turn that ends normally is followed by another while anything said is unread: a
    // message that lands during the final model call, or as the lock is let go, would
    // otherwise sit in the inbox with nobody to read it. `send` looks at the lock again after
    // it appends, so between that and the look here after release, every ordering is read by
    // someone.
    let mut lock = Some(lock);
    let mut continuing = args.continuing;
    let code = loop {
        if unsafe { libc::getuid() == 0 || libc::geteuid() == 0 } {
            let problem = ROOT_REFUSED_DETAIL;
            eprintln!("spore: {problem}");
            record(&ws, &iso_now(), "error", "ROOT_REFUSED", problem, 0.0);
            break 2;
        }
        if let Some(retain) = def.retain {
            if let Err(e) = prune_trail(&ws, retain as u32) {
                let problem = format!("cannot prune the trail — {e}");
                eprintln!("spore: {problem}");
                record(&ws, &iso_now(), "error", "START_FAILED", &problem, 0.0);
                break 2;
            }
        }
        match free_bytes(&ws) {
            Ok(free) if free >= args.free_floor => {}
            Ok(free) => {
                let problem = format!(
                    "the disk holding this workspace has {} MB free, under the {} MB floor the host keeps — spore config set freeFloor to change it",
                    free >> 20,
                    args.free_floor >> 20
                );
                eprintln!("spore: {problem}");
                record(&ws, &iso_now(), "error", "DISK_FULL", &problem, 0.0);
                break 2;
            }
            Err(e) => {
                let problem = format!("cannot tell how much room is left on the disk — {e}");
                eprintln!("spore: {problem}");
                record(&ws, &iso_now(), "error", "START_FAILED", &problem, 0.0);
                break 2;
            }
        }
        if !args.unsafe_ && !args.host.no_contain {
            if let Some(why) = contain_refused(&root()) {
                let problem = uncontained(&why);
                eprintln!("spore: {problem}");
                record(&ws, &iso_now(), "error", "CONTAIN_FAILED", &problem, 0.0);
                break 2;
            }
        }
        if let Some(problem) = kept_refusal(&args.host.kept, !args.unsafe_ && !args.host.no_contain)
        {
            eprintln!("spore: {problem}");
            record(&ws, &iso_now(), "error", "CONTAIN_FAILED", &problem, 0.0);
            break 2;
        }
        // A fork carries a turn on and reads no message, so it answers no caller.
        let traced = if continuing {
            Vec::new()
        } else {
            unanswered_traceparents(&ws).unwrap_or_else(|e| {
                eprintln!("spore: this turn is traced under none of its callers — cannot read the inbox: {e}");
                Vec::new()
            })
        };
        let turn = trace::Turn::start(&ws.display().to_string(), &traced);
        let turn_started = iso_now();
        let (passed, model, served) = match open_turn() {
            Ok(opened) => opened,
            Err(problem) => {
                eprintln!("spore: {problem}");
                record(&ws, &turn_started, "error", "START_FAILED", &problem, 0.0);
                turn.end(0.0);
                break 2;
            }
        };
        let turn_id = match begin_turn(&ws, &turn_started, args.reply_to.as_deref()) {
            Ok(turn_id) => turn_id,
            Err(problem) => {
                eprintln!("spore: {problem}");
                record(&ws, &turn_started, "error", "START_FAILED", &problem, 0.0);
                served.into_iter().for_each(Served::stop);
                turn.end(0.0);
                break 2;
            }
        };
        let limits = &def.limits;
        let started_limits = [
            ("rounds", limits.rounds.soft, limits.rounds.hard),
            ("cost", limits.cost.soft, limits.cost.hard),
            ("wall", limits.wall.soft, limits.wall.hard),
        ];
        if let Err(problem) = start_limits(&ws, &turn_id, &started_limits) {
            eprintln!("spore: {problem}");
            unrecorded(
                &ws,
                &turn_id,
                &turn_started,
                "error",
                "START_FAILED",
                &problem,
            );
            served.into_iter().for_each(Served::stop);
            turn.end(0.0);
            break 2;
        }
        // The agent writes its turn's records through this, and only through this: the
        // workspace root is a read path to it, and the other end is the one writer.
        let channel =
            UnixStream::pair().and_then(|(ours, theirs)| Ok((ours.try_clone()?, ours, theirs)));
        let (watcher, serving, theirs) = match channel {
            Ok((watcher, ours, theirs)) => (watcher, serve(&ws, turn_id.clone(), ours), theirs),
            Err(e) => {
                let problem = format!("cannot open the turn's channel — {e}");
                eprintln!("spore: {problem}");
                unrecorded(
                    &ws,
                    &turn_id,
                    &turn_started,
                    "error",
                    "START_FAILED",
                    &problem,
                );
                served.into_iter().for_each(Served::stop);
                turn.end(0.0);
                break 2;
            }
        };
        let token = owner_token();
        let started = run_turn(&passed, &token, continuing, turn.traceparent(), &theirs);
        drop(theirs);
        let mut agent = match started {
            Ok(agent) => agent,
            Err(problem) => {
                eprintln!("spore: {problem}");
                close_channel(watcher, serving);
                unrecorded(
                    &ws,
                    &turn_id,
                    &turn_started,
                    "error",
                    "START_FAILED",
                    &problem,
                );
                served.into_iter().for_each(Served::stop);
                turn.end(0.0);
                break 2;
            }
        };
        continuing = false;
        // A signal is passed to the agent: it aborts the turn, takes its tools' process
        // groups with it and leaves its turn's record — within the grace, or it is killed. What
        // the turn left running is swept once the agent is gone, before the lock is let go.
        let (raise_wall, raised_wall) =
            watch::channel(Duration::from_millis(def.limits.wall.hard as u64));
        let watching = tokio::spawn(follow_limits(
            ws.clone(),
            turn_id.clone(),
            raise_wall,
            model.clone(),
        ));
        let ended = supervise(
            &mut agent,
            &token,
            Duration::from_millis(def.limits.wall.hard as u64),
            Some(raised_wall),
            GRACE,
            &mut sigterm,
            &mut sigint,
            "spore",
        )
        .await;
        watching.abort();
        // No call starts after this; those in flight run to their end and are counted before
        // the turn is written down, with the lock still held — the turn is draining.
        served.into_iter().for_each(Served::stop);
        close_channel(watcher, serving);
        let agent_recorded = match turn_state(&ws, &turn_id) {
            Ok(state) => state.as_deref() == Some("pending"),
            Err(e) => {
                eprintln!("spore: the agent's record cannot be read, so the runner records the turn — {e}");
                false
            }
        };
        if !agent_recorded {
            let (stop_reason, error, detail) = ended.account("spore.err says why");
            let unrecorded = Unanswered {
                started_at: &turn_started,
                stop_reason,
                error,
                detail: &detail,
                tree: 0.0,
            };
            if let Err(e) = write_outcome(&ws, &turn_id, &unanswered(&unrecorded)) {
                eprintln!("spore: cannot record the turn — {e}");
            }
        }
        if let Some(model) = &model {
            model.drained().await;
        }
        let settled = model.as_ref().map(|model| model.settled());
        turn.end(settled.as_ref().map_or(0.0, |settled| settled.tree));
        let code = ended
            .status
            .as_ref()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1);
        crash_at("before-finalize");
        let finalized = match finalize_turn(&ws, &turn_id, settled.as_ref()) {
            Ok(row) => Some(row),
            Err(e) => {
                eprintln!("spore: cannot record the turn — {e}");
                None
            }
        };
        crash_at("after-finalize");
        // Only after a turn that answered on its own: it read what was pending, so anything
        // unread now arrived during it. A stopped turn leaves what is pending for the next
        // `send`; an errored or killed one left its own message unread, and carrying on would
        // meet it — and the same failure — again and again.
        let answered =
            agent_recorded && finalized.is_some_and(|row| row["concluded"].as_i64() == Some(1));
        if ended.signalled || ended.walled || ended.killed || !answered {
            break code;
        }
        match unread(&ws) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                eprintln!("spore: cannot tell whether anything is unread — {e}");
                break code;
            }
        }
        let_go(&ws, lock.take().expect("held through the turn"));
        if !matches!(unread(&ws), Ok(true)) {
            break code;
        }
        match acquire_lock(&ws) {
            Ok(Acquired::Held(file, _)) => lock = Some(file),
            _ => break code,
        }
    };

    trace::shutdown();
    if let Some(lock) = lock {
        let_go(&ws, lock);
    }
    std::process::exit(code)
}

/// Stopped before the agent started: the turn a `send` asked for was cancelled, not lost.
fn leave(ws: &Path, lock: std::fs::File, started_at: &str) -> ! {
    record(
        ws,
        started_at,
        "cancelled",
        "OPERATION_CANCELLED",
        "stopped before the agent started",
        0.0,
    );
    let_go(ws, lock);
    std::process::exit(143)
}

/// The spore's dream, under the lock this runner holds — which says so while it lasts:
/// `bin/spore-dream.js` runs it as a super cell, and a stop reaches it as it reaches a turn's
/// agent. Its exit code, and whether it was stopped.
async fn dream(
    ws: &Path,
    node: &str,
    lock: &std::fs::File,
    sigterm: &mut Signal,
    sigint: &mut Signal,
) -> (i32, bool) {
    let held = |dreaming: bool| {
        let mut held = json!({ "pid": std::process::id(), "startedAt": iso_now() });
        if dreaming {
            held["dream"] = json!(true);
        }
        held
    };
    if let Err(e) = write_lock(lock, &held(true)) {
        eprintln!("spore: cannot say the spore is dreaming — {e}");
        return (1, false);
    }
    let started = Command::new(node)
        .arg(root().join("bin").join("spore-dream.js"))
        .arg("--ws")
        .arg(ws)
        .stdin(Stdio::null())
        .spawn();
    let mut child = match started {
        Ok(child) => child,
        Err(e) => {
            eprintln!("spore: cannot start the dream — {e}");
            let _ = write_lock(lock, &held(false));
            return (1, false);
        }
    };
    let mut stopped = false;
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            _ = sigterm.recv() => stopped = true,
            _ = sigint.recv() => stopped = true,
        }
        if let Some(pid) = child.id() {
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
    };
    let _ = write_lock(lock, &held(false));
    let code = status.ok().and_then(|status| status.code()).unwrap_or(1);
    (code, stopped)
}

/// The workspace handed back: its database a single file again, then its lock.
fn let_go(ws: &Path, lock: std::fs::File) {
    if let Err(e) = leave_wal(ws) {
        eprintln!("spore: {e}");
    }
    let _ = release_lock(lock);
}

//! `spore-definition` and `spore-workspace` for Node. Each structured answer crosses as a
//! JSON string — the value, or `{ "error": ... }` — written straight from serde so the
//! frontmatter keeps its order. A descriptor crosses as its number, and from then on the
//! JavaScript side owns it.

use std::os::fd::{FromRawFd, IntoRawFd};
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde_json::{json, Value};
use spore_definition as definition;
use spore_workspace as workspace;

fn failed(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

fn refused(r: &workspace::Refusal) -> String {
    json!({ "error": { "type": r.kind, "message": r.message, "detail": r.detail } }).to_string()
}

#[napi(object)]
pub struct ParseOptions {
    pub known_tools: Vec<String>,
    pub cell: bool,
    pub seed: bool,
}

fn answer<T: serde::Serialize>(result: Result<T, String>, key: Option<&str>) -> String {
    match result {
        Ok(value) => {
            let json = serde_json::to_string(&value).expect("a parsed definition serializes");
            match key {
                Some(key) => format!("{{\"{key}\":{json}}}"),
                None => json,
            }
        }
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}

#[napi]
pub fn parse_definition(source: String, options: ParseOptions) -> String {
    let opts = definition::Options {
        known_tools: &options.known_tools,
        cell: options.cell,
        seed: options.seed,
    };
    answer(definition::parse_definition(&source, &opts), None)
}

#[napi]
pub fn parse_frontmatter(head: String) -> String {
    answer(definition::parse_frontmatter(&head), Some("fields"))
}

/// A schedule's source is passed whole to each of these, because the pass that fires one
/// holds the file's text and nothing parsed survives between passes.
#[napi]
pub fn parse_schedule(source: String) -> String {
    answer(definition::parse_schedule(&source), None)
}

#[napi]
pub fn schedule_due(source: String, after_ms: i64, now_ms: i64) -> String {
    answer(
        definition::parse_schedule(&source)
            .and_then(|s| definition::schedule::due(&s, after_ms, now_ms)),
        None,
    )
}

#[napi]
pub fn schedule_gap(source: String, from_ms: i64, floor_ms: f64) -> String {
    answer(
        definition::parse_schedule(&source)
            .and_then(|s| definition::schedule::shortest_gap(&s, from_ms, floor_ms)),
        Some("gap"),
    )
}

#[napi]
pub fn duration_ms(value: String) -> Option<f64> {
    definition::duration_ms(&value)
}

#[napi]
pub fn size_bytes(value: String) -> Option<f64> {
    definition::size_bytes(&value)
}

#[napi]
pub fn acquire_lock(ws: String) -> napi::Result<String> {
    Ok(
        match workspace::acquire_lock(Path::new(&ws)).map_err(failed)? {
            workspace::Acquired::Held(file, lock) => {
                json!({ "fd": file.into_raw_fd(), "lock": lock }).to_string()
            }
            workspace::Acquired::Taken(refusal) => json!({ "error": refusal }).to_string(),
        },
    )
}

/// `fd` is one `acquire_lock` handed over; this takes it back and closes it.
#[napi]
pub fn release_lock(fd: i32) -> napi::Result<()> {
    workspace::release_lock(unsafe { std::fs::File::from_raw_fd(fd) }).map_err(failed)
}

/// The pid holding the workspace's lock, as the kernel says, or null.
#[napi]
pub fn lock_holder(ws: String) -> napi::Result<Option<u32>> {
    workspace::lock_holder(Path::new(&ws)).map_err(failed)
}

/// SIGTERM to whoever holds the workspace's lock; the pid signalled, or null.
#[napi]
pub fn stop_holder(ws: String) -> napi::Result<Option<u32>> {
    workspace::stop_holder(Path::new(&ws)).map_err(failed)
}

#[napi]
pub fn read_lock(ws: String) -> napi::Result<String> {
    let held = workspace::read_lock(Path::new(&ws)).map_err(failed)?;
    Ok(serde_json::to_string(&held).map_err(failed)?)
}

#[napi]
pub fn slot_dir() -> String {
    workspace::slot_dir().to_string_lossy().into_owned()
}

#[napi]
pub fn sqlite_minimum() -> String {
    workspace::SQLITE_MINIMUM.to_string()
}

#[napi]
pub fn bundled_sqlite() -> String {
    workspace::sqlite_version().to_string()
}

#[napi]
pub fn sqlite_supported(version: String) -> bool {
    workspace::sqlite_supported(&version)
}

#[napi]
pub fn tick_lock_path() -> String {
    workspace::tick_lock_path().to_string_lossy().into_owned()
}

/// The descriptor now holding `path`'s lock, or null when another holds it. Closing it is
/// letting go.
#[napi]
pub fn hold(path: String) -> napi::Result<Option<i32>> {
    Ok(workspace::hold(Path::new(&path))
        .map_err(failed)?
        .map(|file| file.into_raw_fd()))
}

#[napi]
pub fn job_lock_path(run: String) -> String {
    workspace::job_lock_path(&run)
        .to_string_lossy()
        .into_owned()
}

/// The pid holding the lock file at `path`, whose content names its holder, or null.
#[napi]
pub fn holder_at(path: String) -> napi::Result<Option<u32>> {
    workspace::holder_at(Path::new(&path)).map_err(failed)
}

/// SIGTERM to whoever holds the lock file at `path`; the pid signalled, or null.
#[napi]
pub fn stop_holder_at(path: String) -> napi::Result<Option<u32>> {
    workspace::stop_holder_at(Path::new(&path)).map_err(failed)
}

/// Kills every process of this user still carrying `token` in `SPORE_OWNERS`; how many.
#[napi]
pub fn sweep_owned(token: String) -> u32 {
    workspace::owners::sweep(&token) as u32
}

#[napi]
pub fn default_turns() -> u32 {
    workspace::DEFAULT_TURNS
}

#[napi]
pub fn default_model_sessions() -> u32 {
    workspace::DEFAULT_MODEL_SESSIONS
}

#[napi]
pub fn default_largest_file() -> f64 {
    workspace::DEFAULT_LARGEST_FILE as f64
}

#[napi]
pub fn default_free_floor() -> f64 {
    workspace::DEFAULT_FREE_FLOOR as f64
}

#[napi]
pub fn take_slot(
    turns: u32,
    dir: String,
    spend_per_day: Option<f64>,
    spend_per_month: Option<f64>,
) -> napi::Result<String> {
    let limits = workspace::spend::Limits {
        day: spend_per_day,
        month: spend_per_month,
    };
    Ok(
        match workspace::take_slot(turns, Path::new(&dir), &limits).map_err(failed)? {
            Ok(slot) => json!({ "fd": slot.file.into_raw_fd(), "path": slot.path }).to_string(),
            Err(refusal) => refused(&refusal),
        },
    )
}

/// `{ date, day, month }`: the local day and the micros settled on it and in its month so far.
#[napi]
pub fn spend_so_far(dir: String) -> napi::Result<String> {
    let spent = workspace::spend::spent(Path::new(&dir)).map_err(failed)?;
    Ok(
        json!({ "date": spent.date.to_string(), "day": spent.day, "month": spent.month })
            .to_string(),
    )
}

/// The refusal a limit reached gives, as JSON, or null.
#[napi]
pub fn spend_refusal(
    dir: String,
    spend_per_day: Option<f64>,
    spend_per_month: Option<f64>,
) -> napi::Result<Option<String>> {
    let limits = workspace::spend::Limits {
        day: spend_per_day,
        month: spend_per_month,
    };
    Ok(workspace::spend::spend_refusal(Path::new(&dir), &limits)
        .map_err(failed)?
        .map(|refusal| refused(&refusal)))
}

/// The pause in force on the spores whose slots are in `dir`, as JSON, or null.
#[napi]
pub fn paused(dir: String) -> napi::Result<Option<String>> {
    Ok(workspace::paused(Path::new(&dir))
        .map_err(failed)?
        .map(|mark| mark.to_string()))
}

/// `{ mark, already }`: the pause now in force, and whether it was there before this call.
#[napi]
pub fn pause(dir: String, why: Option<String>) -> napi::Result<String> {
    let (mark, already) = workspace::pause(Path::new(&dir), why.as_deref()).map_err(failed)?;
    Ok(json!({ "mark": mark, "already": already }).to_string())
}

/// Lifts the pause; false when there was none.
#[napi]
pub fn unpause(dir: String) -> napi::Result<bool> {
    workspace::unpause(Path::new(&dir)).map_err(failed)
}

#[napi]
pub fn agent_env(env_json: String) -> napi::Result<String> {
    let env: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&env_json).map_err(failed)?;
    let passed = workspace::agent_env(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    Ok(serde_json::to_string(&passed).map_err(failed)?)
}

#[napi]
pub fn broker_socket_path(kind: String) -> napi::Result<String> {
    Ok(
        match workspace::broker_socket_path(&kind).map_err(failed)? {
            Ok(path) => json!({ "path": path }).to_string(),
            Err(refusal) => refused(&refusal),
        },
    )
}

#[napi]
pub fn spore_socket_dir(ws: String) -> napi::Result<String> {
    Ok(workspace::spore_socket_dir(Path::new(&ws))
        .map_err(failed)?
        .display()
        .to_string())
}

#[napi]
pub fn tool_names() -> Vec<String> {
    definition::TOOL_NAMES
        .iter()
        .map(|t| t.to_string())
        .collect()
}

#[napi]
pub fn layout() -> String {
    json!({
        "definition": workspace::DEFINITION_FILE,
        "lock": workspace::LOCK_FILE,
        "calls": workspace::CALLS_DIR,
        "modelKey": workspace::MODEL_KEY_FILE,
        "dataDir": workspace::DATA_DIR,
        "precursorDir": workspace::PRECURSOR_DIR,
        "precursorExt": workspace::PRECURSOR_EXT,
        "spawnFile": workspace::SPAWN_FILE,
        "state": workspace::STATE_FILE,
        "stateFd": workspace::STATE_FD,
        "eventSchema": workspace::EVENT_SCHEMA,
        "passedThrough": workspace::PASSED_THROUGH,
        "runtimeEnv": workspace::RUNTIME_ENV,
        "pluginEnv": workspace::PLUGIN_ENV
    })
    .to_string()
}

/// `{ inbox, repeated }` — the entry's `inboxNo`, and whether its `requestId` was already
/// there — or `{ error: { message } }`, which the caller raises as a refused send.
#[napi]
pub fn append_inbox(ws: String, entry: String) -> String {
    match workspace::append_inbox(Path::new(&ws), &entry) {
        Ok((inbox, repeated)) => json!({ "inbox": inbox, "repeated": repeated }).to_string(),
        Err(message) => json!({ "error": { "message": message } }).to_string(),
    }
}

/// The row a change to the running turn's limits wrote, or `{ refused }` saying why none was —
/// both JSON. A request it cannot read, or a database it cannot write, throws.
#[napi]
pub fn change_limits(ws: String, request: String) -> napi::Result<String> {
    workspace::change_limits(Path::new(&ws), &request)
        .map(|answer| answer.to_string())
        .map_err(failed)
}

/// Who said an entry, as `<kind>:<name>`, or null when a person did.
#[napi]
pub fn origin_of(entry: String) -> napi::Result<Option<String>> {
    let record = workspace::Record::parse(&entry).map_err(failed)?;
    workspace::origin_of(&record).map_err(failed)
}

/// `{ held }` or `{ repeated }`, as JSON.
#[napi]
pub fn hold_delivery(
    ws: String,
    entry: String,
    release_at: String,
    deadline: String,
) -> napi::Result<String> {
    workspace::hold_delivery(Path::new(&ws), &entry, &release_at, &deadline)
        .map(|answer| answer.to_string())
        .map_err(failed)
}

#[napi]
pub fn reschedule_held(
    ws: String,
    held_no: i64,
    release_at: String,
    urgent: bool,
    summary: Option<String>,
    replaces: bool,
) -> napi::Result<bool> {
    workspace::reschedule_held(
        Path::new(&ws),
        held_no,
        &release_at,
        urgent,
        summary.as_deref(),
        replaces,
    )
    .map_err(failed)
}

/// `{ jobNo }` or `{ refused, running }`, as JSON.
#[napi]
pub fn begin_job(ws: String, job: String, most: i64) -> napi::Result<String> {
    workspace::begin_job(Path::new(&ws), &job, most)
        .map(|answer| answer.to_string())
        .map_err(failed)
}

#[napi]
pub fn end_job(
    ws: String,
    run: String,
    status: String,
    exit: Option<i64>,
    signal: Option<String>,
) -> napi::Result<bool> {
    workspace::end_job(Path::new(&ws), &run, &status, exit, signal.as_deref()).map_err(failed)
}

/// The inbox numbers the released deliveries took, as JSON.
#[napi]
pub fn release_held(ws: String, now: String, due: bool) -> napi::Result<String> {
    workspace::release_held(Path::new(&ws), &now, due)
        .map(|released| json!(released).to_string())
        .map_err(failed)
}

#[napi]
pub fn record_cell(ws: String, run: String) -> napi::Result<i64> {
    workspace::record_cell(Path::new(&ws), &run).map_err(failed)
}

#[napi]
pub fn copy_inbox(from: String, to: String, upto: i64) -> napi::Result<()> {
    workspace::copy_inbox(Path::new(&from), Path::new(&to), upto).map_err(failed)
}

fn records(json: &str) -> napi::Result<Vec<workspace::Record>> {
    let values: Vec<Value> = serde_json::from_str(json).map_err(failed)?;
    Ok(values.iter().map(workspace::Record::from_value).collect())
}

/// A workspace's turns, replaced — host side, for a fork and for fixtures.
#[napi]
pub fn write_turns(ws: String, turns: String) -> napi::Result<()> {
    let mut turns = records(&turns)?;
    workspace::replace_turns(Path::new(&ws), &mut turns).map_err(failed)
}

/// One more turn, finalized as the runner would — host side, for fixtures. Answers the record
/// with what finalizing it assigned.
#[napi]
pub fn append_turn(ws: String, turn: String) -> napi::Result<String> {
    let mut turn = workspace::Record::parse(&turn).map_err(failed)?;
    if !turn.has(workspace::TURN_ID) {
        turn.set(
            workspace::TURN_ID,
            json!(workspace::new_turn_id().map_err(failed)?),
        );
    }
    workspace::finalize(Path::new(&ws), &mut turn).map_err(failed)?;
    Ok(turn.to_json())
}

/// A turn begun from the host side, as a supervisor begins one: its `turnId`. For fixtures, and
/// for a caller running the confined half in its own process.
#[napi]
pub fn begin_turn(ws: String, reply_default: Option<String>) -> napi::Result<String> {
    workspace::begin_turn(
        Path::new(&ws),
        &workspace::iso_now(),
        reply_default.as_deref(),
    )
    .map_err(failed)
}

/// Why `reply_to` is not one, or null when it is.
#[napi]
pub fn reply_to_problem(reply_to: String) -> Option<String> {
    workspace::check_reply_to(&reply_to).err()
}

/// The outbox entries of `kind`, in `state`, as JSON.
#[napi]
pub fn outbox(ws: String, kind: Option<String>, state: Option<String>) -> napi::Result<String> {
    workspace::outbox(Path::new(&ws), kind.as_deref(), state.as_deref())
        .map(|entries| entries.to_string())
        .map_err(failed)
}

#[napi]
pub fn attempt_outbox(ws: String, outbox_no: i64) -> napi::Result<bool> {
    workspace::attempt_outbox(Path::new(&ws), outbox_no).map_err(failed)
}

/// The inbox numbers set aside, or null while a runner holds the workspace.
#[napi]
pub fn set_aside(ws: String, reply_to: String, upto: i64) -> napi::Result<Option<Vec<i64>>> {
    workspace::set_aside(Path::new(&ws), &reply_to, upto).map_err(failed)
}

#[napi]
pub fn settle_outbox(ws: String, outbox_no: i64, refused: Option<String>) -> napi::Result<bool> {
    workspace::settle_outbox(Path::new(&ws), outbox_no, refused.as_deref()).map_err(failed)
}

/// One channel request from the host side — what the agent's channel carries, on a connection
/// of this call's own. Answers the frame the supervisor would.
#[napi]
pub fn state_request(ws: String, turn: Option<String>, frame: String) -> napi::Result<String> {
    workspace::request(Path::new(&ws), turn.as_deref(), &frame).map_err(failed)
}

/// The turn left `pending`, finalized as its agent left it: the row, or `null`.
#[napi]
pub fn finalize_pending(ws: String) -> napi::Result<String> {
    let row = workspace::finalize_pending(Path::new(&ws)).map_err(failed)?;
    Ok(row.map_or_else(|| "null".to_string(), |row| row.to_string()))
}

/// A workspace's transcript, replaced — host side, for a fork and for fixtures.
#[napi]
pub fn write_transcript(ws: String, entries: String) -> napi::Result<()> {
    workspace::replace_transcript(Path::new(&ws), &records(&entries)?).map_err(failed)
}

/// Kept from what this process spawns: the agent's end of its channel is the one writer's,
/// and a tool that inherited it could write records the agent never made.
#[napi]
pub fn close_on_exec(fd: i32) -> napi::Result<()> {
    workspace::close_on_exec(fd).map_err(failed)
}

#[napi]
pub fn work_units(own_rounds: u32, child_rounds: u32) -> u32 {
    workspace::work_units(own_rounds.into(), child_rounds.into()) as u32
}

#[napi]
pub fn prune_trail(ws: String, keep: u32) -> napi::Result<Vec<String>> {
    workspace::prune_trail(Path::new(&ws), keep).map_err(failed)
}

#[napi]
pub fn write_model_key(ws: String) -> napi::Result<String> {
    workspace::write_model_key(Path::new(&ws)).map_err(failed)
}

fn paths(list: Vec<String>) -> Vec<PathBuf> {
    list.into_iter().map(PathBuf::from).collect()
}

fn strings(list: Vec<PathBuf>) -> Vec<String> {
    list.into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[napi]
pub fn safe_path(ws: String, user_path: String, reads: Vec<String>) -> String {
    match workspace::safe_path(Path::new(&ws), &user_path, &paths(reads)) {
        Ok(path) => json!({ "path": path.to_string_lossy() }).to_string(),
        Err(refusal) => refused(&refusal),
    }
}

#[napi]
pub fn writable_dirs(ws: String) -> Vec<String> {
    strings(workspace::writable_dirs(Path::new(&ws)))
}

#[napi]
pub fn node_modules_root(root: String) -> Option<String> {
    workspace::node_modules_root(Path::new(&root)).map(|p| p.to_string_lossy().into_owned())
}

#[napi]
pub fn confine_max_paths() -> u32 {
    workspace::CONFINE_MAX_PATHS as u32
}

#[napi]
pub fn system_read_paths(root: String) -> Vec<String> {
    strings(workspace::system_read_paths(Path::new(&root)))
}

/// `{ granted }`, or `{ error: { code, message } }` when the target cannot be resolved,
/// which the caller throws as the error `realpath` would have.
#[napi]
pub fn granted_path_containing(root: String, target: String, extra: Vec<String>) -> String {
    match workspace::granted_path_containing(Path::new(&root), Path::new(&target), &paths(extra)) {
        Ok(granted) => {
            json!({ "granted": granted.map(|p| p.to_string_lossy().into_owned()) }).to_string()
        }
        Err(e) => {
            json!({ "error": { "code": errno_name(&e), "message": e.to_string() } }).to_string()
        }
    }
}

/// Why a spore at `ws` may not write the `writes` grants, each `[name, path]`, or null when it
/// may: the check the runner makes when a turn starts, made before a spore is.
#[napi]
pub fn writes_refusal(
    root: String,
    ws: String,
    writes: Vec<Vec<String>>,
    reads: Vec<String>,
) -> Option<String> {
    let writes: Vec<(String, PathBuf)> = writes
        .into_iter()
        .map(|grant| match grant.as_slice() {
            [name, path] => (name.clone(), PathBuf::from(path)),
            _ => panic!("a writes grant is [name, path] — got {grant:?}"),
        })
        .collect();
    workspace::writes_refusal(Path::new(&root), Path::new(&ws), &writes, &paths(reads))
}

fn errno_name(e: &std::io::Error) -> Option<&'static str> {
    match e.kind() {
        std::io::ErrorKind::NotFound => Some("ENOENT"),
        std::io::ErrorKind::PermissionDenied => Some("EACCES"),
        _ => None,
    }
}

#[napi]
pub fn provisioned_modules() -> Vec<String> {
    workspace::PROVISIONED_MODULES
        .iter()
        .map(|m| m.to_string())
        .collect()
}

#[napi]
pub fn provision_modules(ws: String, root: String) -> String {
    match workspace::provision_modules(Path::new(&ws), Path::new(&root)) {
        Ok(linked) => json!({ "linked": linked }).to_string(),
        Err(r) => json!({
            "error": {
                "type": r.kind,
                "message": r.message,
                "detail": r.detail,
                "missing": workspace::unprovisioned(Path::new(&root))
            }
        })
        .to_string(),
    }
}

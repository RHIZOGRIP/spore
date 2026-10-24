//! Workspace rules the runner and the JS runtime share: the workspace lock, admission
//! slots, the environment an agent is given, where a broker socket goes, path containment,
//! what the sandbox grants, and the libraries an agent's programs may import.
//! Contract: ARCHITECTURE.md, "One runner per workspace" and "Turns of one user".
//!
//! One implementation. JavaScript reaches it through `spore-node`; the Rust runner links it.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{symlink, DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::value::RawValue;
use serde_json::{json, Value};

pub mod kept;
pub mod owners;
pub mod source_spec;
pub mod state;

pub use state::{
    annotate, answer_approval, append_inbox, ask_approval, attach_held, attempt_outbox, begin_job,
    begin_turn, change_limits, check_reply_to, copy_inbox, end_channel, end_job, expire_approval,
    finalize, finalize_turn, hold_delivery, inbox_consumed, leave_wal, migrate_state, origin_of,
    outbox, post_approval, prune_trail, record_cell, recover, refuse_approval, release_held,
    replace_transcript, replace_turns, request, reschedule_held, serve, set_aside, settle_approval,
    settle_outbox, start_limits, starting_since, turn_limits, turn_state, unanswered_traceparents,
    unread, write_outcome, EVENT_SCHEMA, MAX_FRAME, STATE_FILE,
};

/// The descriptor a supervisor hands its agent the channel on, named to it in
/// `SPORE_STATE_FD`.
pub const STATE_FD: i32 = 3;

/// A fault a test injects, by name: the step at which a supervisor dies as a crash would leave
/// it, or its channel stops answering. Read at each named step and nowhere else; unset, nothing
/// changes.
pub const CRASH_ENV: &str = "SPORE_CRASH_AT";

pub fn crash_asked(point: &str) -> bool {
    std::env::var(CRASH_ENV).as_deref() == Ok(point)
}

/// Dies here, by SIGKILL — no cleanup, the lock's file still naming this pid — when a test asked
/// for a crash at `point`.
pub fn crash_at(point: &str) {
    if crash_asked(point) {
        unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
    }
}

/// Kept from whatever this process spawns.
pub fn close_on_exec(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// In a child between fork and exec: `fd` put on `to` and kept across the exec, which every
/// other descriptor a supervisor holds is not.
pub fn hand_over(fd: i32, to: i32) -> io::Result<()> {
    if fd != to {
        return match unsafe { libc::dup2(fd, to) } {
            -1 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        };
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// In a child between fork and exec: no file it or anything it starts writes may pass `bytes`.
/// Soft and hard alike, so nothing below can raise it; a write past it fails with `EFBIG`, or
/// ends a process that has not ignored `SIGXFSZ`.
pub fn limit_file_size(bytes: u64) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: bytes as libc::rlim_t,
        rlim_max: bytes as libc::rlim_t,
    };
    match unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &limit) } {
        -1 => Err(io::Error::last_os_error()),
        _ => Ok(()),
    }
}

/// In a child between fork and exec: it and everything it starts yield to the host, at
/// `AGENT_NICE` and `AGENT_OOM_SCORE_ADJ`. Each is only raised — a parent already standing
/// further back stays there, and moving forward takes a privilege nothing here has. Raw
/// calls and stack buffers only, since nothing may allocate after a fork.
pub fn yield_to_host() -> io::Result<()> {
    unsafe { *libc::__errno_location() = 0 };
    let nice = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
    if nice == -1 && unsafe { *libc::__errno_location() } != 0 {
        return Err(io::Error::last_os_error());
    }
    if nice < AGENT_NICE && unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, AGENT_NICE) } == -1 {
        return Err(io::Error::last_os_error());
    }
    raise_oom_score(AGENT_OOM_SCORE_ADJ)
}

const OOM_SCORE_ADJ: &[u8] = b"/proc/self/oom_score_adj\0";

fn raise_oom_score(to: i32) -> io::Result<()> {
    let mut read = [0u8; 16];
    let fd = unsafe {
        libc::open(
            OOM_SCORE_ADJ.as_ptr().cast(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    let n = unsafe { libc::read(fd, read.as_mut_ptr().cast(), read.len()) };
    unsafe { libc::close(fd) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    if parse_int(&read[..n as usize]) >= to {
        return Ok(());
    }
    let mut text = [0u8; 12];
    let len = format_int(to, &mut text);
    let fd = unsafe {
        libc::open(
            OOM_SCORE_ADJ.as_ptr().cast(),
            libc::O_WRONLY | libc::O_CLOEXEC,
        )
    };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    let written = unsafe { libc::write(fd, text.as_ptr().cast(), len) };
    unsafe { libc::close(fd) };
    if written == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn parse_int(text: &[u8]) -> i32 {
    let (negative, digits) = match text.first() {
        Some(b'-') => (true, &text[1..]),
        _ => (false, text),
    };
    let value = digits
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .fold(0i32, |n, b| n * 10 + (b - b'0') as i32);
    if negative {
        -value
    } else {
        value
    }
}

fn format_int(value: i32, out: &mut [u8; 12]) -> usize {
    let mut digits = [0u8; 11];
    let mut n = value.unsigned_abs();
    let mut count = 0;
    loop {
        digits[count] = b'0' + (n % 10) as u8;
        count += 1;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    let mut len = 0;
    if value < 0 {
        out[0] = b'-';
        len = 1;
    }
    for i in (0..count).rev() {
        out[len] = digits[i];
        len += 1;
    }
    len
}

/// What an unprivileged process may still write on the filesystem holding `path`.
pub fn free_bytes(path: &Path) -> io::Result<u64> {
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    match unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } {
        -1 => Err(io::Error::last_os_error()),
        _ => Ok(stat.f_bavail as u64 * stat.f_frsize as u64),
    }
}

pub const DEFINITION_FILE: &str = "spore.cmk";
pub const LOCK_FILE: &str = "lock";
pub const CALLS_DIR: &str = "calls";
pub const MODEL_KEY_FILE: &str = "model.key";
pub const DATA_DIR: &str = "data";
pub const PRECURSOR_DIR: &str = "precursors";
pub const SCHEDULE_DIR: &str = "schedules";
/// The agent's `$HOME`: where the programs it runs keep their settings and caches — git's
/// identity, npm's cache — writable, and the workspace's own rather than the host's.
pub const HOME_DIR: &str = "home";
pub const PRECURSOR_EXT: &str = ".cmk";
pub const SPAWN_FILE: &str = "spawn.json";
/// Names one turn's record, so writing it down again is known for what it is.
pub const TURN_ID: &str = "turnId";
pub const DEFAULT_TURNS: u32 = 8;
/// How many model calls one running turn and its cells may have going at once: the most
/// sessions its runner starts, one at first and another each time every one is busy.
pub const DEFAULT_MODEL_SESSIONS: u32 = 8;
/// The largest file anything in a turn may write, unless the host's config says otherwise.
pub const DEFAULT_LARGEST_FILE: u64 = 1 << 30;
/// Below this much free space on a workspace's filesystem, no turn starts there.
pub const DEFAULT_FREE_FLOOR: u64 = 2 << 30;
/// How far an agent and everything it starts stand back from the host: scheduled after it,
/// and killed before it when memory runs out.
pub const AGENT_NICE: i32 = 10;
pub const AGENT_OOM_SCORE_ADJ: i32 = 500;
/// Where a user's broker sockets go: `/tmp/spore-<uid>`, one directory per user, since `/tmp`
/// is shared and a directory the first user made is closed to the next.
pub fn socket_root() -> PathBuf {
    PathBuf::from(format!("/tmp/spore-{}", unsafe { libc::getuid() }))
}
/// `sockaddr_un.sun_path` is 108 bytes on Linux, its terminator included.
pub const SUN_PATH_MAX: usize = 107;

/// Named here rather than filtered out: a denylist of key names goes stale the day a
/// provider is added, so nothing reaches an agent that is not on this list. Not `HOME`: the
/// host's is not granted, so its supervisor sets the workspace's own (`HOME_DIR`).
pub const PASSED_THROUGH: [&str; 17] = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "MODEL",
    "TRACEPARENT",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "OTEL_INIT_TIMEOUT_MS",
    "SPORE_SPAWN",
    "SPORE_FANOUT",
    "SPORE_RECALL",
    "SPORE_SOURCE",
    "SPORE_SQL",
    "SPORE_OWNERS",
    CELL_MODELS_ENV,
];

/// What the runtime itself sets in the environment of what it starts — the agent, a cell, a job —
/// which no variable a plugin declares may set.
pub const RUNTIME_ENV: [&str; 22] = [
    "HOME",
    "TMPDIR",
    "TRACEPARENT",
    "MOHDEL_MEDIA_ROOTS",
    "SPORE_SOCKET_DIR",
    "SPORE_CELL",
    "SPORE_CELL_MODELS",
    "SPORE_DEBUG",
    "SPORE_ENZYME",
    "SPORE_ENZYMES",
    "SPORE_JOB",
    "SPORE_JOB_DIR",
    "SPORE_JOB_NAME",
    "SPORE_JOB_SOCKET",
    "SPORE_MODEL_SOCKET",
    "SPORE_SOURCES",
    "SPORE_SOURCE_SOCKET",
    "SPORE_STATE_FD",
    "SPORE_STORE_SOCKET",
    PLUGIN_READS,
    PLUGIN_ENV,
    PLUGIN_CALLS,
];

/// What the agent reads of its plugins, a JSON array of paths: their packages and what they
/// depend on, less what the system's read paths already grant.
pub const PLUGIN_READS: &str = "SPORE_PLUGIN_READS";

/// How the plugins a spore uses describe their programs' calls, a JSON array of call rows.
pub const PLUGIN_CALLS: &str = "SPORE_PLUGIN_CALLS";

/// The variable a runner reads its spore's plugin environment from, a JSON object of name to
/// value: a process's environment is readable by its own user alone, its arguments by anyone.
pub const PLUGIN_ENV: &str = "SPORE_PLUGIN_ENV";

/// A spore's `cell-models` as a JSON object of name to model, set by the runner and passed to every
/// cell, so a precursor's `model:` is read against its root's map at any depth.
pub const CELL_MODELS_ENV: &str = "SPORE_CELL_MODELS";

/// Libraries an agent's own programs may import, and dependencies of the package for that
/// reason alone: each is a format or a kind of arithmetic that is unreasonable to redo by
/// hand and easy to get subtly wrong. Naming them here is the whole declaration.
pub const PROVISIONED_MODULES: [&str; 9] = [
    "csv-parse",
    "csv-stringify",
    "fast-xml-parser",
    "yaml",
    "cheerio",
    "fflate",
    "decimal.js",
    "luxon",
    "ajv",
];

/// What a confined agent reads of the runtime itself: the programs it runs, what they
/// import, the native binaries, and `sporangia/`, which a cell's workspace is seeded from. Not
/// the checkout — tests, benchmark fixtures, graders and plans are not the agent's to read.
pub const RUNTIME_PATHS: [&str; 6] = ["bin", "src", "build", "native", "package.json", "sporangia"];

const SYSTEM_READ_PATHS: [&str; 9] = [
    "/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/proc", "/dev", "/run",
];

const MAX_LINK_DEPTH: u32 = 32;

/// A refusal a caller acts on, as distinct from a failure to evaluate.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub kind: &'static str,
    pub message: String,
    pub detail: String,
}

/// `flock(2)`, exclusive and non-blocking: true when this descriptor now holds it, false
/// when another does. Anything else is an error, because a lock that could not be
/// evaluated is not a lock that is free.
pub fn try_lock(file: &File) -> io::Result<bool> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::EWOULDBLOCK) | Some(libc::EINTR) => Ok(false),
        _ => Err(err),
    }
}

pub fn lock_path(ws: &Path) -> PathBuf {
    ws.join(LOCK_FILE)
}

pub enum Acquired {
    Held(File, Value),
    Taken(String),
}

/// One runner per workspace. The `flock` decides, before anything is written; the content
/// — who claimed it and when — is what a reader outside the run sees. Taken before the
/// sandbox, since opening the file read-write is a path resolution Landlock refuses after.
pub fn acquire_lock(ws: &Path) -> io::Result<Acquired> {
    fs::create_dir_all(ws)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o644)
        .open(lock_path(ws))?;
    if !try_lock(&file)? {
        drop(file);
        // A file caught half-written must not turn "someone is running" into the advice
        // to delete it, so an unreadable one names nobody.
        let other = read_lock(ws).ok().flatten();
        let refusal = match other {
            Some(held) => format!(
                "workspace is already running — pid {} since {}",
                text_of(&held["pid"]),
                text_of(&held["startedAt"])
            ),
            None => "workspace is already running — another process holds the lock".to_string(),
        };
        return Ok(Acquired::Taken(refusal));
    }
    let held = json!({ "pid": std::process::id(), "startedAt": iso_now() });
    write_lock(&file, &held)?;
    Ok(Acquired::Held(file, held))
}

/// What the lock says to a reader outside the run, said again by its holder: who holds it, since
/// when, and — for a dream — that the spore is dreaming rather than in a turn.
pub fn write_lock(file: &File, held: &Value) -> io::Result<()> {
    // Through the descriptor held, not the path: resolving it again is a window for
    // another process to open and truncate between the lock and the write.
    file.set_len(0)?;
    file.write_all_at(serde_json::to_string_pretty(held)?.as_bytes(), 0)
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "undefined".to_string(),
        other => other.to_string(),
    }
}

/// Who holds a workspace's lock, as the kernel says: its pid, or none when nobody does. Read
/// from `/proc/locks` rather than by trying the lock, since a probe holding it for an instant
/// would turn away a runner starting at that instant; and checked against the process's open
/// files, since `/proc/locks` names a device `stat` may not.
pub fn lock_holder(ws: &Path) -> io::Result<Option<u32>> {
    holder_at(&lock_path(ws))
}

/// Who holds the `flock` on the lock file at `path`, whose content names its holder as the
/// workspace lock's does — a job's supervisor holds one so.
pub fn holder_at(path: &Path) -> io::Result<Option<u32>> {
    let locks = fs::read_to_string("/proc/locks")?;
    holder_of(path, &locks)
}

/// `/proc/locks` is handed out a page at a time, each page built anew when it is read, so an
/// entry can be skipped while other locks come and go between two pages. The pid written in
/// the file backs it up: on its own it outlives a crash and can be reused, so it says only who
/// held the lock, but a process that has the file open still is the one holding it — the file
/// is emptied before a holder lets go, and a crashed one's files are closed by the kernel.
fn holder_of(lock: &Path, locks: &str) -> io::Result<Option<u32>> {
    let inode = match fs::metadata(lock) {
        Ok(meta) => meta.ino(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let path = fs::canonicalize(lock)?;
    let listed = locks
        .lines()
        .filter_map(flock_entry)
        .find(|&(pid, held)| held == inode && has_open(pid, &path))
        .map(|(pid, _)| pid);
    Ok(listed.or_else(|| {
        read_lock_at(lock)
            .ok()
            .flatten()
            .and_then(|held| held["pid"].as_u64())
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|&pid| has_open(pid, &path))
    }))
}

/// A `flock` held, as `/proc/locks` lists it — `1: FLOCK ADVISORY WRITE <pid> <maj>:<min>:<inode>
/// 0 EOF` — and not one waiting for it, which it marks `->`.
fn flock_entry(line: &str) -> Option<(u32, u64)> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.get(1) != Some(&"FLOCK") {
        return None;
    }
    let pid = fields.get(4)?.parse().ok()?;
    let inode = fields.get(5)?.rsplit(':').next()?.parse().ok()?;
    Some((pid, inode))
}

fn has_open(pid: u32, path: &Path) -> bool {
    fs::read_dir(format!("/proc/{pid}/fd"))
        .map(|fds| {
            fds.filter_map(Result::ok)
                .any(|fd| fs::read_link(fd.path()).is_ok_and(|to| to == path))
        })
        .unwrap_or(false)
}

/// `signal` to whoever holds the workspace's lock, through a pidfd taken first and then checked
/// against the lock again, so a pid reused in between is never the one signalled. The holder's
/// pid, or none when nobody holds the lock.
pub fn signal_holder(ws: &Path, signal: i32) -> io::Result<Option<u32>> {
    signal_holder_at(&lock_path(ws), signal)
}

/// `signal_holder` for the lock file at `path`.
pub fn signal_holder_at(lock: &Path, signal: i32) -> io::Result<Option<u32>> {
    let Some(pid) = holder_at(lock)? else {
        return Ok(None);
    };
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) } as i32;
    if pidfd == -1 {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(e)
        };
    }
    let signalled = match holder_at(lock) {
        Ok(Some(still)) if still == pid => {
            let sent = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd,
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            match sent {
                -1 => {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() == Some(libc::ESRCH) {
                        Ok(None)
                    } else {
                        Err(e)
                    }
                }
                _ => Ok(Some(pid)),
            }
        }
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    };
    unsafe { libc::close(pidfd) };
    signalled
}

/// SIGTERM to the holder, which the runner passes to its agent: the turn aborts and is recorded.
pub fn stop_holder(ws: &Path) -> io::Result<Option<u32>> {
    signal_holder(ws, libc::SIGTERM)
}

/// SIGTERM to the holder of the lock file at `path`: a job's supervisor stops its job and records it.
pub fn stop_holder_at(lock: &Path) -> io::Result<Option<u32>> {
    signal_holder_at(lock, libc::SIGTERM)
}

/// The lock's content, or none when nobody is named in it.
pub fn read_lock(ws: &Path) -> Result<Option<Value>, String> {
    read_lock_at(&lock_path(ws))
}

fn read_lock_at(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} could not be read — {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&raw).map(Some).map_err(|_| {
        format!(
            "{} is not readable JSON — delete it if no run is live",
            path.display()
        )
    })
}

/// Truncating says "nobody is here" to a reader holding only the file; closing drops the
/// lock. Unlinking would need write permission on a directory that is read-only by now.
pub fn release_lock(file: File) -> io::Result<()> {
    file.set_len(0)
}

/// A fresh key for this tree's model socket, written where only the tree can read it: a
/// request that does not present it is from another tree and is refused.
pub fn write_model_key(ws: &Path) -> io::Result<String> {
    let key = random_hex(32)?;
    fs::create_dir_all(ws)?;
    fs::write(ws.join(MODEL_KEY_FILE), &key)?;
    Ok(key)
}

/// A fresh `turnId`: what names one turn's record, so finalizing it again is known for what
/// it is.
pub fn new_turn_id() -> io::Result<String> {
    random_hex(16)
}

pub(crate) fn random_hex(len: usize) -> io::Result<String> {
    let mut bytes = vec![0u8; len];
    let got = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if got != bytes.len() as isize {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Where the slots live: outside every sandbox grant, since a slot an agent could open is
/// a slot an agent could hold.
pub fn slot_dir() -> PathBuf {
    let state = match std::env::var("XDG_STATE_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()
            .expect("a home directory, or XDG_STATE_HOME")
            .join(".local")
            .join("state"),
    };
    state.join("spore").join("slots")
}

/// The oldest SQLite either side of a workspace database may run: the Rust writer's bundled
/// build and the one inside the Node an agent reads it with. 3.51.3 carries the WAL-reset fix
/// the database's journal relies on (ARCHITECTURE §The workspace database).
pub const SQLITE_MINIMUM: &str = "3.51.3";

/// The SQLite this crate is built with.
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

/// Whether a dotted `sqlite_version()` is at least `SQLITE_MINIMUM`. A version that does not
/// read as numbers is not one this runtime can vouch for.
pub fn sqlite_supported(version: &str) -> bool {
    let numbers = |v: &str| -> Option<Vec<u32>> { v.split('.').map(|p| p.parse().ok()).collect() };
    match (numbers(version), numbers(SQLITE_MINIMUM)) {
        (Some(have), Some(need)) => have >= need,
        _ => false,
    }
}

/// Where the pass that fires schedules takes its lock: beside the slots and outside every
/// sandbox grant, since a lock an agent could open is a pass an agent could stop.
pub fn tick_lock_path() -> PathBuf {
    slot_dir()
        .parent()
        .expect("the slots live in a directory")
        .join("tick.lock")
}

/// Where a job's supervisor holds its lock for as long as the job runs: host state beside the
/// slots, out of every agent's reach, named by the job's run.
pub fn job_lock_path(run: &str) -> PathBuf {
    slot_dir()
        .parent()
        .expect("the slots live in a directory")
        .join("jobs")
        .join(format!("{run}.lock"))
}

/// An exclusive `flock` on `path`, created when missing, held until the file closes. None
/// when another holds it.
pub fn hold(path: &Path) -> io::Result<Option<File>> {
    if let Some(dir) = path.parent() {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    Ok(if try_lock(&file)? { Some(file) } else { None })
}

#[derive(Debug)]
pub struct Slot {
    pub file: File,
    pub path: PathBuf,
}

/// Where a pause of a user's spores is marked: beside the slots, in state no agent reaches.
/// While the file is there, no turn is admitted.
pub fn pause_path(slots: &Path) -> PathBuf {
    slots
        .parent()
        .expect("the slots live in a directory")
        .join("paused")
}

/// The pause in force, as its mark says — `{ at, why? }` — or none. The file is the pause: one
/// an operator made by hand, with nothing readable in it, pauses as well and says `{}`.
pub fn paused(slots: &Path) -> io::Result<Option<Value>> {
    match fs::read_to_string(pause_path(slots)) {
        Ok(raw) => Ok(Some(
            serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({})),
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Pauses the user's spores, unless they are paused already: the first mark stands. Answers the mark in
/// force and whether it was already there.
pub fn pause(slots: &Path, why: Option<&str>) -> io::Result<(Value, bool)> {
    let path = pause_path(slots);
    if let Some(dir) = path.parent() {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    let mark = match why {
        Some(why) => json!({ "at": iso_now(), "why": why }),
        None => json!({ "at": iso_now() }),
    };
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(mark.to_string().as_bytes())?;
            Ok((mark, false))
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => match paused(slots)? {
            Some(held) => Ok((held, true)),
            None => Err(io::Error::other(
                "the pause was lifted while it was being set — pause again",
            )),
        },
        Err(e) => Err(e),
    }
}

/// Lifts the pause. False when there was none.
pub fn unpause(slots: &Path) -> io::Result<bool> {
    match fs::remove_file(pause_path(slots)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// A free admission slot, held until its descriptor closes. Refused while the user's spores
/// are paused and when every slot is held: waiting is a policy, and it belongs to the caller.
pub fn take_slot(turns: u32, dir: &Path) -> io::Result<Result<Slot, Refusal>> {
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    if let Some(mark) = paused(dir)? {
        let since = match (mark["at"].as_str(), mark["why"].as_str()) {
            (Some(at), Some(why)) => format!("since {at} ({why})"),
            (Some(at), None) => format!("since {at}"),
            _ => "by a mark with no date".to_string(),
        };
        return Ok(Err(Refusal {
            kind: "PAUSED",
            message: "your spores are paused".into(),
            detail: format!(
                "{since} — nothing was said or started; spore unpause lets turns start again"
            ),
        }));
    }
    for i in 0..turns {
        let path = dir.join(i.to_string());
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .open(&path)?;
        if try_lock(&file)? {
            return Ok(Ok(Slot { file, path }));
        }
    }
    Ok(Err(Refusal {
        kind: "ADMISSION_FULL",
        message: format!("{turns} of your turns are already running"),
        detail: "nothing was said or started; try again when one ends, or raise the limit with spore config set turns <n>".into(),
    }))
}

/// What an agent is given: the names above, and nothing else of its parent's environment.
pub fn agent_env<'a>(
    env: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> BTreeMap<String, String> {
    let env: BTreeMap<&str, &str> = env.into_iter().collect();
    PASSED_THROUGH
        .iter()
        .filter_map(|name| {
            env.get(name)
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

/// `path.resolve` for an absolute path: `.` and `..` collapse lexically, as the JS runtime
/// always has, before anything is looked up.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::RootDir | Component::Prefix(_) => out = PathBuf::from("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        lexical(path)
    } else {
        lexical(
            &std::env::current_dir()
                .expect("a working directory")
                .join(path),
        )
    }
}

pub fn writable_dirs(ws: &Path) -> Vec<PathBuf> {
    let ws = absolute(ws);
    [DATA_DIR, CALLS_DIR, PRECURSOR_DIR, HOME_DIR]
        .iter()
        .map(|dir| ws.join(dir))
        .collect()
}

/// The deepest ancestor that exists, resolved, with the missing tail put back on. A symlink
/// can only be something that exists, so canonicalising the existing prefix closes the
/// question; the tail cannot be a link because it is not anything yet. A link whose target
/// is missing cannot be canonicalised and is followed by hand — read as a plain missing
/// name, a write would follow it and create its target outside the workspace. None when a
/// link cannot be read or the chain is deeper than any real one.
fn canonical(resolved: &Path, depth: u32) -> Option<PathBuf> {
    let mut missing: Vec<OsString> = Vec::new();
    let mut at = resolved.to_path_buf();
    loop {
        if let Ok(entry) = fs::symlink_metadata(&at) {
            let rejoin = |base: PathBuf| missing.iter().rev().fold(base, |p, n| p.join(n));
            return match fs::canonicalize(&at) {
                Ok(base) => Some(rejoin(base)),
                Err(_) if entry.file_type().is_symlink() && depth < MAX_LINK_DEPTH => {
                    let target = fs::read_link(&at).ok()?;
                    let dir = at.parent().unwrap_or(Path::new("/"));
                    canonical(&rejoin(lexical(&dir.join(target))), depth + 1)
                }
                Err(_) => None,
            };
        }
        let name = at.file_name()?.to_os_string();
        missing.push(name);
        at = at.parent()?.to_path_buf();
    }
}

/// A path an agent named, resolved within its workspace. Rejects absolute paths, `..`
/// escapes and symlinks out; a declared grant — a corpus it reads, a directory it writes — is
/// the one way out. Whether it may write there is the islands check's and Landlock's. It does
/// not defend against a link swapped between this check and the open that follows.
pub fn safe_path(ws: &Path, user_path: &str, grants: &[PathBuf]) -> Result<PathBuf, Refusal> {
    let refuse = |kind: &'static str, message: &str, detail: String| Refusal {
        kind,
        message: message.to_string(),
        detail,
    };
    if user_path.is_empty() {
        return Err(refuse(
            "PATH_EMPTY",
            "empty path",
            "A path is required, and none was given.".into(),
        ));
    }
    if Path::new(user_path).is_absolute() {
        return Err(refuse(
            "PATH_ABSOLUTE",
            "absolute path rejected",
            format!("Paths are relative to the workspace root — \"{user_path}\" is absolute, so it names something outside it."),
        ));
    }
    if user_path.contains('\0') {
        return Err(refuse(
            "PATH_NULL_BYTE",
            "path contains a null byte",
            format!("\"{user_path}\" contains a null byte, which is not a name any file has."),
        ));
    }
    let escapes = || {
        refuse(
            "PATH_ESCAPE",
            "path escapes workspace",
            format!(
                "\"{user_path}\" resolves outside the workspace. Everything you can reach is under the workspace root{}, and a symlink pointing out of it does not change that.",
                if grants.is_empty() { "" } else { " or in what this definition declares it may reach" }
            ),
        )
    };
    let ws_canonical = fs::canonicalize(ws).map_err(|e| {
        refuse(
            "PATH_NO_WORKSPACE",
            "workspace cannot be resolved",
            format!("{} — {e}", ws.display()),
        )
    })?;
    let resolved = absolute(&ws.join(user_path));
    let found = canonical(&resolved, 0).ok_or_else(escapes)?;
    if found.starts_with(&ws_canonical) || grants.iter().any(|grant| found.starts_with(grant)) {
        Ok(found)
    } else {
        Err(escapes())
    }
}

/// Where the spore root's hoisted dependencies live: installed inside another package, the
/// node_modules that contains it; in a checkout, the nearest node_modules above it, where npm
/// workspaces hoist and where Node resolves from. Found by looking, never by reading a file:
/// `spore-spawn` asks from inside a sandbox that grants none above the root.
pub fn node_modules_root(root: &Path) -> Option<PathBuf> {
    let root = absolute(root);
    let installed = root
        .ancestors()
        .skip(1)
        .find(|dir| dir.file_name().is_some_and(|name| name == "node_modules"));
    if let Some(installed) = installed {
        return Some(installed.to_path_buf());
    }
    root.ancestors()
        .skip(1)
        .map(|dir| dir.join("node_modules"))
        .find(|dir| dir.is_dir())
}

pub fn system_read_paths(root: &Path) -> Vec<PathBuf> {
    let root = absolute(root);
    let own = root.join("node_modules");
    let mut paths: Vec<PathBuf> = SYSTEM_READ_PATHS.iter().map(PathBuf::from).collect();
    paths.extend(RUNTIME_PATHS.iter().map(|p| root.join(p)));
    if own.exists() {
        paths.push(own);
    }
    paths.extend(node_modules_root(&root));
    paths
}

/// The grant containing `target`, if any: a workspace inside one cannot isolate a child
/// confined beneath it, since the surroundings stay reachable through the grant. The spore
/// root counts as a whole, not only the parts of it the sandbox grants: it is the runtime's
/// tree, never a place for a workspace. `extra` is what a definition declared it may read.
pub fn granted_path_containing(
    root: &Path,
    target: &Path,
    extra: &[PathBuf],
) -> io::Result<Option<PathBuf>> {
    let resolved = fs::canonicalize(target)?;
    let granted = std::iter::once(absolute(root))
        .chain(system_read_paths(root))
        .chain(std::iter::once(PathBuf::from("/tmp")))
        .chain(extra.iter().cloned());
    for path in granted {
        let Ok(real) = fs::canonicalize(&path) else {
            continue;
        };
        if resolved.starts_with(&real) {
            return Ok(Some(real));
        }
    }
    Ok(None)
}

/// How many paths `confine` takes to read: past it, it runs nothing. `MAX_PATHS` in
/// `confine.c` is the same number; the JS suite runs `confine` at both sides of it.
pub const CONFINE_MAX_PATHS: usize = 256;

/// Why every command an agent runs under `exec` would be refused, or none: `confine` is handed
/// the system's read paths, the directory of the node running the agent, what the definition
/// reads and writes, the plugins' reads and the workspace, and takes no more than
/// `CONFINE_MAX_PATHS`.
pub fn read_paths_refusal(
    root: &Path,
    reads: usize,
    writes: usize,
    plugin_reads: usize,
) -> Option<String> {
    let system = system_read_paths(root).len() + 1;
    let total = system + reads + writes + plugin_reads + 1;
    (total > CONFINE_MAX_PATHS).then(|| {
        format!(
            "would hand its commands {total} paths to read, past the {CONFINE_MAX_PATHS} confine takes — {reads} it reads, {writes} it writes, {plugin_reads} of its plugins, and {} the runtime's own",
            system + 1
        )
    })
}

/// `~/.config/spore`: what the operator authors, which no agent may write.
pub fn config_dir() -> PathBuf {
    let config = match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()
            .expect("a home directory, or XDG_CONFIG_HOME")
            .join(".config"),
    };
    config.join("spore")
}

/// Why a directory a definition `writes` cannot be granted, or none. Landlock adds up the rights
/// along a path, so a grant overlapping anything the agent must not write — its own workspace
/// root, the runtime, what the operator authors, a corpus it only reads — would hand that over
/// too, whichever of the two holds the other.
pub fn writes_refusal(
    root: &Path,
    ws: &Path,
    writes: &[(String, PathBuf)],
    reads: &[PathBuf],
) -> Option<String> {
    let overlap = |a: &Path, b: &Path| a.starts_with(b) || b.starts_with(a);
    let real = |path: &Path| fs::canonicalize(path).ok();
    let ws = real(ws).unwrap_or_else(|| absolute(ws));
    let runtime = real(root).unwrap_or_else(|| absolute(root));
    let config = config_dir();
    let config = real(&config).unwrap_or(config);
    for (name, declared) in writes {
        let said = format!("writes {name}={}", declared.display());
        let Some(path) = real(declared).filter(|p| p.is_dir()) else {
            return Some(format!("{said}, which is not a directory on this host"));
        };
        if overlap(&path, &ws) {
            return Some(format!("{said}, which overlaps the spore's own workspace — the workspace root stays the runtime's"));
        }
        if overlap(&path, &runtime) {
            return Some(format!(
                "{said}, which overlaps the runtime at {}",
                runtime.display()
            ));
        }
        if overlap(&path, &config) {
            return Some(format!(
                "{said}, which overlaps {} — what the operator authors is no agent's to write",
                config.display()
            ));
        }
        if let Ok(Some(granted)) = granted_path_containing(root, &path, &[]) {
            return Some(format!(
                "{said}, which lies inside {} — every sandbox is granted it, read-only",
                granted.display()
            ));
        }
        if let Some(read) = reads
            .iter()
            .filter_map(|r| real(r))
            .find(|r| overlap(&path, r))
        {
            return Some(format!("{said}, which overlaps {}, a corpus it only reads — a write grant would reach it too", read.display()));
        }
    }
    None
}

fn provisioned_targets(root: &Path) -> Vec<(&'static str, Option<PathBuf>)> {
    let root = absolute(root);
    let hoisted = node_modules_root(&root);
    PROVISIONED_MODULES
        .iter()
        .map(|name| {
            let target = std::iter::once(root.join("node_modules").join(name))
                .chain(hoisted.iter().map(|dir| dir.join(name)))
                .find(|candidate| candidate.exists());
            (*name, target)
        })
        .collect()
}

pub fn unprovisioned(root: &Path) -> Vec<String> {
    provisioned_targets(root)
        .into_iter()
        .filter(|(_, target)| target.is_none())
        .map(|(name, _)| name.to_string())
        .collect()
}

/// Node resolves a bare import by walking up from the importing file, and an agent's
/// program in `<ws>/data/` never reaches this package, so each declared library is linked
/// into `<ws>/node_modules/` by name — one link each, never the directory, so what is
/// offered is what was declared. A declared library that is not installed is a broken
/// install, refused before anything is linked.
pub fn provision_modules(ws: &Path, root: &Path) -> Result<Vec<String>, Refusal> {
    let found = provisioned_targets(root);
    let missing: Vec<&str> = found
        .iter()
        .filter(|(_, target)| target.is_none())
        .map(|(name, _)| *name)
        .collect();
    if !missing.is_empty() {
        return Err(Refusal {
            kind: "PROVISION_INCOMPLETE",
            message: format!("provisioned modules are missing: {}", missing.join(", ")),
            detail: format!(
                "{} {} declared for the agent's programs but not installed — run npm install in {}",
                missing.join(", "),
                if missing.len() > 1 { "are" } else { "is" },
                absolute(root).display()
            ),
        });
    }
    let dir = absolute(ws).join("node_modules");
    let failed = |e: io::Error| Refusal {
        kind: "PROVISION_FAILED",
        message: "provisioned modules could not be linked".into(),
        detail: format!("{} — {e}", dir.display()),
    };
    let mut linked = Vec::new();
    for (name, target) in found {
        let link = dir.join(name);
        if fs::symlink_metadata(&link).is_ok() {
            continue;
        }
        fs::create_dir_all(&dir).map_err(failed)?;
        symlink(target.expect("checked above"), &link).map_err(failed)?;
        linked.push(name.to_string());
    }
    Ok(linked)
}

/// A directory of this user's own for sockets, made 0700 if it is not there. `/tmp` lets anyone
/// create a name first, so one found that is not — another user's, a link, open to others — is
/// refused rather than used.
fn own_socket_dir(dir: &Path) -> io::Result<Result<(), Refusal>> {
    match DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let found = fs::symlink_metadata(dir)?;
    let mine = unsafe { libc::getuid() };
    if !found.is_dir() || found.uid() != mine || found.mode() & 0o077 != 0 {
        return Ok(Err(Refusal {
            kind: "SOCKET_DIR_UNSAFE",
            message: format!("{} is not this user's own directory", dir.display()),
            detail: format!(
                "broker sockets go there, so it must be a directory owned by uid {mine} with mode 0700 — remove it and run again"
            ),
        }));
    }
    Ok(Ok(()))
}

fn socket_in(dir: &Path, kind: &str) -> Result<String, Refusal> {
    let path = format!(
        "{}/{}-{}.{kind}.sock",
        dir.display(),
        std::process::id(),
        base36(millis_now())
    );
    if path.len() > SUN_PATH_MAX {
        return Err(Refusal {
            kind: "SOCKET_PATH_TOO_LONG",
            message: "broker socket path is too long".into(),
            detail: format!(
                "{path} is {} bytes and a unix socket path may be {SUN_PATH_MAX}.",
                path.len()
            ),
        });
    }
    Ok(path)
}

/// A socket for a process no spore's sandbox holds — a standalone cell, a test — at the root.
/// Under `/tmp` literally: the runtime points `TMPDIR` at a scratch directory inside the
/// workspace for every command an agent runs, and a socket built under it passed the
/// `sun_path` limit.
pub fn broker_socket_path(kind: &str) -> io::Result<Result<String, Refusal>> {
    let root = socket_root();
    if let Err(refused) = own_socket_dir(&root)? {
        return Ok(Err(refused));
    }
    Ok(socket_in(&root, kind))
}

/// The directory a spore's sockets go in, `<root>/<12 hex of its real path>`: granted read-write
/// to that spore's agent and nothing else, so another spore of the same uid can connect to a
/// socket there — and is refused by the key — but cannot remove one or bind in its place. Per
/// spore rather than per turn, since a plugin names it before a turn starts.
pub fn spore_socket_dir(ws: &Path) -> io::Result<PathBuf> {
    let real = fs::canonicalize(ws)?;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in real.as_os_str().as_encoded_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    Ok(socket_root().join(format!("{:012x}", hash & 0xffff_ffff_ffff)))
}

/// `dir`, a spore's own socket directory, made with the root if they are not there.
pub fn make_spore_socket_dir(dir: &Path) -> io::Result<Result<(), Refusal>> {
    for one in [socket_root(), dir.to_path_buf()] {
        if let Err(refused) = own_socket_dir(&one)? {
            return Ok(Err(refused));
        }
    }
    Ok(Ok(()))
}

/// A socket in `dir`, a spore's own directory, made with the root if they are not there.
pub fn spore_socket_path(dir: &Path, kind: &str) -> io::Result<Result<String, Refusal>> {
    if let Err(refused) = make_spore_socket_dir(dir)? {
        return Ok(Err(refused));
    }
    Ok(socket_in(dir, kind))
}

fn millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set after 1970")
        .as_millis()
}

fn base36(mut n: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii digits")
}

/// A turn record as JSON text field by field. A string may carry an escape no Rust string can
/// hold — a lone surrogate, which JavaScript writes as `\ud800` — so a record is decoded only
/// field by field, as needed, and written back byte for byte except where it was set.
#[derive(Debug, Clone)]
pub struct Record(BTreeMap<String, Box<RawValue>>);

impl Record {
    pub fn parse(text: &str) -> serde_json::Result<Record> {
        serde_json::from_str(text).map(Record)
    }

    pub fn from_value(value: &Value) -> Record {
        Record::parse(&value.to_string()).expect("an object serializes to a record")
    }

    pub fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.0
            .get(key)
            .and_then(|raw| serde_json::from_str(raw.get()).ok())
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn set(&mut self, key: &str, value: Value) {
        let raw = RawValue::from_string(value.to_string()).expect("a Value serializes to JSON");
        self.0.insert(key.to_string(), raw);
    }

    pub fn without(mut self, key: &str) -> Record {
        self.0.remove(key);
        self
    }

    pub fn fields(&self) -> impl Iterator<Item = (&str, &RawValue)> {
        self.0.iter().map(|(key, raw)| (key.as_str(), &**raw))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.0).expect("raw values serialize as written")
    }
}

impl PartialEq for Record {
    fn eq(&self, other: &Record) -> bool {
        self.to_json() == other.to_json()
    }
}

pub struct Unanswered<'a> {
    pub started_at: &'a str,
    pub stop_reason: &'a str,
    pub error: &'a str,
    pub detail: &'a str,
    pub tree: f64,
}

/// A turn the agent did not record — it never started, or was killed, or died first —
/// finalized by the supervisor so that every turn a `send` started ends in the workspace's
/// turns. It answered nothing, so it read nothing: no `inboxTo`, and what it was sent stays
/// for the next turn. No `runId`, which is the agent's, and no `deliverables`, which only the
/// agent walks.
pub fn record_unanswered(ws: &Path, turn: &Unanswered) -> io::Result<()> {
    let mut record = unanswered(turn);
    record.set(TURN_ID, json!(new_turn_id()?));
    state::finalize(ws, &mut record).map_err(io::Error::other)
}

pub fn unanswered(turn: &Unanswered) -> Record {
    Record::from_value(&json!({
        "startedAt": turn.started_at,
        "endedAt": iso_now(),
        "stopReason": turn.stop_reason,
        "error": turn.error,
        "detail": turn.detail,
        "concluded": false,
        "rounds": null,
        "treeMicros": micros(turn.tree)
    }))
}

/// Dollars as the integer micro-dollars a record holds.
pub fn micros(dollars: f64) -> i64 {
    (dollars * 1_000_000.0).round() as i64
}

/// How a turn's own rounds and its cells' weigh in reasoning done, 2:1 toward the turn.
pub fn work_units(own_rounds: u64, child_rounds: u64) -> u64 {
    2 * own_rounds + child_rounds
}

/// What a turn drew, as counted where the calls went: every call in flight at its end
/// included, once they have all finished.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Settled {
    pub own: f64,
    pub tree: f64,
    pub own_rounds: u64,
    pub child_rounds: u64,
    pub cut: u64,
    /// Each precursor's spend and rounds, as its cells marked their calls: `tree` less `own` less
    /// these is what no caller named.
    pub by_precursor: BTreeMap<String, (f64, u64)>,
}

/// Now, as ECMAScript's `toISOString` writes it: `2026-09-25T12:34:56.789Z`.
pub fn iso_now() -> String {
    iso_at(millis_now())
}

fn iso_at(millis: u128) -> String {
    let secs = (millis / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        millis % 1000
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("spore-workspace-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn caps_every_file_a_child_and_its_commands_write() {
        use std::os::unix::process::CommandExt;
        let dir = scratch("fsize");
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg("head -c 4096 /dev/zero > big")
            .current_dir(&dir);
        unsafe {
            command.pre_exec(|| limit_file_size(1024));
        }
        let status = command.status().unwrap();
        assert!(!status.success());
        assert!(fs::metadata(dir.join("big")).unwrap().len() <= 1024);
    }

    #[test]
    fn a_child_and_its_commands_stand_back_from_the_host() {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg("sh -c 'cat /proc/self/oom_score_adj; nice'");
        unsafe {
            command.pre_exec(yield_to_host);
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        let values: Vec<i32> = text
            .lines()
            .map(|line| line.trim().parse().unwrap())
            .collect();
        assert!(values[0] >= AGENT_OOM_SCORE_ADJ, "{text}");
        assert!(values[1] >= AGENT_NICE, "{text}");
    }

    #[test]
    fn reads_and_writes_the_numbers_procfs_holds() {
        assert_eq!(parse_int(b"-17\n"), -17);
        assert_eq!(parse_int(b"500\n"), 500);
        let mut out = [0u8; 12];
        let len = format_int(-1000, &mut out);
        assert_eq!(&out[..len], b"-1000");
        let len = format_int(0, &mut out);
        assert_eq!(&out[..len], b"0");
    }

    #[test]
    fn names_the_holder_of_any_lock_file_held_as_the_workspace_lock_is() {
        let lock = scratch("held-at").join("jobs").join("r-1.lock");
        assert_eq!(holder_at(&lock).unwrap(), None);
        let held = hold(&lock).unwrap().expect("free");
        // As a job's supervisor does: the pid is what names the holder when `/proc/locks`,
        // read while this process's other tests take and drop locks, skips the entry.
        write_lock(&held, &json!({ "pid": std::process::id() })).unwrap();
        assert_eq!(holder_at(&lock).unwrap(), Some(std::process::id()));
        assert_eq!(
            signal_holder_at(&lock, 0).unwrap(),
            Some(std::process::id())
        );
        assert!(hold(&lock).unwrap().is_none());
        drop(held);
        assert_eq!(holder_at(&lock).unwrap(), None);
    }

    #[test]
    fn names_the_lock_holder_the_kernel_knows_and_not_the_pid_the_file_says() {
        let ws = scratch("holder");
        assert_eq!(lock_holder(&ws).unwrap(), None);
        fs::write(lock_path(&ws), r#"{"pid":1,"startedAt":"then"}"#).unwrap();
        assert_eq!(lock_holder(&ws).unwrap(), None);
        assert_eq!(signal_holder(&ws, 0).unwrap(), None);

        let held = match acquire_lock(&ws).unwrap() {
            Acquired::Held(file, _) => file,
            Acquired::Taken(why) => panic!("{why}"),
        };
        assert_eq!(lock_holder(&ws).unwrap(), Some(std::process::id()));
        assert_eq!(signal_holder(&ws, 0).unwrap(), Some(std::process::id()));
        drop(held);
        assert_eq!(lock_holder(&ws).unwrap(), None);
    }

    #[test]
    fn names_a_holder_the_listing_skipped_by_the_pid_it_wrote() {
        let ws = scratch("holder-skipped");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(lock_path(&ws))
            .unwrap();
        let named = format!(r#"{{"pid":{},"startedAt":"now"}}"#, std::process::id());
        file.write_all_at(named.as_bytes(), 0).unwrap();
        assert_eq!(
            holder_of(&lock_path(&ws), "").unwrap(),
            Some(std::process::id())
        );
        drop(file);
        assert_eq!(holder_of(&lock_path(&ws), "").unwrap(), None);
    }

    #[test]
    fn reads_a_held_flock_and_skips_a_waiter() {
        assert_eq!(
            flock_entry("1: FLOCK  ADVISORY  WRITE 4242 fd:01:917504 0 EOF"),
            Some((4242, 917504))
        );
        assert_eq!(
            flock_entry("1: -> FLOCK  ADVISORY  WRITE 4243 fd:01:917504 0 EOF"),
            None
        );
        assert_eq!(
            flock_entry("2: OFDLCK ADVISORY  READ  -1 00:1a:77 0 EOF"),
            None
        );
    }

    #[test]
    fn says_how_much_room_is_left() {
        let dir = scratch("room");
        assert!(free_bytes(&dir).unwrap() > 0);
        assert!(free_bytes(&dir.join("absent")).is_err());
    }

    #[test]
    fn writes_time_as_ecmascript_does() {
        assert_eq!(iso_at(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_at(1_790_329_990_225), "2026-09-25T09:53:10.225Z");
        assert_eq!(iso_at(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn holds_a_workspace_once() {
        let ws = scratch("lock");
        let Acquired::Held(first, held) = acquire_lock(&ws).unwrap() else {
            panic!("not held")
        };
        assert_eq!(held["pid"], std::process::id());
        assert!(
            matches!(acquire_lock(&ws).unwrap(), Acquired::Taken(ref m) if m.contains("already running — pid"))
        );
        release_lock(first).unwrap();
        assert_eq!(read_lock(&ws).unwrap(), None);
        assert!(matches!(acquire_lock(&ws).unwrap(), Acquired::Held(..)));
    }

    #[test]
    fn is_built_on_a_sqlite_with_the_wal_reset_fix() {
        assert!(
            sqlite_supported(sqlite_version()),
            "bundled SQLite {} is older than {SQLITE_MINIMUM}",
            sqlite_version()
        );
    }

    #[test]
    fn compares_sqlite_versions_as_numbers() {
        assert!(sqlite_supported("3.51.3"));
        assert!(sqlite_supported("3.53.2"));
        assert!(sqlite_supported("4.0.0"));
        assert!(!sqlite_supported("3.51.2"));
        assert!(!sqlite_supported("3.9.10"));
        assert!(!sqlite_supported("three"));
    }

    #[test]
    fn holds_a_lock_once_until_it_closes() {
        let path = scratch("hold").join("tick.lock");
        let first = hold(&path).unwrap();
        assert!(first.is_some());
        assert!(hold(&path).unwrap().is_none());
        drop(first);
        assert!(hold(&path).unwrap().is_some());
    }

    #[test]
    fn refuses_a_slot_once_all_are_held() {
        let dir = scratch("slots");
        let one = take_slot(1, &dir).unwrap().unwrap();
        let refused = take_slot(1, &dir).unwrap().unwrap_err();
        assert_eq!(refused.kind, "ADMISSION_FULL");
        drop(one);
        assert!(take_slot(1, &dir).unwrap().is_ok());
    }

    #[test]
    fn admits_no_turn_while_the_spores_are_paused_and_keeps_the_first_mark() {
        let dir = scratch("pause").join("slots");
        assert_eq!(paused(&dir).unwrap(), None);
        assert!(!unpause(&dir).unwrap());

        let (mark, already) = pause(&dir, Some("alerts storm")).unwrap();
        assert!(!already);
        assert_eq!(mark["why"], "alerts storm");
        let refused = take_slot(4, &dir).unwrap().unwrap_err();
        assert_eq!(refused.kind, "PAUSED");
        assert!(
            refused.detail.contains("(alerts storm)") && refused.detail.contains("spore unpause")
        );

        let (held, already) = pause(&dir, Some("again")).unwrap();
        assert!(already);
        assert_eq!(held, mark);

        assert!(unpause(&dir).unwrap());
        assert!(take_slot(4, &dir).unwrap().is_ok());

        fs::write(pause_path(&dir), "").unwrap();
        assert_eq!(paused(&dir).unwrap(), Some(json!({})));
        assert!(take_slot(4, &dir)
            .unwrap()
            .unwrap_err()
            .detail
            .contains("no date"));
    }

    #[test]
    fn passes_on_only_what_is_named() {
        let env = [
            ("PATH", "/usr/bin"),
            ("HOME", "/home/someone"),
            ("ANTHROPIC_API_SK", "sk"),
            ("BRAVE_API_SK", "b"),
        ];
        assert_eq!(agent_env(env).keys().collect::<Vec<_>>(), ["PATH"]);
    }

    #[test]
    fn writes_a_fresh_key_each_time() {
        let ws = scratch("key");
        let first = write_model_key(&ws).unwrap();
        let second = write_model_key(&ws).unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(ws.join(MODEL_KEY_FILE)).unwrap(), second);
    }

    #[test]
    fn roots_a_socket_at_tmp() {
        let path = broker_socket_path("model").unwrap().unwrap();
        let root = format!("/tmp/spore-{}/", unsafe { libc::getuid() });
        assert!(path.starts_with(&root) && path.ends_with(".model.sock"));
        let dir = fs::symlink_metadata(socket_root()).unwrap();
        assert!(dir.is_dir() && dir.mode() & 0o077 == 0);
        assert!(path.len() <= SUN_PATH_MAX);
    }

    #[test]
    fn gives_each_spore_a_socket_directory_of_its_own() {
        use std::os::unix::fs::PermissionsExt;
        let one = fs::canonicalize(scratch("sockets-one")).unwrap();
        let other = fs::canonicalize(scratch("sockets-other")).unwrap();
        let dir = spore_socket_dir(&one).unwrap();
        assert_eq!(dir, spore_socket_dir(&one).unwrap());
        assert_ne!(dir, spore_socket_dir(&other).unwrap());
        assert_eq!(dir.parent().unwrap(), socket_root());

        let path = spore_socket_path(&dir, "model").unwrap().unwrap();
        assert!(path.starts_with(&format!("{}/", dir.display())) && path.ends_with(".model.sock"));
        assert!(path.len() <= SUN_PATH_MAX);
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            spore_socket_path(&dir, "model").unwrap().unwrap_err().kind,
            "SOCKET_DIR_UNSAFE"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    fn contained(name: &str) -> PathBuf {
        let ws = scratch(name);
        fs::create_dir_all(ws.join("sub/dir")).unwrap();
        fs::write(ws.join("file.txt"), "hello").unwrap();
        fs::canonicalize(ws).unwrap()
    }

    #[test]
    fn resolves_paths_inside_the_workspace() {
        let ws = contained("safe-in");
        assert_eq!(
            safe_path(&ws, "file.txt", &[]).unwrap(),
            ws.join("file.txt")
        );
        assert_eq!(
            safe_path(&ws, "sub/new-file.txt", &[]).unwrap(),
            ws.join("sub/new-file.txt")
        );
        assert_eq!(
            safe_path(&ws, "a/b/c/new.txt", &[]).unwrap(),
            ws.join("a/b/c/new.txt")
        );
        assert_eq!(
            safe_path(&ws, "sub/../file.txt", &[]).unwrap(),
            ws.join("file.txt")
        );
        assert_eq!(safe_path(&ws, "..foo", &[]).unwrap(), ws.join("..foo"));
    }

    #[test]
    fn refuses_what_names_something_outside() {
        let ws = contained("safe-out");
        let kind = |p: &str| safe_path(&ws, p, &[]).unwrap_err().kind;
        assert_eq!(kind(""), "PATH_EMPTY");
        assert_eq!(kind("/etc/passwd"), "PATH_ABSOLUTE");
        assert_eq!(kind("file\0.txt"), "PATH_NULL_BYTE");
        assert_eq!(kind("../../../etc/passwd"), "PATH_ESCAPE");
    }

    #[test]
    fn follows_links_out_however_many_segments_are_missing() {
        let ws = contained("safe-links");
        let outside = scratch("safe-links-outside");
        symlink(&outside, ws.join("out-link")).unwrap();
        symlink("/etc/hostname", ws.join("escape-link")).unwrap();
        symlink(ws.join("file.txt"), ws.join("safe-link")).unwrap();
        for p in [
            "escape-link",
            "out-link/file.txt",
            "out-link/new-dir/file.txt",
            "out-link/a/b/c/file.txt",
        ] {
            assert_eq!(
                safe_path(&ws, p, &[]).unwrap_err().kind,
                "PATH_ESCAPE",
                "{p}"
            );
        }
        assert_eq!(
            safe_path(&ws, "safe-link", &[]).unwrap(),
            ws.join("file.txt")
        );
    }

    #[test]
    fn follows_a_dangling_link_rather_than_reading_it_as_missing() {
        let ws = contained("safe-dangling");
        let outside = scratch("safe-dangling-outside");
        symlink(outside.join("absent.txt"), ws.join("out-dangling")).unwrap();
        symlink(ws.join("not-yet.txt"), ws.join("in-dangling")).unwrap();
        assert_eq!(
            safe_path(&ws, "out-dangling", &[]).unwrap_err().kind,
            "PATH_ESCAPE"
        );
        assert_eq!(
            safe_path(&ws, "in-dangling", &[]).unwrap(),
            ws.join("not-yet.txt")
        );
    }

    #[test]
    fn lets_a_declared_read_out_and_nothing_else() {
        let ws = contained("safe-reads");
        let corpus = fs::canonicalize(scratch("safe-reads-corpus")).unwrap();
        fs::write(corpus.join("a.txt"), "a").unwrap();
        symlink(&corpus, ws.join("corpus")).unwrap();
        let refused = safe_path(&ws, "corpus/a.txt", &[]).unwrap_err();
        assert!(!refused.detail.contains("declares it may reach"));
        assert_eq!(
            safe_path(&ws, "corpus/a.txt", std::slice::from_ref(&corpus)).unwrap(),
            corpus.join("a.txt")
        );
        let other = safe_path(&ws, "../elsewhere", &[corpus]).unwrap_err();
        assert!(other.detail.contains("declares it may reach"));
    }

    #[test]
    fn refuses_more_read_paths_than_confine_takes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let own = system_read_paths(root).len() + 2;
        let room = CONFINE_MAX_PATHS - own;

        assert_eq!(read_paths_refusal(root, room - 2, 1, 1), None);
        let refused = read_paths_refusal(root, room - 1, 1, 1).unwrap();
        assert!(refused.contains(&format!("{} paths", CONFINE_MAX_PATHS + 1)));
        assert!(refused.contains(&format!(
            "{} it reads, 1 it writes, 1 of its plugins",
            room - 1
        )));
    }

    #[test]
    fn grants_a_directory_to_write_only_where_nothing_else_is_reached() {
        let outside = |name: &str| {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/writes-test")
                .join(format!("{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(dir).unwrap()
        };
        let root = outside("root");
        let ws = outside("ws");
        let proj = outside("proj");
        let corpus = outside("corpus");
        let named = |path: &Path| vec![("here".to_string(), path.to_path_buf())];
        let refused =
            |path: &Path, reads: &[PathBuf]| writes_refusal(&root, &ws, &named(path), reads);

        assert_eq!(refused(&proj, std::slice::from_ref(&corpus)), None);
        assert!(refused(&proj.join("missing"), &[])
            .unwrap()
            .contains("not a directory"));
        fs::write(proj.join("file"), "x").unwrap();
        assert!(refused(&proj.join("file"), &[])
            .unwrap()
            .contains("not a directory"));
        assert!(refused(&ws, &[]).unwrap().contains("own workspace"));
        assert!(refused(ws.parent().unwrap(), &[])
            .unwrap()
            .contains("own workspace"));
        assert!(refused(&scratch("writes-tmp"), &[])
            .unwrap()
            .contains("every sandbox is granted"));
        fs::create_dir_all(ws.join("data/inner")).unwrap();
        assert!(refused(&ws.join("data/inner"), &[])
            .unwrap()
            .contains("own workspace"));
        assert!(refused(&root, &[]).unwrap().contains("the runtime"));
        assert!(refused(Path::new("/usr"), &[])
            .unwrap()
            .contains("every sandbox is granted"));
        fs::create_dir_all(corpus.join("sub")).unwrap();
        assert!(refused(&corpus.join("sub"), std::slice::from_ref(&corpus))
            .unwrap()
            .contains("only reads"));
        assert!(refused(&proj, &[proj.join("docs")]).is_none());
        fs::create_dir_all(proj.join("docs")).unwrap();
        assert!(refused(&proj, &[proj.join("docs")])
            .unwrap()
            .contains("only reads"));
    }

    #[test]
    fn grants_no_model_socket_but_the_runners_broker() {
        std::env::set_var("MOHDEL_SOCKET", "/srv/spore-test-gate/gate.sock");
        let paths = system_read_paths(Path::new("/opt/spore"));
        std::env::remove_var("MOHDEL_SOCKET");
        assert!(
            paths.iter().all(|p| !p.starts_with("/srv/spore-test-gate")),
            "{paths:?}"
        );
    }

    #[test]
    fn grants_the_agent_its_islands_and_not_the_root() {
        assert_eq!(
            writable_dirs(Path::new("/w/a")),
            [
                PathBuf::from("/w/a/data"),
                PathBuf::from("/w/a/calls"),
                PathBuf::from("/w/a/precursors"),
                PathBuf::from("/w/a/home")
            ]
        );
    }

    #[test]
    fn names_the_grant_a_path_is_inside() {
        let root = fs::canonicalize(scratch("granted-root")).unwrap();
        fs::create_dir_all(root.join("work/1")).unwrap();
        assert_eq!(
            granted_path_containing(&root, &root.join("work/1"), &[]).unwrap(),
            Some(root.clone())
        );
        assert!(system_read_paths(&root).contains(&root.join("native")));
        assert!(!system_read_paths(&root).contains(&root));
        assert_eq!(
            granted_path_containing(&root, &root.join("absent"), &[])
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn finds_the_node_modules_a_package_is_installed_in() {
        let base = fs::canonicalize(scratch("hoisted")).unwrap();
        let root = base.join("node_modules/@rhizogrip/spore");
        assert_eq!(node_modules_root(&root), Some(base.join("node_modules")));
        assert_eq!(node_modules_root(&base), None);
    }

    #[test]
    fn finds_the_node_modules_of_the_workspace_a_checkout_is_in() {
        let base = fs::canonicalize(scratch("workspaces")).unwrap();
        let root = base.join("packages/spore");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(base.join("node_modules")).unwrap();
        assert_eq!(node_modules_root(&root), Some(base.join("node_modules")));
        fs::create_dir(base.join("packages/node_modules")).unwrap();
        assert_eq!(
            node_modules_root(&root),
            Some(base.join("packages/node_modules"))
        );
    }

    #[test]
    fn links_each_declared_library_once_and_refuses_a_broken_install() {
        let root = fs::canonicalize(scratch("provision-root")).unwrap();
        let ws = scratch("provision-ws");
        for name in &PROVISIONED_MODULES[1..] {
            fs::create_dir_all(root.join("node_modules").join(name)).unwrap();
        }
        let refused = provision_modules(&ws, &root).unwrap_err();
        assert_eq!(refused.kind, "PROVISION_INCOMPLETE");
        assert_eq!(unprovisioned(&root), [PROVISIONED_MODULES[0]]);
        assert!(!ws.join("node_modules").exists());

        fs::create_dir_all(root.join("node_modules").join(PROVISIONED_MODULES[0])).unwrap();
        assert_eq!(
            provision_modules(&ws, &root).unwrap().len(),
            PROVISIONED_MODULES.len()
        );
        assert!(provision_modules(&ws, &root).unwrap().is_empty());
        assert_eq!(
            fs::read_link(ws.join("node_modules/luxon")).unwrap(),
            root.join("node_modules/luxon")
        );
    }
}

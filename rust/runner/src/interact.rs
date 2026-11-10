//! The interact socket: how a turn asks a handler the operator describes for something whose result
//! comes back later. The runner stamps what the agent must not choose — the turn, the inbox entries
//! it had read, the route the answer goes to — and freezes the data the agent wrote into
//! `interactions/<id>/`, reading every file from a directory descriptor without following a link.
//! What needs the operator's config — the hash, the record, the handoff to a URL or a program — is
//! `bin/spore-interaction.js`'s, launched for each request outside the agent's confinement, the one
//! implementation `spore tick` runs too. Contract: docs/interactions.md.

use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::{json, Value};
use spore_workspace::interaction_origin;

use crate::broker::{answer, read_json, Refusal};

pub const INTERACTIONS_DIR: &str = "interactions";
const MOST_FILES: usize = 1000;
const MOST_BYTES: u64 = 16 * 1024 * 1024;
const MOST_PATH: usize = 255;
// The helper's own call to a handler gives up well before this; past it the helper is killed and
// the agent told, rather than the turn waiting on it.
const HELPER_PATIENCE: Duration = Duration::from_secs(90);

pub struct Interactions {
    pub ws: PathBuf,
    pub node: PathBuf,
    pub helper: PathBuf,
    pub most: u64,
    pub handlers: Vec<String>,
    pub env: Vec<(String, String)>,
    pub turn: RwLock<Option<String>>,
}

fn malformed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::BAD_REQUEST,
        "PROTOCOL_INVALID_REQUEST",
        "malformed interaction request",
        detail,
    )
}

fn failed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERACTION_FAILED",
        "the interaction could not be asked",
        detail,
    )
}

fn data(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::BAD_REQUEST,
        "INTERACTION_DATA",
        "the data breaks a rule",
        detail,
    )
}

pub fn chosen_route(named: Option<&str>, candidates: &[String]) -> Result<String, Refusal> {
    let listed = || candidates.join(", ");
    match (named, candidates) {
        (_, []) => Err(Refusal::new(
            StatusCode::CONFLICT,
            "INTERACTION_NO_ROUTE",
            "nothing this turn read says where the answer would go",
            "set replyTo for this spore in config.json, so an answer nobody asked for has a place to go",
        )),
        (Some(named), _) if candidates.iter().any(|c| c == named) => Ok(named.to_string()),
        (Some(named), _) => Err(Refusal::new(
            StatusCode::CONFLICT,
            "INTERACTION_ROUTES",
            format!("{named} is not where this turn may be answered"),
            format!("--route is one of {}", listed()),
        )),
        (None, [only]) => Ok(only.clone()),
        (None, _) => Err(Refusal::new(
            StatusCode::CONFLICT,
            "INTERACTION_ROUTES",
            "this turn may be answered in more than one place",
            format!("name one with --route: {}", listed()),
        )),
    }
}

fn data_dir(ws: &Path, dir: &str) -> Result<Vec<CString>, Refusal> {
    let given = Path::new(dir);
    let relative = if given.is_absolute() {
        given
            .strip_prefix(ws)
            .map_err(|_| data(format!("{dir} is not in this workspace")))?
    } else {
        given
    };
    let mut names = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => names.push(
                CString::new(name.as_encoded_bytes())
                    .map_err(|_| data(format!("{dir} holds a NUL")))?,
            ),
            Component::CurDir => {}
            _ => return Err(data(format!("{dir} is reached through .. or a root"))),
        }
    }
    if names.len() < 2 || names[0].as_bytes() != b"data" {
        return Err(data(format!(
            "{dir} is not a directory under data/ — write the data in one, as data/review/"
        )));
    }
    Ok(names)
}

fn open_at(dir: RawFd, name: &CStr, flags: i32) -> io::Result<OwnedFd> {
    // SAFETY: `name` is a NUL-terminated string that outlives the call.
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` was just opened and is owned by nothing else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn stat_of(fd: &OwnedFd) -> io::Result<libc::stat> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` is written by the kernel before it is read.
    if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded, so the struct is filled.
    Ok(unsafe { stat.assume_init() })
}

fn names_in(dir: &OwnedFd) -> io::Result<Vec<Vec<u8>>> {
    // SAFETY: a descriptor duplicated for the stream to own; the stream closes it.
    let copy = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `copy` is a directory descriptor this function owns.
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let e = io::Error::last_os_error();
        // SAFETY: fdopendir failed, so `copy` is still ours to close.
        unsafe { libc::close(copy) };
        return Err(e);
    }
    let mut names = Vec::new();
    let ended = loop {
        // SAFETY: errno is this thread's; it is cleared so the end of the stream reads as 0.
        unsafe { *libc::__errno_location() = 0 };
        // SAFETY: `stream` is open until the closedir below.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let e = io::Error::last_os_error();
            break if e.raw_os_error() == Some(0) {
                Ok(())
            } else {
                Err(e)
            };
        }
        // SAFETY: readdir returned an entry whose name is NUL-terminated.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            names.push(name.to_vec());
        }
    };
    // SAFETY: closes the stream and the descriptor it owns, once.
    unsafe { libc::closedir(stream) };
    ended?;
    names.sort();
    Ok(names)
}

struct Walk {
    files: Vec<(String, Vec<u8>)>,
    folded: HashSet<String>,
    bytes: u64,
}

fn walk(dir: &OwnedFd, prefix: &str, into: &mut Walk) -> Result<(), Refusal> {
    let unreadable = |path: &str, e: io::Error| failed(format!("cannot read {path} — {e}"));
    for name in names_in(dir).map_err(|e| unreadable(prefix, e))? {
        let text = String::from_utf8(name.clone()).map_err(|_| {
            data(format!(
                "a name in {} is not UTF-8",
                if prefix.is_empty() {
                    "the data"
                } else {
                    prefix
                }
            ))
        })?;
        let path = if prefix.is_empty() {
            text
        } else {
            format!("{prefix}/{text}")
        };
        if path.len() > MOST_PATH {
            return Err(data(format!("{path} is over {MOST_PATH} bytes")));
        }
        if !into.folded.insert(path.to_lowercase()) {
            return Err(data(format!(
                "{path} differs from another path only in case"
            )));
        }
        let name = CString::new(name).expect("a directory entry holds no NUL");
        let fd = open_at(dir.as_raw_fd(), &name, libc::O_RDONLY | libc::O_NONBLOCK).map_err(
            |e| match e.raw_os_error() {
                Some(libc::ELOOP) => data(format!("{path} is a symbolic link")),
                _ => unreadable(&path, e),
            },
        )?;
        let stat = stat_of(&fd).map_err(|e| unreadable(&path, e))?;
        match stat.st_mode & libc::S_IFMT {
            libc::S_IFDIR => walk(&fd, &path, into)?,
            libc::S_IFREG if stat.st_nlink != 1 => {
                return Err(data(format!("{path} is a hard link")))
            }
            libc::S_IFREG => {
                if into.files.len() == MOST_FILES {
                    return Err(data(format!("more than {MOST_FILES} files")));
                }
                let room = MOST_BYTES - into.bytes;
                let mut bytes = Vec::new();
                File::from(fd)
                    .take(room + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| unreadable(&path, e))?;
                if bytes.len() as u64 > room {
                    return Err(data(format!("more than {MOST_BYTES} bytes in all")));
                }
                into.bytes += bytes.len() as u64;
                into.files.push((path, bytes));
            }
            _ => {
                return Err(data(format!(
                    "{path} is neither a regular file nor a directory"
                )))
            }
        }
    }
    Ok(())
}

pub fn read_data(ws: &Path, dir: &str) -> Result<Vec<(String, Vec<u8>)>, Refusal> {
    let names = data_dir(ws, dir)?;
    let root = File::open(ws)
        .map(OwnedFd::from)
        .map_err(|e| failed(format!("cannot open {} — {e}", ws.display())))?;
    let mut at = root;
    for name in &names {
        at = open_at(at.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY).map_err(
            |e| match e.raw_os_error() {
                Some(libc::ELOOP | libc::ENOTDIR) => data(format!(
                    "{dir} is reached through something that is not a directory"
                )),
                Some(libc::ENOENT) => data(format!("{dir} does not exist")),
                _ => failed(format!("cannot open {dir} — {e}")),
            },
        )?;
    }
    let mut walked = Walk {
        files: Vec::new(),
        folded: HashSet::new(),
        bytes: 0,
    };
    walk(&at, "", &mut walked)?;
    walked
        .files
        .sort_by(|(a, _), (b, _)| a.as_bytes().cmp(b.as_bytes()));
    Ok(walked.files)
}

pub fn freeze(to: &Path, files: &[(String, Vec<u8>)]) -> io::Result<()> {
    fs::create_dir_all(to.parent().expect("frozen data has a parent"))?;
    fs::create_dir(to)?;
    for (path, bytes) in files {
        let at = to.join(path);
        fs::create_dir_all(at.parent().expect("a file of the data has a parent"))?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&at)?
            .write_all(bytes)?;
    }
    Ok(())
}

pub fn new_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    // SAFETY: getrandom writes at most `bytes.len()` bytes into it.
    let got = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if got != bytes.len() as isize {
        return Err(io::Error::last_os_error());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn is_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        })
}

fn text<'a>(body: &'a Value, field: &str) -> Result<Option<&'a str>, Refusal> {
    match &body[field] {
        Value::Null => Ok(None),
        Value::String(s) if !s.is_empty() => Ok(Some(s.as_str())),
        _ => Err(malformed(format!("{field} is a string"))),
    }
}

impl Interactions {
    pub fn begin_turn(&self, id: &str) {
        *self
            .turn
            .write()
            .expect("the turn is never written across a panic") = Some(id.to_string());
    }

    fn turn(&self) -> Result<String, Refusal> {
        self.turn
            .read()
            .expect("the turn is never written across a panic")
            .clone()
            .ok_or_else(|| failed("no turn is running"))
    }

    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let (method, path) = (req.method().clone(), req.uri().path().to_string());
        if method != Method::POST
            || !["/create", "/status", "/list", "/cancel", "/handlers"].contains(&path.as_str())
        {
            return not_found_response(&method, &path);
        }
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(refusal) => return refusal.response(),
        };
        answer(match path.as_str() {
            "/create" => self.create(&body).await,
            "/list" => self.helper(vec!["list".into()]).await,
            "/handlers" => self.helper(vec!["handlers".into()]).await,
            verb => match text(&body, "id") {
                Ok(Some(id)) if is_id(id) => {
                    self.helper(vec![verb[1..].to_string(), format!("--id={id}")])
                        .await
                }
                Ok(_) => Err(malformed(
                    "id is an interaction's id, as create answered it",
                )),
                Err(refusal) => Err(refusal),
            },
        })
    }

    async fn create(&self, body: &Value) -> Result<Value, Refusal> {
        let handler = text(body, "handler")?
            .ok_or_else(|| malformed("handler is the name of a handler this spore may ask"))?
            .to_string();
        if !self.handlers.contains(&handler) {
            return Err(Refusal::new(
                StatusCode::FORBIDDEN,
                "INTERACTION_HANDLER",
                format!("this spore is not granted the handler {handler}"),
                format!(
                    "it may ask {} — interactions.handlers in spore.cmk says which",
                    self.handlers.join(", ")
                ),
            ));
        }
        let dir = text(body, "dir")?
            .ok_or_else(|| malformed("dir is the data's directory under data/"))?
            .to_string();
        let (route, key, supersedes, expires) = (
            text(body, "route")?,
            text(body, "key")?,
            text(body, "supersedes")?,
            text(body, "expires")?,
        );
        if supersedes.is_some_and(|s| !is_id(s)) {
            return Err(malformed("supersedes is an interaction's id"));
        }
        let turn = self.turn()?;
        let (inbox, candidates) = interaction_origin(&self.ws, &turn)
            .map_err(|e| failed(format!("cannot read what this turn read — {e}")))?;
        let route = chosen_route(route, &candidates)?;
        let id = new_id().map_err(|e| failed(format!("cannot make an id — {e}")))?;
        let ws = self.ws.clone();
        let to = self.ws.join(INTERACTIONS_DIR).join(&id);
        tokio::task::spawn_blocking(move || {
            let files = read_data(&ws, &dir)?;
            freeze(&to, &files).map_err(|e| failed(format!("cannot keep the data — {e}")))
        })
        .await
        .map_err(|e| failed(e.to_string()))??;
        let origin = json!({ "turnId": turn, "inbox": inbox }).to_string();
        let mut args = vec![
            "create".to_string(),
            format!("--handler={handler}"),
            format!("--id={id}"),
            format!("--route={route}"),
            format!("--origin={origin}"),
            format!("--most={}", self.most),
        ];
        for (flag, value) in [
            ("key", key),
            ("supersedes", supersedes),
            ("expires", expires),
        ] {
            if let Some(value) = value {
                args.push(format!("--{flag}={value}"));
            }
        }
        self.helper(args).await
    }

    async fn helper(&self, args: Vec<String>) -> Result<Value, Refusal> {
        let mut command = tokio::process::Command::new(&self.node);
        command
            .arg(&self.helper)
            .args(args)
            .arg(format!("--ws={}", self.ws.display()))
            .arg(format!(
                "--handlers={}",
                serde_json::to_string(&self.handlers).expect("a list of names serializes")
            ))
            .env_clear()
            .envs(self.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|e| failed(format!("cannot start its helper — {e}")))?;
        let output = tokio::time::timeout(HELPER_PATIENCE, child.wait_with_output())
            .await
            .map_err(|_| {
                failed(format!(
                    "its helper did not answer within {}s",
                    HELPER_PATIENCE.as_secs()
                ))
            })?
            .map_err(|e| failed(format!("its helper could not be read — {e}")))?;
        let line = String::from_utf8_lossy(&output.stdout);
        let said: Value = serde_json::from_str(line.trim()).map_err(|_| {
            failed(format!(
                "its helper answered {:?}, not one JSON line — {}",
                line.trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        })?;
        let refused = &said["refused"];
        if refused.is_null() {
            return Ok(said);
        }
        let (Some(status), Some(kind), Some(message), Some(detail)) = (
            refused["status"]
                .as_u64()
                .and_then(|s| StatusCode::from_u16(s as u16).ok()),
            refused["type"].as_str(),
            refused["message"].as_str(),
            refused["detail"].as_str(),
        ) else {
            return Err(failed(format!(
                "its helper refused it in a shape it does not answer in — {refused}"
            )));
        };
        Err(Refusal::new(status, kind, message, detail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spore-interact-{name}-{}", new_id().unwrap()));
        fs::create_dir_all(dir.join("data")).unwrap();
        dir
    }

    fn kind(result: Result<Vec<(String, Vec<u8>)>, Refusal>) -> String {
        result
            .map(|_| "ok".to_string())
            .unwrap_or_else(|r| r.detail)
    }

    #[test]
    fn stamps_the_one_route_or_the_one_named_and_refuses_the_rest() {
        let two = ["telegram:main/42".to_string(), "discord:ops/7".into()];
        assert_eq!(chosen_route(None, &two[..1]).unwrap(), "telegram:main/42");
        assert_eq!(
            chosen_route(Some("discord:ops/7"), &two).unwrap(),
            "discord:ops/7"
        );
        assert_eq!(
            chosen_route(None, &two).unwrap_err().kind,
            "INTERACTION_ROUTES"
        );
        assert_eq!(
            chosen_route(Some("telegram:main/9"), &two)
                .unwrap_err()
                .kind,
            "INTERACTION_ROUTES"
        );
        assert_eq!(
            chosen_route(Some("telegram:main/42"), &[])
                .unwrap_err()
                .kind,
            "INTERACTION_NO_ROUTE"
        );
    }

    #[test]
    fn reads_every_regular_file_under_data_in_path_order() {
        let ws = scratch("read");
        let dir = ws.join("data/review");
        fs::create_dir_all(dir.join("app/b")).unwrap();
        fs::write(dir.join("changes.json"), "{}").unwrap();
        fs::write(dir.join("app/index.html"), "<p>").unwrap();
        fs::write(dir.join("app/b/z.js"), "1").unwrap();
        fs::write(dir.join("Z.txt"), "z").unwrap();
        let files = read_data(&ws, "data/review").unwrap();
        let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            ["Z.txt", "app/b/z.js", "app/index.html", "changes.json"]
        );
        assert_eq!(read_data(&ws, &dir.display().to_string()).unwrap(), files);
        let to = ws.join(INTERACTIONS_DIR).join("one");
        freeze(&to, &files).unwrap();
        assert_eq!(fs::read(to.join("app/b/z.js")).unwrap(), b"1");
        assert!(freeze(&to, &files).is_err());
    }

    #[test]
    fn refuses_data_outside_data_or_holding_anything_but_plain_files() {
        let ws = scratch("refuse");
        let dir = ws.join("data/p");
        fs::create_dir_all(&dir).unwrap();
        assert!(read_data(&ws, "data/p").unwrap().is_empty());
        fs::write(dir.join("a.json"), "{}").unwrap();
        assert_eq!(kind(read_data(&ws, "data/p")), "ok");
        for outside in ["data", "home/p", "data/../data/p", "/etc"] {
            assert_eq!(
                read_data(&ws, outside).unwrap_err().kind,
                "INTERACTION_DATA",
                "{outside}"
            );
        }

        std::os::unix::fs::symlink("/etc/passwd", dir.join("passwd")).unwrap();
        assert!(kind(read_data(&ws, "data/p")).contains("symbolic link"));
        fs::remove_file(dir.join("passwd")).unwrap();

        fs::write(ws.join("outside"), "x").unwrap();
        fs::hard_link(ws.join("outside"), dir.join("linked")).unwrap();
        assert!(kind(read_data(&ws, "data/p")).contains("hard link"));
        fs::remove_file(dir.join("linked")).unwrap();

        std::os::unix::fs::symlink(&dir, ws.join("data/via")).unwrap();
        assert!(kind(read_data(&ws, "data/via")).contains("not a directory"));

        fs::write(dir.join("a.txt"), "a").unwrap();
        fs::write(dir.join("A.TXT"), "a").unwrap();
        assert!(kind(read_data(&ws, "data/p")).contains("only in case"));
        fs::remove_file(dir.join("A.TXT")).unwrap();

        fs::create_dir_all(dir.join("x".repeat(200))).unwrap();
        fs::write(dir.join("x".repeat(200)).join("y".repeat(60)), "a").unwrap();
        assert!(kind(read_data(&ws, "data/p")).contains("over 255 bytes"));
    }

    #[test]
    fn bounds_how_many_files_and_bytes_the_data_holds() {
        let ws = scratch("bounds");
        let dir = ws.join("data/many");
        fs::create_dir_all(&dir).unwrap();
        for n in 0..=MOST_FILES {
            fs::write(dir.join(format!("{n:04}")), "").unwrap();
        }
        assert!(kind(read_data(&ws, "data/many")).contains("more than 1000 files"));

        let dir = ws.join("data/big");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("big"), vec![0u8; MOST_BYTES as usize]).unwrap();
        assert_eq!(kind(read_data(&ws, "data/big")), "ok");
        fs::write(dir.join("more"), "a").unwrap();
        assert!(kind(read_data(&ws, "data/big")).contains("bytes in all"));
    }

    #[test]
    fn makes_ids_the_socket_takes_back() {
        let id = new_id().unwrap();
        assert!(is_id(&id), "{id}");
        assert_eq!(&id[14..15], "4");
        assert!(!is_id("--ws=/elsewhere"));
        assert!(!is_id(&id.to_uppercase()));
    }
}

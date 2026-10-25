//! The enzyme broker: runs a precursor's enzymes on a confined cell's behalf. The enzymes live
//! in the parent's tree, which the cell cannot reach; the cell names one through `enzyme.js` and
//! this runs it, with the supervisor's privileges, in the cell's workspace.
//!
//! `POST /run?enzyme=<name>&arg=<a>&arg=<b>` — the request body is the enzyme's stdin, and the
//! response is NDJSON: `stdout` and `stderr` events carrying base64, then one `exit`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use base64::Engine;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body as HttpBody, Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::broker::Refusal;

pub const HASH_LEN: usize = 16;
pub const MAX_ARGS: usize = 64;

pub fn hash_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Some(hex[..HASH_LEN].to_string())
}

/// An enzyme is its program and what the precursor says it needs beside itself (`<enzyme>.with`),
/// so an edited helper is as much a changed enzyme as an edited entry. Each item is labelled
/// by its position and its path within itself, so the hash does not depend on where the
/// tree sits.
pub fn hash_enzyme(command: &Path, with: &[PathBuf]) -> Option<String> {
    if with.is_empty() {
        return hash_file(command);
    }
    fn feed(hasher: &mut Sha256, path: &Path, label: &str) -> Option<()> {
        if path.is_dir() {
            let mut entries: Vec<_> = std::fs::read_dir(path)
                .ok()?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<Result<_, _>>()
                .ok()?;
            entries.sort();
            for name in entries {
                let inner = format!("{label}/{}", name.to_string_lossy());
                feed(hasher, &path.join(&name), &inner)?;
            }
        } else {
            let bytes = std::fs::read(path).ok()?;
            hasher.update(label.as_bytes());
            hasher.update([0]);
            hasher.update((bytes.len() as u64).to_be_bytes());
            hasher.update(&bytes);
        }
        Some(())
    }
    let mut hasher = Sha256::new();
    feed(&mut hasher, command, "0")?;
    for (at, item) in with.iter().enumerate() {
        feed(&mut hasher, item, &(at + 1).to_string())?;
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(hex[..HASH_LEN].to_string())
}

pub struct Enzyme {
    pub name: String,
    pub command: PathBuf,
    pub with: Vec<PathBuf>,
    pub hash: String,
}

pub struct Enzymes {
    enzymes: HashMap<String, Enzyme>,
    cwd: PathBuf,
    live: Mutex<HashMap<u64, u32>>,
    next: AtomicU64,
}

/// A running enzyme, terminated when its caller goes away before it has finished: nothing is
/// waiting for its output, and left running it would hold the broker open past shutdown.
struct Running {
    pid: u32,
    done: AtomicBool,
}

impl Running {
    fn terminate(&self) {
        if !self.done.load(Ordering::SeqCst) {
            unsafe { libc::kill(self.pid as i32, libc::SIGTERM) };
        }
    }
}

struct Events {
    rx: mpsc::Receiver<Bytes>,
    running: Arc<Running>,
}

impl HttpBody for Events {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.rx
            .poll_recv(cx)
            .map(|event| event.map(|line| Ok(Frame::data(line))))
    }
}

impl Drop for Events {
    fn drop(&mut self) {
        self.running.terminate();
    }
}

fn event(kind: &str, data: &[u8]) -> Bytes {
    Bytes::from(
        json!({ "type": kind, "data": base64::engine::general_purpose::STANDARD.encode(data) })
            .to_string()
            + "\n",
    )
}

async fn relay(mut pipe: impl AsyncRead + Unpin, kind: &'static str, tx: mpsc::Sender<Bytes>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(event(kind, &buf[..n])).await.is_err() {
                    break;
                }
            }
        }
    }
}

impl Enzymes {
    pub fn new(enzymes: Vec<Enzyme>, cwd: PathBuf) -> Arc<Enzymes> {
        Arc::new(Enzymes {
            enzymes: enzymes.into_iter().map(|t| (t.name.clone(), t)).collect(),
            cwd,
            live: Mutex::default(),
            next: AtomicU64::new(0),
        })
    }

    pub fn stop(&self) {
        for pid in self.live.lock().expect("live").values() {
            unsafe { libc::kill(*pid as i32, libc::SIGKILL) };
        }
    }

    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        if req.method() != Method::POST || req.uri().path() != "/run" {
            return not_found_response(req.method(), req.uri().path());
        }
        match self.run(req) {
            Ok(answered) => answered,
            Err(refusal) => refusal.response(),
        }
    }

    fn run(self: &Arc<Self>, req: Request<Incoming>) -> Result<Response<Body>, Refusal> {
        let mut named = None;
        let mut args = Vec::new();
        for (key, value) in url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        {
            match key.as_ref() {
                "enzyme" => named = Some(value.into_owned()),
                "arg" => args.push(value.into_owned()),
                _ => {}
            }
        }
        let Some(named) = named.filter(|n| !n.is_empty()) else {
            return Err(Refusal::new(
                StatusCode::BAD_REQUEST,
                "PROTOCOL_INVALID_REQUEST",
                "no enzyme named",
                "POST /run?enzyme=<name>&arg=<a>…",
            ));
        };
        if args.len() > MAX_ARGS {
            return Err(Refusal::new(
                StatusCode::BAD_REQUEST,
                "ENZYME_TOO_MANY_ARGS",
                format!("{named} was given {} arguments", args.len()),
                format!("an enzyme takes at most {MAX_ARGS}"),
            ));
        }
        let Some(enzyme) = self.enzymes.get(&named) else {
            return Err(Refusal::new(
                StatusCode::NOT_FOUND,
                "ENZYME_UNKNOWN",
                format!("unknown enzyme: {named}"),
                "",
            ));
        };
        // The cell was told about the program that was there when it started. Answers from
        // an edited one would come from another program with nothing saying which — the
        // kind of wrong that reads as right. Coherence, not access: the parent could always
        // change the file.
        match hash_enzyme(&enzyme.command, &enzyme.with) {
            None => {
                return Err(Refusal::new(
                    StatusCode::CONFLICT,
                    "ENZYME_GONE",
                    format!(
                        "{} is gone — it was {} when this cell started",
                        enzyme.name, enzyme.hash
                    ),
                    if enzyme.with.is_empty() {
                        ""
                    } else {
                        "the program, or something it needs beside itself"
                    },
                ))
            }
            Some(now) if now != enzyme.hash => {
                return Err(Refusal::new(
                    StatusCode::CONFLICT,
                    "ENZYME_CHANGED",
                    format!(
                        "{} changed since this cell started ({} → {now}) — it is no longer the program the cell was told about",
                        enzyme.name, enzyme.hash
                    ),
                    "",
                ))
            }
            Some(_) => {}
        }

        let mut child = Command::new(&enzyme.command)
            .args(&args)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "ENZYME_START_FAILED",
                    format!("cannot run {}: {e}", enzyme.name),
                    "",
                )
            })?;
        let pid = child.id().expect("a child just spawned has a pid");
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.live.lock().expect("live").insert(id, pid);
        let running = Arc::new(Running {
            pid,
            done: AtomicBool::new(false),
        });

        // A body that fails rather than ends is a caller that went away. Once the enzyme stops
        // reading, the rest is drained rather than refused: a caller still writing would
        // otherwise lose the connection, and with it the exit code on its way back.
        let mut body = req.into_body();
        let mut stdin = child.stdin.take();
        let caller = running.clone();
        tokio::spawn(async move {
            while let Some(frame) = body.frame().await {
                let Ok(frame) = frame else {
                    caller.terminate();
                    break;
                };
                let (Ok(data), Some(pipe)) = (frame.into_data(), stdin.as_mut()) else {
                    continue;
                };
                if pipe.write_all(&data).await.is_err() {
                    stdin = None;
                }
            }
        });

        let (tx, rx) = mpsc::channel(16);
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let enzymes = self.clone();
        let finished = running.clone();
        tokio::spawn(async move {
            let out = tokio::spawn(relay(stdout, "stdout", tx.clone()));
            let err = tokio::spawn(relay(stderr, "stderr", tx.clone()));
            let status = child.wait().await;
            let _ = out.await;
            let _ = err.await;
            finished.done.store(true, Ordering::SeqCst);
            enzymes.live.lock().expect("live").remove(&id);
            let code = status.ok().and_then(|s| s.code()).unwrap_or(137);
            let _ = tx
                .send(Bytes::from(
                    json!({ "type": "exit", "code": code }).to_string() + "\n",
                ))
                .await;
        });

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/x-ndjson")
            .body(Events { rx, running }.boxed())
            .expect("a static response builds"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use crate::broker::serve;

    const KEY: &str = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Scene {
        dir: PathBuf,
    }

    impl Drop for Scene {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Scene {
        fn new() -> Scene {
            let dir = PathBuf::from(format!(
                "/tmp/spore-enzymes-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("enzymes")).unwrap();
            Scene { dir }
        }

        fn script(&self, name: &str, body: &str) -> PathBuf {
            let path = self.dir.join("enzymes").join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn serve(&self, names: &[&str], cwd: &Path) -> (Arc<Enzymes>, PathBuf) {
            let enzymes = names
                .iter()
                .map(|name| {
                    let command = self.dir.join("enzymes").join(name);
                    Enzyme {
                        name: name.to_string(),
                        hash: hash_file(&command).unwrap(),
                        command,
                        with: Vec::new(),
                    }
                })
                .collect();
            let enzymes = Enzymes::new(enzymes, cwd.to_path_buf());
            let socket = self.dir.join("t.sock");
            let _ = std::fs::remove_file(&socket);
            let served = enzymes.clone();
            serve(&socket, KEY.to_string(), move |req| {
                served.clone().route(req)
            })
            .unwrap();
            (enzymes, socket)
        }

        fn client(&self, keyed: bool) -> PathBuf {
            if keyed {
                self.staged("keyed", Some(KEY))
            } else {
                self.staged("another", Some(&"j".repeat(KEY.len())))
            }
        }

        fn staged(&self, name: &str, key: Option<&str>) -> PathBuf {
            let at = self.dir.join(name);
            std::fs::create_dir_all(&at).unwrap();
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            std::fs::copy(
                repo.join("packages/spore/bin/enzyme.js"),
                at.join("enzyme.js"),
            )
            .unwrap();
            if let Some(key) = key {
                std::fs::write(at.join("tree.key"), key).unwrap();
            }
            at.join("enzyme.js")
        }
    }

    struct Called {
        code: i32,
        stdout: Vec<u8>,
        stderr: String,
    }

    impl Called {
        fn out(&self) -> String {
            String::from_utf8_lossy(&self.stdout).into_owned()
        }
    }

    fn start(client: &Path, socket: &str, args: &[&str]) -> tokio::process::Child {
        tokio::process::Command::new("node")
            .arg(client)
            .args(args)
            .env("SPORE_ENZYMES", socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("node is on PATH")
    }

    async fn call(client: &Path, socket: &Path, args: &[&str], input: &[u8]) -> Called {
        call_on(client, &socket.display().to_string(), args, input).await
    }

    async fn call_on(client: &Path, socket: &str, args: &[&str], input: &[u8]) -> Called {
        let mut child = start(client, socket, args);
        let mut stdin = child.stdin.take().unwrap();
        let input = input.to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
        });
        let output = child.wait_with_output().await.unwrap();
        Called {
            code: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    #[test]
    fn hashes_a_file_the_way_call_records_do_and_says_when_it_is_gone() {
        let scene = Scene::new();
        let a = scene.script("a", "echo same");
        let b = scene.script("b", "echo same");
        assert_eq!(hash_file(&a).unwrap().len(), HASH_LEN);
        assert_eq!(hash_file(&a), hash_file(&b));
        assert_eq!(hash_file(&scene.dir.join("absent")), None);
    }

    #[test]
    fn an_enzyme_changes_when_what_it_needs_changes() {
        let scene = Scene::new();
        let entry = scene.dir.join("entry.mjs");
        let lib = scene.dir.join("lib");
        std::fs::write(&entry, "import './lib/palette.mjs'").unwrap();
        std::fs::create_dir_all(lib.join("deep")).unwrap();
        std::fs::write(lib.join("palette.mjs"), "export const red = 1").unwrap();
        std::fs::write(lib.join("deep").join("more.mjs"), "x").unwrap();
        let with = vec![lib.clone()];

        let was = hash_enzyme(&entry, &with).unwrap();
        assert_eq!(hash_enzyme(&entry, &with).unwrap(), was);
        std::fs::write(lib.join("deep").join("more.mjs"), "y").unwrap();
        assert_ne!(hash_enzyme(&entry, &with).unwrap(), was);
        std::fs::remove_dir_all(lib.join("deep")).unwrap();
        assert_ne!(hash_enzyme(&entry, &with).unwrap(), was);
        std::fs::remove_file(lib.join("palette.mjs")).unwrap();
        std::fs::remove_dir(&lib).unwrap();
        assert_eq!(hash_enzyme(&entry, &with), None);
        assert_eq!(hash_enzyme(&entry, &[]), hash_file(&entry));
    }

    #[tokio::test]
    async fn delivers_every_byte_to_a_slow_reader_before_reporting_success() {
        let scene = Scene::new();
        let data: Vec<u8> = (0..1024 * 1024).map(|i| (i * 7 % 256) as u8).collect();
        let blob = scene.dir.join("blob.bin");
        std::fs::write(&blob, &data).unwrap();
        scene.script("dump", &format!("cat '{}'", blob.display()));
        let (_, socket) = scene.serve(&["dump"], &scene.dir);

        let mut child = start(
            &scene.client(true),
            &socket.display().to_string(),
            &["dump"],
        );
        drop(child.stdin.take());
        let mut stdout = child.stdout.take().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let mut delivered = Vec::new();
        stdout.read_to_end(&mut delivered).await.unwrap();
        let status = child.wait().await.unwrap();

        assert_eq!(status.code(), Some(0));
        assert_eq!(delivered.len(), data.len());
        assert!(
            delivered == data,
            "the bytes arrived, but not as they were written"
        );
    }

    #[tokio::test]
    async fn runs_an_enzyme_by_name_and_returns_its_stdout() {
        let scene = Scene::new();
        scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);
        let r = call(&scene.client(true), &socket, &["wordcount"], b"a\nb\nc\n").await;
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert_eq!(r.out().trim(), "3");
    }

    #[tokio::test]
    async fn keeps_stdout_and_stderr_apart_and_passes_the_exit_code_through() {
        let scene = Scene::new();
        scene.script("noisy", "echo out-here\necho err-here >&2\nexit 3");
        let (_, socket) = scene.serve(&["noisy"], &scene.dir);
        let r = call(&scene.client(true), &socket, &["noisy"], b"").await;
        assert_eq!(r.out().trim(), "out-here");
        assert_eq!(r.stderr.trim(), "err-here");
        assert_eq!(r.code, 3);
    }

    #[tokio::test]
    async fn carries_bytes_that_are_not_text() {
        let scene = Scene::new();
        scene.script("binary", "printf '\\000\\377\\200'");
        let (_, socket) = scene.serve(&["binary"], &scene.dir);
        let r = call(&scene.client(true), &socket, &["binary"], b"").await;
        assert_eq!(r.code, 0, "{}", r.stderr);
        assert_eq!(r.stdout, vec![0, 255, 128]);
    }

    #[tokio::test]
    async fn refuses_an_enzyme_that_changed_under_a_running_cell() {
        let scene = Scene::new();
        let command = scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);
        let client = scene.client(true);
        assert_eq!(
            call(&client, &socket, &["wordcount"], b"a\nb\n")
                .await
                .out()
                .trim(),
            "2"
        );

        std::fs::write(&command, "#!/bin/sh\necho 99\n").unwrap();
        let after = call(&client, &socket, &["wordcount"], b"a\nb\n").await;
        assert_eq!(after.code, 127);
        assert!(
            after
                .stderr
                .contains("wordcount changed since this cell started"),
            "{}",
            after.stderr
        );
        assert!(after.stdout.is_empty());
    }

    #[tokio::test]
    async fn refuses_an_enzyme_that_was_deleted_under_a_running_cell() {
        let scene = Scene::new();
        let command = scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);
        std::fs::remove_file(&command).unwrap();
        let after = call(&scene.client(true), &socket, &["wordcount"], b"").await;
        assert_eq!(after.code, 127);
        assert!(
            after.stderr.contains("wordcount is gone"),
            "{}",
            after.stderr
        );
    }

    #[tokio::test]
    async fn runs_an_enzyme_where_the_cell_is_so_a_path_means_what_the_cell_means() {
        let scene = Scene::new();
        let cell = scene.dir.join("cell");
        std::fs::create_dir_all(&cell).unwrap();
        std::fs::write(scene.dir.join("marker.txt"), "parent\n").unwrap();
        std::fs::write(cell.join("marker.txt"), "cell\n").unwrap();
        scene.script("readmarker", "cat \"$1\"");
        let (_, socket) = scene.serve(&["readmarker"], &cell);
        let r = call(
            &scene.client(true),
            &socket,
            &["readmarker", "marker.txt"],
            b"",
        )
        .await;
        assert_eq!(r.out(), "cell\n");
    }

    #[tokio::test]
    async fn serves_only_callers_holding_this_trees_key() {
        let scene = Scene::new();
        scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);

        let another = call(&scene.client(false), &socket, &["wordcount"], b"a\n").await;
        assert_eq!(another.code, 127);
        assert!(
            another.stderr.contains("not this tree"),
            "{}",
            another.stderr
        );

        let unstaged = call(
            &scene.staged("unstaged", None),
            &socket,
            &["wordcount"],
            b"a\n",
        )
        .await;
        assert_eq!(unstaged.code, 2);
        assert!(
            unstaged.stderr.contains("no tree.key beside"),
            "{}",
            unstaged.stderr
        );

        let keyed = call(&scene.client(true), &socket, &["wordcount"], b"a\nb\n").await;
        assert_eq!(keyed.code, 0, "{}", keyed.stderr);
        assert_eq!(keyed.out().trim(), "2");
    }

    #[tokio::test]
    async fn forwards_arguments_as_argv_never_as_a_shell() {
        let scene = Scene::new();
        scene.script("echoargs", "printf '%s|' \"$@\"");
        let (_, socket) = scene.serve(&["echoargs"], &scene.dir);
        let r = call(
            &scene.client(true),
            &socket,
            &["echoargs", "one", "; rm -rf /", "$(whoami)", "a&b=c"],
            b"",
        )
        .await;
        assert_eq!(r.out(), "one|; rm -rf /|$(whoami)|a&b=c|");
    }

    #[tokio::test]
    async fn refuses_an_enzyme_that_is_not_granted_or_named_by_path() {
        let scene = Scene::new();
        scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);
        let client = scene.client(true);
        for name in ["notgranted", "/bin/sh"] {
            let r = call(&client, &socket, &[name], b"").await;
            assert_eq!(r.code, 127);
            assert!(
                r.stderr.contains(&format!("unknown enzyme: {name}")),
                "{}",
                r.stderr
            );
        }
    }

    #[tokio::test]
    async fn keeps_the_refusal_code_when_the_caller_was_still_sending_stdin() {
        let scene = Scene::new();
        scene.script("wordcount", "wc -l");
        let (_, socket) = scene.serve(&["wordcount"], &scene.dir);
        let r = call(
            &scene.client(true),
            &socket,
            &["nope"],
            &vec![b'x'; 256 * 1024],
        )
        .await;
        assert_eq!(r.code, 127);
        assert!(r.stderr.contains("unknown enzyme: nope"), "{}", r.stderr);
        assert!(!r.stderr.contains("cannot reach"), "{}", r.stderr);
    }

    #[tokio::test]
    async fn refuses_more_arguments_than_an_enzyme_takes_rather_than_dropping_some() {
        let scene = Scene::new();
        scene.script("echoargs", "printf '%s|' \"$@\"");
        let (_, socket) = scene.serve(&["echoargs"], &scene.dir);
        let mut args = vec!["echoargs"];
        args.extend(std::iter::repeat("x").take(MAX_ARGS + 1));
        let r = call(&scene.client(true), &socket, &args, b"").await;
        assert_eq!(r.code, 127);
        assert!(r.stderr.contains("65 arguments"), "{}", r.stderr);
        assert!(r.stdout.is_empty());
    }

    #[tokio::test]
    async fn tells_a_caller_with_no_broker_what_is_wrong() {
        let scene = Scene::new();
        let client = scene.client(true);
        let absent = scene.dir.join("absent.sock").display().to_string();
        let r = call_on(&client, &absent, &["wordcount"], b"").await;
        assert_eq!(r.code, 2);
        assert!(
            r.stderr.contains("cannot reach the enzyme broker"),
            "{}",
            r.stderr
        );

        let r = call_on(&client, "", &["wordcount"], b"").await;
        assert_eq!(r.code, 2);
        assert!(
            r.stderr.contains("no enzymes are available here"),
            "{}",
            r.stderr
        );
    }

    async fn until(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..200 {
            if check() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    #[tokio::test]
    async fn terminates_an_enzyme_whose_caller_went_away() {
        let scene = Scene::new();
        scene.script("lingering", "echo $$ > \"$1\"\nexec sleep 30");
        let (enzymes, socket) = scene.serve(&["lingering"], &scene.dir);
        let pidfile = scene.dir.join("pid");
        let mut caller = start(
            &scene.client(true),
            &socket.display().to_string(),
            &["lingering", &pidfile.display().to_string()],
        );
        assert!(until(|| std::fs::read_to_string(&pidfile).is_ok_and(|p| p.ends_with('\n'))).await);
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        caller.kill().await.unwrap();

        assert!(until(|| unsafe { libc::kill(pid, 0) } != 0).await);
        assert!(until(|| enzymes.live.lock().unwrap().is_empty()).await);
    }

    #[tokio::test]
    async fn stops_every_running_enzyme_when_the_supervisor_leaves() {
        let scene = Scene::new();
        scene.script("lingering", "exec sleep 30");
        let (enzymes, socket) = scene.serve(&["lingering"], &scene.dir);
        let caller = start(
            &scene.client(true),
            &socket.display().to_string(),
            &["lingering"],
        );
        assert!(until(|| !enzymes.live.lock().unwrap().is_empty()).await);

        enzymes.stop();

        let output = caller.wait_with_output().await.unwrap();
        assert_eq!(output.status.code(), Some(137));
    }
}

//! Waiting on a confined child with the supervisor's own bounds: a signal is passed on, the
//! definition's hard wall holds even when the child is stuck where its own timer cannot reach,
//! and a child that does not stop within the grace after being asked is killed — with every
//! process it started, since the tools it runs sit in process groups of their own and only a
//! child that can still run its abort handler stops them. The lock and the admission slot are
//! the supervisor's, so they are released however the child ends — and only once nothing the
//! turn started is still running: everything the child starts carries the supervisor's token
//! in `SPORE_OWNERS`, and what carries it when the child is gone is killed, re-parented or not.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::signal::unix::Signal;
use tokio::sync::watch;
use tokio::time::{sleep, Instant};

use spore_workspace::crash_asked;
pub use spore_workspace::kept::{kept_from, kept_refusal, Kept};
pub use spore_workspace::owners::{owner_token, owners_with, sweep, OWNERS};

pub const GRACE: Duration = Duration::from_secs(5);

fn confine(root: &Path) -> PathBuf {
    root.join("build").join("Release").join("confine")
}

/// `program` started through spore's `confine`, under the syscall filter every confined process
/// gets, and with `contain` in namespaces of its own, seeing only the processes it starts and
/// only the `kept` directory of each it hides; it applies its own Landlock. `root` is the spore
/// package.
pub fn confined(root: &Path, program: impl AsRef<OsStr>, contain: bool, kept: &[Kept]) -> Command {
    let mut command = Command::new(confine(root));
    if contain {
        command.arg("--contain");
        for k in kept {
            command.arg("--hide").arg(&k.hide);
            if let Some(keep) = &k.keep {
                command.arg("--keep").arg(keep);
            }
        }
    }
    command.arg("--no-landlock").arg("--").arg(program);
    command
}

/// Why this host cannot give a turn namespaces of its own, as `confine --contain-check` says,
/// or none when it can.
pub fn contain_refused(root: &Path) -> Option<String> {
    if crash_asked("contain-check") {
        return Some("refused for a test".into());
    }
    match std::process::Command::new(confine(root))
        .arg("--contain-check")
        .output()
    {
        Ok(checked) if checked.status.success() => None,
        Ok(checked) => Some(String::from_utf8_lossy(&checked.stdout).trim().to_string()),
        Err(e) => Some(format!("cannot run confine — {e}")),
    }
}

/// What a turn refused for want of containment is told, `why` being the step the host refused.
pub fn uncontained(why: &str) -> String {
    format!("this host cannot give a turn namespaces of its own ({why}), so the turn would see every other spore's processes — allow unprivileged user namespaces for spore's confine, or spore config set contain off when no one else's spores run as this user")
}

pub struct Ended {
    pub status: std::io::Result<ExitStatus>,
    pub signalled: bool,
    pub walled: bool,
    pub killed: bool,
}

impl Ended {
    /// How the turn ended, for a supervisor writing it down because its child could not: the
    /// stop reason, the error, and what happened. `told` is where the child's own account went.
    pub fn account(&self, told: &str) -> (&'static str, &'static str, String) {
        let stop_reason = match (self.walled, self.signalled) {
            (true, _) => "hard:wall",
            (false, true) => "cancelled",
            _ => "error",
        };
        if self.killed {
            return (
                stop_reason,
                "KILLED",
                format!(
                    "the agent did not stop within {} s of being asked, and was killed",
                    GRACE.as_secs()
                ),
            );
        }
        let how = match &self.status {
            Ok(status) => status.to_string(),
            Err(e) => e.to_string(),
        };
        (
            stop_reason,
            "AGENT_EXITED",
            format!("the agent ended ({how}) without recording its turn — {told}"),
        )
    }
}

fn send(child: &Child, signal: i32) {
    if let Some(pid) = child.id() {
        unsafe { libc::kill(pid as i32, signal) };
    }
}

/// Parent links from `/proc/*/stat`, which every Linux has, rather than `children`, which
/// depends on how the kernel was built. The command name sits between the first `(` and the
/// last `)` and may hold either, so the fields are read after the last one.
fn parents() -> HashMap<i32, Vec<i32>> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return children;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(after) = stat.rfind(')').map(|at| &stat[at + 1..]) else {
            continue;
        };
        if let Some(parent) = after
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.parse::<i32>().ok())
        {
            children.entry(parent).or_default().push(pid);
        }
    }
    children
}

fn descendants(root: i32) -> Vec<i32> {
    let children = parents();
    let mut found = Vec::new();
    let mut next = vec![root];
    while let Some(pid) = next.pop() {
        for &child in children.get(&pid).into_iter().flatten() {
            found.push(child);
            next.push(child);
        }
    }
    found
}

/// Freezes the child, then each descendant as it is found — a stopped process cannot fork, so
/// the walk ends with the whole tree — and kills them all. What escaped the tree before this,
/// a daemon that double-forked to init, is out of reach without OS containment.
fn kill_tree(root: i32) {
    unsafe { libc::kill(root, libc::SIGSTOP) };
    let mut frozen: HashSet<i32> = HashSet::new();
    loop {
        let fresh: Vec<i32> = descendants(root)
            .into_iter()
            .filter(|pid| !frozen.contains(pid))
            .collect();
        if fresh.is_empty() {
            break;
        }
        for pid in fresh {
            unsafe { libc::kill(pid, libc::SIGSTOP) };
            frozen.insert(pid);
        }
    }
    for pid in frozen {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    unsafe { libc::kill(root, libc::SIGKILL) };
}

enum Woke {
    Signal,
    Wall,
    Grace,
    Raised,
    Unraisable,
}

pub async fn supervise(
    child: &mut Child,
    token: &str,
    wall: Duration,
    mut raised: Option<watch::Receiver<Duration>>,
    grace: Duration,
    sigterm: &mut Signal,
    sigint: &mut Signal,
    who: &str,
) -> Ended {
    let started = Instant::now();
    let past_wall = sleep(wall + grace);
    tokio::pin!(past_wall);
    let asked = sleep(Duration::from_secs(u32::MAX as u64));
    tokio::pin!(asked);
    let (mut signalled, mut walled, mut killed, mut asking) = (false, false, false, false);
    let status = loop {
        let woke = tokio::select! {
            status = child.wait() => break status,
            _ = sigterm.recv() => Woke::Signal,
            _ = sigint.recv() => Woke::Signal,
            _ = &mut past_wall, if !walled => Woke::Wall,
            _ = &mut asked, if asking => Woke::Grace,
            changed = async { raised.as_mut().expect("guarded").changed().await }, if raised.is_some() && !walled => {
                if changed.is_ok() { Woke::Raised } else { Woke::Unraisable }
            }
        };
        match woke {
            Woke::Raised => {
                let wall = *raised.as_mut().expect("guarded").borrow_and_update();
                past_wall.as_mut().reset(started + wall + grace);
            }
            Woke::Unraisable => raised = None,
            Woke::Signal | Woke::Wall => {
                if matches!(woke, Woke::Wall) {
                    walled = true;
                    eprintln!(
                        "{who}: the turn ran {} s past its hard wall — stopping it",
                        grace.as_secs_f64()
                    );
                } else {
                    signalled = true;
                }
                send(child, libc::SIGTERM);
                if !asking {
                    asking = true;
                    asked.as_mut().reset(Instant::now() + grace);
                }
            }
            Woke::Grace => {
                asking = false;
                killed = true;
                eprintln!(
                    "{who}: killed after {} s, with every process it started — it did not stop when asked, so it wrote no turn record",
                    grace.as_secs_f64()
                );
                if let Some(pid) = child.id() {
                    kill_tree(pid as i32);
                }
            }
        }
    };
    let left = sweep(token);
    if left > 0 {
        eprintln!("{who}: stopped {left} processes the turn left running");
    }
    Ended {
        status,
        signalled,
        walled,
        killed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;
    use tokio::signal::unix::{signal, SignalKind};

    #[test]
    fn hides_a_directory_outright_and_refuses_one_that_is_not_there() {
        let dir = std::env::temp_dir().join(format!("spore-hidden-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let given = serde_json::json!([{ "plugin": "cs", "hide": dir }]).to_string();
        let kept = kept_from(&given).unwrap();
        assert_eq!(kept[0].keep, None);
        assert_eq!(kept_refusal(&kept, true), None);
        let args: Vec<_> = confined(Path::new("/spore"), "agent", true, &kept)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "--contain",
                "--hide",
                dir.to_str().unwrap(),
                "--no-landlock",
                "--",
                "agent"
            ]
        );

        std::fs::remove_dir_all(&dir).unwrap();
        let absent = kept_refusal(&kept, true).unwrap();
        assert!(
            absent.contains("plugin cs hides")
                && absent.ends_with("drop cs from plugins: in its spore.cmk"),
            "{absent}"
        );
    }

    fn stubborn() -> Child {
        Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 0.05; done")
            .spawn()
            .unwrap()
    }

    #[tokio::test]
    async fn kills_a_child_that_ignores_the_wall_once_the_grace_has_passed() {
        let mut child = stubborn();
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();
        let started = Instant::now();
        let ended = supervise(
            &mut child,
            &owner_token(),
            Duration::from_millis(100),
            None,
            Duration::from_millis(200),
            &mut term,
            &mut int,
            "test",
        )
        .await;
        assert!(ended.walled && ended.killed && !ended.signalled);
        assert!(ended.status.unwrap().code().is_none());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn moves_its_wall_when_the_owner_raises_it() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 0.6; exit 4")
            .spawn()
            .unwrap();
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();
        let (raise, raised) = watch::channel(Duration::from_millis(100));
        tokio::spawn(async move {
            sleep(Duration::from_millis(50)).await;
            raise.send(Duration::from_secs(5)).unwrap();
        });
        let ended = supervise(
            &mut child,
            &owner_token(),
            Duration::from_millis(100),
            Some(raised),
            Duration::from_millis(200),
            &mut term,
            &mut int,
            "test",
        )
        .await;
        assert!(!ended.walled && !ended.killed && !ended.signalled);
        assert_eq!(ended.status.unwrap().code(), Some(4));
    }

    #[tokio::test]
    async fn waits_out_a_child_that_ends_within_its_wall() {
        let mut child = Command::new("sh").arg("-c").arg("exit 3").spawn().unwrap();
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();
        let ended = supervise(
            &mut child,
            &owner_token(),
            Duration::from_secs(60),
            None,
            GRACE,
            &mut term,
            &mut int,
            "test",
        )
        .await;
        assert!(!ended.walled && !ended.killed && !ended.signalled);
        assert_eq!(ended.status.unwrap().code(), Some(3));
    }

    #[tokio::test]
    async fn kills_what_a_stuck_child_started_in_a_session_of_its_own() {
        let marker = std::env::temp_dir().join(format!("spore-supervise-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "setsid sleep 60 & echo $! > '{}'; trap '' TERM; while :; do sleep 0.05; done",
                marker.display()
            ))
            .spawn()
            .unwrap();
        while std::fs::read_to_string(&marker).map_or(true, |s| s.trim().is_empty()) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let grandchild: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();

        let ended = supervise(
            &mut child,
            &owner_token(),
            Duration::from_millis(100),
            None,
            Duration::from_millis(200),
            &mut term,
            &mut int,
            "test",
        )
        .await;

        assert!(ended.killed);
        let deadline = Instant::now() + Duration::from_secs(3);
        while unsafe { libc::kill(grandchild, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "the grandchild outlived the kill"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = std::fs::remove_file(&marker);
    }

    #[tokio::test]
    async fn sweeps_what_the_turn_left_running_even_once_it_has_been_orphaned() {
        let token = owner_token();
        let marker = std::env::temp_dir().join(format!("spore-sweep-{token}"));
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 60 & echo $! > '{}'", marker.display()))
            .env(OWNERS, format!("elsewhere:{token}"))
            .spawn()
            .unwrap();
        let bystander = Command::new("sleep")
            .arg("60")
            .env_remove(OWNERS)
            .spawn()
            .unwrap();
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();

        let ended = supervise(
            &mut child,
            &token,
            Duration::from_secs(60),
            None,
            GRACE,
            &mut term,
            &mut int,
            "test",
        )
        .await;

        assert_eq!(ended.status.unwrap().code(), Some(0));
        let orphan: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while unsafe { libc::kill(orphan, 0) } == 0 {
            assert!(Instant::now() < deadline, "the orphan outlived the sweep");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let bystander_pid = bystander.id().unwrap() as i32;
        assert_eq!(
            unsafe { libc::kill(bystander_pid, 0) },
            0,
            "a process without the token was swept"
        );
        unsafe { libc::kill(bystander_pid, libc::SIGKILL) };
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn appends_its_token_to_what_it_was_started_under() {
        assert!(owners_with("abc").ends_with("abc"));
    }
}

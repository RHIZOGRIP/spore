//! Which processes belong to whom: everything a supervisor starts carries its token in
//! `SPORE_OWNERS`, and what still carries it when the supervisor lets go is killed, re-parented
//! or not. The runner and `spore-spawn` sweep a turn's; a job's supervisor sweeps its job's.

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;

pub const OWNERS: &str = "SPORE_OWNERS";

/// A token naming one turn's processes, unique on this host.
pub fn owner_token() -> String {
    crate::random_hex(16).expect("getrandom filled the token")
}

/// `SPORE_OWNERS` for a child: what this process was started under, and this turn's token.
pub fn owners_with(token: &str) -> String {
    match std::env::var(OWNERS) {
        Ok(held) if !held.is_empty() => format!("{held}:{token}"),
        _ => token.to_string(),
    }
}

fn carries(pid: i32, token: &str) -> bool {
    let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    environ
        .split(|b| *b == 0)
        .filter_map(|entry| entry.strip_prefix(format!("{OWNERS}=").as_bytes()))
        .any(|owners| owners.split(|b| *b == b':').any(|t| t == token.as_bytes()))
}

fn owned(token: &str) -> Vec<i32> {
    let (me, uid) = (std::process::id() as i32, unsafe { libc::getuid() });
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<i32>().ok()?;
            let mine = entry.metadata().ok()?.uid() == uid;
            (pid != me && mine && carries(pid, token)).then_some(pid)
        })
        .collect()
}

/// Every process still carrying `token`, frozen as it is found and then killed. What cleared
/// its environment and left the tree as well is out of reach without a cgroup per turn.
pub fn sweep(token: &str) -> usize {
    let mut frozen: HashSet<i32> = HashSet::new();
    loop {
        let fresh: Vec<i32> = owned(token)
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
    for &pid in &frozen {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    frozen.len()
}

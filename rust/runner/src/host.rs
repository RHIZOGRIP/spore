//! The flags the host gives the runner and a cell outside any turn alike, as `hostFlags` in
//! `send.js` builds them: the Node and the mohdel helpers they run, whether to contain, what the spore's plugins keep in view of a contained process, the gate, and when a model call is cut.

use std::path::PathBuf;
use std::time::Duration;

use spore_workspace::kept::{kept_from, Kept};
use spore_workspace::DEFAULT_CALL_CEILING_SECS;

#[derive(Debug, Default)]
pub struct HostArgs {
    pub node: Option<String>,
    pub session: Option<String>,
    pub chatgpt_helper: Option<String>,
    pub no_contain: bool,
    pub kept: Vec<Kept>,
    pub gate: Option<PathBuf>,
    pub call_ceiling: Option<Duration>,
}

impl HostArgs {
    /// Whether `name` is one of the host's flags, read with `value` when it takes one; the error
    /// says why a value cannot be read.
    pub fn take(&mut self, name: &str, value: impl FnOnce() -> String) -> Result<bool, String> {
        match name {
            "--node" => self.node = Some(value()),
            "--session" => self.session = Some(value()),
            "--chatgpt-helper" => self.chatgpt_helper = Some(value()),
            "--no-contain" => self.no_contain = true,
            "--contain-keep" => self.kept = kept_from(&value())?,
            "--gate" => self.gate = Some(PathBuf::from(value())),
            "--call-ceiling" => {
                let given = value();
                self.call_ceiling = Some(match given.parse::<u64>() {
                    Ok(secs) if secs >= 1 => Duration::from_secs(secs),
                    _ => {
                        return Err(format!(
                            "--call-ceiling is a number of seconds from 1 — got {given}"
                        ))
                    }
                })
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    /// How long a model call may run before it is cut as stalled.
    pub fn call_ceiling(&self) -> Duration {
        self.call_ceiling
            .unwrap_or(Duration::from_secs(DEFAULT_CALL_CEILING_SECS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(given: &[&str]) -> Result<HostArgs, String> {
        let mut host = HostArgs::default();
        let mut rest = given.iter();
        while let Some(name) = rest.next() {
            let taken = host.take(name, || rest.next().expect("a value").to_string())?;
            assert!(taken, "{name}");
        }
        Ok(host)
    }

    #[test]
    fn reads_every_flag_the_host_gives_both() {
        let host = read(&[
            "--node",
            "/usr/bin/node",
            "--session",
            "s",
            "--chatgpt-helper",
            "c",
            "--no-contain",
            "--contain-keep",
            "[]",
            "--gate",
            "/run/gate.sock",
            "--call-ceiling",
            "10800",
        ])
        .unwrap();
        assert_eq!(host.node.as_deref(), Some("/usr/bin/node"));
        assert!(host.no_contain && host.kept.is_empty());
        assert_eq!(host.gate, Some(PathBuf::from("/run/gate.sock")));
        assert_eq!(host.call_ceiling(), Duration::from_secs(3 * 60 * 60));
        assert_eq!(
            HostArgs::default().call_ceiling(),
            Duration::from_secs(60 * 60)
        );
    }

    #[test]
    fn leaves_a_flag_that_is_not_the_host_s_and_refuses_one_it_cannot_read() {
        assert_eq!(
            HostArgs::default().take("--ws", || unreachable!()),
            Ok(false)
        );
        assert!(read(&["--contain-keep", "{"]).is_err());
        assert!(read(&["--call-ceiling", "0"]).is_err());
        assert!(read(&["--call-ceiling", "1h"]).is_err());
    }
}

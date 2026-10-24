//! The flags the host gives the runner and a cell outside any turn alike, as `hostFlags` in
//! `send.js` builds them: the Node and the mohdel helpers they run, whether to contain, what the spore's plugins keep in view of a contained process, and the gate.

use std::path::PathBuf;

use spore_workspace::kept::{kept_from, Kept};

#[derive(Debug, Default)]
pub struct HostArgs {
    pub node: Option<String>,
    pub session: Option<String>,
    pub chatgpt_helper: Option<String>,
    pub no_contain: bool,
    pub kept: Vec<Kept>,
    pub gate: Option<PathBuf>,
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
            _ => return Ok(false),
        }
        Ok(true)
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
        ])
        .unwrap();
        assert_eq!(host.node.as_deref(), Some("/usr/bin/node"));
        assert!(host.no_contain && host.kept.is_empty());
        assert_eq!(host.gate, Some(PathBuf::from("/run/gate.sock")));
    }

    #[test]
    fn leaves_a_flag_that_is_not_the_host_s_and_refuses_one_it_cannot_read() {
        assert_eq!(
            HostArgs::default().take("--ws", || unreachable!()),
            Ok(false)
        );
        assert!(read(&["--contain-keep", "{"]).is_err());
    }
}

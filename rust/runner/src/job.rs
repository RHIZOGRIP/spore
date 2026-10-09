//! The job socket: how a turn starts work that outlives it. The runner only launches —
//! `bin/spore-job.js`, detached, outside the agent's confinement and without the turn's owner
//! token, so ending the turn leaves it — and passes back the one line it answers: the job begun,
//! or why not. Everything after is the job supervisor's. Contract: ARCHITECTURE.md, "Jobs".

use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::Value;
use spore_workspace::{limit_file_size, yield_to_host};

use crate::broker::{answer, read_json, Refusal};

pub struct Jobs {
    pub ws: PathBuf,
    pub node: PathBuf,
    pub supervisor: PathBuf,
    pub count: u64,
    pub wall_ms: f64,
    pub env: Vec<(String, String)>,
    pub largest_file: u64,
}

fn malformed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::BAD_REQUEST,
        "PROTOCOL_INVALID_REQUEST",
        "malformed job request",
        detail,
    )
}

fn failed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "JOB_START_FAILED",
        "the job could not be started",
        detail,
    )
}

/// What a job supervisor is started with, named rather than filtered, as an agent's is: where to
/// find the host's config and state, and the tracing endpoint. No credential — it reads the
/// operator's environment file when it releases what the job said, as the services do — and no
/// owner token or trace context: the job is nobody's turn.
const SUPERVISOR_PASSED: [&str; 10] = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "OTEL_INIT_TIMEOUT_MS",
];

pub fn supervisor_env(env: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    env.filter(|(name, _)| SUPERVISOR_PASSED.contains(&name.as_str()))
        .collect()
}

impl Jobs {
    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let (method, path) = (req.method().clone(), req.uri().path().to_string());
        if method != Method::POST || path != "/start" {
            return not_found_response(&method, &path);
        }
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(refusal) => return refusal.response(),
        };
        let jobs = self.clone();
        answer(
            tokio::task::spawn_blocking(move || jobs.start(&body))
                .await
                .unwrap_or_else(|e| Err(failed(e.to_string()))),
        )
    }

    fn start(&self, body: &Value) -> Result<Value, Refusal> {
        let name = body["name"]
            .as_str()
            .ok_or_else(|| malformed("name is a string"))?;
        let command = body["command"]
            .as_str()
            .filter(|c| !c.trim().is_empty())
            .ok_or_else(|| malformed("command is the shell command the job runs"))?;
        let largest_file = self.largest_file;
        let mut launch = Command::new(&self.node);
        launch
            .arg(&self.supervisor)
            .arg("--ws")
            .arg(&self.ws)
            .arg("--name")
            .arg(name)
            .arg("--count")
            .arg(self.count.to_string())
            .arg("--wall")
            .arg(self.wall_ms.to_string())
            .arg("--command")
            .arg(command)
            .env_clear()
            .envs(self.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: between fork and exec only `setsid`, `setrlimit`, `setpriority` and
        // `open`/`read`/`write` on procfs run, all async-signal-safe, with nothing allocated.
        unsafe {
            launch.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                limit_file_size(largest_file)?;
                yield_to_host()
            });
        }
        let mut child = launch.spawn().map_err(|e| failed(e.to_string()))?;
        let stdout = child.stdout.take().expect("piped");
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line);
        std::thread::spawn(move || child.wait());
        read.map_err(|e| failed(format!("its supervisor could not be read — {e}")))?;
        let said: Value = serde_json::from_str(line.trim()).map_err(|_| {
            failed(format!(
                "its supervisor answered {:?}, not one JSON line",
                line.trim()
            ))
        })?;
        let refused = &said["refused"];
        if refused.is_null() {
            return Ok(said);
        }
        let (Some(kind), Some(message), Some(detail)) = (
            refused["type"].as_str(),
            refused["message"].as_str(),
            refused["detail"].as_str(),
        ) else {
            return Err(failed(format!(
                "its supervisor refused it in a shape it does not answer in — {refused}"
            )));
        };
        Err(Refusal::new(StatusCode::CONFLICT, kind, message, detail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spore_workspace::owners::OWNERS;

    #[test]
    fn gives_a_supervisor_no_credential_owner_token_or_trace_context() {
        let env = supervisor_env(
            [
                ("PATH", "/usr/bin"),
                (OWNERS, "a:b"),
                ("TRACEPARENT", "00-x"),
                ("ANTHROPIC_API_KEY", "k"),
                ("XDG_STATE_HOME", "/s"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string())),
        );
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["PATH", "XDG_STATE_HOME"]);
    }
}

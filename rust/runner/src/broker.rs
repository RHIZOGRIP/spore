//! What every socket the runner and a cell's supervisor serve has in common: the tree key on each
//! request, typed refusals in mohdel's error shape, and JSON bodies. The model, store, source,
//! job and enzymes sockets differ only in their routes.

use std::convert::Infallible;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::client::conn::http1 as client;
use hyper::header::HeaderValue;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use mohdel_thin_gate::prelude::{typed_error_response, Body, Severity};
use serde_json::Value;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;

pub const KEY_HEADER: &str = "x-spore-key";

const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: StatusCode,
    pub kind: String,
    pub message: String,
    pub detail: String,
    pub retryable: bool,
}

impl Refusal {
    pub fn new(
        status: StatusCode,
        kind: &str,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Refusal {
        Refusal {
            status,
            kind: kind.to_string(),
            message: message.into(),
            detail: detail.into(),
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Refusal {
        self.retryable = true;
        self
    }

    pub fn response(&self) -> Response<Body> {
        refuse(
            self.status,
            &self.message,
            &self.detail,
            &self.kind,
            self.retryable,
        )
    }
}

pub fn accepts(key: &str, given: Option<&HeaderValue>) -> bool {
    let Some(given) = given else { return false };
    let (a, b) = (given.as_bytes(), key.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn refuse(
    status: StatusCode,
    message: &str,
    detail: &str,
    kind: &str,
    retryable: bool,
) -> Response<Body> {
    typed_error_response(status, Severity::Error, message, detail, kind, retryable)
}

pub fn json_response(status: StatusCode, value: &Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(value.to_string())).boxed())
        .expect("a static response builds")
}

pub fn answer(result: Result<Value, Refusal>) -> Response<Body> {
    match result {
        Ok(value) => json_response(StatusCode::OK, &value),
        Err(refusal) => refusal.response(),
    }
}

pub async fn read_json(req: Request<Incoming>) -> Result<Value, Refusal> {
    let body = Limited::new(req.into_body(), MAX_REQUEST_BYTES)
        .collect()
        .await
        .map_err(|e| {
            Refusal::new(
                StatusCode::BAD_REQUEST,
                "PROTOCOL_READ_BODY",
                "the request body could not be read",
                e.to_string(),
            )
        })?
        .to_bytes();
    serde_json::from_slice(&body).map_err(|e| {
        Refusal::new(
            StatusCode::BAD_REQUEST,
            "PROTOCOL_INVALID_REQUEST",
            "the request body is not JSON",
            e.to_string(),
        )
    })
}

/// One JSON request to a socket the runner serves, presenting `key`; a refusal comes back as
/// the typed error it was sent as.
pub async fn ask(socket: &Path, key: &str, route: &str, body: &Value) -> Result<Value, Refusal> {
    let unreachable = |e: String| {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "BROKER_UNREACHABLE",
            format!("{} is unreachable", socket.display()),
            e,
        )
    };
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|e| unreachable(e.to_string()))?;
    let (mut sender, connection) = client::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| unreachable(e.to_string()))?;
    tokio::spawn(connection);
    let request = Request::post(route)
        .header("host", "spore")
        .header("content-type", "application/json")
        .header(KEY_HEADER, key)
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("a static request builds");
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| unreachable(e.to_string()))?;
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|e| unreachable(e.to_string()))?
        .to_bytes();
    let answered: Value = serde_json::from_slice(&bytes).map_err(|e| {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "BROKER_FAILED",
            format!("{route} answered with what is not JSON"),
            e.to_string(),
        )
    })?;
    if status == StatusCode::OK {
        return Ok(answered);
    }
    let field = |name: &str| answered[name].as_str().unwrap_or_default().to_string();
    Err(Refusal {
        status,
        kind: field("type"),
        message: field("message"),
        detail: field("detail"),
        retryable: answered["retryable"].as_bool().unwrap_or(false),
    })
}

/// A socket being served, and the way to stop it: `stop` refuses new connections, drops the
/// ones open — a call in flight is cut off with its connection — and removes the socket file.
/// Dropping the handle without stopping leaves the socket served for the life of the process.
pub struct Served {
    pub path: PathBuf,
    stopping: watch::Sender<bool>,
}

impl Served {
    pub fn stop(self) {
        let _ = self.stopping.send(true);
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn stopped(mut stopping: watch::Receiver<bool>) {
    if stopping.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await
    }
}

pub fn serve<R, F>(path: &Path, key: String, route: R) -> std::io::Result<Served>
where
    R: Fn(Request<Incoming>) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    let listener = UnixListener::bind(path)?;
    let key: Arc<str> = key.into();
    let (stopping, watching) = watch::channel(false);
    tokio::spawn(async move {
        loop {
            let stream = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => break,
                },
                _ = stopped(watching.clone()) => break,
            };
            let (key, route, watching) = (key.clone(), route.clone(), watching.clone());
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let (key, route) = (key.clone(), route.clone());
                    async move {
                        if !accepts(&key, req.headers().get(KEY_HEADER)) {
                            return Ok::<_, Infallible>(refuse(
                                StatusCode::UNAUTHORIZED,
                                "not this tree",
                                "a request presents its tree's key",
                                "BROKER_UNAUTHORIZED",
                                false,
                            ));
                        }
                        Ok(route(req).await)
                    }
                });
                let connection =
                    http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                tokio::select! {
                    _ = connection => {}
                    _ = stopped(watching) => {}
                }
            });
        }
    });
    Ok(Served {
        path: path.to_path_buf(),
        stopping,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_its_own_key() {
        let key = "k".repeat(64);
        let ours = HeaderValue::from_str(&"k".repeat(64)).unwrap();
        let other = HeaderValue::from_str(&"j".repeat(64)).unwrap();
        let short = HeaderValue::from_str("k").unwrap();
        assert!(accepts(&key, Some(&ours)));
        assert!(!accepts(&key, Some(&other)));
        assert!(!accepts(&key, Some(&short)));
        assert!(!accepts(&key, None));
    }

    #[tokio::test]
    async fn stops_a_socket_cutting_off_what_is_in_flight_and_refusing_what_comes_after() {
        let path = std::env::temp_dir().join(format!("spore-served-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let key = "k".repeat(64);
        let served = serve(&path, key.clone(), |_req| async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            json_response(StatusCode::OK, &serde_json::json!({}))
        })
        .unwrap();

        let in_flight = {
            let (path, key) = (path.clone(), key.clone());
            tokio::spawn(async move { ask(&path, &key, "/slow", &serde_json::json!({})).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        served.stop();

        let cut = tokio::time::timeout(std::time::Duration::from_secs(5), in_flight)
            .await
            .expect("the call in flight ends when the socket stops")
            .unwrap();
        assert_eq!(cut.unwrap_err().kind, "BROKER_UNREACHABLE");
        assert!(!path.exists());
        let refused = ask(&path, &key, "/slow", &serde_json::json!({})).await;
        assert_eq!(refused.unwrap_err().kind, "BROKER_UNREACHABLE");
    }
}

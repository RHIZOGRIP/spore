//! The vector store a spore's `memory: vectors` keeps its index in, reached over http or https
//! with the protocol ARCHITECTURE §The vector store protocol documents: create a collection,
//! fetch which ids it holds, upsert records, query by vector. Where the store is, the headers that carry its
//! credential, and its paths come from the host's `memory.json`; the credential never leaves
//! this process.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use spore_definition::fill_variables;

use crate::broker::Refusal;
use crate::dial::{https_client, socket_path, Dial};

pub const MEMORY_FILE: &str = "memory.json";
pub const MAX_RECORDS: usize = 256;
pub const MAX_TOP_K: u64 = 50_000;
pub const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const ENVELOPE_BYTES: usize = r#"{"records":[]}"#.len();
const ATTEMPTS: u32 = 6;
pub const TIMEOUT: Duration = Duration::from_secs(30);
const COLLECTION: &str = "{collection}";

pub type Paused = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type Pause = Arc<dyn Fn(Duration) -> Paused + Send + Sync>;

/// Where each operation is, `{collection}` standing for the collection's id in the three that
/// act on one.
#[derive(Clone, Debug, PartialEq)]
pub struct Paths {
    pub ready: String,
    pub create: String,
    pub fetch: String,
    pub upsert: String,
    pub query: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            ready: "/health/ready".into(),
            create: "/v1/collections".into(),
            fetch: "/v1/collections/{collection}/records:fetch".into(),
            upsert: "/v1/collections/{collection}/records:upsert".into(),
            query: "/v1/collections/{collection}/query".into(),
        }
    }
}

/// The host's `memory.json`: `url`, and each optional — `socket`, the unix socket the store is
/// reached on instead of the url's host, `headers` (`${VAR}` filled from the runner's
/// environment), `paths`, and `collectionField`, the field of a create's body that names the
/// collection. Absent paths and field are the protocol's own.
#[derive(Clone, Debug)]
pub struct Config {
    pub url: String,
    pub socket: Option<PathBuf>,
    pub headers: Vec<(String, String)>,
    pub paths: Paths,
    pub collection_field: String,
}

impl Config {
    pub fn load(file: &Path, env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let raw = std::fs::read_to_string(file).map_err(|e| format!("{} — {e}", file.display()))?;
        Config::parse(&file.display().to_string(), &raw, env)
    }

    pub fn parse(
        where_: &str,
        raw: &str,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Config, String> {
        let given: Map<String, Value> = match serde_json::from_str(raw) {
            Ok(Value::Object(given)) => given,
            Ok(_) => {
                return Err(format!(
                    "{where_} holds {{ url, socket?, headers?, paths?, collectionField? }}"
                ))
            }
            Err(e) => return Err(format!("{where_} is not readable JSON — {e}")),
        };
        if let Some(unknown) = given.keys().find(|k| {
            !["url", "socket", "headers", "paths", "collectionField"].contains(&k.as_str())
        }) {
            return Err(format!("{where_} has \"{unknown}\", which is not one of url, socket, headers, paths, collectionField"));
        }
        let text = |value: &Value, what: &str| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{where_}: {what} is a string"))
        };
        let url = text(given.get("url").unwrap_or(&Value::Null), "url")?;
        let parsed =
            url::Url::parse(&url).map_err(|e| format!("{where_}: {url} is not a url — {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!(
                "{where_}: {url} — the store is reached over http or https"
            ));
        }
        let socket = match given.get("socket") {
            None => None,
            Some(value) => {
                let raw = text(value, "socket")?;
                let filled = fill_variables(&raw, &env).map_err(|variable| {
                    format!("{where_}: socket wants ${variable}, which is not set for the runner")
                })?;
                Some(socket_path(&filled, &parsed).map_err(|why| format!("{where_}: {why}"))?)
            }
        };

        let mut headers = Vec::new();
        if let Some(given) = given.get("headers") {
            let given = given
                .as_object()
                .ok_or_else(|| format!("{where_}: headers is {{ name: value }}"))?;
            for (name, value) in given {
                let value = text(value, &format!("headers.{name}"))?;
                let filled = fill_variables(&value, &env).map_err(|variable| {
                    format!("{where_}: headers.{name} wants ${variable}, which is not set for the runner")
                })?;
                headers.push((name.clone(), filled));
            }
        }

        let mut paths = Paths::default();
        if let Some(given) = given.get("paths") {
            let given = given.as_object().ok_or_else(|| {
                format!("{where_}: paths is {{ ready?, create?, fetch?, upsert?, query? }}")
            })?;
            for (name, value) in given {
                let path = text(value, &format!("paths.{name}"))?;
                if !path.starts_with('/') {
                    return Err(format!("{where_}: paths.{name} is a path, starting with /"));
                }
                let names_one = matches!(name.as_str(), "fetch" | "upsert" | "query");
                if names_one && !path.contains(COLLECTION) {
                    return Err(format!(
                        "{where_}: paths.{name} acts on one collection, so it holds {COLLECTION}"
                    ));
                }
                let slot = match name.as_str() {
                    "ready" => &mut paths.ready,
                    "create" => &mut paths.create,
                    "fetch" => &mut paths.fetch,
                    "upsert" => &mut paths.upsert,
                    "query" => &mut paths.query,
                    _ => {
                        return Err(format!(
                        "{where_}: paths.{name} is not one of ready, create, fetch, upsert, query"
                    ))
                    }
                };
                *slot = path;
            }
        }

        let collection_field = match given.get("collectionField") {
            None => "collection".to_string(),
            Some(value) => text(value, "collectionField")?,
        };
        Ok(Config {
            url: parsed.as_str().trim_end_matches('/').to_string(),
            socket,
            headers,
            paths,
            collection_field,
        })
    }
}

pub struct VectorStore {
    config: Config,
    dial: Dial,
    pause: Pause,
    timeout: Duration,
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn idempotency_for(parts: &[&str]) -> String {
    sha256_hex(&parts.join(" "))[..32].to_string()
}

fn path_segment(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Two 503s with different clocks: a collection another caller is activating clears in
/// milliseconds, `CAPACITY_EXCEEDED` only when some other caller finishes its work.
fn backoff(attempt: u32, code: Option<&str>) -> Duration {
    let step = if code == Some("CAPACITY_EXCEEDED") {
        400
    } else {
        50
    };
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 50)
        .unwrap_or(0);
    Duration::from_millis(2u64.pow(attempt) * step + jitter as u64)
}

fn invalid(kind: &str, message: String, detail: &str) -> Refusal {
    Refusal::new(StatusCode::BAD_REQUEST, kind, message, detail)
}

fn assert_unique(ids: &[&str], what: &str) -> Result<(), Refusal> {
    let mut seen = HashSet::new();
    let mut repeated: Vec<&str> = Vec::new();
    for id in ids {
        if !seen.insert(*id) && !repeated.contains(id) {
            repeated.push(id);
        }
    }
    if repeated.is_empty() {
        return Ok(());
    }
    Err(invalid(
        "STORE_DUPLICATE_ID",
        format!(
            "{what} names the same id twice: {}",
            repeated.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
        ),
        "a collection takes each id once; collapse them before sending rather than letting the store refuse the batch",
    ))
}

/// Contiguous batches within both of the protocol's limits, 256 records and 8 MiB encoded: a
/// 1536-dimension vector serialises to about 25 KB, so 256 of them sit at the byte ceiling.
pub fn batches_of(records: Vec<Value>) -> Result<Vec<Vec<Value>>, Refusal> {
    let mut batches = Vec::new();
    let mut batch: Vec<Value> = Vec::new();
    let mut bytes = ENVELOPE_BYTES;
    for record in records {
        let size = record.to_string().len();
        if size + ENVELOPE_BYTES > MAX_REQUEST_BYTES {
            return Err(invalid(
                "STORE_RECORD_TOO_LARGE",
                "one record is larger than the whole request limit".into(),
                &format!("{size} bytes against a {MAX_REQUEST_BYTES} byte ceiling"),
            ));
        }
        let separator = usize::from(!batch.is_empty());
        if batch.len() == MAX_RECORDS || bytes + size + separator > MAX_REQUEST_BYTES {
            batches.push(std::mem::take(&mut batch));
            bytes = ENVELOPE_BYTES;
        }
        bytes += size + usize::from(!batch.is_empty());
        batch.push(record);
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

fn describe_failure(status: StatusCode, body: &[u8], operation: &str) -> Refusal {
    let parsed = serde_json::from_slice::<Value>(body).ok();
    let error = parsed.as_ref().map(|v| &v["error"]);
    let code = error.and_then(|e| e["code"].as_str());
    let message = error
        .and_then(|e| e["message"].as_str())
        .or(status.canonical_reason())
        .unwrap_or("");
    let retryable = matches!(status.as_u16(), 503 | 504);
    let refusal = Refusal::new(
        if retryable {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::BAD_GATEWAY
        },
        code.unwrap_or("STORE_FAILED"),
        format!("the vector store's {operation} failed: {message}"),
        format!("HTTP {}", status.as_u16()),
    );
    if retryable {
        refusal.retryable()
    } else {
        refusal
    }
}

impl VectorStore {
    pub fn new(config: Config) -> VectorStore {
        let dial = match &config.socket {
            Some(path) => Dial::Socket(path.clone()),
            None => Dial::Net(https_client()),
        };
        VectorStore {
            config,
            dial,
            pause: Arc::new(|d: Duration| -> Paused { Box::pin(tokio::time::sleep(d)) }),
            timeout: TIMEOUT,
        }
    }

    pub fn url(&self) -> &str {
        &self.config.url
    }

    #[cfg(test)]
    pub(crate) fn with_timeout(mut self, timeout: Duration) -> VectorStore {
        self.timeout = timeout;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_pause(mut self, pause: Pause) -> VectorStore {
        self.pause = pause;
        self
    }

    fn on(template: &str, collection: &str) -> String {
        template.replace(COLLECTION, &path_segment(collection))
    }

    fn request(&self, method: Method, path: &str) -> hyper::http::request::Builder {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.config.url));
        for (name, value) in &self.config.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        req
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency: Option<String>,
        operation: &str,
    ) -> Result<Option<Value>, Refusal> {
        let payload = body.map(|b| Bytes::from(b.to_string())).unwrap_or_default();
        let mut last: Option<Refusal> = None;
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                let code = last.as_ref().map(|r| r.kind.as_str());
                (self.pause)(backoff(attempt, code)).await;
            }
            let mut req = self.request(method.clone(), path);
            if body.is_some() {
                req = req.header("content-type", "application/json");
            }
            if let Some(key) = &idempotency {
                req = req.header("idempotency-key", key);
            }
            let req = req.body(Full::new(payload.clone())).map_err(|e| {
                invalid(
                    "STORE_FAILED",
                    format!("the vector store's {operation} could not be sent"),
                    &e.to_string(),
                )
            })?;

            let unreachable = |detail: String| {
                Refusal::new(
                    StatusCode::BAD_GATEWAY,
                    "STORE_UNREACHABLE",
                    format!("the vector store's {operation} unreachable"),
                    format!("{}: {detail}", self.config.url),
                )
                .retryable()
            };
            let exchange = async {
                let response = self.dial.send(req).await.map_err(unreachable)?;
                let status = response.status();
                let bytes = response
                    .into_body()
                    .collect()
                    .await
                    .map_err(|e| unreachable(e.to_string()))?
                    .to_bytes();
                Ok::<_, Refusal>((status, bytes))
            };
            // A store that stops answering is not busy, so it is not asked again: the
            // retries are for refusals that say when to come back.
            let (status, bytes) = match tokio::time::timeout(self.timeout, exchange).await {
                Err(_) => {
                    return Err(Refusal::new(
                        StatusCode::GATEWAY_TIMEOUT,
                        "STORE_TIMEOUT",
                        format!(
                            "the vector store's {operation} did not answer within {} s",
                            self.timeout.as_secs_f64()
                        ),
                        self.config.url.clone(),
                    ))
                }
                Ok(Err(refusal)) => {
                    last = Some(refusal);
                    continue;
                }
                Ok(Ok(answered)) => answered,
            };
            if status.is_success() {
                if status == StatusCode::NO_CONTENT || bytes.is_empty() {
                    return Ok(None);
                }
                return serde_json::from_slice(&bytes).map(Some).map_err(|_| {
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "STORE_FAILED",
                        format!("the vector store's {operation} answered with what is not JSON"),
                        String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).into_owned(),
                    )
                });
            }
            let failure = describe_failure(status, &bytes, operation);
            if !failure.retryable {
                return Err(failure);
            }
            last = Some(failure);
        }
        Err(last.expect("at least one attempt"))
    }

    pub async fn ready(&self) -> bool {
        let Ok(req) = self
            .request(Method::GET, &self.config.paths.ready)
            .body(Full::new(Bytes::new()))
        else {
            return false;
        };
        matches!(
            tokio::time::timeout(self.timeout, self.dial.send(req)).await,
            Ok(Ok(r)) if r.status().is_success()
        )
    }

    pub async fn ensure_collection(
        &self,
        collection: &str,
        vector_schema: Value,
        metadata_schema: Value,
    ) -> Result<(), Refusal> {
        let mut body = json!({
            "vector_schema": vector_schema,
            "metadata_schema": metadata_schema,
        });
        body[self.config.collection_field.as_str()] = json!(collection);
        match self
            .send(
                Method::POST,
                &self.config.paths.create,
                Some(&body),
                Some(idempotency_for(&["create", collection])),
                "create",
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(refusal) if refusal.kind == "ALREADY_EXISTS" => Ok(()),
            Err(refusal) => Err(refusal),
        }
    }

    pub async fn holds(&self, collection: &str, ids: &[&str]) -> Result<HashSet<String>, Refusal> {
        assert_unique(ids, "fetch")?;
        let mut present = HashSet::new();
        for page in ids.chunks(MAX_RECORDS) {
            let answered = self
                .send(
                    Method::POST,
                    &Self::on(&self.config.paths.fetch, collection),
                    Some(&json!({ "ids": page })),
                    None,
                    "fetch",
                )
                .await?;
            let records = answered.as_ref().and_then(|v| v["records"].as_array());
            for record in records.into_iter().flatten() {
                if let Some(id) = record["id"].as_str() {
                    present.insert(id.to_string());
                }
            }
        }
        Ok(present)
    }

    pub async fn upsert(&self, collection: &str, records: &[Value]) -> Result<(), Refusal> {
        if records.len() > MAX_RECORDS {
            return Err(invalid(
                "STORE_BATCH_TOO_LARGE",
                format!(
                    "the vector store takes {MAX_RECORDS} records at a time, not {}",
                    records.len()
                ),
                "split the batch before upserting",
            ));
        }
        let ids: Vec<&str> = records
            .iter()
            .map(|r| r["id"].as_str().unwrap_or(""))
            .collect();
        assert_unique(&ids, "upsert")?;
        let parts: Vec<&str> = ["upsert", collection].into_iter().chain(ids).collect();
        self.send(
            Method::POST,
            &Self::on(&self.config.paths.upsert, collection),
            Some(&json!({ "records": records })),
            Some(idempotency_for(&parts)),
            "upsert",
        )
        .await
        .map(|_| ())
    }

    /// `mode` is sent rather than inherited: a store's default can change underneath callers,
    /// and the difference is a different search, not a different spelling.
    pub async fn query(
        &self,
        collection: &str,
        vector: &[f64],
        top_k: u64,
        filter: Option<Value>,
    ) -> Result<Vec<Value>, Refusal> {
        let mut body = json!({
            "vector": vector,
            "top_k": top_k.min(MAX_TOP_K),
            "mode": "exact",
        });
        if let Some(filter) = filter {
            body["filter"] = filter;
        }
        let answered = self
            .send(
                Method::POST,
                &Self::on(&self.config.paths.query, collection),
                Some(&body),
                None,
                "query",
            )
            .await?;
        Ok(answered
            .and_then(|mut v| {
                v.get_mut("matches")
                    .and_then(Value::as_array_mut)
                    .map(std::mem::take)
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::collections::HashMap;
    use std::convert::Infallible;
    use std::sync::Mutex;

    use http_body_util::BodyExt;
    use hyper::body::Incoming;
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response};
    use hyper_util::rt::TokioIo;
    use tokio::net::{TcpListener, UnixListener};

    use super::*;

    #[derive(Clone, Debug)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub headers: HashMap<String, String>,
        pub body: Value,
    }

    pub struct Fake {
        pub url: String,
        pub seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl Fake {
        pub fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }
    }

    type Reply = Arc<dyn Fn(&Seen, usize) -> (u16, String) + Send + Sync>;

    async fn answer<S>(stream: S, reply: Reply, log: Arc<Mutex<Vec<Seen>>>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let service = service_fn(move |req: Request<Incoming>| {
            let (reply, log) = (reply.clone(), log.clone());
            async move {
                let method = req.method().to_string();
                let path = req.uri().path().to_string();
                let headers = req
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect();
                let bytes = req.into_body().collect().await.unwrap().to_bytes();
                let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                let seen = Seen {
                    method,
                    path,
                    headers,
                    body,
                };
                let at = {
                    let mut log = log.lock().unwrap();
                    log.push(seen.clone());
                    log.len() - 1
                };
                let (status, body) = reply(&seen, at);
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(Full::new(Bytes::from(body)))
                        .unwrap(),
                )
            }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    }

    pub async fn serve<F>(reply: F) -> Fake
    where
        F: Fn(&Seen, usize) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let reply: Reply = Arc::new(reply);
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(stream, reply.clone(), log.clone()));
            }
        });
        Fake { url, seen }
    }

    pub async fn serve_socket<F>(socket: &Path, reply: F) -> Fake
    where
        F: Fn(&Seen, usize) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = UnixListener::bind(socket).unwrap();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let reply: Reply = Arc::new(reply);
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(stream, reply.clone(), log.clone()));
            }
        });
        Fake {
            url: "http://vectors.local".into(),
            seen,
        }
    }

    pub fn recording() -> (Pause, Arc<Mutex<Vec<Duration>>>) {
        let pauses: Arc<Mutex<Vec<Duration>>> = Arc::default();
        let log = pauses.clone();
        let pause: Pause = Arc::new(move |d: Duration| -> Paused {
            log.lock().unwrap().push(d);
            Box::pin(std::future::ready(()))
        });
        (pause, pauses)
    }

    pub fn config(url: &str) -> Config {
        Config {
            url: url.to_string(),
            socket: None,
            headers: vec![("authorization".into(), "Bearer tok".into())],
            paths: Paths::default(),
            collection_field: "collection".into(),
        }
    }

    pub fn store(fake: &Fake) -> (VectorStore, Arc<Mutex<Vec<Duration>>>) {
        let (pause, pauses) = recording();
        (
            VectorStore::new(config(&fake.url)).with_pause(pause),
            pauses,
        )
    }

    pub fn error(code: &str) -> String {
        json!({ "error": { "code": code, "message": code.to_lowercase() } }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{config, error, recording, serve, serve_socket, store};
    use super::*;

    fn record(id: &str) -> Value {
        json!({ "id": id, "vector": [1.0, 0.0], "metadata": { "unit": "sentence" } })
    }

    #[tokio::test]
    async fn gives_up_on_a_store_that_stops_answering_rather_than_asking_again() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = accepted.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                held.push(stream);
            }
        });
        let (pause, _) = recording();
        let r = VectorStore::new(config(&url))
            .with_pause(pause)
            .with_timeout(Duration::from_millis(100));
        let refused = r.holds("l", &["a"]).await.unwrap_err();
        assert_eq!(refused.kind, "STORE_TIMEOUT");
        assert!(!refused.retryable);
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!r.ready().await);
    }

    #[tokio::test]
    async fn reads_a_collection_that_already_exists_as_success() {
        let fake = serve(|_, _| (409, error("ALREADY_EXISTS"))).await;
        let (r, _) = store(&fake);
        r.ensure_collection("l", json!({}), json!({}))
            .await
            .unwrap();
        assert_eq!(fake.seen().len(), 1);
    }

    #[tokio::test]
    async fn retries_a_busy_collection() {
        let fake = serve(|_, at| {
            if at < 2 {
                (503, error("BUSY"))
            } else {
                (200, "{}".into())
            }
        })
        .await;
        let (r, pauses) = store(&fake);
        r.upsert("l", &[record("a")]).await.unwrap();
        assert_eq!(fake.seen().len(), 3);
        assert_eq!(pauses.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn waits_longer_on_a_full_store_than_on_a_busy_collection() {
        let first_pause = |code: &'static str| async move {
            let fake = serve(move |_, at| {
                if at == 0 {
                    (503, error(code))
                } else {
                    (200, "{}".into())
                }
            })
            .await;
            let (r, pauses) = store(&fake);
            r.upsert("l", &[record("a")]).await.unwrap();
            let first = pauses.lock().unwrap()[0];
            first
        };
        let busy = first_pause("BUSY").await;
        let full = first_pause("CAPACITY_EXCEEDED").await;
        assert!(full > busy, "{full:?} should exceed {busy:?}");
        assert!(busy < Duration::from_millis(150));
        assert!(full >= Duration::from_millis(800));
    }

    #[tokio::test]
    async fn surfaces_a_rejected_request_instead_of_retrying_it() {
        let fake = serve(|_, _| (400, error("INVALID_ARGUMENT"))).await;
        let (r, pauses) = store(&fake);
        let refused = r.upsert("l", &[record("a")]).await.unwrap_err();
        assert_eq!(refused.kind, "INVALID_ARGUMENT");
        assert!(!refused.retryable);
        assert_eq!(refused.detail, "HTTP 400");
        assert_eq!(fake.seen().len(), 1);
        assert!(pauses.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn names_a_body_that_is_not_json() {
        let fake = serve(|_, _| (400, "<html>no</html>".into())).await;
        let (r, _) = store(&fake);
        let refused = r.upsert("l", &[record("a")]).await.unwrap_err();
        assert_eq!(refused.kind, "STORE_FAILED");
        assert_eq!(
            refused.message,
            "the vector store's upsert failed: Bad Request"
        );
    }

    #[tokio::test]
    async fn retries_an_unreachable_store_then_says_so() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let (pause, pauses) = recording();
        let r = VectorStore::new(config(&format!("http://127.0.0.1:{port}"))).with_pause(pause);
        let refused = r.holds("l", &["a"]).await.unwrap_err();
        assert_eq!(refused.kind, "STORE_UNREACHABLE");
        assert!(refused.retryable);
        assert_eq!(pauses.lock().unwrap().len(), (ATTEMPTS - 1) as usize);
    }

    #[tokio::test]
    async fn sends_the_configured_headers_and_an_idempotency_key_on_a_write_and_none_on_a_read() {
        let fake = serve(|_, _| (200, json!({ "records": [] }).to_string())).await;
        let (r, _) = store(&fake);
        r.upsert("l", &[record("a")]).await.unwrap();
        r.holds("l", &["a"]).await.unwrap();
        let seen = fake.seen();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path, "/v1/collections/l/records:upsert");
        assert_eq!(seen[0].headers["authorization"], "Bearer tok");
        assert_eq!(seen[0].headers["idempotency-key"].len(), 32);
        assert_eq!(seen[1].path, "/v1/collections/l/records:fetch");
        assert_eq!(seen[1].headers["authorization"], "Bearer tok");
        assert!(!seen[1].headers.contains_key("idempotency-key"));
    }

    #[tokio::test]
    async fn refuses_a_batch_naming_one_id_twice() {
        let fake = serve(|_, _| (200, "{}".into())).await;
        let (r, _) = store(&fake);
        let refused = r
            .upsert("l", &[record("a"), record("a")])
            .await
            .unwrap_err();
        assert_eq!(refused.kind, "STORE_DUPLICATE_ID");
        let refused = r.holds("l", &["b", "b"]).await.unwrap_err();
        assert_eq!(refused.kind, "STORE_DUPLICATE_ID");
        assert!(fake.seen().is_empty());
    }

    #[tokio::test]
    async fn fetches_in_pages_and_reports_what_is_held() {
        let fake = serve(|seen, _| {
            let first = seen.body["ids"][0].clone();
            (200, json!({ "records": [{ "id": first }] }).to_string())
        })
        .await;
        let (r, _) = store(&fake);
        let ids: Vec<String> = (0..300).map(|i| format!("id{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let held = r.holds("l", &refs).await.unwrap();
        assert_eq!(fake.seen().len(), 2);
        assert_eq!(
            fake.seen()[0].body["ids"].as_array().unwrap().len(),
            MAX_RECORDS
        );
        assert_eq!(
            held,
            HashSet::from(["id0".to_string(), "id256".to_string()])
        );
    }

    #[test]
    fn splits_on_encoded_bytes_not_only_on_the_record_count() {
        let pad = "x".repeat(3 * 1024 * 1024);
        let records: Vec<Value> = (0..3).map(|i| json!({ "id": i, "pad": pad })).collect();
        let sizes: Vec<usize> = batches_of(records).unwrap().iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![2, 1]);

        let records: Vec<Value> = (0..300).map(|i| json!({ "id": i })).collect();
        let sizes: Vec<usize> = batches_of(records).unwrap().iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![256, 44]);
    }

    #[test]
    fn refuses_a_single_record_too_large_for_any_request() {
        let pad = "x".repeat(MAX_REQUEST_BYTES);
        let refused = batches_of(vec![json!({ "id": "a", "pad": pad })]).unwrap_err();
        assert_eq!(refused.kind, "STORE_RECORD_TOO_LARGE");
    }

    #[tokio::test]
    async fn names_the_search_mode_and_caps_top_k() {
        let fake = serve(|_, _| {
            (
                200,
                json!({ "matches": [{ "id": "a", "distance": 0.25 }] }).to_string(),
            )
        })
        .await;
        let (r, _) = store(&fake);
        let matches = r
            .query(
                "l",
                &[1.0, 0.0],
                60_000,
                Some(json!({ "eq": { "field": "unit", "value": "turn" } })),
            )
            .await
            .unwrap();
        assert_eq!(matches, vec![json!({ "id": "a", "distance": 0.25 })]);
        let body = &fake.seen()[0].body;
        assert_eq!(body["mode"], "exact");
        assert_eq!(body["top_k"], MAX_TOP_K);
        assert_eq!(body["filter"]["eq"]["value"], "turn");
    }

    fn parsed(raw: &str) -> Result<Config, String> {
        Config::parse("memory.json", raw, |name| {
            (name == "TOKEN").then(|| "t0k".to_string())
        })
    }

    #[test]
    fn takes_the_protocol_paths_and_field_when_memory_json_names_only_the_store() {
        let config = parsed(r#"{ "url": "https://vectors.example/" }"#).unwrap();
        assert_eq!(config.url, "https://vectors.example");
        assert_eq!(config.paths, Paths::default());
        assert_eq!(config.collection_field, "collection");
        assert!(config.headers.is_empty());
    }

    #[tokio::test]
    async fn speaks_to_a_store_whose_paths_and_field_are_its_own() {
        let fake = serve(|_, _| (200, json!({ "matches": [] }).to_string())).await;
        let raw = json!({
            "url": fake.url.as_str(),
            "headers": { "authorization": "Bearer ${TOKEN}" },
            "paths": { "create": "/v2/indexes", "query": "/v2/indexes/{collection}/search" },
            "collectionField": "index"
        })
        .to_string();
        let (pause, _) = recording();
        let r = VectorStore::new(parsed(&raw).unwrap()).with_pause(pause);
        r.ensure_collection("l", json!({}), json!({}))
            .await
            .unwrap();
        r.query("l", &[1.0], 1, None).await.unwrap();
        let seen = fake.seen();
        assert_eq!(seen[0].path, "/v2/indexes");
        assert_eq!(seen[0].body["index"], "l");
        assert!(seen[0].body.get("collection").is_none());
        assert_eq!(seen[0].headers["authorization"], "Bearer t0k");
        assert_eq!(seen[1].path, "/v2/indexes/l/search");
    }

    #[test]
    fn refuses_a_memory_json_it_cannot_use() {
        let refused = |raw: &str| parsed(raw).unwrap_err();
        assert!(refused(r#"{ "url": "ftp://x" }"#).contains("http or https"));
        assert!(refused(r#"{ "url": "not a url" }"#).contains("not a url"));
        assert!(refused(r#"{}"#).contains("url is a string"));
        assert!(refused(r#"{ "url": "http://x", "token": "t" }"#).contains("\"token\""));
        assert!(
            refused(r#"{ "url": "http://x", "headers": { "a": "${UNSET}" } }"#).contains("$UNSET")
        );
        assert!(
            refused(r#"{ "url": "http://x", "paths": { "query": "/q" } }"#)
                .contains("{collection}")
        );
        assert!(
            refused(r#"{ "url": "http://x", "paths": { "create": "v1" } }"#)
                .contains("starting with /")
        );
        assert!(
            refused(r#"{ "url": "http://x", "paths": { "delete": "/d" } }"#)
                .contains("paths.delete")
        );
    }

    #[tokio::test]
    async fn speaks_to_a_store_on_the_socket_memory_json_names() {
        let socket =
            std::env::temp_dir().join(format!("spore-vectors-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let fake = serve_socket(&socket, |_, _| (200, json!({ "matches": [] }).to_string())).await;
        let raw = json!({
            "url": fake.url.as_str(),
            "socket": socket.to_str().unwrap(),
            "headers": { "authorization": "Bearer ${TOKEN}" }
        })
        .to_string();
        let (pause, _) = recording();
        let r = VectorStore::new(parsed(&raw).unwrap()).with_pause(pause);
        assert!(r.ready().await);
        r.query("l", &[1.0], 1, None).await.unwrap();
        let seen = fake.seen();
        assert_eq!(seen[1].path, "/v1/collections/l/query");
        assert_eq!(seen[1].headers["host"], "vectors.local");
        assert_eq!(seen[1].headers["authorization"], "Bearer t0k");
        std::fs::remove_file(&socket).unwrap();
    }

    #[test]
    fn refuses_a_socket_it_cannot_use() {
        let refused = |raw: &str| parsed(raw).unwrap_err();
        assert!(
            refused(r#"{ "url": "http://x", "socket": "run/v.sock" }"#).contains("absolute path")
        );
        assert!(
            refused(r#"{ "url": "https://x", "socket": "/run/v.sock" }"#).contains("plain http")
        );
        assert!(refused(r#"{ "url": "http://x", "socket": 7 }"#).contains("socket is a string"));
        assert!(refused(r#"{ "url": "http://x", "socket": "${UNSET}" }"#).contains("$UNSET"));
    }

    #[test]
    fn keeps_a_collection_id_to_one_path_segment() {
        assert_eq!(
            VectorStore::on("/v1/collections/{collection}/query", "a/b c"),
            "/v1/collections/a%2Fb%20c/query"
        );
    }
}

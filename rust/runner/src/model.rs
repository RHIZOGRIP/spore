//! The model path: mohdel's call protocol on the tree's model socket, with the three things
//! spore adds around it and nothing more — the tree key, the ledger, and the hard stop.
//! Contract: ARCHITECTURE.md §The model broker.
//!
//! `POST /v1/call` and `POST /v1/embed` go to thin-gate's public `handle_call` and
//! `dispatch_embed` over an embedded session pool; `POST /spore/info` answers a model's catalog
//! entry from a session; `GET /spore/spend` is what the tree has settled.
//!
//! A call runs to its end on a task of its own, whatever becomes of the connection that asked
//! for it, and is counted there: nothing spore does stops a call, and the
//! turn that made it pays for all of it. Only `MODEL_CALL_CEILING` cuts one.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body as HttpBody, Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::defaults::{FileQuotaPolicy, FileRoutePolicy};
use mohdel_thin_gate::prelude::*;
use serde_json::{json, Value};
use spore_workspace::spend::{add_spend, spend_refusal, Limits};
use spore_workspace::{micros, Settled};
use tokio::sync::{mpsc, watch};

use crate::broker::{json_response, refuse};

/// Marks an answer as the root agent's own; every other call, embeddings included, is
/// counted as its cells', which is how the agent's loop keeps its books.
pub const CALLER_HEADER: &str = "x-spore-caller";
pub const ROOT_CALLER: &str = "root";
/// A cell's calls name its precursor after this, so a precursor called `root` is still a cell's.
pub const PRECURSOR_CALLER: &str = "precursor:";
/// The call's `callId` again, since the envelope reaches the gate unread.
pub const MODEL_CALL_HEADER: &str = "x-spore-model-call";
/// The `authId` spore's model client sends.
const AUTH_ID: &str = "spore";
/// Above the longest healthy call measured (44 min), so what it cuts has stalled.
pub const MODEL_CALL_CEILING: Duration = Duration::from_secs(60 * 60);

/// Settled spend and answered rounds of the whole tree, cells included, and the root
/// agent's share of them.
#[derive(Default)]
struct Ledger {
    spend: f64,
    rounds: u64,
    own: f64,
    own_rounds: u64,
    cut: u64,
    by_precursor: BTreeMap<String, (f64, u64)>,
}

/// Who a call says made it: the root agent, a cell of a named precursor, or nobody — a program
/// of the agent's own, an embedding for memory. Self-reported, as accounting inside one tree is.
enum Caller {
    Own,
    Precursor(String),
    Unnamed,
}

type Gate = Option<Result<Arc<GateState>, String>>;

/// Where the user's spend is kept, and the limits they set on it.
pub struct Spending {
    pub slots: PathBuf,
    pub limits: Limits,
}

pub struct Model {
    key: String,
    limit: Mutex<f64>,
    spending: Option<Spending>,
    gate: watch::Receiver<Gate>,
    ledger: Mutex<Ledger>,
    entries: Mutex<HashMap<String, Value>>,
    in_flight: watch::Sender<usize>,
}

/// One call counted as in flight until dropped.
struct InFlight(Arc<Model>);

impl InFlight {
    fn new(model: &Arc<Model>) -> InFlight {
        model.in_flight.send_modify(|n| *n += 1);
        InFlight(model.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.send_modify(|n| *n -= 1);
    }
}

fn header(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn caller(req: &Request<Incoming>) -> Caller {
    match header(req, CALLER_HEADER) {
        Some(named) if named == ROOT_CALLER => Caller::Own,
        Some(named) => match named.strip_prefix(PRECURSOR_CALLER) {
            Some(precursor) if !precursor.is_empty() => Caller::Precursor(precursor.to_string()),
            _ => Caller::Unnamed,
        },
        None => Caller::Unnamed,
    }
}

impl Model {
    pub fn new(
        key: String,
        limit: f64,
        spending: Option<Spending>,
        gate: watch::Receiver<Gate>,
    ) -> Arc<Model> {
        Arc::new(Model {
            key,
            limit: Mutex::new(limit),
            spending,
            gate,
            ledger: Mutex::default(),
            entries: Mutex::default(),
            in_flight: watch::channel(0).0,
        })
    }

    /// The hard cost limit as the turn's owner has since raised it.
    pub fn raise_limit(&self, limit: f64) {
        *self.limit.lock().expect("limit") = limit;
    }

    pub fn spent(&self) -> f64 {
        self.ledger.lock().expect("ledger").spend
    }

    pub fn settled(&self) -> Settled {
        let ledger = self.ledger.lock().expect("ledger");
        Settled {
            own: ledger.own,
            tree: ledger.spend,
            own_rounds: ledger.own_rounds,
            child_rounds: ledger.rounds - ledger.own_rounds,
            cut: ledger.cut,
            by_precursor: ledger.by_precursor.clone(),
        }
    }

    /// Returns once no call is in flight.
    pub async fn drained(&self) {
        let mut watching = self.in_flight.subscribe();
        watching
            .wait_for(|n| *n == 0)
            .await
            .expect("the model holds the sender");
    }

    /// Waits for the session to be up: the agent starts in parallel with it.
    async fn ready(&self) -> Result<Arc<GateState>, Response<Body>> {
        let mut gate = self.gate.clone();
        let held = gate.wait_for(Option::is_some).await.map_err(|_| {
            refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "no model session",
                "the runner stopped starting one",
                "SESSION_START_FAILED",
                false,
            )
        })?;
        match held.as_ref().expect("waited for Some") {
            Ok(state) => Ok(state.clone()),
            Err(why) => Err(refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "the model session could not start",
                why,
                "SESSION_START_FAILED",
                false,
            )),
        }
    }

    fn stopped(&self) -> Option<Response<Body>> {
        let spent = self.spent();
        let limit = *self.limit.lock().expect("limit");
        if spent >= limit {
            return Some(refuse(
                StatusCode::PAYMENT_REQUIRED,
                "budget exhausted",
                &format!("the tree has spent ${spent:.4}, which reaches its hard cost limit of ${limit}. Raise cost in spore.cmk if the work needs it."),
                "BUDGET_EXHAUSTED",
                false,
            ));
        }
        let spending = self.spending.as_ref()?;
        match spend_refusal(&spending.slots, &spending.limits) {
            Ok(None) => None,
            Ok(Some(refused)) => Some(refuse(
                StatusCode::PAYMENT_REQUIRED,
                &refused.message,
                &refused.detail,
                refused.kind,
                false,
            )),
            Err(e) => Some(refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read what your spores have spent",
                &e.to_string(),
                "SPEND_UNREADABLE",
                false,
            )),
        }
    }

    /// Until the gate has dispatched it, a call belongs to its connection, and a turn ending
    /// drops it unstarted. From then on it belongs to a task that reads it to its end.
    async fn call(self: &Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        if let Some(stopped) = self.stopped() {
            return stopped;
        }
        let Some(call_id) = header(&req, MODEL_CALL_HEADER) else {
            return refuse(
                StatusCode::BAD_REQUEST,
                "the model call names no id",
                &format!("a model call on this socket repeats its callId in {MODEL_CALL_HEADER}"),
                "PROTOCOL_INVALID_REQUEST",
                false,
            );
        };
        let caller = caller(&req);
        let state = match self.ready().await {
            Ok(state) => state,
            Err(refused) => return refused,
        };
        let answered = handle_call(req, state.clone()).await;
        if answered.status() != StatusCode::OK {
            return answered;
        }
        let (parts, body) = answered.into_parts();
        let (tx, rx) = mpsc::unbounded_channel();
        let carrying = InFlight::new(self);
        let abort: Abort = Box::new(move || {
            state
                .pool
                .as_ref()
                .expect("the runner's gate has a pool")
                .abort(&call_id, AUTH_ID)
        });
        tokio::spawn(
            self.clone()
                .carry(body, tx, caller, MODEL_CALL_CEILING, abort, carrying),
        );
        Response::from_parts(parts, Relay(rx).boxed())
    }

    /// Reads a call's events to its end, counting its `done`, and passes each frame on while
    /// anyone is there to take it. Past `ceiling` the call is aborted and ends on the usage
    /// it had reported.
    async fn carry(
        self: Arc<Self>,
        mut body: Body,
        tx: mpsc::UnboundedSender<Frame<Bytes>>,
        caller: Caller,
        ceiling: Duration,
        abort: Abort,
        _carrying: InFlight,
    ) {
        let past = tokio::time::sleep(ceiling);
        tokio::pin!(past);
        let mut lines = Lines::default();
        let mut abort = Some(abort);
        loop {
            tokio::select! {
                frame = body.frame() => {
                    let Some(frame) = frame else { break };
                    let frame = match frame {
                        Ok(frame) => frame,
                        Err(never) => match never {},
                    };
                    if let Some(data) = frame.data_ref() {
                        lines.feed(data, |line| self.observe(line, &caller));
                    }
                    let _ = tx.send(frame);
                }
                _ = &mut past, if abort.is_some() => {
                    let abort = abort.take().expect("checked");
                    if abort() {
                        self.ledger.lock().expect("ledger").cut += 1;
                    } else {
                        eprintln!("spore: a call past {} min was not in flight at the gate; reading it to its end", ceiling.as_secs() / 60);
                    }
                }
            }
        }
    }

    /// An embedding is spend but not a round, and runs by a call's rules: dropped with its
    /// connection until it has a session, read to its end and counted from then on. What
    /// bounds it is the session's own, not `MODEL_CALL_CEILING`: a one-shot exchange has no abort.
    async fn embed(self: &Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        if let Some(stopped) = self.stopped() {
            return stopped;
        }
        let caller = caller(&req);
        let state = match self.ready().await {
            Ok(state) => state,
            Err(refused) => return refused,
        };
        let exchange = match dispatch_embed(req, state).await {
            Ok(exchange) => exchange,
            Err(refused) => return refused,
        };
        let carrying = InFlight::new(self);
        let model = self.clone();
        let embedding = tokio::spawn(async move {
            let _carrying = carrying;
            let answered = exchange.await;
            if answered.status() != StatusCode::OK {
                return answered;
            }
            let (parts, body) = answered.into_parts();
            let bytes = body
                .collect()
                .await
                .expect("an answered body is infallible")
                .to_bytes();
            if let Some(cost) = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|result| result["cost"].as_f64())
            {
                model.count(cost, false, &caller);
            }
            Response::from_parts(parts, Full::new(bytes).boxed())
        });
        match embedding.await {
            Ok(response) => response,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }

    async fn info(&self, req: Request<Incoming>) -> Response<Body> {
        let asked = match req.into_body().collect().await {
            Ok(body) => serde_json::from_slice::<Value>(&body.to_bytes()).ok(),
            Err(_) => None,
        };
        let Some(model) = asked
            .as_ref()
            .and_then(|v| v["model"].as_str())
            .map(str::to_string)
        else {
            return refuse(
                StatusCode::BAD_REQUEST,
                "no model named",
                "POST /spore/info takes { model }",
                "PROTOCOL_INVALID_REQUEST",
                false,
            );
        };
        if let Some(entry) = self.entries.lock().expect("entries").get(&model) {
            return json_response(StatusCode::OK, entry);
        }
        let state = match self.ready().await {
            Ok(state) => state,
            Err(refused) => return refused,
        };
        let pool = state.pool.as_ref().expect("the runner's gate has a pool");
        match pool.info(&model).await {
            Ok(Some(entry)) => {
                self.entries
                    .lock()
                    .expect("entries")
                    .insert(model, entry.clone());
                json_response(StatusCode::OK, &entry)
            }
            Ok(None) => json_response(StatusCode::OK, &Value::Null),
            Err(error) => json_response(
                StatusCode::BAD_REQUEST,
                &serde_json::to_value(&error).expect("a TypedError serializes"),
            ),
        }
    }

    fn spend(&self) -> Response<Body> {
        let ledger = self.ledger.lock().expect("ledger");
        json_response(
            StatusCode::OK,
            &json!({ "spend": ledger.spend, "rounds": ledger.rounds, "own": ledger.own, "ownRounds": ledger.own_rounds }),
        )
    }

    /// A terminal `done` is where a call's cost is known; every answer is a round.
    fn observe(&self, line: &[u8], caller: &Caller) {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        if event["type"] != "done" {
            return;
        }
        self.count(
            event["result"]["cost"].as_f64().unwrap_or(0.0),
            true,
            caller,
        );
    }

    fn count(&self, cost: f64, round: bool, caller: &Caller) {
        if let Some(spending) = &self.spending {
            if let Err(e) = add_spend(&spending.slots, micros(cost)) {
                eprintln!("spore: a call's ${cost:.4} is not in your spores' spend, which your limits read — {e}");
            }
        }
        let mut ledger = self.ledger.lock().expect("ledger");
        ledger.spend += cost;
        ledger.rounds += u64::from(round);
        match caller {
            Caller::Own => {
                ledger.own += cost;
                ledger.own_rounds += u64::from(round);
            }
            Caller::Precursor(name) => {
                let share = ledger.by_precursor.entry(name.clone()).or_default();
                share.0 += cost;
                share.1 += u64::from(round);
            }
            Caller::Unnamed => {}
        }
    }
}

type Abort = Box<dyn FnOnce() -> bool + Send>;

/// Complete lines out of frames that split them anywhere.
#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
}

impl Lines {
    fn feed(&mut self, data: &[u8], mut each: impl FnMut(&[u8])) {
        self.pending.extend_from_slice(data);
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            each(&line[..end]);
        }
    }
}

/// A call's frames as its carrier passes them on.
struct Relay(mpsc::UnboundedReceiver<Frame<Bytes>>);

impl HttpBody for Relay {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.get_mut().0.poll_recv(cx).map(|frame| frame.map(Ok))
    }
}

/// mohdel's default cooldown, without its placeholder rate limits: each session paces its
/// own provider calls, and a fan-out's cells would otherwise queue on 60 a minute.
pub struct Unmetered;

#[async_trait]
impl QuotaPolicy for Unmetered {
    async fn policy_for(&self, user_id: &str) -> Result<QuotaSpec, QuotaError> {
        let mut spec = FileQuotaPolicy::new().policy_for(user_id).await?;
        spec.rpm = None;
        spec.tpm = None;
        spec.inpm = None;
        Ok(spec)
    }
}

/// The sessions for this turn and its cells: one started alongside the agent, another each
/// time every one is busy, up to `max`. A call waits for a session as long as it takes, since
/// the turn's wall bounds the whole tree. The catalog is the session's own disk load;
/// Refuses a call to a model the definition does not name, before a key is filled: an agent sets
/// what its commands and cells are told, so what the definition grants is held here, where the call
/// is. Embeddings do not pass through a route and are not held to it.
struct DefinedModels {
    allowed: Vec<String>,
    inner: FileRoutePolicy,
}

#[async_trait]
impl RoutePolicy for DefinedModels {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        if !self.allowed.contains(&env.model) {
            return Err(RouteError::Config(format!(
                "{} is not a model this spore's definition names — it may run on {}",
                env.model,
                self.allowed.join(", ")
            )));
        }
        self.inner.resolve(env).await
    }
}

/// `MOHDEL_MEDIA_ROOTS` must be set in this process first, since the session's environment is
/// built from an allowlist of this one. `allowed` is every model the definition names.
pub fn start_pool(
    node: String,
    session: String,
    chatgpt_helper: String,
    max: usize,
    allowed: Vec<String>,
) -> watch::Receiver<Gate> {
    let (tx, rx) = watch::channel(None);
    tokio::spawn(async move {
        let config = SessionConfig {
            command: node.clone(),
            args: vec![session],
            ..Default::default()
        };
        let made = match LocalAuth::new() {
            Err(e) => Err(e.to_string()),
            Ok(local) => SessionPool::growing(config, max, Duration::MAX)
                .await
                .map(|pool| {
                    Arc::new(GateState {
                        pool: Some(pool),
                        route: Arc::new(DefinedModels {
                            allowed,
                            inner: FileRoutePolicy::new(),
                        }),
                        quota: Arc::new(Unmetered),
                        auth: Arc::new(ChatGptAuth::new(
                            local,
                            node.into(),
                            chatgpt_helper.into(),
                            None,
                        )),
                        enforcer: Arc::new(Enforcer::new()),
                    })
                })
                .map_err(|e| e.to_string()),
        };
        let _ = tx.send(Some(made));
    });
    rx
}

/// One turn's model socket. A runner that carries on to another turn serves a new `Model` —
/// a new key, a new ledger — on a new socket, over the same session pool, and stops this
/// one: a cell the last turn detached reaches a model through the last turn's socket only.
pub fn serve(model: Arc<Model>, path: &Path) -> std::io::Result<crate::broker::Served> {
    let key = model.key.clone();
    crate::broker::serve(path, key, move |req| route(model.clone(), req))
}

async fn route(model: Arc<Model>, req: Request<Incoming>) -> Response<Body> {
    let (method, path) = (req.method().clone(), req.uri().path().to_string());
    match (&method, path.as_str()) {
        (&Method::POST, "/v1/call") => model.call(req).await,
        (&Method::POST, "/v1/embed") => model.embed(req).await,
        (&Method::POST, "/spore/info") => model.info(req).await,
        (&Method::GET, "/spore/spend") => model.spend(),
        _ => not_found_response(&method, &path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> Arc<Model> {
        let (_tx, rx) = watch::channel(None);
        Model::new("k".repeat(64), 1.0, None, rx)
    }

    #[test]
    fn adds_a_done_events_cost_and_counts_the_round_to_whoever_made_it() {
        let m = model();
        m.observe(
            br#"{"type":"delta","delta":{"type":"message","delta":"hi"}}"#,
            &Caller::Own,
        );
        m.observe(
            br#"{"type":"done","result":{"status":"completed","cost":0.25}}"#,
            &Caller::Own,
        );
        m.observe(
            br#"{"type":"done","result":{"status":"tool_use","cost":0.5}}"#,
            &Caller::Precursor("summarize".into()),
        );
        m.count(0.125, false, &Caller::Unnamed);
        assert_eq!(
            m.settled(),
            Settled {
                own: 0.25,
                tree: 0.875,
                own_rounds: 1,
                child_rounds: 1,
                cut: 0,
                by_precursor: [("summarize".to_string(), (0.5, 1))].into_iter().collect(),
            }
        );
    }

    #[tokio::test]
    async fn routes_only_the_models_the_definition_names() {
        let policy = DefinedModels {
            allowed: vec!["m/root".into(), "m/low".into()],
            inner: FileRoutePolicy::new(),
        };
        let asking = |model: &str| -> CallEnvelope {
            serde_json::from_value(
                json!({ "callId": "c1", "authId": "spore", "model": model, "prompt": "hi" }),
            )
            .expect("an envelope")
        };
        assert_eq!(
            policy.resolve(&asking("m/low")).await.unwrap().model_id,
            "m/low"
        );
        let refused = policy
            .resolve(&asking("m/costly"))
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains("m/costly is not a model this spore's definition names — it may run on m/root, m/low"), "{refused}");
    }

    #[test]
    fn adds_each_call_to_the_users_spend_and_refuses_once_it_reaches_a_limit() {
        let dir = std::env::temp_dir().join(format!("spore-model-spend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let slots = dir.join("slots");
        let (_tx, rx) = watch::channel(None);
        let spending = Spending {
            slots: slots.clone(),
            limits: Limits {
                day: Some(0.5),
                month: None,
            },
        };
        let m = Model::new("k".repeat(64), 10.0, Some(spending), rx);
        m.count(0.25, true, &Caller::Own);
        assert!(m.stopped().is_none());
        m.count(0.25, false, &Caller::Unnamed);
        assert_eq!(spore_workspace::spend::spent(&slots).unwrap().day, 500_000);
        assert_eq!(
            m.stopped().map(|refused| refused.status()),
            Some(StatusCode::PAYMENT_REQUIRED)
        );
    }

    #[tokio::test]
    async fn counts_a_call_to_its_end_with_nobody_left_reading_it() {
        let m = model();
        let body: Body = http_body_util::StreamBody::new(futures_frames(&[
            b"{\"type\":\"done\",\"res",
            b"ult\":{\"cost\":0.1}}\n{\"type\":\"done\",\"result\":{\"cost\":0.2}}\n",
        ]))
        .boxed();
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        let carrying = InFlight::new(&m);
        let never: Abort = Box::new(|| panic!("no ceiling reached"));
        let carried = tokio::spawn(m.clone().carry(
            body,
            tx,
            Caller::Own,
            MODEL_CALL_CEILING,
            never,
            carrying,
        ));
        m.drained().await;
        carried.await.unwrap();
        let settled = m.settled();
        assert!((settled.tree - 0.3).abs() < 1e-9 && (settled.own - 0.3).abs() < 1e-9);
        assert_eq!(settled.own_rounds, 2);
    }

    #[tokio::test]
    async fn waits_for_every_call_in_flight() {
        let m = model();
        let first = InFlight::new(&m);
        let second = InFlight::new(&m);
        let drained = tokio::spawn({
            let m = m.clone();
            async move { m.drained().await }
        });
        drop(first);
        tokio::task::yield_now().await;
        assert!(!drained.is_finished());
        drop(second);
        drained.await.unwrap();
    }

    #[tokio::test]
    async fn aborts_a_call_past_the_ceiling_and_counts_what_it_reported() {
        let m = model();
        let (frames, rx) = mpsc::unbounded_channel::<Frame<Bytes>>();
        let body: Body =
            http_body_util::StreamBody::new(futures::stream::unfold(rx, |mut rx| async move {
                rx.recv()
                    .await
                    .map(|frame| (Ok::<_, Infallible>(frame), rx))
            }))
            .boxed();
        let abort: Abort = Box::new(move || {
            let done = br#"{"type":"done","result":{"status":"incomplete","warning":"aborted","cost":0.04}}"#;
            frames.send(Frame::data(Bytes::from_static(done))).unwrap();
            frames.send(Frame::data(Bytes::from_static(b"\n"))).unwrap();
            true
        });
        let (tx, mut seen) = mpsc::unbounded_channel();
        let carrying = InFlight::new(&m);
        m.clone()
            .carry(
                body,
                tx,
                Caller::Unnamed,
                Duration::from_millis(20),
                abort,
                carrying,
            )
            .await;
        let settled = m.settled();
        assert_eq!(settled.cut, 1);
        assert!((settled.tree - 0.04).abs() < 1e-9 && settled.own == 0.0);
        assert_eq!(settled.child_rounds, 1);
        assert!(seen.recv().await.is_some());
    }

    fn futures_frames(
        chunks: &[&'static [u8]],
    ) -> impl futures::Stream<Item = Result<Frame<Bytes>, Infallible>> {
        futures::stream::iter(
            chunks
                .iter()
                .map(|c| Ok(Frame::data(Bytes::from_static(c))))
                .collect::<Vec<_>>(),
        )
    }
}

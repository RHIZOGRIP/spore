//! A spore definition — `spore.cmk`, and `precursors/<name>.cmk` in the top workspace.
//! Format and rationale: ARCHITECTURE.md, "Precursors".
//!
//! The one implementation of the grammar, the schema and every refusal. JavaScript reaches
//! it through `spore-definition-node`; a Rust host links it directly. Two parsers would be
//! a definition that means two things.

use std::sync::LazyLock;

use regex::Regex;
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

pub mod call;
pub mod deadline;
pub mod name;
pub mod schedule;

pub use call::{CallRow, Description};
pub use deadline::{deadline, Calendar};
pub use name::{
    is_name, is_origin, name_pattern, name_rule, NAME_KINDS, NAME_MOST, VARIABLE_PATTERN,
    VARIABLE_RULE,
};
pub use schedule::{parse_schedule, Due, Schedule};

/// The tool suite, by name. Contract: ARCHITECTURE.md, "Tools".
pub const TOOL_NAMES: [&str; 7] = ["read", "write", "edit", "exec", "wsexec", "ask", "quiet"];

const FIELDS: [&str; 40] = [
    "name",
    "description",
    "model",
    "auth",
    "models",
    "cell-models",
    "tools",
    "enzymes",
    "reads",
    "writes",
    "sources",
    "rounds",
    "cost",
    "wall",
    "on-wrap",
    "retain",
    "history",
    "extend.rounds",
    "extend.cost",
    "extend.wall",
    "memory",
    "push",
    "pull",
    "floor",
    "embedding",
    "images",
    "schedules",
    "jobs",
    "jobs.maxWait",
    "jobs.perDay",
    "jobs.writes",
    "dream",
    "dream.cost",
    "dream.wall",
    "dream.precursor",
    "plugins",
    "prepare",
    "prepare.timeout",
    "prepare.attach",
    "reasoning",
];

const ON_WRAP: [&str; 2] = ["keep", "discard"];

/// What a turn may ask its model for besides the answer: `summaries` of its reasoning, `raw` reasoning.
const REASONING: [&str; 2] = ["summaries", "raw"];

/// mohdel's bound on an envelope's `authId`.
const AUTH_MAX_BYTES: usize = 128;

/// What sits at the workspace root under a name a grant could take: staging a grant there would
/// replace the workspace's own directory with a link.
const WORKSPACE_NAMES: [&str; 8] = [
    "data",
    "home",
    "calls",
    "precursors",
    "schedules",
    "node_modules",
    "lock",
    "tmp",
];

const MEMORY_BACKENDS: [&str; 2] = ["bm25", "vectors"];

static TOOL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]*$").unwrap());
static SCOPED_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)$").unwrap());
static OPEN_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:::(enzyme|call)[ \t]+(\S+)[ \t]*$").unwrap());
static CLOSE_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^:::[ \t]*$").unwrap());
static DOCUMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$").unwrap());
static DURATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]+)(s|m|h)$").unwrap());
static SIZE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]+)(B|KB|MB|GB)?$").unwrap());
static COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").unwrap());
static AMOUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+(\.[0-9]+)?$").unwrap());

/// The most a prepare step may run, and attach, whatever a definition asks.
pub const PREPARE_MOST_MS: f64 = 60_000.0;
pub const PREPARE_MOST_FILES: u64 = 100;
pub const PREPARE_MOST_BYTES: u64 = 256 * 1024 * 1024;

/// A frontmatter value: `key: scalar` or `key: [a, b]`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Value {
    Scalar(String),
    List(Vec<String>),
}

impl Value {
    /// How the value reads when quoted back in a refusal: a list as its items joined by commas.
    fn text(&self) -> String {
        match self {
            Value::Scalar(s) => s.clone(),
            Value::List(items) => items.join(","),
        }
    }
}

/// Keys in the order they were written.
#[derive(Debug, Clone, PartialEq)]
pub struct Ordered<T>(pub Vec<(String, T)>);

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Ordered(Vec::new())
    }
}

impl<T> Ordered<T> {
    pub fn get(&self, key: &str) -> Option<&T> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

impl<T: Serialize> Serialize for Ordered<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

pub type Fields = Ordered<Value>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pair {
    pub soft: f64,
    pub hard: f64,
}

/// The highest each hard limit may be raised to while a turn runs, by its owner. A dimension
/// left out cannot be raised.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Extend {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wall: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limits {
    pub rounds: Pair,
    pub cost: Pair,
    pub wall: Pair,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Enzyme {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub with: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Grant {
    pub name: String,
    pub path: String,
}

/// A name a precursor's `model:` may give, and the model it stands for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellModel {
    pub name: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Memory {
    pub backend: String,
    pub push: u64,
    pub pull: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Images {
    pub count: u64,
    pub bytes: u64,
}

/// How many schedule files the agent may keep, and how close two slots of one may be.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Schedules {
    pub count: u64,
    pub interval: f64,
}

/// How many jobs — work that outlives the turn starting it — may run at once, the hard wall of
/// each, how long a delivery of theirs may be held (absent, none is held), how many triage
/// cells their deliveries may start a day (absent, the default every origin has), and which of the
/// definition's `writes` a job may write as well as read (absent, none).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Jobs {
    pub count: u64,
    pub wall: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wait: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_day: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
}

/// One of a plugin's programs, by its variable, run on every delivery from `origin` before any turn reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrepareStep {
    pub origin: String,
    pub plugin: String,
    pub program: String,
}

/// What prepares this spore's deliveries, by origin, and the bounds every step runs within.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Prepare {
    pub steps: Vec<PrepareStep>,
    pub timeout: f64,
    pub attach: Attach,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attach {
    pub files: u64,
    pub bytes: u64,
}

/// When the spore dreams — after how many turns, and how much quiet, at the pressure the
/// two make together — what one dream may spend and how long it may hold the spore, and the
/// precursor it runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dream {
    pub turns: u64,
    pub quiet: f64,
    pub cost: Pair,
    pub wall: Pair,
    pub precursor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub name: String,
    /// One line for a person choosing among definitions; never part of what the model is told.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A root's model; a precursor's is the name of one of its spore's `cell_models`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Whom a root's model calls are for on a shared gate, sent as every envelope's `authId`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// What a person may switch the root to, beside `model`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cell_models: Vec<CellModel>,
    pub identity: String,
    pub tools: Vec<String>,
    pub enzymes: Vec<Enzyme>,
    pub reads: Vec<Grant>,
    pub writes: Vec<Grant>,
    pub sources: Vec<String>,
    pub scopes: Ordered<Ordered<Vec<String>>>,
    pub limits: Limits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_wrap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retain: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extend: Option<Extend>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<Memory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Images>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedules: Option<Schedules>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jobs: Option<Jobs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dream: Option<Dream>,
    pub plugins: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepare: Option<Prepare>,
    /// How a person is shown its calls, from its `:::call` blocks, in the order written.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<CallRow>,
    /// What each model call asks for besides the answer, from `REASONING`; empty asks for neither.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reasoning: Vec<String>,
}

/// `cell` holds a definition to a cell's rules, `seed` to the shipped template's, which is
/// cut from rather than run and so names no model.
pub struct Options<'a> {
    pub known_tools: &'a [String],
    pub cell: bool,
    pub seed: bool,
}

/// Whitespace as ECMAScript's `trim` counts it, byte-order mark included.
fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A string read as ECMAScript's `Number` reads one, bar hexadecimal: blank is 0 and
/// anything else unreadable is NaN.
fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// A whole number written as digits alone — no sign, exponent or fraction — and at least `min`.
fn whole_number(text: &str, min: u64) -> Option<u64> {
    COUNT
        .is_match(text)
        .then(|| text.parse::<u64>().ok())
        .flatten()
        .filter(|n| *n >= min)
}

/// A field that takes one value: a list in its place is refused rather than read joined.
fn scalar<'a>(fields: &'a Fields, key: &str) -> Result<Option<&'a str>, String> {
    match fields.get(key) {
        None => Ok(None),
        Some(Value::Scalar(text)) => Ok(Some(text.as_str())),
        Some(Value::List(_)) => Err(format!("\"{key}\" takes one value, not a list")),
    }
}

fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in p.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

/// The home of the account this runs as, from the password database. Not `$HOME`: inside a
/// turn that is the agent's own home, and a definition has to name the same path wherever it is
/// read.
fn account_home() -> Option<String> {
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: every pointer is to a live local, and buf's length is passed with it.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buf.as_mut_ptr(),
            buf.len(),
            &mut found,
        )
    };
    if rc != 0 || found.is_null() || entry.pw_dir.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_dir points into buf, NUL-terminated.
    let dir = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }
        .to_string_lossy()
        .into_owned();
    (!dir.is_empty()).then_some(dir)
}

/// `~` is expanded here rather than left to a shell: nothing between the definition and the
/// kernel runs one, and a precursor shared between machines is the ordinary case.
fn host_path(declared: &str) -> Result<String, String> {
    if let Some(rest) = declared.strip_prefix('~') {
        let home = account_home().ok_or_else(|| {
            format!("names \"{declared}\" from home, and this account has no home directory — write it from /")
        })?;
        return Ok(normalize(&format!("{home}/{rest}")));
    }
    if declared.starts_with('/') {
        return Ok(normalize(declared));
    }
    Err(format!(
        "names \"{declared}\", a relative path — write it from / or ~, since a relative one would mean wherever the process reading the definition runs"
    ))
}

/// `10m` in milliseconds, or none. The one place this spelling is understood.
pub fn duration_ms(v: &str) -> Option<f64> {
    let m = DURATION.captures(v)?;
    let unit = match &m[2] {
        "s" => 1_000.0,
        "m" => 60_000.0,
        _ => 3_600_000.0,
    };
    Some(number(&m[1]) * unit)
}

/// `10MB` in bytes, or none. A bare number is bytes, as `wall` has no bare form and this does.
pub fn size_bytes(v: &str) -> Option<f64> {
    let m = SIZE.captures(trim(v))?;
    let unit = match m.get(2).map(|u| u.as_str().to_ascii_lowercase()).as_deref() {
        Some("kb") => 1024.0,
        Some("mb") => 1024.0 * 1024.0,
        Some("gb") => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    Some(number(&m[1]) * unit)
}

fn rounds(v: &str) -> Option<f64> {
    COUNT.is_match(v).then(|| number(v))
}

fn cost(v: &str) -> Option<f64> {
    AMOUNT.is_match(v).then(|| number(v))
}

/// The grammar only: `key: scalar` and `key: [a, b]`. Which keys are allowed is the
/// schema's business — a definition that describes an agent — and an origin's frontmatter
/// is read with it when an experiment inherits its settings.
pub fn parse_frontmatter(head: &str) -> Result<Fields, String> {
    let mut fields = Fields::default();
    for raw in head.split('\n') {
        let line = trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(sep) = line.find(':') else {
            return Err(format!("frontmatter needs \"key: value\" — got \"{line}\""));
        };
        let key = trim(&line[..sep]);
        let value = trim(&line[sep + 1..]);
        if fields.has(key) {
            return Err(format!("\"{key}\" appears twice"));
        }
        let value = if value.starts_with('[') {
            if !value.ends_with(']') || value.len() < 2 {
                return Err(format!("list is not closed — \"{line}\""));
            }
            Value::List(
                value[1..value.len() - 1]
                    .split(',')
                    .map(trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            )
        } else {
            Value::Scalar(value.to_string())
        };
        fields.0.push((key.to_string(), value));
    }
    Ok(fields)
}

/// The body is the identity, plus one `:::enzyme <name>` block per enzyme it grants and one
/// `:::call <name>` block per way of describing its calls. A description is a property of the use
/// rather than of the program — two precursors may grant one binary and frame it two different
/// ways — so it is written where the grant is and never asked of the binary itself.
struct Body {
    identity: String,
    enzymes: Ordered<String>,
    calls: Ordered<String>,
}

fn parse_body(body: &str) -> Result<Body, String> {
    let left_open = |kind: &str, name: &str| {
        format!("has \":::{kind} {name}\" left open — a block ends with \":::\" alone on a line")
    };
    let mut identity: Vec<&str> = Vec::new();
    let mut enzymes = Ordered::default();
    let mut calls = Ordered::default();
    let mut open: Option<(String, String, Vec<&str>)> = None;

    for line in body.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(opening) = OPEN_BLOCK.captures(line) {
            if let Some((kind, name, _)) = &open {
                return Err(left_open(kind, name));
            }
            open = Some((opening[1].to_string(), opening[2].to_string(), Vec::new()));
            continue;
        }
        if CLOSE_BLOCK.is_match(line) {
            let Some((kind, name, lines)) = open.take() else {
                return Err("has a \":::\" closing a block that was never opened".into());
            };
            let blocks = if kind == "call" {
                &mut calls
            } else {
                &mut enzymes
            };
            if blocks.has(&name) {
                return Err(format!("has two \":::{kind} {name}\" blocks"));
            }
            blocks.0.push((name, trim(&lines.join("\n")).to_string()));
            continue;
        }
        match &mut open {
            Some((_, _, lines)) => lines.push(line),
            None => identity.push(line),
        }
    }
    if let Some((kind, name, _)) = &open {
        return Err(left_open(kind, name));
    }
    Ok(Body {
        identity: trim(&identity.join("\n")).to_string(),
        enzymes,
        calls,
    })
}

/// `name=path`, or a bare path taking its basename.
fn named(raw: &str) -> (&str, &str) {
    match raw.find('=') {
        Some(eq) => (trim(&raw[..eq]), trim(&raw[eq + 1..])),
        None => (trim(basename(raw)), trim(raw)),
    }
}

/// The name is what the cell calls and what the broker keys on, so renaming one binary for
/// two precursors is part of framing it.
fn parse_enzymes(entries: &[String]) -> Result<Vec<Enzyme>, String> {
    let mut enzymes: Vec<Enzyme> = Vec::new();
    for raw in entries {
        let (name, path) = named(raw);
        if path.is_empty() {
            return Err(format!("declares an enzyme with no path — \"{raw}\""));
        }
        if !TOOL_NAME.is_match(name) {
            return Err(format!(
                "has an enzyme name it cannot use — \"{name}\", expected letters, digits, - and _"
            ));
        }
        if enzymes.iter().any(|e| e.name == name) {
            return Err(format!("grants two enzymes named \"{name}\""));
        }
        enzymes.push(Enzyme {
            name: name.into(),
            path: path.into(),
            description: None,
            with: Vec::new(),
        });
    }
    Ok(enzymes)
}

fn model_id(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_whitespace) && text.contains('/')
}

/// `models`, the root models a person may switch to, and `cell-models`, the names a precursor's
/// `model:` may give: the root's alone, since a cell runs on what its spore gives it.
fn parse_models(fields: &Fields, cell: bool) -> Result<(Vec<String>, Vec<CellModel>), String> {
    let models = list(fields, "models").to_vec();
    let raw = list(fields, "cell-models");
    if cell && !(models.is_empty() && raw.is_empty()) {
        return Err("declares models or cell-models, which are the root definition's — a cell runs on the model its spore gives it".into());
    }
    for (i, model) in models.iter().enumerate() {
        if !model_id(model) {
            return Err(format!(
                "has a models entry \"{model}\" that is not a model — expected <provider>/<name>"
            ));
        }
        if models[..i].contains(model) {
            return Err(format!("lists {model} twice in models"));
        }
    }
    let mut cell_models: Vec<CellModel> = Vec::new();
    for entry in raw {
        let (name, model) = named(entry);
        if !entry.contains('=') || !TOOL_NAME.is_match(name) || model.is_empty() {
            return Err(format!("has a cell-models entry \"{entry}\" it cannot use — expected <name>=<provider>/<model>, as low=anthropic/claude-haiku-4-5"));
        }
        if !model_id(model) {
            return Err(format!("names {name} in cell-models as \"{model}\", which is not a model — expected <provider>/<name>"));
        }
        if cell_models.iter().any(|m| m.name == name) {
            return Err(format!("names {name} twice in cell-models"));
        }
        cell_models.push(CellModel {
            name: name.into(),
            model: model.into(),
        });
    }
    Ok((models, cell_models))
}

/// Directories on disk staged in the workspace under a name: `reads` the agent may read and
/// never write, `writes` it may also write. The name becomes a link in the workspace pointing
/// at the path, so a definition never carries a host layout into a prompt, and both kinds share
/// one namespace because both are links in one directory.
fn parse_grants(reads: &[String], writes: &[String]) -> Result<(Vec<Grant>, Vec<Grant>), String> {
    let mut staged: Vec<Grant> = Vec::new();
    let mut parse = |entries: &[String], kind: &str| -> Result<Vec<Grant>, String> {
        let mut grants: Vec<Grant> = Vec::new();
        for raw in entries {
            let (name, declared) = named(raw);
            if declared.is_empty() {
                return Err(format!("declares a {kind} with no path — \"{raw}\""));
            }
            if !TOOL_NAME.is_match(name) {
                return Err(format!(
                    "has a {kind} named \"{name}\" it cannot use — expected letters, digits, - and _"
                ));
            }
            if WORKSPACE_NAMES.contains(&name) {
                return Err(format!(
                    "has a {kind} named \"{name}\", which the workspace already uses — name it something else"
                ));
            }
            if staged.iter().any(|g| g.name == name) {
                return Err(format!(
                    "declares two grants named \"{name}\" across reads and writes"
                ));
            }
            let grant = Grant {
                name: name.into(),
                path: host_path(declared)?,
            };
            staged.push(grant.clone());
            grants.push(grant);
        }
        Ok(grants)
    };
    let reads = parse(reads, "read")?;
    let writes = parse(writes, "write")?;
    Ok((reads, writes))
}

/// Each limit is a soft/hard pair. Soft enters wrap mode, hard kills; both are declared
/// rather than defaulted in code, because the shipped definition is already the default and
/// a second one would drift from it.
fn parse_limit(
    key: &str,
    raw: Option<&Value>,
    read: fn(&str) -> Option<f64>,
) -> Result<Pair, String> {
    let shape = match key {
        "rounds" => "rounds: [40, 45]",
        "cost" => "cost: [0.50, 0.75]",
        "dream.cost" => "dream.cost: [0.50, 1.00]",
        "dream.wall" => "dream.wall: [10m, 15m]",
        _ => "wall: [10m, 12m]",
    };
    let Some(raw) = raw else {
        return Err(format!(
            "declares no {key} — every definition carries its own limits, as {shape}"
        ));
    };
    let Value::List(items) = raw else {
        return Err(format!("needs {key} as a soft/hard pair, {shape}"));
    };
    if items.len() != 2 {
        return Err(format!("needs {key} as a soft/hard pair, {shape}"));
    }
    let written = items.join(", ");
    match (read(&items[0]), read(&items[1])) {
        (Some(soft), Some(hard)) if soft > 0.0 => {
            if hard <= soft {
                return Err(format!(
                    "has a hard {key} limit that is not past the soft one — got [{written}]"
                ));
            }
            Ok(Pair { soft, hard })
        }
        _ => Err(format!(
            "has a {key} limit it cannot read — got [{written}], expected {shape}"
        )),
    }
}

fn parse_extend(fields: &Fields, limits: &Limits, cell: bool) -> Result<Option<Extend>, String> {
    let dimensions: [(&str, fn(&str) -> Option<f64>, &Pair, &str); 3] = [
        ("rounds", rounds, &limits.rounds, "extend.rounds: 100"),
        ("cost", cost, &limits.cost, "extend.cost: 5.00"),
        ("wall", duration_ms, &limits.wall, "extend.wall: 3h"),
    ];
    let mut extend = Extend {
        rounds: None,
        cost: None,
        wall: None,
    };
    let mut any = false;
    for (dimension, read, pair, shape) in dimensions {
        let key = format!("extend.{dimension}");
        let Some(raw) = fields.get(&key) else {
            continue;
        };
        if cell {
            return Err(format!("declares {key}, which is the root definition's — a cell's limits are its parent's to give, and nobody extends a cell's turn"));
        }
        let Value::Scalar(text) = raw else {
            return Err(format!(
                "has a {key} it cannot read — expected one ceiling, as {shape}"
            ));
        };
        let Some(ceiling) = read(text) else {
            return Err(format!(
                "has a {key} it cannot read — got \"{text}\", expected {shape}"
            ));
        };
        if ceiling <= pair.hard {
            return Err(format!("has a {key} that is not past the hard {dimension} limit — it is the highest that limit may be raised to, so it lies beyond it"));
        }
        match dimension {
            "rounds" => extend.rounds = Some(ceiling),
            "cost" => extend.cost = Some(ceiling),
            _ => extend.wall = Some(ceiling),
        }
        any = true;
    }
    Ok(any.then_some(extend))
}

// Absent means everything a turn starts ends with it. The owner's alone, as a turn's limits are:
// a job runs past every limit of the turn that started it.
fn parse_jobs(fields: &Fields, cell: bool, granted: &[Grant]) -> Result<Option<Jobs>, String> {
    let max_wait = fields.get("jobs.maxWait");
    let per_day = fields.get("jobs.perDay");
    let job_writes = fields.get("jobs.writes");
    let raw = match fields.get("jobs") {
        None if max_wait.is_some() || per_day.is_some() => {
            return Err("declares jobs.maxWait or jobs.perDay without jobs — they bound the deliveries of jobs this spore may start, as jobs: [2, 2h]".into());
        }
        None if job_writes.is_some() => {
            return Err("declares jobs.writes without jobs — it names which of writes the jobs this spore may start can write, as jobs: [2, 2h]".into());
        }
        None => return Ok(None),
        Some(_) if cell => {
            return Err("declares jobs, which are the root definition's — a cell's work ends with it, so nothing of it outlives a turn".into());
        }
        Some(Value::List(raw)) if raw.len() == 2 => raw,
        Some(_) => return Err("needs jobs as a count and a wall, jobs: [2, 2h]".into()),
    };
    let Some(count) = whole_number(&raw[0], 1) else {
        return Err(format!(
            "has a jobs count it cannot read — got \"{}\", expected how many jobs may run at once, at least 1",
            raw[0]
        ));
    };
    let wall = match duration_ms(&raw[1]) {
        Some(ms) if ms > 0.0 => ms,
        _ => {
            return Err(format!(
                "has a jobs wall it cannot read — got \"{}\", expected how long one job may run, as 2h",
                raw[1]
            ));
        }
    };
    let max_wait = match max_wait {
        None => None,
        Some(Value::Scalar(text)) => match duration_ms(text) {
            Some(ms) if ms > 0.0 => Some(ms),
            _ => {
                return Err(format!(
                    "has a jobs.maxWait it cannot read — got \"{text}\", expected the longest a job's delivery may be held, as 30m"
                ));
            }
        },
        Some(_) => {
            return Err(
                "has a jobs.maxWait it cannot read — expected one duration, as jobs.maxWait: 30m"
                    .into(),
            );
        }
    };
    let per_day = match per_day {
        None => None,
        Some(value) => {
            let read = match value {
                Value::Scalar(text) => whole_number(text, 1),
                Value::List(_) => None,
            };
            let Some(n) = read else {
                return Err(format!(
                    "has a jobs.perDay it cannot read — got \"{}\", expected how many triage cells a job's deliveries may start a day, a whole number from 1",
                    value.text()
                ));
            };
            Some(n)
        }
    };
    let writes = match job_writes {
        None => Vec::new(),
        Some(Value::List(names)) => names.clone(),
        Some(_) => {
            return Err("\"jobs.writes\" must be a list, as jobs.writes: [here]".into());
        }
    };
    for name in &writes {
        if !granted.iter().any(|grant| &grant.name == name) {
            return Err(format!(
                "names {name} in jobs.writes, which writes does not grant — a job may write only a directory the spore itself writes"
            ));
        }
    }
    Ok(Some(Jobs {
        count,
        wall,
        max_wait,
        per_day,
        writes,
    }))
}

// Absent, the spore never dreams. Its limits are declared beside it, never defaulted: a dream
// spends the owner's money and holds the spore, and the agent writes the precursor it runs.
fn parse_dream(fields: &Fields, cell: bool) -> Result<Option<Dream>, String> {
    let raw = match fields.get("dream") {
        None => {
            return match ["dream.cost", "dream.wall", "dream.precursor"]
                .into_iter()
                .find(|key| fields.get(key).is_some())
            {
                Some(key) => Err(format!("declares {key} without dream — it bounds or names the dream this spore may have, as dream: [50, 1h]")),
                None => Ok(None),
            };
        }
        Some(_) if cell => {
            return Err("declares dream, which is the root definition's — a dream reorganizes the spore, and a cell is not one".into());
        }
        Some(Value::List(raw)) if raw.len() == 2 => raw,
        Some(_) => return Err("needs dream as turns and a quiet, dream: [50, 1h]".into()),
    };
    let Some(turns) = whole_number(&raw[0], 1) else {
        return Err(format!(
            "has a dream turns it cannot read — got \"{}\", expected how many turns make a dream due after the quiet, at least 1",
            raw[0]
        ));
    };
    let quiet = match duration_ms(&raw[1]) {
        Some(ms) if ms > 0.0 => ms,
        _ => {
            return Err(format!(
                "has a dream quiet it cannot read — got \"{}\", expected how long without a turn makes a dream due after the turns, as 1h",
                raw[1]
            ));
        }
    };
    for (key, shape) in [
        ("dream.cost", "dream.cost: [0.50, 1.00]"),
        ("dream.wall", "dream.wall: [10m, 15m]"),
        ("dream.precursor", "dream.precursor: dream"),
    ] {
        if fields.get(key).is_none() {
            return Err(format!("declares dream without {key} — a dream is a precursor the spore names, run within limits its owner sets, as {shape}"));
        }
    }
    let spend = parse_limit("dream.cost", fields.get("dream.cost"), cost)?;
    let held = parse_limit("dream.wall", fields.get("dream.wall"), duration_ms)?;
    let precursor = match fields.get("dream.precursor") {
        Some(Value::Scalar(name)) if is_name("precursor", name) == Ok(true) => name.clone(),
        other => {
            return Err(format!(
                "has a dream.precursor it cannot read — got \"{}\", expected the name of one of its precursors, as dream.precursor: dream",
                other.map(Value::text).unwrap_or_default()
            ));
        }
    };
    Ok(Some(Dream {
        turns,
        quiet,
        cost: spend,
        wall: held,
        precursor,
    }))
}

// Absent, a delivery reaches its spore as it came. Root only, and only from a plugin the spore
// uses: the program is the owner's, outside the workspace, and runs before the agent sees anything.
fn parse_prepare(fields: &Fields, cell: bool) -> Result<Option<Prepare>, String> {
    let raw = match fields.get("prepare") {
        None => {
            return match ["prepare.timeout", "prepare.attach"]
                .into_iter()
                .find(|key| fields.get(key).is_some())
            {
                Some(key) => Err(format!("declares {key} without prepare — it bounds the programs that prepare this spore's deliveries, as prepare: [hook:scans=pdf/SPORE_PDF_PAGES]")),
                None => Ok(None),
            };
        }
        Some(_) if cell => {
            return Err("declares prepare, which is the root definition's — deliveries reach the spore, not a cell".into());
        }
        Some(Value::List(raw)) if !raw.is_empty() => raw,
        Some(_) => {
            return Err("needs prepare as a list of <origin>=<plugin>/<program>, as prepare: [hook:scans=pdf/SPORE_PDF_PAGES]".into())
        }
    };
    let mut steps: Vec<PrepareStep> = Vec::new();
    for entry in raw {
        let shape =
            "<origin>=<plugin>/<program>, the origin hook:<name>, job:<name> or api:<caller>, the program a variable among the plugin's programs";
        let Some((origin, run)) = entry.split_once('=') else {
            return Err(format!(
                "has a prepare entry it cannot read — got \"{entry}\", expected {shape}"
            ));
        };
        let (origin, run) = (trim(origin), trim(run));
        if !is_origin(origin) {
            return Err(format!(
                "has a prepare entry it cannot read — got origin \"{origin}\", expected {shape}"
            ));
        }
        let Some((plugin, program)) = run
            .split_once('/')
            .filter(|(p, n)| is_name("plugin", p) == Ok(true) && name::VARIABLE.is_match(n))
        else {
            return Err(format!(
                "has a prepare entry it cannot read — got \"{run}\" for {origin}, expected {shape}"
            ));
        };
        if steps.iter().any(|step| step.origin == origin) {
            return Err(format!(
                "prepares {origin} twice — one program prepares an origin"
            ));
        }
        steps.push(PrepareStep {
            origin: origin.into(),
            plugin: plugin.into(),
            program: program.into(),
        });
    }
    let timeout = match fields.get("prepare.timeout") {
        Some(Value::Scalar(text)) => match duration_ms(text) {
            Some(ms) if ms > 0.0 && ms <= PREPARE_MOST_MS => ms,
            _ => {
                return Err(format!(
                    "has a prepare.timeout it cannot take — got \"{text}\", expected how long one program may run, at most {}s, as 45s",
                    PREPARE_MOST_MS / 1000.0
                ));
            }
        },
        Some(_) => return Err("has a prepare.timeout it cannot read — expected one duration, as prepare.timeout: 45s".into()),
        None => return Err("declares prepare without prepare.timeout — how long one program may run, as prepare.timeout: 45s".into()),
    };
    let attach = match fields.get("prepare.attach") {
        Some(Value::List(pair)) if pair.len() == 2 => {
            let files = whole_number(&pair[0], 1).filter(|n| *n <= PREPARE_MOST_FILES);
            let bytes = size_bytes(&pair[1]).filter(|b| *b >= 1.0 && *b <= PREPARE_MOST_BYTES as f64);
            let (Some(files), Some(bytes)) = (files, bytes) else {
                return Err(format!(
                    "has a prepare.attach it cannot take — got [{}], expected how many files and bytes a program may attach, at most [{PREPARE_MOST_FILES}, {}MB], as [20, 200MB]",
                    pair.join(", "),
                    PREPARE_MOST_BYTES / 1024 / 1024
                ));
            };
            Attach { files, bytes: bytes as u64 }
        }
        Some(_) => return Err("needs prepare.attach as a count and a size, prepare.attach: [20, 200MB]".into()),
        None => return Err("declares prepare without prepare.attach — how many files and bytes a program may attach, as prepare.attach: [20, 200MB]".into()),
    };
    Ok(Some(Prepare {
        steps,
        timeout,
        attach,
    }))
}

fn list<'a>(fields: &'a Fields, key: &str) -> &'a [String] {
    match fields.get(key) {
        Some(Value::List(items)) => items,
        _ => &[],
    }
}

pub fn parse_definition(source: &str, opts: &Options) -> Result<Definition, String> {
    let Some(document) = DOCUMENT.captures(source) else {
        return Err("must open with a --- frontmatter block".into());
    };
    let fields = parse_frontmatter(&document[1])?;

    // `<source>.<param>` narrows what a granted source may be asked for, and `<enzyme>.with`
    // names what a granted enzyme needs beside itself — the one key shape the schema does
    // not name in advance, since which are legal depends on what this definition grants. A
    // name carries no dot, so the split is unambiguous, and a source and an enzyme may not share
    // one.
    let granted: Vec<&str> = match fields.get("sources") {
        Some(Value::List(items)) => items.iter().map(String::as_str).collect(),
        Some(Value::Scalar(s)) => vec![s.as_str()],
        None => Vec::new(),
    };
    let enzyme_names: Vec<&str> = list(&fields, "enzymes")
        .iter()
        .map(|raw| named(raw).0)
        .collect();
    if let Some(both) = enzyme_names.iter().find(|name| granted.contains(name)) {
        return Err(format!(
            "grants a source and an enzyme both named \"{both}\" — {both}.<field> could mean either, so rename one"
        ));
    }
    for (key, value) in &fields.0 {
        if FIELDS.contains(&key.as_str()) {
            continue;
        }
        let Some(scoped) = SCOPED_KEY.captures(key) else {
            return Err(format!(
                "unknown field \"{key}\" — definitions take {}",
                FIELDS.join(", ")
            ));
        };
        if enzyme_names.contains(&&scoped[1]) {
            if &scoped[2] != "with" {
                return Err(format!(
                    "has \"{key}\" — an enzyme takes only {}.with, the files and directories it needs beside itself",
                    &scoped[1]
                ));
            }
            match value {
                Value::List(items) if !items.is_empty() && items.iter().all(|i| !i.is_empty()) => {}
                _ => {
                    return Err(format!(
                        "has a {key} it cannot read — expected the paths it needs, as {key}: [lib/helper.mjs, templates/]"
                    ))
                }
            }
            continue;
        }
        if !granted.contains(&&scoped[1]) {
            return Err(format!(
                "narrows \"{key}\" without granting the source — add {} to sources, or drop the line",
                &scoped[1]
            ));
        }
        match value {
            Value::List(items) if !items.is_empty() => {}
            _ => {
                return Err(format!(
                    "has a {key} it cannot read — expected the values it may ask for, as {key}: [one, two]"
                ))
            }
        }
    }

    let Body {
        identity,
        enzymes: described,
        calls: call_blocks,
    } = parse_body(&document[2])?;
    if identity.is_empty() {
        return Err(
            "has no identity — the body below the frontmatter is what the sub-agent is told".into(),
        );
    }
    let name = match fields.get("name") {
        Some(Value::Scalar(s)) if !s.is_empty() => s.clone(),
        _ => return Err("needs a name".into()),
    };
    let description = match fields.get("description") {
        None => None,
        Some(Value::Scalar(d)) if !d.is_empty() => Some(d.clone()),
        Some(other) => {
            return Err(format!(
                "has a description it cannot read — got \"{}\", expected one line of text",
                other.text()
            ));
        }
    };

    let auth = match (opts.cell, fields.get("auth")) {
        (_, None) => None,
        (true, Some(_)) => {
            return Err("declares auth — a cell's model calls go through its root's runner, under its root's auth".into());
        }
        (false, Some(Value::Scalar(a))) if !a.is_empty() && a.len() <= AUTH_MAX_BYTES => {
            Some(a.clone())
        }
        (false, Some(other)) => {
            return Err(format!(
                "has an auth it cannot read — got \"{}\", expected one id of at most {AUTH_MAX_BYTES} bytes",
                other.text()
            ));
        }
    };

    for key in [
        "tools",
        "enzymes",
        "reads",
        "writes",
        "sources",
        "plugins",
        "models",
        "cell-models",
        "reasoning",
    ] {
        if let Some(Value::Scalar(_)) = fields.get(key) {
            return Err(format!("\"{key}\" must be a list, as {key}: [a, b]"));
        }
    }

    let limits = Limits {
        rounds: parse_limit("rounds", fields.get("rounds"), rounds)?,
        cost: parse_limit("cost", fields.get("cost"), cost)?,
        wall: parse_limit("wall", fields.get("wall"), duration_ms)?,
    };

    let tools = list(&fields, "tools").to_vec();
    for tool in &tools {
        if !opts.known_tools.contains(tool) {
            return Err(format!(
                "unknown tool \"{tool}\" — choose from {}",
                opts.known_tools.join(", ")
            ));
        }
    }

    if opts.cell && tools.iter().any(|t| t == "quiet") {
        return Err("grants \"quiet\", which ends a turn with nothing to say — a cell's parent reads its answer, and a part that says nothing reads as unfinished".into());
    }

    // Two rules hold for a cell and not for the root definition, because a cell answers to
    // an agent rather than to a person.
    let on_wrap = match (opts.cell, fields.get("on-wrap")) {
        (true, _) if tools.iter().any(|t| t == "ask") => {
            return Err("grants \"ask\", which stops a turn to ask a user something — a cell has no user, and the question would reach the parent as if it were the answer".into());
        }
        (true, None) => {
            return Err(format!(
                "declares no on-wrap — a cell says what an unfinished answer is worth, as on-wrap: {}",
                ON_WRAP.join(" or on-wrap: ")
            ));
        }
        (true, Some(Value::Scalar(w))) if ON_WRAP.contains(&w.as_str()) => Some(w.clone()),
        (true, Some(other)) => {
            return Err(format!(
                "has an on-wrap it cannot read — got \"{}\", expected {}",
                other.text(),
                ON_WRAP.join(" or ")
            ));
        }
        (false, Some(_)) => {
            return Err("declares on-wrap, which is a cell's policy — a wrapped answer here goes to the user, who decides what it is worth".into());
        }
        (false, None) => None,
    };

    let (reads, writes) = parse_grants(list(&fields, "reads"), list(&fields, "writes"))?;
    if opts.cell && !writes.is_empty() {
        return Err("declares writes — a cell works in its own directory, and its parent brings what it made into the one the parent writes".into());
    }

    // Endpoints this agent may call by name. What a name means is the host's to say and the
    // agent never learns it — a URL it could read is a URL it could call without the broker.
    let sources = list(&fields, "sources").to_vec();
    for (i, source) in sources.iter().enumerate() {
        if sources[..i].contains(source) {
            return Err(format!("grants the source \"{source}\" twice"));
        }
        if !TOOL_NAME.is_match(source) {
            return Err(format!("grants a source named \"{source}\" it cannot use — expected letters, digits, - and _"));
        }
        if source == "extend" {
            return Err("grants a source named \"extend\" — extend.<limit> is the field that lets a turn's limits be raised, so rename the source".into());
        }
        if source == "jobs" {
            return Err("grants a source named \"jobs\" — jobs.maxWait is the field that bounds how long a job's deliveries wait, so rename the source".into());
        }
        if source == "dream" {
            return Err("grants a source named \"dream\" — dream.cost is the field that bounds what a dream spends, so rename the source".into());
        }
        if source == "prepare" {
            return Err("grants a source named \"prepare\" — prepare.timeout is the field that bounds what prepares a delivery, so rename the source".into());
        }
    }

    // What each granted source may be asked for. Absent means the parameter is free; one
    // value means the broker fills it and the agent need not know it at all.
    let mut scopes: Ordered<Ordered<Vec<String>>> = Ordered::default();
    for (key, value) in &fields.0 {
        let Some(scoped) = SCOPED_KEY.captures(key) else {
            continue;
        };
        if FIELDS.contains(&key.as_str()) {
            continue;
        }
        if enzyme_names.contains(&&scoped[1]) {
            continue;
        }
        let Value::List(values) = value else { continue };
        let (source, param) = (scoped[1].to_string(), scoped[2].to_string());
        match scopes.0.iter_mut().find(|(s, _)| *s == source) {
            Some((_, params)) => params.0.push((param, values.clone())),
            None => scopes
                .0
                .push((source, Ordered(vec![(param, values.clone())]))),
        }
    }

    // The model is configuration, so it is declared with everything else that says what an
    // agent is. A cell may leave it out and run on its parent's, which is inheritance from a
    // real value rather than a default standing in for one.
    let model = match fields.get("model") {
        None => None,
        Some(Value::Scalar(m)) if !m.is_empty() && !m.chars().any(char::is_whitespace) => {
            Some(m.clone())
        }
        Some(other) => {
            return Err(format!(
                "has a model it cannot read — got \"{}\", expected one identifier like anthropic/claude-sonnet-5-5",
                other.text()
            ));
        }
    };
    if model.is_none() && !opts.cell && !opts.seed {
        return Err("declares no model — a definition says what it runs on, as model: <provider>/<name>; \"mo ls\" lists your catalog".into());
    }
    if let (false, Some(id)) = (opts.cell, &model) {
        if !model_id(id) {
            return Err(format!("has a model it cannot read — got \"{id}\", expected <provider>/<name>, as anthropic/claude-sonnet-5-5"));
        }
    }
    if let (true, Some(named)) = (opts.cell, &model) {
        if !TOOL_NAME.is_match(named) {
            return Err(format!("names its model as \"{named}\" — a precursor names one of its spore's cell-models, as model: low, never a model itself"));
        }
    }
    let (models, cell_models) = parse_models(&fields, opts.cell)?;

    // How many turns of trail survive, this one included. Absent means every turn survives,
    // which is a real answer rather than a number standing in for one.
    let retain = match fields.get("retain") {
        None => None,
        Some(_) if opts.cell => {
            return Err("declares retain, which is the root definition's — a cell runs once, so it has no older turns to drop".into());
        }
        Some(_) => {
            let text = scalar(&fields, "retain")?.unwrap_or_default();
            let Some(n) = whole_number(text, 1) else {
                return Err(format!(
                    "has a retain it cannot read — got \"{text}\", expected a whole number of turns, at least 1"
                ));
            };
            Some(n)
        }
    };

    // How many tokens of earlier turns are carried word for word before the oldest are
    // summarized. Absent leaves it to the runtime, which bounds it by the model's window.
    let history = match fields.get("history") {
        None => None,
        Some(_) if opts.cell => {
            return Err("declares history, which is the root definition's — a cell runs once, so it has no earlier turns to carry".into());
        }
        Some(_) => {
            let text = scalar(&fields, "history")?.unwrap_or_default();
            let Some(n) = whole_number(text, 1) else {
                return Err(format!(
                    "has a history it cannot read — got \"{text}\", expected a whole number of tokens, as history: 64000"
                ));
            };
            Some(n)
        }
    };

    let extend = parse_extend(&fields, &limits, opts.cell)?;

    let mut enzymes = parse_enzymes(list(&fields, "enzymes"))?;
    for entry in &mut enzymes {
        entry.with = list(&fields, &format!("{}.with", entry.name)).to_vec();
    }
    if !opts.cell && !enzymes.is_empty() {
        return Err("declares enzymes, which are a cell's alone — a cell is offered programs it cannot see, while everything here is already in this workspace and runs under exec or wsexec".into());
    }
    if opts.cell {
        if !enzymes.is_empty() && !tools.iter().any(|t| t == "exec" || t == "wsexec") {
            return Err("grants enzymes but neither exec nor wsexec — a cell calls one by running enzyme.js, so without a shell they are unreachable".into());
        }
        for entry in &mut enzymes {
            let Some(description) = described.get(&entry.name) else {
                return Err(format!(
                    "grants \"{0}\" and never describes it — add a \":::enzyme {0}\" block, or the cell is never told it exists",
                    entry.name
                ));
            };
            if description.is_empty() {
                return Err(format!("has an empty \":::enzyme {}\" block", entry.name));
            }
            entry.description = Some(description.clone());
        }
        for (name, _) in &described.0 {
            if !enzymes.iter().any(|e| &e.name == name) {
                return Err(format!("describes \"{name}\", which it does not grant — name it in enzymes, or drop the block"));
            }
        }
    } else if !described.0.is_empty() {
        return Err("has a \":::enzyme\" block but grants no enzymes".into());
    }

    if opts.cell && !call_blocks.0.is_empty() {
        return Err("has a \":::call\" block — what a cell runs is shown to no one, so only a spore describes its calls".into());
    }
    let calls = call_blocks
        .0
        .iter()
        .map(|(name, body)| call::parse_call_block(name, body))
        .collect::<Result<Vec<_>, _>>()?;

    // Long-term memory, and the two depths it is read at. The depths are declared rather
    // than defaulted for the reason the limits are: each came from one sweep over one
    // dataset, and a number buried in code is a number nobody benchmarks.
    let memory = match fields.get("memory") {
        Some(_) => {
            let backend = trim(scalar(&fields, "memory")?.unwrap_or_default()).to_string();
            if !MEMORY_BACKENDS.contains(&backend.as_str()) {
                return Err(format!(
                    "asks for a memory backend that does not exist — got \"{backend}\", expected {}",
                    MEMORY_BACKENDS.join(" or ")
                ));
            }
            let depth = |key: &str, example: u64| -> Result<u64, String> {
                let Some(text) = scalar(&fields, key)? else {
                    return Err(format!(
                        "declares memory and no {key} — a definition carries its own depths, as {key}: {example}"
                    ));
                };
                whole_number(text, 1).ok_or_else(|| {
                    format!("has a {key} it cannot read — got \"{text}\", expected a whole number of chunks, at least 1")
                })
            };
            let push = depth("push", 5)?;
            let pull = depth("pull", 20)?;
            // Absent means take anything scoring above zero. A floor only means the same
            // thing twice if the backend's scores do, so a usable one depends on the backend.
            let floor = match scalar(&fields, "floor")? {
                None => None,
                Some(text) => match cost(text) {
                    Some(n) => Some(n),
                    None => {
                        return Err(format!(
                            "has a floor it cannot read — got \"{text}\", expected a score below which a hit is not worth surfacing"
                        ));
                    }
                },
            };
            let embedding = match (backend.as_str(), fields.get("embedding")) {
                ("vectors", None) => {
                    return Err("declares memory: vectors and no embedding — a vector store keeps vectors, and the definition names the model that makes them, as embedding: <provider>/<name>".into());
                }
                ("vectors", Some(Value::Scalar(m)))
                    if !m.is_empty() && !m.chars().any(char::is_whitespace) =>
                {
                    Some(m.clone())
                }
                ("vectors", Some(other)) => {
                    return Err(format!(
                        "has an embedding it cannot read — got \"{}\", expected one identifier like openai/text-embedding-3-small",
                        other.text()
                    ));
                }
                (_, Some(_)) => {
                    return Err(format!(
                        "declares an embedding with memory: {backend}, which embeds nothing — only a vector store keeps vectors"
                    ));
                }
                (_, None) => None,
            };
            Some(Memory {
                backend,
                push,
                pull,
                floor,
                embedding,
            })
        }
        None => {
            if ["push", "pull", "floor", "embedding"]
                .iter()
                .any(|k| fields.has(k))
            {
                return Err("declares push, pull, floor or embedding without memory — they are how a store is read, so there is nothing for them to mean".into());
            }
            None
        }
    };

    // Absent means the agent cannot look at anything. The pair is intake per turn, not soft
    // and hard: `read` takes one path, so a per-call count would always be one.
    let images = match fields.get("images") {
        None => None,
        Some(Value::List(raw)) if raw.len() == 2 => {
            let Some(count) = whole_number(&raw[0], 1) else {
                return Err(format!(
                    "has an images count it cannot read — got \"{}\", expected a whole number of images a turn may look at, at least 1",
                    raw[0]
                ));
            };
            let bytes = match size_bytes(&raw[1]) {
                Some(b) if b >= 1.0 => b,
                _ => {
                    return Err(format!(
                        "has an images size it cannot read — got \"{}\", expected bytes as 10MB, 512KB or a bare number",
                        raw[1]
                    ));
                }
            };
            Some(Images {
                count,
                bytes: bytes as u64,
            })
        }
        Some(_) => return Err("needs images as a count and a size, images: [4, 10MB]".into()),
    };

    // Absent means the agent cannot touch its schedules and only its operator writes them.
    // The pair bounds how often the clock can start a turn, which `cost` alone cannot: it
    // holds per turn.
    let schedules = match fields.get("schedules") {
        None => None,
        Some(_) if opts.cell => {
            return Err("declares schedules, which are the root definition's — a cell runs once, so nothing of it recurs".into());
        }
        Some(Value::List(raw)) if raw.len() == 2 => {
            let Some(count) = whole_number(&raw[0], 1) else {
                return Err(format!(
                    "has a schedules count it cannot read — got \"{}\", expected a whole number of schedule files, at least 1",
                    raw[0]
                ));
            };
            let interval = match duration_ms(&raw[1]) {
                Some(ms) if ms >= 60_000.0 => ms,
                _ => {
                    return Err(format!(
                        "has a schedules interval it cannot read — got \"{}\", expected the shortest time between two firings of one schedule, at least a minute, as 1h",
                        raw[1]
                    ));
                }
            };
            Some(Schedules { count, interval })
        }
        Some(_) => {
            return Err("needs schedules as a count and an interval, schedules: [4, 1h]".into())
        }
    };

    let jobs = parse_jobs(&fields, opts.cell, &writes)?;
    let dream = parse_dream(&fields, opts.cell)?;

    // Named here and resolved by the host, which knows which plugins are enabled on this
    // machine: a definition only says which of them this spore uses.
    let plugins = list(&fields, "plugins").to_vec();
    if opts.cell && !plugins.is_empty() {
        return Err("uses plugins, which a cell cannot — what a plugin offers is given to the root spore alone".into());
    }
    for (i, plugin) in plugins.iter().enumerate() {
        if is_name("plugin", plugin) != Ok(true) {
            return Err(format!(
                "uses a plugin named \"{plugin}\" — expected the name after spore-plugin-, {}",
                name_rule("plugin")?
            ));
        }
        if plugins[..i].contains(plugin) {
            return Err(format!("uses the plugin \"{plugin}\" twice"));
        }
    }

    let prepare = parse_prepare(&fields, opts.cell)?;

    let reasoning = list(&fields, "reasoning").to_vec();
    for (i, asked) in reasoning.iter().enumerate() {
        if !REASONING.contains(&asked.as_str()) {
            return Err(format!(
                "asks for reasoning \"{asked}\" — expected {}",
                REASONING.join(" or ")
            ));
        }
        if reasoning[..i].contains(asked) {
            return Err(format!("asks for reasoning \"{asked}\" twice"));
        }
    }

    Ok(Definition {
        name,
        description,
        model,
        auth,
        models,
        cell_models,
        identity,
        tools,
        enzymes,
        reads,
        writes,
        sources,
        scopes,
        limits,
        on_wrap,
        retain,
        history,
        extend,
        memory,
        images,
        schedules,
        jobs,
        dream,
        plugins,
        prepare,
        calls,
        reasoning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOOLS: [&str; 3] = ["read", "exec", "wsexec"];

    fn parse(source: &str) -> Result<Definition, String> {
        let known: Vec<String> = TOOLS.iter().map(|t| t.to_string()).collect();
        parse_definition(
            source,
            &Options {
                known_tools: &known,
                cell: false,
                seed: false,
            },
        )
    }

    const WELL_FORMED: &str = "---\nname: x\nmodel: m/1\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou read.\n";

    #[test]
    fn reads_a_well_formed_definition() {
        let d = parse(WELL_FORMED).unwrap();
        assert_eq!(d.name, "x");
        assert_eq!(d.identity, "You read.");
        assert_eq!(
            d.limits.wall,
            Pair {
                soft: 120_000.0,
                hard: 180_000.0
            }
        );
        assert_eq!(
            d.limits.cost,
            Pair {
                soft: 0.1,
                hard: 0.15
            }
        );
    }

    #[test]
    fn carries_a_history_budget_at_the_root_and_refuses_one_in_a_cell() {
        let with =
            |field: &str| parse(&WELL_FORMED.replacen("---\n", &format!("---\n{field}\n"), 1));
        assert_eq!(with("history: 64000").unwrap().history, Some(64000));
        assert!(with("history: 64k")
            .unwrap_err()
            .contains("history it cannot read"));
        assert!(with("history: 0")
            .unwrap_err()
            .contains("history it cannot read"));
        let known: Vec<String> = TOOLS.iter().map(|t| t.to_string()).collect();
        let source = "---\nname: c\nhistory: 64000\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou work.\n";
        let refused = parse_definition(
            source,
            &Options {
                known_tools: &known,
                cell: true,
                seed: false,
            },
        )
        .unwrap_err();
        assert!(refused.contains("a cell runs once"));
    }

    #[test]
    fn carries_extension_ceilings_at_the_root_past_each_hard_limit() {
        let with =
            |field: &str| parse(&WELL_FORMED.replacen("---\n", &format!("---\n{field}\n"), 1));
        let both =
            parse(&WELL_FORMED.replacen("---\n", "---\nextend.wall: 3h\nextend.cost: 5.00\n", 1))
                .unwrap();
        assert_eq!(
            both.extend,
            Some(Extend {
                rounds: None,
                cost: Some(5.0),
                wall: Some(10_800_000.0)
            })
        );
        assert_eq!(
            with("extend.rounds: 50").unwrap().extend.unwrap().rounds,
            Some(50.0)
        );
        assert!(with("extend.wall: 3m")
            .unwrap_err()
            .contains("not past the hard wall limit"));
        assert!(with("extend.cost: 0.15")
            .unwrap_err()
            .contains("not past the hard cost limit"));
        assert!(with("extend.wall: 3 hours")
            .unwrap_err()
            .contains("extend.wall it cannot read"));
        assert!(with("extend.wall: [3h, 4h]")
            .unwrap_err()
            .contains("expected one ceiling"));
        assert!(with("extend.time: 3h")
            .unwrap_err()
            .contains("without granting the source"));
        let known: Vec<String> = TOOLS.iter().map(|t| t.to_string()).collect();
        let source = "---\nname: c\nextend.wall: 1h\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou work.\n";
        let refused = parse_definition(
            source,
            &Options {
                known_tools: &known,
                cell: true,
                seed: false,
            },
        )
        .unwrap_err();
        assert!(refused.contains("nobody extends a cell's turn"));
    }

    #[test]
    fn serializes_what_is_absent_as_absent() {
        let json = serde_json::to_value(parse(WELL_FORMED).unwrap()).unwrap();
        for key in [
            "description",
            "auth",
            "onWrap",
            "retain",
            "history",
            "extend",
            "memory",
            "images",
            "schedules",
            "jobs",
            "dream",
        ] {
            assert!(json.get(key).is_none(), "{key} is present");
        }
        assert_eq!(json["model"], "m/1");
    }

    #[test]
    fn reads_a_description_for_a_person_and_keeps_it_out_of_the_identity() {
        let with =
            |line: &str| parse(&WELL_FORMED.replace("name: x\n", &format!("name: x\n{line}")));
        let d = with("description: Shell work in one directory, in place\n").unwrap();
        assert_eq!(
            d.description.as_deref(),
            Some("Shell work in one directory, in place")
        );
        assert!(!d.identity.contains("Shell work"));
        assert!(with("description: [a, b]\n")
            .unwrap_err()
            .contains("one line of text"));
        assert!(with("description:\n")
            .unwrap_err()
            .contains("one line of text"));
    }

    #[test]
    fn reads_whom_a_roots_calls_are_for_and_refuses_it_in_a_cell() {
        let with =
            |line: &str| parse(&WELL_FORMED.replace("name: x\n", &format!("name: x\n{line}")));
        assert_eq!(
            with("auth: thread-7f3a\n").unwrap().auth.as_deref(),
            Some("thread-7f3a")
        );
        assert!(with(&format!("auth: {}\n", "a".repeat(129)))
            .unwrap_err()
            .contains("at most 128 bytes"));
        assert!(with("auth: [a, b]\n")
            .unwrap_err()
            .contains("an auth it cannot read"));
        let refused = cell(&CHART.replace("on-wrap: keep\n", "on-wrap: keep\nauth: thread-7f3a\n"))
            .unwrap_err();
        assert!(refused.contains("under its root's auth"), "{refused}");
    }

    #[test]
    fn keeps_frontmatter_in_the_order_written() {
        let fields = parse_frontmatter("b: 1\na: [x, y]").unwrap();
        assert_eq!(
            serde_json::to_string(&fields).unwrap(),
            r#"{"b":"1","a":["x","y"]}"#
        );
    }

    #[test]
    fn reads_durations_and_sizes() {
        assert_eq!(duration_ms("90s"), Some(90_000.0));
        assert_eq!(duration_ms("10"), None);
        assert_eq!(size_bytes(" 10MB "), Some(10.0 * 1024.0 * 1024.0));
        assert_eq!(size_bytes("512kb"), Some(512.0 * 1024.0));
        assert_eq!(size_bytes("1GB"), Some(1024.0 * 1024.0 * 1024.0));
        assert_eq!(size_bytes("7"), Some(7.0));
        assert_eq!(size_bytes("7TB"), None);
    }

    #[test]
    fn reads_numbers_as_ecmascript_does() {
        assert_eq!(number(""), 0.0);
        assert_eq!(number(" 3 "), 3.0);
        assert!(number("half").is_nan());
        assert!(number("inf").is_nan());
    }

    #[test]
    fn resolves_paths_lexically() {
        assert_eq!(normalize("/a/./b/../c/"), "/a/c");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(basename("/srv/pubmed/"), "pubmed");
    }

    #[test]
    fn names_the_plugins_a_spore_uses() {
        let with = |line: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")))
        };
        assert_eq!(
            with("plugins: [browser, docs]\n").unwrap().plugins,
            vec!["browser", "docs"]
        );
        assert!(parse(WELL_FORMED).unwrap().plugins.is_empty());
        assert_eq!(
            with("plugins: browser\n").unwrap_err(),
            "\"plugins\" must be a list, as plugins: [a, b]"
        );
        assert!(with("plugins: [Browser]\n")
            .unwrap_err()
            .contains("expected the name after spore-plugin-"));
        assert_eq!(
            with("plugins: [docs, docs]\n").unwrap_err(),
            "uses the plugin \"docs\" twice"
        );
    }

    #[test]
    fn names_the_reasoning_each_call_asks_for() {
        let with = |line: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")))
        };
        assert_eq!(
            with("reasoning: [summaries, raw]\n").unwrap().reasoning,
            vec!["summaries", "raw"]
        );
        assert!(parse(WELL_FORMED).unwrap().reasoning.is_empty());
        assert_eq!(
            with("reasoning: summaries\n").unwrap_err(),
            "\"reasoning\" must be a list, as reasoning: [a, b]"
        );
        assert_eq!(
            with("reasoning: [thoughts]\n").unwrap_err(),
            "asks for reasoning \"thoughts\" — expected summaries or raw"
        );
        assert_eq!(
            with("reasoning: [raw, raw]\n").unwrap_err(),
            "asks for reasoning \"raw\" twice"
        );
    }

    #[test]
    fn refuses_plugins_in_a_cell() {
        let known: Vec<String> = TOOLS.iter().map(|t| t.to_string()).collect();
        let source = "---\nname: c\nplugins: [browser]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou work.\n";
        let refused = parse_definition(
            source,
            &Options {
                known_tools: &known,
                cell: true,
                seed: false,
            },
        )
        .unwrap_err();
        assert!(refused.starts_with("uses plugins, which a cell cannot"));
    }

    #[test]
    fn refuses_a_list_field_written_as_a_scalar() {
        let source = WELL_FORMED.replace("tools: [read]", "sources: pubmed");
        assert_eq!(
            parse(&source).unwrap_err(),
            "\"sources\" must be a list, as sources: [a, b]"
        );
    }

    #[test]
    fn a_vector_store_names_the_model_that_makes_its_vectors() {
        let with = |extra: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{extra}")))
        };
        let memory = with("memory: vectors\npush: 5\npull: 20\nembedding: e/small\n")
            .unwrap()
            .memory
            .unwrap();
        assert_eq!(memory.embedding.as_deref(), Some("e/small"));
        assert!(with("memory: vectors\npush: 5\npull: 20\n")
            .unwrap_err()
            .contains("no embedding"));
        assert!(
            with("memory: bm25\npush: 5\npull: 20\nembedding: e/small\n")
                .unwrap_err()
                .contains("embeds nothing")
        );
        assert!(with("embedding: e/small\n")
            .unwrap_err()
            .contains("without memory"));
        assert!(
            with("memory: vectors\npush: 5\npull: 20\nembedding: [a, b]\n")
                .unwrap_err()
                .contains("embedding it cannot read")
        );
    }

    fn cell(source: &str) -> Result<Definition, String> {
        let known: Vec<String> = TOOLS.iter().map(|t| t.to_string()).collect();
        parse_definition(
            source,
            &Options {
                known_tools: &known,
                cell: true,
                seed: false,
            },
        )
    }

    const CHART: &str = "---\nname: charts\ntools: [exec]\nenzymes: [chart=tools/chart.mjs]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou chart.\n\n:::enzyme chart\nDraws a chart.\n:::\n";

    #[test]
    fn reads_what_an_enzyme_needs_beside_itself() {
        let with = cell(&CHART.replace(
            "on-wrap: keep\n",
            "on-wrap: keep\nchart.with: [tools/lib/palette.mjs, tools/templates/]\n",
        ))
        .unwrap();
        assert_eq!(
            with.enzymes[0].with,
            vec!["tools/lib/palette.mjs", "tools/templates/"]
        );
        assert!(cell(CHART).unwrap().enzymes[0].with.is_empty());
        let json = serde_json::to_value(cell(CHART).unwrap()).unwrap();
        assert!(json["enzymes"][0].get("with").is_none());
    }

    #[test]
    fn refuses_what_an_enzyme_cannot_be_given() {
        let refused = |extra: &str| {
            cell(&CHART.replace("on-wrap: keep\n", &format!("on-wrap: keep\n{extra}"))).unwrap_err()
        };
        assert!(refused("chart.needs: [a]\n").contains("an enzyme takes only chart.with"));
        assert!(refused("chart.with: []\n").contains("chart.with it cannot read"));
        assert!(
            refused("sources: [chart]\n").contains("a source and an enzyme both named \"chart\"")
        );
        assert!(refused("other.with: [a]\n").contains("without granting the source"));
    }

    #[test]
    fn reads_what_prepares_each_origin_from_a_plugin_it_uses_at_the_root_only() {
        let with = |lines: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{lines}")))
        };
        const BOUNDS: &str = "prepare.timeout: 45s\nprepare.attach: [20, 200MB]\n";
        let prepared = |entries: &str| format!("plugins: [pdf]\nprepare: [{entries}]\n{BOUNDS}");
        assert_eq!(
            with(&prepared(
                "hook:scans=pdf/SPORE_PDF_PAGES, api:pipeline=pdf/SPORE_PDF_OCR"
            ))
            .unwrap()
            .prepare,
            Some(Prepare {
                steps: vec![
                    PrepareStep {
                        origin: "hook:scans".into(),
                        plugin: "pdf".into(),
                        program: "SPORE_PDF_PAGES".into()
                    },
                    PrepareStep {
                        origin: "api:pipeline".into(),
                        plugin: "pdf".into(),
                        program: "SPORE_PDF_OCR".into()
                    }
                ],
                timeout: 45_000.0,
                attach: Attach {
                    files: 20,
                    bytes: 200 * 1024 * 1024
                }
            })
        );
        assert_eq!(with("").unwrap().prepare, None);
        let refused = |lines: &str| with(lines).unwrap_err();
        assert!(refused(BOUNDS).contains("without prepare"));
        assert_eq!(
            with(&format!(
                "plugins: [ocr]\nprepare: [hook:scans=pdf/SPORE_PDF_PAGES]\n{BOUNDS}"
            ))
            .unwrap()
            .prepare
            .unwrap()
            .steps[0]
                .plugin,
            "pdf"
        );
        assert!(refused(&prepared(
            "hook:scans=pdf/SPORE_PDF_PAGES, hook:scans=pdf/SPORE_PDF_OCR"
        ))
        .contains("twice"));
        for wrong in [
            "scans=pdf/SPORE_PDF_PAGES",
            "chat:x=pdf/SPORE_PDF_PAGES",
            "hook:scans=pages",
            "hook:scans=pdf/SPORE-PDF",
            "hook:scans=pdf/1PAGES",
            "hook:scans",
            "job:Scan=pdf/SPORE_PDF_PAGES",
            "api:a b=pdf/SPORE_PDF_PAGES",
        ] {
            assert!(
                refused(&prepared(wrong)).contains("prepare entry it cannot read"),
                "{wrong}"
            );
        }
        assert!(
            refused("plugins: [pdf]\nprepare: hook:scans=pdf/SPORE_PDF_PAGES\n")
                .contains("needs prepare as a list")
        );
        let bounded = |bounds: &str| {
            refused(&format!(
                "plugins: [pdf]\nprepare: [hook:scans=pdf/SPORE_PDF_PAGES]\n{bounds}"
            ))
        };
        assert!(bounded("prepare.attach: [20, 200MB]\n").contains("without prepare.timeout"));
        assert!(bounded("prepare.timeout: 45s\n").contains("without prepare.attach"));
        assert!(
            bounded("prepare.timeout: 2m\nprepare.attach: [20, 200MB]\n").contains("at most 60s")
        );
        assert!(
            bounded("prepare.timeout: 45s\nprepare.attach: [101, 1MB]\n")
                .contains("prepare.attach it cannot take")
        );
        assert!(bounded("prepare.timeout: 45s\nprepare.attach: [1, 1GB]\n")
            .contains("prepare.attach it cannot take"));
        assert!(refused(&format!(
            "{}sources: [prepare]\n",
            prepared("hook:scans=pdf/SPORE_PDF_PAGES")
        ))
        .contains("source named \"prepare\""));
        assert!(cell(&CHART.replace(
            "on-wrap: keep\n",
            &format!("on-wrap: keep\nprepare: [hook:scans=pdf/SPORE_PDF_PAGES]\n{BOUNDS}")
        ))
        .unwrap_err()
        .contains("root definition's"));
        let json =
            serde_json::to_value(with(&prepared("job:scan=pdf/SPORE_PDF_PAGES")).unwrap()).unwrap();
        assert_eq!(json["prepare"]["steps"][0]["origin"], "job:scan");
        assert!(serde_json::to_value(with("").unwrap())
            .unwrap()
            .get("prepare")
            .is_none());
    }

    #[test]
    fn reads_the_dream_its_limits_and_its_precursor_at_the_root_only() {
        let with = |lines: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{lines}")))
        };
        const COST: &str = "dream.cost: [0.50, 1.00]\n";
        const WALL: &str = "dream.wall: [10m, 15m]\n";
        const NAMED: &str = "dream.precursor: tidy\n";
        let dream = |lines: &str| format!("dream: [50, 1h]\n{lines}");
        assert_eq!(
            with(&dream(&format!("{COST}{WALL}{NAMED}"))).unwrap().dream,
            Some(Dream {
                turns: 50,
                quiet: 3_600_000.0,
                cost: Pair {
                    soft: 0.5,
                    hard: 1.0
                },
                wall: Pair {
                    soft: 600_000.0,
                    hard: 900_000.0
                },
                precursor: "tidy".into()
            })
        );
        let refused = |lines: &str| with(lines).unwrap_err();
        assert!(refused(NAMED).contains("without dream"));
        assert!(refused(&format!("{COST}{WALL}")).contains("without dream"));
        assert!(refused(&dream(&format!("{WALL}{NAMED}"))).contains("without dream.cost"));
        assert!(refused(&dream(&format!("{COST}{NAMED}"))).contains("without dream.wall"));
        assert!(refused(&dream(&format!("{COST}{WALL}"))).contains("without dream.precursor"));
        assert!(refused(&format!("dream: [0, 1h]\n{COST}{WALL}{NAMED}")).contains("dream turns"));
        assert!(refused(&format!("dream: [50, soon]\n{COST}{WALL}{NAMED}")).contains("dream quiet"));
        assert!(refused(&format!("dream: 50\n{COST}{WALL}{NAMED}")).contains("turns and a quiet"));
        assert!(
            refused(&dream(&format!("dream.cost: [1.00, 0.50]\n{WALL}{NAMED}")))
                .contains("hard dream.cost")
        );
        assert!(
            refused(&dream(&format!("{COST}{WALL}dream.precursor: ../spore\n")))
                .contains("dream.precursor it cannot read")
        );
        assert!(
            refused(&dream(&format!("{COST}{WALL}{NAMED}sources: [dream]\n")))
                .contains("source named \"dream\"")
        );
        assert!(cell(&CHART.replace(
            "on-wrap: keep\n",
            &format!("on-wrap: keep\n{}", dream(&format!("{COST}{WALL}{NAMED}")))
        ))
        .unwrap_err()
        .contains("root definition's"));
    }

    #[test]
    fn reads_the_jobs_grant_and_its_bound_at_the_root_only() {
        let with = |lines: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{lines}")))
        };
        assert_eq!(
            with("jobs: [2, 2h]\njobs.maxWait: 30m\n").unwrap().jobs,
            Some(Jobs {
                count: 2,
                wall: 7_200_000.0,
                max_wait: Some(1_800_000.0),
                per_day: None,
                writes: Vec::new()
            })
        );
        assert_eq!(
            with("jobs: [2, 2h]\njobs.perDay: 20\n")
                .unwrap()
                .jobs
                .unwrap()
                .per_day,
            Some(20)
        );
        assert!(with("jobs: [2, 2h]\njobs.perDay: 0\n")
            .unwrap_err()
            .contains("jobs.perDay"));
        assert!(with("jobs.perDay: 20\n")
            .unwrap_err()
            .contains("without jobs"));
        assert_eq!(
            with("jobs: [1, 90s]\n").unwrap().jobs.unwrap().max_wait,
            None
        );
        assert!(with("jobs: [0, 2h]\n").unwrap_err().contains("jobs count"));
        assert!(with("jobs: [2, later]\n")
            .unwrap_err()
            .contains("jobs wall"));
        assert!(with("jobs: 2\n").unwrap_err().contains("count and a wall"));
        assert!(with("jobs.maxWait: 30m\n")
            .unwrap_err()
            .contains("without jobs"));
        assert!(with("jobs: [2, 2h]\njobs.maxWait: soon\n")
            .unwrap_err()
            .contains("jobs.maxWait"));
        assert!(with("jobs: [2, 2h]\nsources: [jobs]\n")
            .unwrap_err()
            .contains("source named \"jobs\""));
        assert!(
            cell(&CHART.replace("on-wrap: keep\n", "on-wrap: keep\njobs: [1, 1h]\n"))
                .unwrap_err()
                .contains("root definition's")
        );
    }

    #[test]
    fn reads_the_models_a_person_may_switch_to_and_the_names_a_precursor_may_run_on() {
        let with = |lines: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{lines}")))
        };
        let read =
            with("models: [a/fast, b/slow]\ncell-models: [low=a/fast, strong=c/best]\n").unwrap();
        assert_eq!(
            read.models,
            vec!["a/fast".to_string(), "b/slow".to_string()]
        );
        assert_eq!(
            read.cell_models,
            vec![
                CellModel {
                    name: "low".into(),
                    model: "a/fast".into()
                },
                CellModel {
                    name: "strong".into(),
                    model: "c/best".into()
                }
            ]
        );
        assert!(with("").unwrap().cell_models.is_empty());
        assert!(with("models: [fast]\n")
            .unwrap_err()
            .contains("not a model"));
        assert!(with("models: [a/x, a/x]\n").unwrap_err().contains("twice"));
        assert!(with("cell-models: [low]\n")
            .unwrap_err()
            .contains("<name>=<provider>/<model>"));
        assert!(with("cell-models: [low=fast]\n")
            .unwrap_err()
            .contains("not a model"));
        assert!(with("cell-models: [low=a/x, low=a/y]\n")
            .unwrap_err()
            .contains("twice"));
        assert!(with("cell-models: low=a/x\n")
            .unwrap_err()
            .contains("must be a list"));

        let precursor =
            |line: &str| cell(&CHART.replace("tools: [exec]\n", &format!("tools: [exec]\n{line}")));
        assert_eq!(
            precursor("model: strong\n").unwrap().model,
            Some("strong".into())
        );
        assert!(precursor("model: openai/gpt-6.1-sol\n")
            .unwrap_err()
            .contains("names one of its spore's cell-models"));
        assert!(precursor("cell-models: [low=a/x]\n")
            .unwrap_err()
            .contains("root definition's"));
    }

    #[test]
    fn lets_a_job_write_only_what_the_spore_writes_and_only_when_named() {
        let with = |lines: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{lines}")))
        };
        let granted = "writes: [here=/srv/proj]\njobs: [2, 2h]\n";
        assert_eq!(
            with(&format!("{granted}jobs.writes: [here]\n"))
                .unwrap()
                .jobs
                .unwrap()
                .writes,
            vec!["here".to_string()]
        );
        assert!(with(granted).unwrap().jobs.unwrap().writes.is_empty());
        assert!(with(&format!("{granted}jobs.writes: [there]\n"))
            .unwrap_err()
            .contains("names there in jobs.writes, which writes does not grant"));
        assert!(with(&format!("{granted}jobs.writes: here\n"))
            .unwrap_err()
            .contains("must be a list"));
        assert!(with("writes: [here=/srv/proj]\njobs.writes: [here]\n")
            .unwrap_err()
            .contains("without jobs"));
    }

    #[test]
    fn reads_the_schedules_grant_at_the_root_only() {
        let with = |line: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")))
        };
        assert_eq!(
            with("schedules: [4, 1h]\n").unwrap().schedules,
            Some(Schedules {
                count: 4,
                interval: 3_600_000.0
            })
        );
        assert!(with("schedules: [0, 1h]\n")
            .unwrap_err()
            .contains("schedules count"));
        assert!(with("schedules: [4, 30s]\n")
            .unwrap_err()
            .contains("at least a minute"));
        assert!(with("schedules: 4\n")
            .unwrap_err()
            .contains("count and an interval"));
        assert!(
            cell(&CHART.replace("on-wrap: keep\n", "on-wrap: keep\nschedules: [4, 1h]\n"))
                .unwrap_err()
                .contains("root definition's")
        );
    }

    #[test]
    fn takes_home_from_the_account_whatever_home_says() {
        let home = account_home().expect("the test runs as an account with a home");
        let saved = std::env::var_os("HOME");
        std::env::set_var("HOME", "/nowhere/agent-home");
        let read =
            parse(&WELL_FORMED.replace("tools: [read]\n", "tools: [read]\nreads: [~/bin]\n"));
        match saved {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(
            read.unwrap().reads,
            vec![Grant {
                name: "bin".into(),
                path: format!("{home}/bin")
            }]
        );
    }

    #[test]
    fn reads_the_directories_it_reads_and_writes_under_one_namespace() {
        let with = |line: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")))
        };
        let d = with("reads: [papers=/srv/papers]\nwrites: [here=/srv/proj]\n").unwrap();
        assert_eq!(
            (d.reads, d.writes),
            (
                vec![Grant {
                    name: "papers".into(),
                    path: "/srv/papers".into()
                }],
                vec![Grant {
                    name: "here".into(),
                    path: "/srv/proj".into()
                }]
            )
        );
        assert_eq!(
            with("writes: [/srv/proj]\n").unwrap().writes[0].name,
            "proj"
        );
        assert!(with("reads: [p=/a]\nwrites: [p=/b]\n")
            .unwrap_err()
            .contains("two grants named \"p\""));
        assert!(with("writes: [here=]\n")
            .unwrap_err()
            .contains("a write with no path"));
        assert!(with("writes: here=/srv/proj\n")
            .unwrap_err()
            .contains("must be a list"));
    }

    #[test]
    fn refuses_a_grant_named_as_what_the_workspace_holds() {
        for name in WORKSPACE_NAMES {
            for field in ["reads", "writes"] {
                let line = format!("{field}: [{name}=/srv/x]\n");
                let refused = parse(
                    &WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")),
                )
                .unwrap_err();
                assert!(
                    refused.contains("the workspace already uses"),
                    "{field} {name}: {refused}"
                );
            }
        }
    }

    #[test]
    fn a_cell_writes_nowhere_but_its_own_directory() {
        assert!(cell(&CHART.replace(
            "on-wrap: keep\n",
            "on-wrap: keep\nwrites: [here=/srv/proj]\n"
        ))
        .unwrap_err()
        .contains("declares writes"));
        assert!(cell(&CHART.replace(
            "on-wrap: keep\n",
            "on-wrap: keep\nreads: [papers=/srv/papers]\n"
        ))
        .is_ok());
    }

    #[test]
    fn a_cell_is_not_granted_quiet() {
        let known: Vec<String> = ["read", "quiet"].iter().map(|t| t.to_string()).collect();
        let source = CHART
            .replace("tools: [exec]", "tools: [exec, quiet]")
            .replace("enzymes: [chart=tools/chart.mjs]\n", "")
            .replace("\n:::enzyme chart\nDraws a chart.\n:::\n", "\n");
        let refused = parse_definition(
            &source,
            &Options {
                known_tools: &[known, vec!["exec".to_string()]].concat(),
                cell: true,
                seed: false,
            },
        )
        .unwrap_err();
        assert!(refused.contains("grants \"quiet\""), "{refused}");
    }

    #[test]
    fn refuses_a_relative_grant_path() {
        let with = |line: &str| {
            parse(&WELL_FORMED.replace("tools: [read]\n", &format!("tools: [read]\n{line}")))
        };
        assert!(with("reads: [papers=corpus]\n")
            .unwrap_err()
            .contains("a relative path"));
        assert!(with("writes: [here=../proj]\n")
            .unwrap_err()
            .contains("a relative path"));
        assert_eq!(
            with("reads: [papers=/srv/papers]\n").unwrap().reads[0].path,
            "/srv/papers"
        );
    }

    #[test]
    fn refuses_a_source_granted_twice() {
        let refused = parse(&WELL_FORMED.replace(
            "tools: [read]\n",
            "tools: [read]\nsources: [ledger, ledger]\n",
        ))
        .unwrap_err();
        assert!(
            refused.contains("grants the source \"ledger\" twice"),
            "{refused}"
        );
    }

    #[test]
    fn reads_a_spores_model_as_provider_and_name() {
        let refused = parse(&WELL_FORMED.replace("model: m/1", "model: fast")).unwrap_err();
        assert!(refused.contains("expected <provider>/<name>"), "{refused}");
        assert!(refused.contains("anthropic/claude-sonnet-5-5"), "{refused}");
    }

    #[test]
    fn takes_one_value_where_a_field_takes_one_and_digits_where_it_counts() {
        let with =
            |field: &str| parse(&WELL_FORMED.replacen("---\n", &format!("---\n{field}\n"), 1));
        assert!(with("retain: [3]").unwrap_err().contains("takes one value"));
        assert!(with("memory: [bm25]\npush: 5\npull: 20")
            .unwrap_err()
            .contains("takes one value"));
        for loose in ["retain: 1e1", "retain: +5", "retain: 2.0", "history: 6.4e4"] {
            assert!(with(loose).unwrap_err().contains("cannot read"), "{loose}");
        }
        assert!(with("memory: bm25\npush: 5.0\npull: 20")
            .unwrap_err()
            .contains("cannot read"));
        assert!(with("jobs: [2.0, 2h]").unwrap_err().contains("cannot read"));
        assert!(with("jobs: [2, 2h]\njobs.perDay: 1e2")
            .unwrap_err()
            .contains("cannot read"));
        assert_eq!(with("retain: 3").unwrap().retain, Some(3));
    }

    #[test]
    fn reads_an_enzyme_block_written_with_crlf_line_endings() {
        let d = cell(&CHART.replace('\n', "\r\n")).unwrap();
        assert_eq!(d.enzymes[0].description.as_deref(), Some("Draws a chart."));
    }

    const DESCRIBED: &str = "\n\n:::call contract\ntool: read\ntitle: reading the contract\ncategory: read\n:::\n\n:::call search\ntool: [exec, wsexec]\nprogram: ^node \"?\\$SPORE_DA\"? search (.+)$\ntitle: searching for $1\ncategory: search\n:::\n";

    #[test]
    fn takes_call_blocks_out_of_the_identity_in_the_order_written() {
        let d = parse(&format!("{WELL_FORMED}{DESCRIBED}")).unwrap();
        assert_eq!(d.identity, "You read.");
        let names: Vec<&str> = d.calls.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["contract", "search"]);
        assert_eq!(d.calls[1].tools, vec!["exec", "wsexec"]);
        assert!(parse(WELL_FORMED).unwrap().calls.is_empty());
    }

    #[test]
    fn refuses_a_call_block_it_cannot_use() {
        let refused =
            |block: &str| parse(&format!("{WELL_FORMED}\n:::call x\n{block}\n:::\n")).unwrap_err();
        assert!(refused("tool: read\ntitle: t\ncategory: shelf")
            .contains("\":::call x\" has a category"));
        assert!(refused("tool: read\ntitle: t").contains("category"));
        let twice = format!("{WELL_FORMED}{DESCRIBED}\n:::call contract\ntool: edit\ntitle: t\ncategory: edit\n:::\n");
        assert!(parse(&twice)
            .unwrap_err()
            .contains("two \":::call contract\" blocks"));
        assert!(parse(&format!("{WELL_FORMED}\n:::call x\ntool: read\n"))
            .unwrap_err()
            .contains("\":::call x\" left open"));
    }

    #[test]
    fn refuses_a_call_block_in_a_cell() {
        let source = CHART.replacen("\n:::enzyme", &format!("{DESCRIBED}\n:::enzyme"), 1);
        assert!(cell(&source).unwrap_err().contains("shown to no one"));
    }
}

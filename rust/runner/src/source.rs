//! Named endpoints, held where the agent cannot reach them.
//!
//! An agent can already call the network; what it cannot have is the credential. `wsexec`
//! hands the environment to every command, and a key in a call record is a key in the
//! transcript — the reasoning that put provider keys behind the model socket. So a
//! definition grants a *name*, the host's `sources.json` says what the name means, and the
//! runner holds the secret and makes the call. The agent never learns the URL: one it could
//! read is one it could call without the runner.
//!
//! Everything a host could get wrong is refused at load, before a socket exists: a secret
//! that is not set is a header the endpoint rejects minutes into a turn, and a source that
//! should have been narrowed and was not is the difference between a session reaching its
//! own material and reaching everyone's — nothing at call time would say which was meant.
//! A host default outside the grant is refused for the same reason: it would outrank the
//! narrowing.
//!
//! A cell asks within a *view*: the sources and scopes its precursor names, sent with each
//! request. The view narrows what the cell is shown and what is filled in for it; it is not a
//! boundary. The tree is one trust unit, and a cell that sends no view is answered within the
//! root's grant. A view wider than the grant is refused, since it names what the tree cannot
//! reach.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use hyper::{Method, Request, Response, StatusCode, Uri};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::{json, Map, Value};
use spore_definition::Ordered;
use url::Url;

use crate::broker::{answer, read_json, Refusal};
use crate::dial::{https_client, socket_path, Dial, Net};

pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(30);

const FIELDS: [&str; 8] = [
    "url", "socket", "method", "methods", "paths", "requires", "query", "headers",
];

struct Source {
    url: Url,
    dial: Dial,
    method: Method,
    /// The methods a call may ask for; none means the one `method`.
    methods: Option<Vec<Method>>,
    /// The paths under `url` a call may name, as segment patterns: `*` is one segment, `**`
    /// one or more. None means the source is called at `url` alone.
    paths: Option<Vec<Vec<String>>>,
    requires: Vec<String>,
    query: Vec<(String, String)>,
    headers: Vec<(HeaderName, HeaderValue)>,
}

/// A path as the agent gave it, in segments: none empty, none `.` or `..`, so joining it under
/// the source's url can only go deeper.
fn segments(path: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = path
        .trim_start_matches('/')
        .split('/')
        .map(str::to_string)
        .collect();
    parts
        .iter()
        .all(|part| !part.is_empty() && part != "." && part != "..")
        .then_some(parts)
}

fn matches(pattern: &[String], path: &[String]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((head, rest)) if head == "**" => (1..=path.len()).any(|n| matches(rest, &path[n..])),
        Some((head, rest)) => {
            !path.is_empty() && (head == "*" || *head == path[0]) && matches(rest, &path[1..])
        }
    }
}

type Scope = Vec<(String, Vec<String>)>;

/// The one narrowing that is not a query parameter: `<source>.path` holds the patterns a call's
/// path must also match, within the host's.
const PATH: &str = "path";

fn narrowed_paths(scope: &Scope) -> Option<Vec<Vec<String>>> {
    scope
        .iter()
        .find(|(param, _)| param == PATH)
        .map(|(_, patterns)| patterns.iter().filter_map(|p| segments(p)).collect())
}

pub struct Sources {
    granted: Vec<String>,
    resolved: HashMap<String, Source>,
    scopes: Ordered<Ordered<Vec<String>>>,
}

fn invalid(message: impl Into<String>, detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "SOURCE_INVALID",
        message,
        detail,
    )
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `value` with each `${VAR}` replaced from `env`; the error names the first variable not set.
pub(crate) fn fill_variables(
    value: &str,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let ident = after
            .char_indices()
            .take_while(|(i, c)| {
                c.is_ascii_alphabetic() || *c == '_' || (*i > 0 && c.is_ascii_digit())
            })
            .count();
        if ident > 0 && after[ident..].starts_with('}') {
            let variable = &after[..ident];
            out.push_str(&env(variable).ok_or_else(|| variable.to_string())?);
            rest = &after[ident + 1..];
        } else {
            out.push_str("${");
            rest = after;
        }
    }
    out.push_str(rest);
    Ok(out)
}

fn fill(name: &str, value: &str, env: &impl Fn(&str) -> Option<String>) -> Result<String, Refusal> {
    fill_variables(value, env).map_err(|variable| {
        Refusal::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SOURCE_SECRET_MISSING",
            format!("source \"{name}\" wants ${variable}, which is not set here"),
            "the host resolves a source's secrets from its own environment; the agent never sees either",
        )
    })
}

const NAMED_HEADER: &str =
    "a header may hold {name}, the calling spore's name, which the runner fills";

fn placeholders(raw: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = raw[at..].find('{').map(|i| i + at) {
        let ident = raw[open + 1..]
            .char_indices()
            .take_while(|(i, c)| {
                c.is_ascii_alphabetic()
                    || *c == '_'
                    || (*i > 0 && (c.is_ascii_digit() || *c == '.'))
            })
            .count();
        let close = open + 1 + ident;
        if ident > 0 && raw[close..].starts_with('}') && !raw[..open].ends_with('$') {
            found.push((open, close + 1));
            at = close + 1;
        } else {
            at = open + 1;
        }
    }
    found
}

fn with_name(source: &str, header: &str, raw: &str, spore: &str) -> Result<String, Refusal> {
    let mut out = String::with_capacity(raw.len());
    let mut from = 0;
    for (start, end) in placeholders(raw) {
        let placeholder = &raw[start + 1..end - 1];
        if placeholder != "name" {
            return Err(invalid(
                format!("source \"{source}\" has {{{placeholder}}} in its {header} header, which spore does not fill"),
                NAMED_HEADER,
            ));
        }
        out.push_str(&raw[from..start]);
        out.push_str(spore);
        from = end;
    }
    out.push_str(&raw[from..]);
    Ok(out)
}

fn unnamed(source: &str, field: &str, raw: &str) -> Result<(), Refusal> {
    if placeholders(raw)
        .into_iter()
        .any(|(start, end)| &raw[start + 1..end - 1] == "name")
    {
        return Err(invalid(
            format!("source \"{source}\" has {{name}} in its {field}"),
            "only a header takes {name}, which the runner fills and the agent cannot replace",
        ));
    }
    Ok(())
}

fn resolve(
    name: &str,
    spec: &Value,
    spore: &str,
    env: &impl Fn(&str) -> Option<String>,
    net: &Net,
) -> Result<Source, Refusal> {
    let shape =
        "a source is { url, socket?, query?, headers?, method?, methods?, paths?, requires? }";
    if let Some(unknown) = spec
        .as_object()
        .and_then(|fields| fields.keys().find(|k| !FIELDS.contains(&k.as_str())))
    {
        return Err(invalid(
            format!(
                "source \"{name}\" has \"{unknown}\", which is not one of {}",
                FIELDS.join(", ")
            ),
            shape,
        ));
    }
    let raw = match spec.get("url") {
        Some(Value::String(url)) if !url.is_empty() => url,
        _ => return Err(invalid(format!("source \"{name}\" has no url"), shape)),
    };
    unnamed(name, "url", raw)?;
    let filled = fill(name, raw, env)?;
    let url = Url::parse(&filled).map_err(|e| {
        invalid(
            format!("source \"{name}\" has a url that does not parse"),
            e.to_string(),
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid(
            format!("source \"{name}\" is not an http:// or https:// url"),
            shape,
        ));
    }
    let dial = match spec.get("socket") {
        None => Dial::Net(net.clone()),
        Some(Value::String(raw)) => {
            unnamed(name, "socket", raw)?;
            let path = socket_path(&fill(name, raw, env)?, &url).map_err(|why| {
                invalid(format!("source \"{name}\" has a socket it cannot use"), why)
            })?;
            Dial::Socket(path)
        }
        Some(_) => {
            return Err(invalid(
                format!("source \"{name}\" has a socket that is not a path"),
                shape,
            ))
        }
    };
    let method = spec
        .get("method")
        .map(text)
        .unwrap_or_else(|| "GET".into())
        .to_ascii_uppercase();
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| {
        invalid(
            format!("source \"{name}\" has a method \"{method}\" that is not one"),
            shape,
        )
    })?;
    let methods = match spec.get("methods") {
        None => None,
        Some(value) => {
            let named = strings(value)
                .filter(|names| !names.is_empty())
                .ok_or_else(|| {
                    invalid(
                        format!("source \"{name}\" has methods that are not a list of methods"),
                        shape,
                    )
                })?;
            Some(
                named
                    .iter()
                    .map(|m| {
                        Method::from_bytes(m.to_ascii_uppercase().as_bytes()).map_err(|_| {
                            invalid(
                                format!("source \"{name}\" has a method \"{m}\" that is not one"),
                                shape,
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
    };
    let paths = match spec.get("paths") {
        None => None,
        Some(value) => {
            let patterns = strings(value).filter(|p| !p.is_empty()).ok_or_else(|| {
                invalid(
                    format!("source \"{name}\" has paths that are not a list of paths"),
                    shape,
                )
            })?;
            if !url.path().ends_with('/') {
                return Err(invalid(
                    format!("source \"{name}\" has paths, and a url that does not end in /"),
                    "the paths a call names are joined under the url, so it ends where they begin",
                ));
            }
            Some(
                patterns
                    .iter()
                    .map(|pattern| {
                        segments(pattern).ok_or_else(|| {
                            invalid(
                                format!("source \"{name}\" has a path \"{pattern}\" with an empty, . or .. segment"),
                                "a path is segments under the url: team/project/issues, team/*/issues, team/**",
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
    };
    let requires = match spec.get("requires") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(text).collect(),
        Some(_) => {
            return Err(invalid(
                format!("source \"{name}\" has requires that is not a list"),
                shape,
            ))
        }
    };
    let pairs = |field: &str| -> Result<Vec<(String, String)>, Refusal> {
        match spec.get(field) {
            None => Ok(Vec::new()),
            Some(Value::Object(map)) => map
                .iter()
                .map(|(k, v)| {
                    let raw = text(v);
                    let raw = if field == "headers" {
                        with_name(name, k, &raw, spore)?
                    } else {
                        unnamed(name, field, &raw)?;
                        raw
                    };
                    Ok((k.clone(), fill(name, &raw, env)?))
                })
                .collect(),
            Some(_) => Err(invalid(
                format!("source \"{name}\" has {field} that is not an object"),
                shape,
            )),
        }
    };
    let query = pairs("query")?;
    let headers = pairs("headers")?
        .into_iter()
        .map(|(k, v)| {
            let header = HeaderName::from_bytes(k.as_bytes()).map_err(|_| {
                invalid(
                    format!("source \"{name}\" has a header \"{k}\" that is not a header name"),
                    shape,
                )
            })?;
            let value = HeaderValue::from_str(&v).map_err(|_| {
                invalid(
                    format!(
                        "source \"{name}\" has a value for {k} that cannot be sent in a header"
                    ),
                    shape,
                )
            })?;
            Ok((header, value))
        })
        .collect::<Result<_, Refusal>>()?;
    Ok(Source {
        url,
        dial,
        method,
        methods,
        paths,
        requires,
        query,
        headers,
    })
}

fn set(pairs: &mut Vec<(String, String)>, key: &str, value: String) {
    match pairs.iter().position(|(k, _)| k == key) {
        Some(at) => {
            pairs[at].1 = value;
            let mut seen = false;
            pairs.retain(|(k, _)| {
                if k != key {
                    return true;
                }
                let first = !seen;
                seen = true;
                first
            });
        }
        None => pairs.push((key.to_string(), value)),
    }
}

/// A definition's `<source>.path`: each pattern a path, and one the host's patterns allow.
fn narrows_within(name: &str, source: &Source, allowed: &[String]) -> Result<(), Refusal> {
    let refused = |message: String, detail: String| {
        Refusal::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SOURCE_PATH_REFUSED",
            message,
            detail,
        )
    };
    let Some(patterns) = &source.paths else {
        return Err(refused(
            format!("\"{name}\" takes no path, so {name}.{PATH} narrows nothing"),
            "this host calls it at one address — drop the line".into(),
        ));
    };
    for pattern in allowed {
        let Some(parts) = segments(pattern) else {
            return Err(refused(
                format!("{name}.{PATH} has \"{pattern}\", which is not a path"),
                "segments joined by /, * standing for one and ** for one or more".into(),
            ));
        };
        if !patterns.iter().any(|host| matches(host, &parts)) {
            return Err(refused(
                format!("{name}.{PATH} allows {pattern}, which the host does not"),
                format!(
                    "this host allows {}",
                    patterns
                        .iter()
                        .map(|p| p.join("/"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    }
    Ok(())
}

impl Sources {
    /// `file` is the host's `sources.json`, needed once the definition grants a source the
    /// host describes; `plugins` are the sources the plugins a spore uses describe, granted with
    /// them. Either way a secret is the host's, resolved from the runner's own environment.
    /// `spore` is the name of the spore this runner serves: a header's `{name}`, sent on every
    /// call its tree makes, since its cells call through these same sources.
    pub fn load(
        spore: &str,
        file: Option<&Path>,
        granted: &[String],
        scopes: &Ordered<Ordered<Vec<String>>>,
        plugins: &Map<String, Value>,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Arc<Sources>, Refusal> {
        let where_ = file.map_or("the host".to_string(), |f| f.display().to_string());
        let unreadable = |detail: String| {
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SOURCES_UNREADABLE",
                format!("{where_} is not readable JSON"),
                detail,
            )
        };
        let declared = match file {
            None => Map::new(),
            Some(file) => {
                let raw = std::fs::read_to_string(file).map_err(|e| unreadable(e.to_string()))?;
                match serde_json::from_str(&raw).map_err(|e| unreadable(e.to_string()))? {
                    Value::Object(declared) => declared,
                    _ => {
                        return Err(unreadable(
                            "it holds named sources, as { name: { url, … } }".into(),
                        ))
                    }
                }
            }
        };
        let mut declared = declared;
        for (name, spec) in plugins {
            if spec.get("socket").is_some() {
                return Err(invalid(
                    format!("a plugin's source \"{name}\" names a socket"),
                    "where a socket is mounted is this host's to say — describe the source in sources.json",
                ));
            }
            if declared.contains_key(name) {
                return Err(invalid(
                    format!("{where_} and a plugin both describe \"{name}\""),
                    "rename or remove the host's — a spore using the plugin gets the plugin's",
                ));
            }
            declared.insert(name.clone(), spec.clone());
        }
        let mut granted: Vec<String> = granted.to_vec();
        for name in plugins.keys() {
            if !granted.contains(name) {
                granted.push(name.clone());
            }
        }

        let net = https_client();
        let mut resolved = HashMap::new();
        for name in &granted {
            let spec = declared.get(name).ok_or_else(|| {
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SOURCE_UNKNOWN",
                    format!("no source called \"{name}\" on this host"),
                    format!("the definition grants it and {where_} does not describe it"),
                )
            })?;
            let source = resolve(name, spec, spore, &env, &net)?;
            let narrowed = scopes.get(name);
            for param in &source.requires {
                if narrowed
                    .and_then(|n| n.get(param))
                    .map_or(true, Vec::is_empty)
                {
                    return Err(Refusal::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "SOURCE_UNSCOPED",
                        format!("\"{name}\" may not be called without saying which {param}"),
                        format!(
                            "this host requires it — declare {name}.{param}: [ … ] beside sources"
                        ),
                    ));
                }
            }
            for (param, allowed) in narrowed.map(|n| n.0.as_slice()).unwrap_or_default() {
                if param == PATH {
                    narrows_within(name, &source, allowed)?;
                    continue;
                }
                if let Some((_, fallback)) = source.query.iter().find(|(k, _)| k == param) {
                    if !allowed.contains(fallback) {
                        return Err(Refusal::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "SOURCE_DEFAULT_OUT_OF_SCOPE",
                            format!("\"{name}\" defaults {param} to \"{fallback}\", which this definition does not allow"),
                            format!("it may ask for {} — a default outside that would outrank the narrowing", allowed.join(", ")),
                        ));
                    }
                }
            }
            resolved.insert(name.clone(), source);
        }

        Ok(Arc::new(Sources {
            granted,
            resolved,
            scopes: scopes.clone(),
        }))
    }

    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let (method, path) = (req.method().clone(), req.uri().path().to_string());
        let asked = match (&method, path.as_str()) {
            (&Method::POST, "/list" | "/fetch") => read_json(req).await,
            _ => return not_found_response(&method, &path),
        };
        answer(match asked {
            Ok(asked) if path == "/list" => self.list(asked.get("view")),
            Ok(asked) => self.fetch(&asked).await,
            Err(refusal) => Err(refusal),
        })
    }

    fn granted_scope(&self, name: &str) -> Scope {
        self.scopes
            .get(name)
            .map(|n| n.0.clone())
            .unwrap_or_default()
    }

    fn listed(&self) -> String {
        if self.granted.is_empty() {
            "no sources".to_string()
        } else {
            self.granted.join(", ")
        }
    }

    /// The sources and scopes a request is answered within: the grant, or a cell's view of
    /// it, each view value checked against the grant and the host's defaults.
    fn within(&self, view: Option<&Value>) -> Result<Vec<(String, Scope)>, Refusal> {
        let Some(view) = view.filter(|v| !v.is_null()) else {
            return Ok(self
                .granted
                .iter()
                .map(|name| (name.clone(), self.granted_scope(name)))
                .collect());
        };
        let malformed = || {
            Refusal::new(
                StatusCode::BAD_REQUEST,
                "PROTOCOL_INVALID_REQUEST",
                "a view is { sources: [names], scopes?: { name: { param: [values] } } }",
                "",
            )
        };
        let names = view
            .get("sources")
            .and_then(strings)
            .ok_or_else(malformed)?;
        let narrowings = match view.get("scopes") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(map)) => map.clone(),
            Some(_) => return Err(malformed()),
        };
        if narrowings.keys().any(|name| !names.contains(name)) {
            return Err(malformed());
        }
        names
            .iter()
            .map(|name| {
                let Some(source) = self.resolved.get(name) else {
                    return Err(Refusal::new(
                        StatusCode::FORBIDDEN,
                        "SOURCE_NOT_GRANTED",
                        format!("the view names \"{name}\", which this spore was not granted"),
                        format!("its definition lists {}", self.listed()),
                    ));
                };
                let mut scope = self.granted_scope(name);
                let Some(narrowing) = narrowings.get(name) else {
                    return Ok((name.clone(), scope));
                };
                for (param, values) in narrowing.as_object().ok_or_else(malformed)? {
                    let values = strings(values).ok_or_else(malformed)?;
                    match scope.iter_mut().find(|(p, _)| p == param) {
                        Some((_, allowed)) => {
                            if let Some(value) = values.iter().find(|v| !allowed.contains(v)) {
                                return Err(Refusal::new(
                                    StatusCode::FORBIDDEN,
                                    "SOURCE_OUT_OF_SCOPE",
                                    format!("the view lets \"{name}\" ask for {param} \"{value}\", which this spore may not"),
                                    format!("this spore may ask for {}", allowed.join(", ")),
                                ));
                            }
                            *allowed = values;
                        }
                        None => scope.push((param.clone(), values)),
                    }
                    let (_, allowed) = scope.iter().find(|(p, _)| p == param).expect("just set");
                    if param == PATH {
                        continue;
                    }
                    if let Some((_, fallback)) = source.query.iter().find(|(k, _)| k == param) {
                        if !allowed.contains(fallback) {
                            return Err(Refusal::new(
                                StatusCode::FORBIDDEN,
                                "SOURCE_DEFAULT_OUT_OF_SCOPE",
                                format!("\"{name}\" defaults {param} to \"{fallback}\", which the view does not allow"),
                                format!("it may ask for {} — a default outside that would outrank the narrowing", allowed.join(", ")),
                            ));
                        }
                    }
                }
                Ok((name.clone(), scope))
            })
            .collect()
    }

    fn list(&self, view: Option<&Value>) -> Result<Value, Refusal> {
        let sources: Vec<Value> = self
            .within(view)?
            .into_iter()
            .map(|(name, scope)| {
                let narrowed = scope
                    .iter()
                    .find(|(p, _)| p == PATH)
                    .map(|(_, v)| v.clone());
                let scope: Map<String, Value> = scope
                    .into_iter()
                    .filter(|(p, _)| p != PATH)
                    .map(|(p, v)| (p, json!(v)))
                    .collect();
                let source = &self.resolved[&name];
                let mut shown = json!({ "name": name, "scope": scope });
                if let Some(methods) = &source.methods {
                    shown["methods"] =
                        json!(methods.iter().map(Method::as_str).collect::<Vec<_>>());
                }
                if let Some(paths) = &source.paths {
                    shown["base"] = json!(source.url.path());
                    shown["paths"] = match narrowed {
                        Some(narrowed) => json!(narrowed),
                        None => json!(paths.iter().map(|p| p.join("/")).collect::<Vec<_>>()),
                    };
                }
                shown
            })
            .collect();
        Ok(json!({ "sources": sources }))
    }

    async fn fetch(&self, asked: &Value) -> Result<Value, Refusal> {
        let request = |detail: &str| {
            Refusal::new(
                StatusCode::BAD_REQUEST,
                "PROTOCOL_INVALID_REQUEST",
                "a fetch is { source, params?, method?, path?, body? }",
                detail,
            )
        };
        let Some(name) = asked.get("source").and_then(Value::as_str) else {
            return Err(request("no source named"));
        };
        let params = match asked.get("params") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => return Err(request("params is an object of query parameters")),
        };
        let view = asked.get("view").filter(|v| !v.is_null());
        let within = self.within(view)?;
        let (Some(source), Some((_, scope))) = (
            self.resolved.get(name),
            within.iter().find(|(shown, _)| shown == name),
        ) else {
            return Err(match view {
                None => Refusal::new(
                    StatusCode::FORBIDDEN,
                    "SOURCE_NOT_GRANTED",
                    format!("this spore was not granted \"{name}\""),
                    format!("its definition lists {}", self.listed()),
                ),
                Some(_) => Refusal::new(
                    StatusCode::FORBIDDEN,
                    "SOURCE_NOT_GRANTED",
                    format!("this cell was not given \"{name}\""),
                    format!(
                        "its precursor lists {}",
                        within
                            .iter()
                            .map(|(n, _)| n.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ),
            });
        };

        let mut query = source.query.clone();
        for (k, v) in &params {
            set(&mut query, k, text(v));
        }
        for (param, values) in scope.iter().filter(|(param, _)| param != PATH) {
            match query.iter().find(|(k, _)| k == param) {
                None if values.len() == 1 => query.push((param.clone(), values[0].clone())),
                None => {
                    return Err(Refusal::new(
                        StatusCode::BAD_REQUEST,
                        "SOURCE_SCOPE_REQUIRED",
                        format!("\"{name}\" needs a {param}"),
                        format!("pass --{param} with one of {}", values.join(", ")),
                    ))
                }
                Some((_, value)) if !values.contains(value) => {
                    return Err(Refusal::new(
                        StatusCode::FORBIDDEN,
                        "SOURCE_OUT_OF_SCOPE",
                        format!("\"{name}\" may not be asked for {param} \"{value}\""),
                        format!("this spore may ask for {}", values.join(", ")),
                    ))
                }
                Some(_) => {}
            }
        }

        let method = match asked.get("method") {
            None | Some(Value::Null) => source.method.clone(),
            Some(Value::String(m)) => Method::from_bytes(m.to_ascii_uppercase().as_bytes())
                .map_err(|_| request("method is an HTTP method"))?,
            Some(_) => return Err(request("method is an HTTP method")),
        };
        let allowed = source
            .methods
            .clone()
            .unwrap_or_else(|| vec![source.method.clone()]);
        if !allowed.contains(&method) {
            return Err(Refusal::new(
                StatusCode::FORBIDDEN,
                "SOURCE_METHOD_REFUSED",
                format!("\"{name}\" may not be called with {method}"),
                format!(
                    "this host allows {}",
                    allowed
                        .iter()
                        .map(Method::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        let path = match asked.get("path") {
            None | Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.clone()),
            Some(_) => return Err(request("path is text")),
        };
        let joined = match (&source.paths, path) {
            (None, None) => None,
            (None, Some(_)) => {
                return Err(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "SOURCE_PATH_REFUSED",
                    format!("\"{name}\" takes no path"),
                    "this host calls it at one address",
                ))
            }
            (Some(patterns), None) => {
                return Err(Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "SOURCE_PATH_REQUIRED",
                    format!("\"{name}\" needs a path"),
                    format!(
                        "pass --path under one of {}",
                        narrowed_paths(scope)
                            .as_ref()
                            .unwrap_or(patterns)
                            .iter()
                            .map(|p| p.join("/"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ))
            }
            (Some(patterns), Some(path)) => {
                let parts = segments(&path)
                    .filter(|parts| patterns.iter().any(|pattern| matches(pattern, parts)));
                match parts {
                    Some(parts) => match narrowed_paths(scope) {
                        Some(narrowed) if !narrowed.iter().any(|p| matches(p, &parts)) => {
                            return Err(Refusal::new(
                                StatusCode::FORBIDDEN,
                                "SOURCE_OUT_OF_SCOPE",
                                format!("\"{name}\" may not be called at {path} by this spore"),
                                format!(
                                    "it may call {}",
                                    narrowed
                                        .iter()
                                        .map(|p| p.join("/"))
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                ),
                            ))
                        }
                        _ => Some(parts),
                    },
                    None => {
                        return Err(Refusal::new(
                            StatusCode::FORBIDDEN,
                            "SOURCE_PATH_REFUSED",
                            format!("\"{name}\" may not be called at {path}"),
                            format!(
                                "this host allows {}",
                                patterns
                                    .iter()
                                    .map(|p| p.join("/"))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ))
                    }
                }
            }
        };
        let body = match asked.get("body") {
            None | Some(Value::Null) => None,
            Some(_) if method == Method::GET || method == Method::HEAD => {
                return Err(request("a GET or HEAD carries no body"))
            }
            Some(body) => Some(body.to_string()),
        };

        let mut url = source.url.clone();
        if let Some(parts) = joined {
            url.path_segments_mut()
                .expect("an http url has a path")
                .pop_if_empty()
                .extend(parts);
        }
        if !query.is_empty() {
            let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
            for (k, v) in query {
                set(&mut pairs, &k, v);
            }
            url.query_pairs_mut().clear().extend_pairs(pairs);
        }
        let uri: Uri = url
            .as_str()
            .parse()
            .map_err(|e: hyper::http::uri::InvalidUri| {
                invalid(
                    format!("\"{name}\" makes a url that cannot be sent"),
                    e.to_string(),
                )
            })?;
        let sends_json = body.is_some();
        let mut outgoing = Request::builder()
            .method(method)
            .uri(uri)
            .body(Full::new(body.map(Bytes::from).unwrap_or_default()))
            .expect("a validated request builds");
        if sends_json {
            outgoing
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        for (header, value) in &source.headers {
            outgoing.headers_mut().insert(header.clone(), value.clone());
        }

        let exchange = async {
            let response = source.dial.send(outgoing).await.map_err(|detail| {
                Refusal::new(
                    StatusCode::BAD_GATEWAY,
                    "SOURCE_UNREACHABLE",
                    format!("\"{name}\" could not be reached"),
                    detail,
                )
                .retryable()
            })?;
            let status = response.status();
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let mut body = response.into_body();
            let mut bytes = Vec::new();
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|e| {
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "SOURCE_UNREACHABLE",
                        format!("\"{name}\" stopped answering"),
                        e.to_string(),
                    )
                    .retryable()
                })?;
                if let Some(data) = frame.data_ref() {
                    bytes.extend_from_slice(data);
                    if bytes.len() > MAX_RESPONSE_BYTES {
                        return Err(Refusal::new(
                            StatusCode::BAD_GATEWAY,
                            "SOURCE_TOO_LARGE",
                            format!("\"{name}\" returned more than this broker will pass on"),
                            format!("past a {MAX_RESPONSE_BYTES} byte ceiling — narrow the query"),
                        ));
                    }
                }
            }
            Ok(json!({
                "status": status.as_u16(),
                "ok": status.is_success(),
                "contentType": content_type,
                "bodyBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }))
        };
        tokio::time::timeout(TIMEOUT, exchange)
            .await
            .unwrap_or_else(|_| {
                Err(Refusal::new(
                    StatusCode::GATEWAY_TIMEOUT,
                    "SOURCE_TIMEOUT",
                    format!("\"{name}\" did not answer within {} s", TIMEOUT.as_secs()),
                    "narrow the query, or ask again",
                )
                .retryable())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use tokio::net::{TcpListener, UnixListener, UnixStream};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch() -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "spore-source-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn file(dir: &Scratch, declared: Value) -> PathBuf {
        let path = dir.0.join("sources.json");
        std::fs::write(&path, declared.to_string()).unwrap();
        path
    }

    fn scopes(entries: &[(&str, &str, &[&str])]) -> Ordered<Ordered<Vec<String>>> {
        let mut out: Ordered<Ordered<Vec<String>>> = Ordered::default();
        for (source, param, values) in entries {
            let values = values.iter().map(|v| v.to_string()).collect();
            match out.0.iter_mut().find(|(s, _)| s == source) {
                Some((_, narrowed)) => narrowed.0.push((param.to_string(), values)),
                None => out.0.push((
                    source.to_string(),
                    Ordered(vec![(param.to_string(), values)]),
                )),
            }
        }
        out
    }

    fn granted(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn load(
        declared: Value,
        names: &[&str],
        narrowed: &[(&str, &str, &[&str])],
    ) -> Result<Arc<Sources>, Refusal> {
        let dir = scratch();
        Sources::load(
            "triage",
            Some(&file(&dir, declared)),
            &granted(names),
            &scopes(narrowed),
            &Map::new(),
            no_env,
        )
    }

    fn kind(result: Result<impl Sized, Refusal>) -> String {
        match result {
            Ok(_) => "ok".into(),
            Err(refusal) => refusal.kind,
        }
    }

    /// What the endpoint was sent: the uri, the authorization, the method, the content type,
    /// the body and the host.
    type Call = (
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        Option<String>,
    );

    #[derive(Clone, Default)]
    struct Seen(Arc<Mutex<Vec<Call>>>);

    impl Seen {
        fn last(&self) -> Call {
            self.0
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("the endpoint was called")
        }
    }

    async fn record<S>(stream: S, body: Bytes, log: Seen)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let service = service_fn(move |req: Request<Incoming>| {
            let header = |name: &str| {
                req.headers()
                    .get(name)
                    .map(|v| v.to_str().unwrap().to_string())
            };
            let (authorization, content_type, host) = (
                header("authorization"),
                header("content-type"),
                header("host"),
            );
            let (uri, method) = (req.uri().to_string(), req.method().to_string());
            let (body, log) = (body.clone(), log.clone());
            async move {
                let sent = req.into_body().collect().await.unwrap().to_bytes();
                log.0.lock().unwrap().push((
                    uri,
                    authorization,
                    method,
                    content_type,
                    String::from_utf8_lossy(&sent).into_owned(),
                    host,
                ));
                Ok::<_, Infallible>(
                    Response::builder()
                        .header("content-type", "text/plain")
                        .body(Full::new(body))
                        .unwrap(),
                )
            }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    }

    async fn endpoint(body: Bytes) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Seen::default();
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(record(stream, body.clone(), log.clone()));
            }
        });
        (base, seen)
    }

    fn body(answer: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(answer["bodyBase64"].as_str().unwrap())
            .unwrap()
    }

    async fn socket_endpoint(socket: &Path, body: Bytes) -> Seen {
        let listener = UnixListener::bind(socket).unwrap();
        let seen = Seen::default();
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(record(stream, body.clone(), log.clone()));
            }
        });
        seen
    }

    #[tokio::test]
    async fn resolves_secrets_from_the_host_environment_and_refuses_one_that_is_not_set() {
        let dir = scratch();
        let path = file(
            &dir,
            json!({ "ledger": { "url": "http://x.invalid", "headers": { "authorization": "Bearer ${TOKEN}" } } }),
        );
        let held = Sources::load(
            "triage",
            Some(&path),
            &granted(&["ledger"]),
            &Ordered::default(),
            &Map::new(),
            |v| (v == "TOKEN").then(|| "abc".to_string()),
        )
        .unwrap();
        let (_, value) = &held.resolved["ledger"].headers[0];
        assert_eq!(value, "Bearer abc");

        let refused = Sources::load(
            "triage",
            Some(&path),
            &granted(&["ledger"]),
            &Ordered::default(),
            &Map::new(),
            no_env,
        );
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_SECRET_MISSING");
        assert!(
            refusal.message.contains("wants $TOKEN"),
            "{}",
            refusal.message
        );
    }

    #[tokio::test]
    async fn sends_the_spore_s_name_where_a_header_asks_for_it_and_never_reads_a_secret_as_one() {
        let dir = scratch();
        let path = file(
            &dir,
            json!({ "ledger": { "url": "http://x.invalid", "headers": { "authorization": "Bearer ${TOKEN}", "x-spore": "{name}" } } }),
        );
        let held = Sources::load(
            "triage",
            Some(&path),
            &granted(&["ledger"]),
            &Ordered::default(),
            &Map::new(),
            |v| (v == "TOKEN").then(|| "a{name}b".to_string()),
        )
        .unwrap();
        let headers = &held.resolved["ledger"].headers;
        assert!(headers
            .iter()
            .any(|(name, value)| name == "x-spore" && value == "triage"));
        assert!(headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer a{name}b"));
    }

    #[tokio::test]
    async fn refuses_a_placeholder_it_does_not_fill_and_a_name_the_agent_could_replace() {
        for spec in [
            json!({ "url": "http://x.invalid", "headers": { "x-spore": "{workspace}" } }),
            json!({ "url": "http://x.invalid", "query": { "spore": "{name}" } }),
            json!({ "url": "http://x.invalid/{name}/" }),
        ] {
            let refusal = load(json!({ "ledger": spec.clone() }), &["ledger"], &[])
                .err()
                .unwrap();
            assert_eq!(refusal.kind, "SOURCE_INVALID", "{spec}");
        }
    }

    #[tokio::test]
    async fn a_source_not_granted_needs_no_secret() {
        let declared = json!({
            "ledger": { "url": "http://x.invalid" },
            "other": { "url": "http://y.invalid", "headers": { "authorization": "${UNSET}" } }
        });
        assert_eq!(kind(load(declared, &["ledger"], &[])), "ok");
    }

    #[tokio::test]
    async fn refuses_a_source_with_no_url_rather_than_calling_nowhere() {
        let refused = load(json!({ "ledger": { "headers": {} } }), &["ledger"], &[]);
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_INVALID");
        assert!(refusal.message.contains("has no url"));
    }

    #[tokio::test]
    async fn takes_http_and_https_and_nothing_else() {
        assert!(load(
            json!({ "ledger": { "url": "https://x.invalid" } }),
            &["ledger"],
            &[]
        )
        .is_ok());
        let refusal = load(
            json!({ "ledger": { "url": "ftp://x.invalid" } }),
            &["ledger"],
            &[],
        )
        .err()
        .unwrap();
        assert_eq!(refusal.kind, "SOURCE_INVALID");
        assert!(refusal.message.contains("not an http:// or https:// url"));
    }

    #[tokio::test]
    async fn narrows_a_plugins_paths_to_what_the_definition_names_and_calls_nothing_else() {
        let (base, seen) = endpoint(Bytes::from_static(b"[]")).await;
        let plugins =
            json!({ "chat": { "url": format!("{base}/channels/"), "paths": ["*/messages"] } });
        let sources = Sources::load(
            "triage",
            None,
            &granted(&["chat"]),
            &scopes(&[("chat", "path", &["111/messages"])]),
            plugins.as_object().unwrap(),
            no_env,
        )
        .unwrap();

        sources
            .fetch(&json!({ "source": "chat", "path": "111/messages" }))
            .await
            .unwrap();
        assert_eq!(seen.last().0, "/channels/111/messages");

        let refused = sources
            .fetch(&json!({ "source": "chat", "path": "222/messages" }))
            .await
            .err()
            .unwrap();
        assert_eq!(refused.kind, "SOURCE_OUT_OF_SCOPE");
        assert!(refused.detail.contains("111/messages"));
        assert_eq!(seen.0.lock().unwrap().len(), 1);

        let view =
            json!({ "sources": ["chat"], "scopes": { "chat": { "path": ["222/messages"] } } });
        assert_eq!(
            kind(
                sources
                    .fetch(&json!({ "source": "chat", "path": "222/messages", "view": view }))
                    .await
            ),
            "SOURCE_OUT_OF_SCOPE"
        );

        let listed = sources.list(None).unwrap();
        assert_eq!(listed["sources"][0]["paths"], json!(["111/messages"]));
        assert_eq!(listed["sources"][0]["scope"], json!({}));
    }

    #[tokio::test]
    async fn refuses_at_load_a_path_narrowing_the_host_would_never_serve() {
        let forge = api("http://x.invalid");
        assert_eq!(
            kind(load(
                forge.clone(),
                &["forge"],
                &[("forge", "path", &["repos/team/project/issues"])]
            )),
            "ok"
        );
        for pattern in ["repos/other/**", "repos/team/project/../x", "issues"] {
            assert_eq!(
                kind(load(
                    forge.clone(),
                    &["forge"],
                    &[("forge", "path", &[pattern])]
                )),
                "SOURCE_PATH_REFUSED",
                "{pattern}"
            );
        }
        assert_eq!(
            kind(load(
                json!({ "search": { "url": "http://x.invalid/search" } }),
                &["search"],
                &[("search", "path", &["a"])]
            )),
            "SOURCE_PATH_REFUSED"
        );
    }

    #[tokio::test]
    async fn serves_a_plugins_source_with_the_runners_key_and_grants_it_with_the_plugin() {
        let plugins = json!({ "web": { "url": "https://x.invalid/search", "headers": { "x-key": "${WEB_KEY}" } } });
        let plugins = plugins.as_object().unwrap();
        let key = |name: &str| (name == "WEB_KEY").then(|| "the-key".to_string());
        let sources = Sources::load(
            "triage",
            None,
            &granted(&["web"]),
            &Ordered::default(),
            plugins,
            key,
        )
        .unwrap();
        assert!(sources.resolved["web"]
            .headers
            .iter()
            .any(|(name, value)| name == "x-key" && value == "the-key"));
        assert_eq!(sources.granted, ["web"]);
        assert_eq!(
            kind(Sources::load(
                "triage",
                None,
                &[],
                &Ordered::default(),
                plugins,
                no_env
            )),
            "SOURCE_SECRET_MISSING"
        );
    }

    #[tokio::test]
    async fn refuses_a_host_source_a_plugin_also_describes() {
        let dir = scratch();
        let path = file(&dir, json!({ "web": { "url": "http://x.invalid" } }));
        let plugins = json!({ "web": { "url": "http://y.invalid" } });
        let refused = Sources::load(
            "triage",
            Some(&path),
            &[],
            &Ordered::default(),
            plugins.as_object().unwrap(),
            |_| None,
        );
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_INVALID");
        assert!(refusal
            .message
            .contains("and a plugin both describe \"web\""));
    }

    #[tokio::test]
    async fn refuses_at_load_a_granted_name_the_host_does_not_describe() {
        let refused = load(json!({}), &["missing"], &[]);
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_UNKNOWN");
        assert!(refusal.message.contains("no source called \"missing\""));
    }

    #[tokio::test]
    async fn refuses_a_file_that_is_not_json() {
        let dir = scratch();
        let path = dir.0.join("sources.json");
        std::fs::write(&path, "{ not json").unwrap();
        let refused = Sources::load(
            "triage",
            Some(&path),
            &granted(&["ledger"]),
            &Ordered::default(),
            &Map::new(),
            no_env,
        );
        assert_eq!(kind(refused), "SOURCES_UNREADABLE");
    }

    #[tokio::test]
    async fn refuses_a_granted_source_the_host_says_must_be_narrowed() {
        let declared =
            json!({ "search": { "url": "http://x.invalid", "requires": ["collection"] } });
        let refused = load(declared.clone(), &["search"], &[]);
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_UNSCOPED");
        assert!(refusal.message.contains("without saying which collection"));
        assert_eq!(
            kind(load(
                declared,
                &["search"],
                &[("search", "collection", &["a"])]
            )),
            "ok"
        );
    }

    #[tokio::test]
    async fn refuses_a_host_default_outside_what_the_definition_allows() {
        let declared = json!({ "search": { "url": "http://x.invalid", "query": { "collection": "everything" }, "requires": ["collection"] } });
        let refused = load(
            declared,
            &["search"],
            &[("search", "collection", &["acme"])],
        );
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_DEFAULT_OUT_OF_SCOPE");
        assert!(refusal.message.contains("does not allow"));
    }

    #[tokio::test]
    async fn calls_the_endpoint_and_hands_back_what_it_said_never_where_it_was() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let sources = load(
            json!({ "ledger": { "url": format!("{base}/search") } }),
            &["ledger"],
            &[],
        )
        .unwrap();

        let answer = sources
            .fetch(&json!({ "source": "ledger", "params": { "term": "crispr" } }))
            .await
            .unwrap();

        assert_eq!(answer["status"], 200);
        assert_eq!(answer["ok"], true);
        assert_eq!(body(&answer), b"hi");
        assert_eq!(answer["contentType"], "text/plain");
        assert_eq!(seen.last().0, "/search?term=crispr");
        assert!(!answer.to_string().contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn sends_the_name_whatever_the_agent_asks() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let sources = load(
            json!({ "ledger": { "url": format!("{base}/search"), "headers": { "authorization": "Spore {name}" } } }),
            &["ledger"],
            &[],
        )
        .unwrap();

        sources
            .fetch(&json!({ "source": "ledger", "params": { "authorization": "Spore other", "name": "other" } }))
            .await
            .unwrap();

        assert_eq!(seen.last().1.as_deref(), Some("Spore triage"));
    }

    #[tokio::test]
    async fn hands_back_bytes_that_are_not_text_as_they_came() {
        let png_then_jpeg: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8];
        let (base, _) = endpoint(Bytes::from_static(png_then_jpeg)).await;
        let sources = load(json!({ "ledger": { "url": base } }), &["ledger"], &[]).unwrap();

        let answer = sources.fetch(&json!({ "source": "ledger" })).await.unwrap();

        assert_eq!(body(&answer), png_then_jpeg);
        assert_eq!(answer["contentType"], "text/plain");
        assert!(answer.get("body").is_none());
    }

    #[tokio::test]
    async fn calls_a_source_on_the_socket_the_host_names() {
        let dir = scratch();
        let socket = dir.0.join("service.sock");
        let seen = socket_endpoint(&socket, Bytes::from_static(b"hi")).await;
        let path = file(
            &dir,
            json!({ "docs": {
                "url": "http://service.local/v1/",
                "socket": "${SERVICE_SOCKET}",
                "headers": { "authorization": "Bearer ${TOKEN}" },
                "paths": ["docs/*"],
                "requires": ["collection"]
            } }),
        );
        let socket_text = socket.to_str().unwrap().to_string();
        let sources = Sources::load(
            "triage",
            Some(&path),
            &granted(&["docs"]),
            &scopes(&[("docs", "collection", &["lake"])]),
            &Map::new(),
            move |name| match name {
                "SERVICE_SOCKET" => Some(socket_text.clone()),
                "TOKEN" => Some("abc".into()),
                _ => None,
            },
        )
        .unwrap();

        assert_eq!(sources.list(None).unwrap()["sources"][0]["name"], "docs");
        assert!(!sources.list(None).unwrap().to_string().contains("sock"));
        let answer = sources
            .fetch(&json!({ "source": "docs", "path": "docs/7" }))
            .await
            .unwrap();

        assert_eq!(body(&answer), b"hi");
        let (uri, authorization, _, _, _, host) = seen.last();
        assert_eq!(uri, "/v1/docs/7?collection=lake");
        assert_eq!(authorization.as_deref(), Some("Bearer abc"));
        assert_eq!(host.as_deref(), Some("service.local"));
    }

    #[tokio::test]
    async fn caps_what_a_socket_source_answers() {
        let dir = scratch();
        let socket = dir.0.join("service.sock");
        socket_endpoint(&socket, Bytes::from(vec![b'x'; MAX_RESPONSE_BYTES + 1])).await;
        let sources = load(
            json!({ "docs": { "url": "http://service.local/", "socket": socket.to_str().unwrap() } }),
            &["docs"],
            &[],
        )
        .unwrap();
        let refusal = sources
            .fetch(&json!({ "source": "docs" }))
            .await
            .err()
            .unwrap();
        assert_eq!(refusal.kind, "SOURCE_TOO_LARGE");
    }

    #[tokio::test]
    async fn a_socket_nobody_serves_is_unreachable_without_saying_where_it_is() {
        let dir = scratch();
        let socket = dir.0.join("absent.sock");
        let sources = load(
            json!({ "docs": { "url": "http://service.local/", "socket": socket.to_str().unwrap() } }),
            &["docs"],
            &[],
        )
        .unwrap();
        let refusal = sources
            .fetch(&json!({ "source": "docs" }))
            .await
            .err()
            .unwrap();
        assert_eq!(refusal.kind, "SOURCE_UNREACHABLE");
        assert!(refusal.retryable);
        assert!(refusal.detail.contains("its socket"), "{}", refusal.detail);
        assert!(
            !refusal.detail.contains("absent.sock"),
            "{}",
            refusal.detail
        );
    }

    #[tokio::test]
    async fn refuses_a_socket_it_cannot_use_and_a_field_it_does_not_know() {
        let refused = |declared: Value| load(declared, &["docs"], &[]).err().unwrap();
        let relative =
            refused(json!({ "docs": { "url": "http://x.invalid", "socket": "run/s.sock" } }));
        assert_eq!(relative.kind, "SOURCE_INVALID");
        assert!(relative.detail.contains("absolute path"));
        let tls =
            refused(json!({ "docs": { "url": "https://x.invalid", "socket": "/run/s.sock" } }));
        assert!(tls.detail.contains("plain http"));
        let number = refused(json!({ "docs": { "url": "http://x.invalid", "socket": 7 } }));
        assert!(number.message.contains("not a path"));
        let unset = refused(json!({ "docs": { "url": "http://x.invalid", "socket": "${UNSET}" } }));
        assert_eq!(unset.kind, "SOURCE_SECRET_MISSING");
        let typo =
            refused(json!({ "docs": { "url": "http://x.invalid", "sockt": "/run/s.sock" } }));
        assert_eq!(typo.kind, "SOURCE_INVALID");
        assert!(typo.message.contains("\"sockt\""));
    }

    #[tokio::test]
    async fn refuses_a_plugins_source_that_names_a_socket() {
        let plugins = json!({ "web": { "url": "http://x.invalid", "socket": "/run/s.sock" } });
        let refusal = Sources::load(
            "triage",
            None,
            &[],
            &Ordered::default(),
            plugins.as_object().unwrap(),
            no_env,
        )
        .err()
        .unwrap();
        assert_eq!(refusal.kind, "SOURCE_INVALID");
        assert!(refusal.message.contains("names a socket"));
    }

    fn api(base: &str) -> Value {
        json!({ "forge": {
            "url": format!("{base}/api/v1/"),
            "headers": { "authorization": "token abc" },
            "methods": ["GET", "POST"],
            "paths": ["repos/team/project/**", "user"]
        } })
    }

    #[tokio::test]
    async fn calls_a_path_under_the_url_with_the_method_and_body_asked_for() {
        let (base, seen) = endpoint(Bytes::from_static(b"{\"number\":7}")).await;
        let sources = load(api(&base), &["forge"], &[]).unwrap();

        let answer = sources
            .fetch(&json!({
                "source": "forge",
                "method": "post",
                "path": "repos/team/project/issues",
                "body": { "title": "a bug" }
            }))
            .await
            .unwrap();

        assert_eq!(body(&answer), b"{\"number\":7}");
        let (uri, authorization, method, content_type, body, _) = seen.last();
        assert_eq!(uri, "/api/v1/repos/team/project/issues");
        assert_eq!(authorization.as_deref(), Some("token abc"));
        assert_eq!(method, "POST");
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(body, r#"{"title":"a bug"}"#);

        sources
            .fetch(&json!({ "source": "forge", "path": "user" }))
            .await
            .unwrap();
        assert_eq!(seen.last().2, "GET");
    }

    #[tokio::test]
    async fn refuses_a_path_or_method_the_host_did_not_allow_and_sends_nothing() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let sources = load(api(&base), &["forge"], &[]).unwrap();
        let refused = |asked: Value| {
            let sources = sources.clone();
            async move { kind(sources.fetch(&asked).await) }
        };

        assert_eq!(
            refused(json!({ "source": "forge", "path": "repos/team/other/issues" })).await,
            "SOURCE_PATH_REFUSED"
        );
        assert_eq!(
            refused(json!({ "source": "forge", "path": "repos/team/project/../other" })).await,
            "SOURCE_PATH_REFUSED"
        );
        assert_eq!(
            refused(json!({ "source": "forge", "path": "repos/team/project" })).await,
            "SOURCE_PATH_REFUSED"
        );
        assert_eq!(
            refused(json!({ "source": "forge", "method": "DELETE", "path": "user" })).await,
            "SOURCE_METHOD_REFUSED"
        );
        assert_eq!(
            refused(json!({ "source": "forge" })).await,
            "SOURCE_PATH_REQUIRED"
        );
        assert_eq!(
            refused(json!({ "source": "forge", "path": "user", "body": {} })).await,
            "PROTOCOL_INVALID_REQUEST"
        );
        assert!(seen.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn keeps_a_source_without_paths_or_methods_to_its_one_address() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let sources = load(
            json!({ "ledger": { "url": format!("{base}/search") } }),
            &["ledger"],
            &[],
        )
        .unwrap();
        assert_eq!(
            kind(
                sources
                    .fetch(&json!({ "source": "ledger", "path": "x" }))
                    .await
            ),
            "SOURCE_PATH_REFUSED"
        );
        assert_eq!(
            kind(
                sources
                    .fetch(&json!({ "source": "ledger", "method": "POST" }))
                    .await
            ),
            "SOURCE_METHOD_REFUSED"
        );
        assert!(seen.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_paths_on_a_url_they_cannot_be_joined_under() {
        let refused = load(
            json!({ "forge": { "url": "http://x.invalid/api", "paths": ["repos/**"] } }),
            &["forge"],
            &[],
        );
        assert!(refused
            .err()
            .unwrap()
            .message
            .contains("a url that does not end in /"));
    }

    #[tokio::test]
    async fn lists_what_a_rest_source_may_be_asked() {
        let sources = load(api("http://x.invalid"), &["forge"], &[]).unwrap();
        let listed = sources.list(None).unwrap();
        assert_eq!(listed["sources"][0]["methods"], json!(["GET", "POST"]));
        assert_eq!(listed["sources"][0]["base"], "/api/v1/");
        assert!(!listed.to_string().contains("x.invalid"));
        assert_eq!(
            listed["sources"][0]["paths"],
            json!(["repos/team/project/**", "user"])
        );
    }

    #[tokio::test]
    async fn sends_the_hosts_headers_with_the_secret_filled() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let dir = scratch();
        let path = file(
            &dir,
            json!({ "ledger": { "url": base, "headers": { "authorization": "Bearer ${TOKEN}" } } }),
        );
        let sources = Sources::load(
            "triage",
            Some(&path),
            &granted(&["ledger"]),
            &Ordered::default(),
            &Map::new(),
            |_| Some("abc".into()),
        )
        .unwrap();
        sources.fetch(&json!({ "source": "ledger" })).await.unwrap();
        assert_eq!(seen.last().1.as_deref(), Some("Bearer abc"));
    }

    #[tokio::test]
    async fn merges_the_hosts_query_with_the_callers_and_lets_the_caller_narrow_it() {
        let (base, seen) = endpoint(Bytes::from_static(b"hi")).await;
        let declared = json!({ "ledger": { "url": format!("{base}/s?db=everything"), "query": { "format": "json", "db": "all" } } });
        let sources = load(declared, &["ledger"], &[]).unwrap();

        sources
            .fetch(&json!({ "source": "ledger", "params": { "db": "papers", "term": "x" } }))
            .await
            .unwrap();

        let asked = seen.last().0;
        assert!(asked.contains("format=json"), "{asked}");
        assert!(asked.contains("db=papers"), "{asked}");
        assert_eq!(asked.matches("db=").count(), 1, "{asked}");
    }

    #[tokio::test]
    async fn an_endpoint_that_answered_with_an_error_answered() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = service_fn(|_req: Request<Incoming>| async {
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(404)
                        .body(Full::new(Bytes::from_static(b"gone")))
                        .unwrap(),
                )
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
        let sources = load(json!({ "ledger": { "url": base } }), &["ledger"], &[]).unwrap();
        let answer = sources.fetch(&json!({ "source": "ledger" })).await.unwrap();
        assert_eq!(answer["status"], 404);
        assert_eq!(answer["ok"], false);
        assert_eq!(body(&answer), b"gone");
    }

    #[tokio::test]
    async fn refuses_a_source_this_definition_was_not_granted_even_when_the_host_has_it() {
        let sources = load(json!({ "ledger": { "url": "http://x.invalid" } }), &[], &[]).unwrap();
        let refused = sources.fetch(&json!({ "source": "ledger" })).await;
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_NOT_GRANTED");
        assert!(refusal.message.contains("was not granted"));
        assert_eq!(refusal.detail, "its definition lists no sources");
    }

    #[tokio::test]
    async fn refuses_a_response_past_the_ceiling_rather_than_writing_it() {
        let (base, _) = endpoint(Bytes::from(vec![b'x'; MAX_RESPONSE_BYTES + 1])).await;
        let sources = load(json!({ "ledger": { "url": base } }), &["ledger"], &[]).unwrap();
        let refused = sources.fetch(&json!({ "source": "ledger" })).await;
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_TOO_LARGE");
        assert!(refusal
            .message
            .contains("more than this broker will pass on"));
    }

    #[tokio::test]
    async fn an_endpoint_nobody_answers_is_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let sources = load(json!({ "ledger": { "url": base } }), &["ledger"], &[]).unwrap();
        let refusal = sources
            .fetch(&json!({ "source": "ledger" }))
            .await
            .err()
            .unwrap();
        assert_eq!(refusal.kind, "SOURCE_UNREACHABLE");
        assert!(refusal.retryable);
    }

    #[tokio::test]
    async fn tells_a_caller_only_what_it_was_granted_and_what_it_may_ask_each_for() {
        let declared = json!({
            "ledger": { "url": "http://x.invalid" },
            "search": { "url": "http://y.invalid", "requires": ["collection"] },
            "hidden": { "url": "http://z.invalid" }
        });
        let sources = load(
            declared,
            &["ledger", "search"],
            &[("search", "collection", &["a", "b"])],
        )
        .unwrap();
        assert_eq!(
            sources.list(None).unwrap(),
            json!({ "sources": [
                { "name": "ledger", "scope": {} },
                { "name": "search", "scope": { "collection": ["a", "b"] } }
            ] })
        );
    }

    fn search(base: &str) -> Value {
        json!({ "search": { "url": format!("{base}/search"), "requires": ["collection"] } })
    }

    #[tokio::test]
    async fn passes_a_value_the_definition_allows_and_refuses_one_it_does_not() {
        let (base, seen) = endpoint(Bytes::from_static(b"{}")).await;
        let sources = load(
            search(&base),
            &["search"],
            &[("search", "collection", &["acme-2024", "acme-archive"])],
        )
        .unwrap();

        sources
            .fetch(&json!({ "source": "search", "params": { "collection": "acme-archive", "q": "x" } }))
            .await
            .unwrap();
        assert!(seen.last().0.contains("collection=acme-archive"));

        let refused = sources
            .fetch(&json!({ "source": "search", "params": { "collection": "someone-else" } }))
            .await;
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_OUT_OF_SCOPE");
        assert!(refusal.message.contains("may not be asked for collection"));
    }

    #[tokio::test]
    async fn fills_the_value_when_only_one_is_allowed_and_demands_it_when_several_are() {
        let (base, seen) = endpoint(Bytes::from_static(b"{}")).await;
        let one = load(
            search(&base),
            &["search"],
            &[("search", "collection", &["only-mine"])],
        )
        .unwrap();
        one.fetch(&json!({ "source": "search", "params": { "q": "x" } }))
            .await
            .unwrap();
        assert!(seen.last().0.contains("collection=only-mine"));

        let several = load(
            search(&base),
            &["search"],
            &[("search", "collection", &["a", "b"])],
        )
        .unwrap();
        let refused = several
            .fetch(&json!({ "source": "search", "params": { "q": "x" } }))
            .await;
        let refusal = refused.err().unwrap();
        assert_eq!(refusal.kind, "SOURCE_SCOPE_REQUIRED");
        assert!(refusal.message.contains("needs a collection"));
    }

    #[tokio::test]
    async fn serves_list_and_fetch_on_its_socket() {
        let (base, _) = endpoint(Bytes::from_static(b"hi")).await;
        let sources = load(json!({ "ledger": { "url": base } }), &["ledger"], &[]).unwrap();
        let dir = scratch();
        let socket = dir.0.join("source.sock");
        let key = "k".repeat(64);
        crate::broker::serve(&socket, key.clone(), move |req| sources.clone().route(req)).unwrap();

        let ask = |method: &'static str, path: &'static str, body: Option<Value>| {
            let (socket, key) = (socket.clone(), key.clone());
            async move {
                let stream = UnixStream::connect(&socket).await.unwrap();
                let (mut sender, conn) =
                    hyper::client::conn::http1::handshake(TokioIo::new(stream))
                        .await
                        .unwrap();
                tokio::spawn(conn);
                let req = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "unix")
                    .header(crate::broker::KEY_HEADER, key)
                    .body(Full::new(Bytes::from(
                        body.map(|b| b.to_string()).unwrap_or_default(),
                    )))
                    .unwrap();
                let res = sender.send_request(req).await.unwrap();
                let status = res.status();
                let bytes = res.into_body().collect().await.unwrap().to_bytes();
                (status, serde_json::from_slice::<Value>(&bytes).unwrap())
            }
        };

        let (status, listed) = ask("POST", "/list", Some(json!({}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["sources"][0]["name"], "ledger");

        let (status, fetched) = ask("POST", "/fetch", Some(json!({ "source": "ledger" }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body(&fetched), b"hi");

        let (status, refused) = ask("POST", "/fetch", Some(json!({ "source": "other" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(refused["type"], "SOURCE_NOT_GRANTED");
    }

    fn view(sources: &[&str], scopes: Value) -> Value {
        json!({ "sources": sources, "scopes": scopes })
    }

    #[tokio::test]
    async fn shows_a_cell_only_its_view_of_the_grant() {
        let declared = json!({
            "ledger": { "url": "http://x.invalid" },
            "search": { "url": "http://y.invalid", "requires": ["collection"] }
        });
        let sources = load(
            declared,
            &["ledger", "search"],
            &[("search", "collection", &["a", "b"])],
        )
        .unwrap();
        assert_eq!(
            sources
                .list(Some(&view(
                    &["search"],
                    json!({ "search": { "collection": ["a"] } })
                )))
                .unwrap(),
            json!({ "sources": [{ "name": "search", "scope": { "collection": ["a"] } }] })
        );
    }

    #[tokio::test]
    async fn fills_the_value_a_view_narrows_to_and_refuses_one_outside_it() {
        let (base, seen) = endpoint(Bytes::from_static(b"{}")).await;
        let sources = load(
            search(&base),
            &["search"],
            &[("search", "collection", &["a", "b"])],
        )
        .unwrap();
        let narrowed = view(&["search"], json!({ "search": { "collection": ["a"] } }));

        sources
            .fetch(&json!({ "source": "search", "params": { "q": "x" }, "view": narrowed }))
            .await
            .unwrap();
        assert!(seen.last().0.contains("collection=a"));

        let refusal = sources
            .fetch(
                &json!({ "source": "search", "params": { "collection": "b" }, "view": narrowed }),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(refusal.kind, "SOURCE_OUT_OF_SCOPE");

        sources
            .fetch(&json!({ "source": "search", "params": { "collection": "b" } }))
            .await
            .unwrap();
        assert!(seen.last().0.contains("collection=b"));
    }

    #[tokio::test]
    async fn refuses_a_source_granted_to_the_tree_and_left_out_of_the_view() {
        let (base, _) = endpoint(Bytes::from_static(b"{}")).await;
        let declared = json!({ "ledger": { "url": format!("{base}/l") }, "other": { "url": format!("{base}/o") } });
        let sources = load(declared, &["ledger", "other"], &[]).unwrap();
        let refusal = sources
            .fetch(&json!({ "source": "other", "view": view(&["ledger"], json!({})) }))
            .await
            .err()
            .unwrap();
        assert_eq!(refusal.kind, "SOURCE_NOT_GRANTED");
        assert!(refusal
            .message
            .contains("this cell was not given \"other\""));
        assert!(refusal.detail.contains("its precursor lists ledger"));
    }

    #[tokio::test]
    async fn refuses_a_view_wider_than_the_grant() {
        let declared = json!({
            "search": { "url": "http://y.invalid", "requires": ["collection"] },
            "hidden": { "url": "http://z.invalid" }
        });
        let sources = load(declared, &["search"], &[("search", "collection", &["a"])]).unwrap();
        assert_eq!(
            kind(sources.list(Some(&view(&["hidden"], json!({}))))),
            "SOURCE_NOT_GRANTED"
        );
        assert_eq!(
            kind(sources.list(Some(&view(
                &["search"],
                json!({ "search": { "collection": ["a", "b"] } })
            )))),
            "SOURCE_OUT_OF_SCOPE"
        );
        assert_eq!(
            kind(sources.list(Some(&json!({ "sources": "search" })))),
            "PROTOCOL_INVALID_REQUEST"
        );
    }

    #[tokio::test]
    async fn refuses_a_view_that_a_host_default_would_outrank() {
        let declared =
            json!({ "search": { "url": "http://y.invalid", "query": { "collection": "b" } } });
        let sources = load(
            declared,
            &["search"],
            &[("search", "collection", &["a", "b"])],
        )
        .unwrap();
        assert_eq!(
            kind(sources.list(Some(&view(
                &["search"],
                json!({ "search": { "collection": ["a"] } })
            )))),
            "SOURCE_DEFAULT_OUT_OF_SCOPE"
        );
    }
}

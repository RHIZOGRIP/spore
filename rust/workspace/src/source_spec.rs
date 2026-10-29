//! Where a source's spec may hold a placeholder: a header may hold `{name}`, the calling spore's
//! name, and `{turn}`, the id of the turn that calls, which the runner fills, and nothing else
//! may hold either. The runner refuses a source that breaks this, and a plugin's check and
//! `spore doctor` report it.

use serde_json::Value;

pub const NAMED_HEADER: &str =
    "a header may hold {name}, the calling spore's name, and {turn}, the id of the turn that calls, which the runner fills";
pub const NAMED_ELSEWHERE: &str =
    "only a header takes {name} and {turn}, which the runner fills and the agent cannot replace";

/// What the runner fills in a header.
pub const FILLED: [&str; 2] = ["name", "turn"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Misplaced {
    pub found: String,
    pub place: String,
    pub why: &'static str,
}

/// The `{placeholder}`s in `raw`, as byte ranges braces included; `${VAR}` is a secret, not one.
pub fn placeholders(raw: &str) -> Vec<(usize, usize)> {
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

pub fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn named(raw: &str) -> impl Iterator<Item = &str> {
    placeholders(raw)
        .into_iter()
        .map(move |(start, end)| &raw[start + 1..end - 1])
}

/// The first placeholder in `spec` the runner would refuse: the headers first, then the url, the
/// socket and the query.
pub fn misplaced(spec: &Value) -> Option<Misplaced> {
    let headers = spec.get("headers").and_then(Value::as_object);
    for (header, value) in headers.into_iter().flatten() {
        if let Some(other) = named(&text(value)).find(|p| !FILLED.contains(p)) {
            return Some(Misplaced {
                found: format!("{{{other}}}"),
                place: format!("its {header} header"),
                why: NAMED_HEADER,
            });
        }
    }
    let query = spec.get("query").and_then(Value::as_object);
    let elsewhere = ["url", "socket"]
        .into_iter()
        .filter_map(|field| spec.get(field).map(|value| (field, value)))
        .chain(
            query
                .into_iter()
                .flatten()
                .map(|(_, value)| ("query", value)),
        );
    for (field, value) in elsewhere {
        if let Some(filled) = named(&text(value)).find(|p| FILLED.contains(p)) {
            return Some(Misplaced {
                found: format!("{{{filled}}}"),
                place: format!("its {field}"),
                why: NAMED_ELSEWHERE,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn found(spec: Value) -> Option<(String, String)> {
        misplaced(&spec).map(|m| (m.found, m.place))
    }

    #[test]
    fn lets_a_header_hold_the_spore_s_name_and_turn_and_nothing_hold_a_secret_as_one() {
        assert_eq!(
            found(
                json!({ "url": "http://x.invalid/${BASE}", "headers": { "x-spore": "{name}", "x-turn": "turn {turn} of {name}", "authorization": "Bearer ${TOKEN}" } })
            ),
            None
        );
    }

    #[test]
    fn refuses_another_placeholder_in_a_header_before_anything_elsewhere() {
        assert_eq!(
            found(
                json!({ "url": "http://x.invalid/{name}/", "headers": { "x-spore": "{workspace}" } })
            ),
            Some(("{workspace}".into(), "its x-spore header".into()))
        );
    }

    #[test]
    fn refuses_the_spore_s_name_anywhere_the_agent_could_replace_it() {
        for (spec, place) in [
            (json!({ "url": "http://x.invalid/{name}/" }), "its url"),
            (
                json!({ "url": "http://x.invalid", "socket": "/run/{name}.sock" }),
                "its socket",
            ),
            (
                json!({ "url": "http://x.invalid", "query": { "spore": "{name}" } }),
                "its query",
            ),
        ] {
            assert_eq!(found(spec), Some(("{name}".into(), place.into())));
        }
    }

    #[test]
    fn refuses_the_turn_anywhere_but_a_header() {
        for (spec, place) in [
            (json!({ "url": "http://x.invalid/{turn}/" }), "its url"),
            (
                json!({ "url": "http://x.invalid", "query": { "turn": "{turn}" } }),
                "its query",
            ),
        ] {
            assert_eq!(found(spec), Some(("{turn}".into(), place.into())));
        }
    }

    #[test]
    fn reads_a_placeholder_as_a_name_in_braces_never_a_brace_alone() {
        assert_eq!(placeholders("{a.b_1} {1x} { } ${V} {}"), vec![(0, 7)]);
    }
}

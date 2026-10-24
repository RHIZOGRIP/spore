//! A secret written as a reference to the variable holding it, `${VAR}`, the name one an
//! environment variable may have. A value may be the reference alone, or hold references among
//! other text, each filled from the environment of whoever reads it. A variable set to nothing
//! is not set.

use regex::Regex;
use std::sync::LazyLock;

use crate::name::VARIABLE_PATTERN;

static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    let name = &VARIABLE_PATTERN[1..VARIABLE_PATTERN.len() - 1];
    Regex::new(&format!(r"\$\{{({name})\}}")).expect("the reference pattern compiles")
});

/// The variable `value` names when it is a reference and nothing else.
pub fn variable_of(value: &str) -> Option<String> {
    REFERENCE
        .captures(value)
        .filter(|found| found.get(0).is_some_and(|all| all.len() == value.len()))
        .map(|found| found[1].to_string())
}

/// The variables `text` refers to, each once, in the order they first appear.
pub fn variables_in(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for reference in REFERENCE.captures_iter(text) {
        if !found.iter().any(|v| v == &reference[1]) {
            found.push(reference[1].to_string());
        }
    }
    found
}

/// `value` with each reference replaced from `env`; the error names the first variable not set.
pub fn fill_variables(
    value: &str,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    let mut from = 0;
    for reference in REFERENCE.captures_iter(value) {
        let all = reference.get(0).expect("a match has its whole");
        let variable = &reference[1];
        let set = env(variable)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| variable.to_string())?;
        out.push_str(&value[from..all.start()]);
        out.push_str(&set);
        from = all.end();
    }
    out.push_str(&value[from..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("t0k".into()),
            "EMPTY" => Some(String::new()),
            _ => None,
        }
    }

    #[test]
    fn reads_a_reference_alone_and_nothing_around_one() {
        assert_eq!(variable_of("${TOKEN}"), Some("TOKEN".into()));
        for not in ["Bearer ${TOKEN}", "${TOKEN}x", "$TOKEN", "${1X}", "${}", ""] {
            assert_eq!(variable_of(not), None, "{not:?}");
        }
    }

    #[test]
    fn lists_each_variable_once_in_order() {
        assert_eq!(
            variables_in(r#"{"a":"${B} ${A_1}","c":"${B}","d":"${2X} ${ x}"}"#),
            vec!["B", "A_1"]
        );
    }

    #[test]
    fn fills_each_reference_and_leaves_what_is_not_one() {
        assert_eq!(
            fill_variables("Bearer ${TOKEN}; ${ x} ${TOKEN}", &env),
            Ok("Bearer t0k; ${ x} t0k".into())
        );
    }

    #[test]
    fn takes_a_variable_set_to_nothing_as_not_set() {
        assert_eq!(fill_variables("a ${EMPTY}", &env), Err("EMPTY".into()));
        assert_eq!(fill_variables("${UNSET}", &env), Err("UNSET".into()));
    }

    #[test]
    fn never_reads_a_filled_value_as_a_reference() {
        let nested = |name: &str| (name == "A").then(|| "${B}".to_string());
        assert_eq!(fill_variables("${A}", &nested), Ok("${B}".into()));
    }
}

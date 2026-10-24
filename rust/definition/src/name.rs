//! What each thing spore and its host name may be called. A name becomes a path segment, a part
//! of a URL or of an origin, and gets typed into shells: one segment of ordinary characters, the
//! first a letter or digit so it is never read as a flag or a hidden file.

use regex::Regex;
use std::sync::LazyLock;

pub const NAME_MOST: usize = 64;

pub const NAME_KINDS: [&str; 10] = [
    "spore",
    "schedule",
    "job",
    "hook",
    "caller",
    "bot",
    "sporangium",
    "approval",
    "plugin",
    "precursor",
];

// A job's name and a plugin's are lowercase: a plugin's is the end of an npm package name.
const LOWERCASE: [&str; 2] = ["job", "plugin"];

/// An environment variable's name, which a plugin's programs and its settings are given as.
pub const VARIABLE_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
pub const VARIABLE_RULE: &str = "letters, digits and _, not starting with a digit";
pub static VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(VARIABLE_PATTERN).expect("the variable pattern compiles"));

static ANY_CASE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&pattern(false)).expect("the name pattern compiles"));
static LOWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&pattern(true)).expect("the name pattern compiles"));

fn pattern(lowercase: bool) -> String {
    let letters = if lowercase { "a-z0-9" } else { "A-Za-z0-9" };
    format!("^[{letters}][{letters}._-]{{0,{}}}$", NAME_MOST - 1)
}

fn known(kind: &str) -> Result<bool, String> {
    if NAME_KINDS.contains(&kind) {
        Ok(LOWERCASE.contains(&kind))
    } else {
        Err(format!(
            "\"{kind}\" is no kind of name — expected one of {}",
            NAME_KINDS.join(", ")
        ))
    }
}

/// The pattern a name of `kind` matches, as a regular expression JavaScript reads alike.
pub fn name_pattern(kind: &str) -> Result<String, String> {
    known(kind).map(pattern)
}

pub fn name_rule(kind: &str) -> Result<String, String> {
    let lowercase = known(kind)?;
    Ok(format!(
        "{}letters, digits, ., _ and -, starting with a letter or digit, at most {NAME_MOST}",
        if lowercase { "lowercase " } else { "" }
    ))
}

pub fn is_name(kind: &str, name: &str) -> Result<bool, String> {
    Ok(if known(kind)? { &LOWER } else { &ANY_CASE }.is_match(name))
}

/// Whether `origin` names who delivers in a spore's definition: `hook:<hook>`, `job:<job>` or
/// `api:<caller>`, the name one that kind may have.
pub fn is_origin(origin: &str) -> bool {
    let Some((kind, name)) = origin.split_once(':') else {
        return false;
    };
    let kind = match kind {
        "hook" => "hook",
        "job" => "job",
        "api" => "caller",
        _ => return false,
    };
    is_name(kind, name).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_one_segment_of_ordinary_characters_at_most_64() {
        for good in ["a", "Daily-report", "v1.2_x", &"a".repeat(64)] {
            assert_eq!(is_name("spore", good), Ok(true), "{good}");
        }
        for bad in ["", "-a", ".a", "_a", "a b", "a/b", "a:b", &"a".repeat(65)] {
            assert_eq!(is_name("spore", bad), Ok(false), "{bad:?}");
        }
    }

    #[test]
    fn keeps_a_jobs_name_and_a_plugins_lowercase() {
        assert_eq!(is_name("job", "Scan"), Ok(false));
        assert_eq!(is_name("plugin", "PDF"), Ok(false));
        assert_eq!(is_name("caller", "Pipeline"), Ok(true));
        assert!(name_rule("job").unwrap().starts_with("lowercase "));
        assert!(!name_rule("hook").unwrap().starts_with("lowercase "));
    }

    #[test]
    fn refuses_a_kind_it_does_not_know() {
        assert!(is_name("tool", "read")
            .unwrap_err()
            .contains("no kind of name"));
        assert!(name_pattern("tool").is_err());
    }

    #[test]
    fn reads_an_origin_by_the_name_its_kind_may_have() {
        for good in ["hook:forge", "job:scan", "api:Pipeline"] {
            assert!(is_origin(good), "{good}");
        }
        for bad in [
            "job:Scan",
            "hook:",
            "api:a b",
            "schedule:daily",
            "forge",
            "hook:-x",
        ] {
            assert!(!is_origin(bad), "{bad}");
        }
    }

    #[test]
    fn says_its_pattern_as_javascript_reads_it() {
        assert_eq!(name_pattern("job").unwrap(), "^[a-z0-9][a-z0-9._-]{0,63}$");
        assert_eq!(
            name_pattern("spore").unwrap(),
            "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
        );
    }
}

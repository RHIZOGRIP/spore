//! What a person is shown of a tool call — its title, its category and its detail — from the rows
//! that describe calls: a spore's own `:::call` blocks, then its plugins' `describe`, then the
//! runtime's. Contract: ARCHITECTURE.md, "Describing a call".

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::{parse_frontmatter, Value, TOOL_NAMES};

/// What sort of call it is, for a surface choosing an icon or a grouping. Agent Client Protocol's
/// tool kinds, plus `delegate` for starting sub-agents and `ask` for a question to the person.
pub const CATEGORIES: [&str; 10] = [
    "read", "edit", "delete", "move", "search", "execute", "fetch", "delegate", "ask", "other",
];

const COMMAND_TOOLS: [&str; 2] = ["exec", "wsexec"];
const ROW_KEYS: [&str; 5] = ["tool", "program", "title", "category", "detail"];

const CAPTURE_MAX: usize = 40;
const LINE_MAX: usize = 70;

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$([0-9])").unwrap());

/// One way of describing calls: the tools it applies to, and for a command the regexp its first
/// line must match, whose captures `$1`…`$9` fill the title and the detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallRow {
    pub name: String,
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    pub title: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Description {
    pub title: String,
    pub category: String,
    pub detail: String,
}

fn row(
    name: &str,
    tools: &[&str],
    program: Option<&str>,
    title: &str,
    category: &str,
    detail: Option<&str>,
) -> CallRow {
    CallRow {
        name: name.into(),
        tools: tools.iter().map(|t| t.to_string()).collect(),
        program: program.map(String::from),
        title: title.into(),
        category: category.into(),
        detail: detail.map(String::from),
    }
}

/// The runtime's own rows: every tool, and every program the runtime gives an agent. A plugin
/// describes its own programs in its manifest.
static RUNTIME_ROWS: LazyLock<Vec<CallRow>> = LazyLock::new(|| {
    let commands = &COMMAND_TOOLS[..];
    vec![
        row(
            "source",
            commands,
            Some(r#"^node\s+"?\$SPORE_SOURCE"?\s+([\w.-]+)\s*(.*)$"#),
            "asking $1",
            "fetch",
            Some("source $1 $2"),
        ),
        row(
            "fanout",
            commands,
            Some(r#"^node\s+"?\$SPORE_FANOUT"?\s*(.*)$"#),
            "starting sub-agents",
            "delegate",
            Some("fanout $1"),
        ),
        row(
            "spawn",
            commands,
            Some(r#"^"?\$SPORE_SPAWN"?\s*(.*)$"#),
            "starting a sub-agent",
            "delegate",
            Some("spawn $1"),
        ),
        row(
            "sql",
            commands,
            Some(r#"^(?:node\s+)?"?\$SPORE_SQL"?\s*(.*)$"#),
            "reading its records",
            "read",
            Some("sql $1"),
        ),
        row(
            "recall",
            commands,
            Some(r#"^(?:node\s+)?"?\$SPORE_RECALL"?\s*(.*)$"#),
            "searching its memory",
            "search",
            Some("recall $1"),
        ),
        row(
            "job",
            commands,
            Some(r#"^node\s+"?\$SPORE_JOB"?\s+(\w+)\s*(.*)$"#),
            "managing a job",
            "execute",
            Some("job $1 $2"),
        ),
        row(
            "enzyme",
            commands,
            Some(r#"^node\s+"?\$SPORE_ENZYME"?\s+([\w.-]+)\s*(.*)$"#),
            "running $1",
            "execute",
            Some("enzyme $1 $2"),
        ),
        row("read", &["read"], None, "reading a file", "read", None),
        row("write", &["write"], None, "writing a file", "edit", None),
        row("edit", &["edit"], None, "editing a file", "edit", None),
        row(
            "command",
            commands,
            None,
            "running a command",
            "execute",
            None,
        ),
        row("ask", &["ask"], None, "asking a question", "ask", None),
        row(
            "quiet",
            &["quiet"],
            None,
            "ending with nothing to say",
            "other",
            None,
        ),
    ]
});

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max - 1).collect();
    format!("{}…", kept.trim_end())
}

fn first_line(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn highest_placeholder(text: &str) -> usize {
    PLACEHOLDER
        .captures_iter(text)
        .map(|c| c[1].parse::<usize>().unwrap())
        .max()
        .unwrap_or(0)
}

/// A row as an operator, a sporangium or a plugin wrote it, checked: what it applies to exists, its
/// regexp compiles, and every `$N` it fills names a group the regexp has.
pub fn check_row(row: &CallRow) -> Result<(), String> {
    if row.tools.is_empty() {
        return Err("names no tool — tool: read, or tool: [exec, wsexec]".into());
    }
    if let Some(unknown) = row.tools.iter().find(|t| !TOOL_NAMES.contains(&t.as_str())) {
        return Err(format!(
            "names a tool that does not exist — got \"{unknown}\", expected one of {}",
            TOOL_NAMES.join(", ")
        ));
    }
    if row.title.trim().is_empty() {
        return Err(
            "has no title — the words a person is shown, as title: reading the contract".into(),
        );
    }
    if !CATEGORIES.contains(&row.category.as_str()) {
        return Err(format!(
            "has a category that does not exist — got \"{}\", expected one of {}",
            row.category,
            CATEGORIES.join(", ")
        ));
    }
    let groups = match &row.program {
        None => 0,
        Some(program) => {
            if let Some(other) = row
                .tools
                .iter()
                .find(|t| !COMMAND_TOOLS.contains(&t.as_str()))
            {
                return Err(format!(
                    "has a program and applies to {other} — a program is matched against a command, which only exec and wsexec run"
                ));
            }
            let compiled = Regex::new(program)
                .map_err(|e| format!("has a program that is not a regexp — {e}"))?;
            compiled.captures_len() - 1
        }
    };
    for (field, text) in [("title", Some(&row.title)), ("detail", row.detail.as_ref())] {
        let Some(text) = text else { continue };
        let wanted = highest_placeholder(text);
        if wanted > groups {
            return Err(format!(
                "fills ${wanted} in its {field}, and its program captures {groups}"
            ));
        }
    }
    Ok(())
}

/// A `:::call <name>` block's body: `key: value` lines, as frontmatter is written.
pub fn parse_call_block(name: &str, body: &str) -> Result<CallRow, String> {
    let fields = parse_frontmatter(body).map_err(|e| format!("\":::call {name}\" {e}"))?;
    for (key, _) in &fields.0 {
        if !ROW_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "\":::call {name}\" has an unknown key \"{key}\" — a call block takes {}",
                ROW_KEYS.join(", ")
            ));
        }
    }
    let one = |key: &str| -> Result<Option<String>, String> {
        match fields.get(key) {
            None => Ok(None),
            Some(Value::Scalar(text)) => Ok(Some(text.clone())),
            Some(Value::List(_)) => Err(format!(
                "\":::call {name}\" has a list for {key}, which takes one value"
            )),
        }
    };
    let tools = match fields.get("tool") {
        None => Vec::new(),
        Some(Value::Scalar(tool)) => vec![tool.clone()],
        Some(Value::List(tools)) => tools.clone(),
    };
    let row = CallRow {
        name: name.to_string(),
        tools,
        program: one("program")?,
        title: one("title")?.unwrap_or_default(),
        category: one("category")?.unwrap_or_default(),
        detail: one("detail")?,
    };
    check_row(&row).map_err(|e| format!("\":::call {name}\" {e}"))?;
    Ok(row)
}

/// A plugin's `describe`: rows for the programs it declares, each matched against a command, so
/// each names one of them.
pub fn check_plugin_rows(rows: &[CallRow], programs: &[String]) -> Result<(), String> {
    for row in rows {
        let Some(program) = &row.program else {
            return Err(format!(
                "describes \"{}\" without a program — a plugin describes the programs it declares",
                row.name
            ));
        };
        if !programs.iter().any(|p| program.contains(p.as_str())) {
            return Err(format!(
                "describes \"{}\", whose program names none of its programs ({})",
                row.name,
                programs.join(", ")
            ));
        }
        check_row(row).map_err(|e| format!("describes \"{}\" — {e}", row.name))?;
    }
    Ok(())
}

fn fill(template: &str, captures: Option<&regex::Captures>, capture_max: usize) -> String {
    let filled = PLACEHOLDER.replace_all(template, |c: &regex::Captures| {
        let index: usize = c[1].parse().unwrap();
        captures
            .and_then(|found| found.get(index))
            .map(|m| cut(m.as_str(), capture_max))
            .unwrap_or_default()
    });
    cut(&filled, LINE_MAX)
}

fn verb(tool: &str) -> Option<&'static str> {
    match tool {
        "read" => Some("reading"),
        "write" => Some("writing"),
        "edit" => Some("editing"),
        _ => None,
    }
}

/// The description of one call: the first row that applies, from `rows` and then the runtime's.
/// A file tool's detail is its path, a command's its first line, unless the row says otherwise. A
/// tool no row names — one the model made up — is shown by its name. Rows reach here checked, so
/// a program that does not compile is refused rather than passed over.
pub fn describe(
    tool: &str,
    path: Option<&str>,
    command: Option<&str>,
    rows: &[CallRow],
) -> Result<Description, String> {
    let line = command.map(first_line);
    for row in rows.iter().chain(RUNTIME_ROWS.iter()) {
        if !row.tools.iter().any(|t| t == tool) {
            continue;
        }
        let captures = match (&row.program, &line) {
            (None, _) => None,
            (Some(program), Some(line)) => {
                let compiled = Regex::new(program).map_err(|e| {
                    format!("the call row \"{}\" was never checked — {e}", row.name)
                })?;
                match compiled.captures(line) {
                    Some(found) => Some(found),
                    None => continue,
                }
            }
            (Some(_), None) => continue,
        };
        let detail = match (&row.detail, verb(tool), &line) {
            (Some(template), _, _) => fill(template, captures.as_ref(), LINE_MAX),
            (None, Some(verb), _) => cut(&format!("{verb} {}", path.unwrap_or("")), LINE_MAX),
            (None, None, Some(line)) => cut(&format!("running {line}"), LINE_MAX),
            (None, None, None) => fill(&row.title, captures.as_ref(), CAPTURE_MAX),
        };
        return Ok(Description {
            title: fill(&row.title, captures.as_ref(), CAPTURE_MAX),
            category: row.category.clone(),
            detail,
        });
    }
    Ok(Description {
        title: cut(tool, LINE_MAX),
        category: "other".into(),
        detail: cut(tool, LINE_MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(line: &str, rows: &[CallRow]) -> Description {
        describe("exec", None, Some(line), rows).unwrap()
    }

    fn file(tool: &str, path: &str, rows: &[CallRow]) -> Description {
        describe(tool, Some(path), None, rows).unwrap()
    }

    #[test]
    fn describes_every_tool_and_runtime_program_as_the_relay_did() {
        assert_eq!(file("read", "data/a.md", &[]).title, "reading a file");
        assert_eq!(file("read", "data/a.md", &[]).detail, "reading data/a.md");
        assert_eq!(file("edit", "x.js", &[]).category, "edit");
        let asked = command(r#"node "$SPORE_SOURCE" ledger --month 2026-09"#, &[]);
        assert_eq!(asked.title, "asking ledger");
        assert_eq!(asked.detail, "source ledger --month 2026-09");
        assert_eq!(asked.category, "fetch");
        assert_eq!(
            command(r#"node "$SPORE_SQL" -"#, &[]).title,
            "reading its records"
        );
        assert_eq!(
            command(r#""$SPORE_SQL" -"#, &[]).title,
            "reading its records"
        );
        assert_eq!(
            command(r#"node "$SPORE_FANOUT" summarize parts/"#, &[]).category,
            "delegate"
        );
        let plain = command("grep -n shutdown manual.md\nwc -l x", &[]);
        assert_eq!(plain.title, "running a command");
        assert_eq!(plain.detail, "running grep -n shutdown manual.md");
        assert_eq!(
            describe("wsexec", None, Some("npm test"), &[])
                .unwrap()
                .category,
            "execute"
        );
    }

    #[test]
    fn takes_the_first_row_that_applies_before_the_runtime_s() {
        let rows = vec![
            row("doc", &["read"], None, "reading the contract", "read", None),
            row(
                "search",
                &COMMAND_TOOLS,
                Some(r#"^node\s+"?\$SPORE_DA"?\s+search\s+(.+)$"#),
                "searching for $1",
                "search",
                None,
            ),
        ];
        assert_eq!(file("read", "c.pdf", &rows).title, "reading the contract");
        assert_eq!(file("read", "c.pdf", &rows).detail, "reading c.pdf");
        assert_eq!(
            command(r#"node "$SPORE_DA" search late fees"#, &rows).title,
            "searching for late fees"
        );
        assert_eq!(command("ls data", &rows).title, "running a command");
    }

    #[test]
    fn cuts_what_a_capture_brings_and_never_reads_it_as_markup() {
        let rows = vec![row(
            "all",
            &["exec"],
            Some("^echo (.*)$"),
            "saying $1",
            "other",
            None,
        )];
        let long = format!("echo {}", "x".repeat(200));
        let told = command(&long, &rows);
        assert!(told.title.chars().count() <= LINE_MAX);
        assert!(told.title.ends_with('…'));
        assert_eq!(
            command("echo **bold** <b>", &rows).title,
            "saying **bold** <b>"
        );
    }

    #[test]
    fn shows_a_tool_no_row_names_by_its_name() {
        let told = describe("frobnicate", None, None, &[]).unwrap();
        assert_eq!(
            (told.title.as_str(), told.category.as_str()),
            ("frobnicate", "other")
        );
    }

    #[test]
    fn refuses_a_row_that_cannot_describe_anything() {
        let check = |tools: &[&str], program: Option<&str>, title: &str, category: &str| {
            check_row(&row("r", tools, program, title, category, None))
        };
        assert!(check(&["read"], None, "reading", "read").is_ok());
        assert!(check(&["fetch"], None, "x", "read")
            .unwrap_err()
            .contains("tool that does not exist"));
        assert!(check(&["read"], Some("^x"), "x", "read")
            .unwrap_err()
            .contains("only exec and wsexec"));
        assert!(check(&["exec"], Some("("), "x", "execute")
            .unwrap_err()
            .contains("not a regexp"));
        assert!(check(&["exec"], Some("^a (b)$"), "x $2", "execute")
            .unwrap_err()
            .contains("captures 1"));
        assert!(check(&["exec"], None, " ", "execute")
            .unwrap_err()
            .contains("no title"));
        assert!(check(&["exec"], None, "x", "run")
            .unwrap_err()
            .contains("category that does not exist"));
    }

    #[test]
    fn reads_a_call_block_as_frontmatter_is_written() {
        let parsed = parse_call_block(
            "da-search",
            "tool: [exec, wsexec]\nprogram: ^node \"\\$SPORE_DA\" search (.+)$\ntitle: searching for $1\ncategory: search",
        )
        .unwrap();
        assert_eq!(parsed.tools, vec!["exec", "wsexec"]);
        assert_eq!(
            parsed.program.as_deref(),
            Some("^node \"\\$SPORE_DA\" search (.+)$")
        );
        assert!(
            parse_call_block("x", "tool: read\ntitle: t\ncategory: read\nicon: book")
                .unwrap_err()
                .contains("unknown key \"icon\"")
        );
    }

    #[test]
    fn holds_a_plugin_to_the_programs_it_declares() {
        let programs = vec!["SPORE_BROWSER".to_string()];
        let own = row(
            "b",
            &COMMAND_TOOLS,
            Some(r#"^"?\$SPORE_BROWSER"#),
            "using the browser",
            "fetch",
            None,
        );
        assert!(check_plugin_rows(&[own], &programs).is_ok());
        let other = row(
            "s",
            &COMMAND_TOOLS,
            Some(r#"^"?\$SPORE_SQL"#),
            "x",
            "read",
            None,
        );
        assert!(check_plugin_rows(&[other], &programs)
            .unwrap_err()
            .contains("names none of its programs"));
    }

    #[test]
    fn every_runtime_row_holds_to_its_own_rules() {
        for r in RUNTIME_ROWS.iter() {
            check_row(r).unwrap_or_else(|e| panic!("{}: {e}", r.name));
        }
    }
}

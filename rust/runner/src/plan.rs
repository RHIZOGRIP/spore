//! Resolving and validating one spawn before anything runs. Contract: ARCHITECTURE.md,
//! "Spawn".

use std::collections::BTreeMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use spore_definition::{parse_definition, Definition, Options, TOOL_NAMES};
use spore_workspace::{
    safe_path, writable_dirs, DATA_DIR, PRECURSOR_DIR, PRECURSOR_EXT, SPAWN_FILE,
};

pub struct Asked<'a> {
    pub precursor: Option<&'a str>,
    pub ws: Option<&'a str>,
    pub prompt: Option<&'a str>,
    pub answer: Option<&'a str>,
}

pub struct Enzyme {
    pub name: String,
    pub command: PathBuf,
    pub description: Option<String>,
    pub with: Vec<PathBuf>,
}

pub struct Plan {
    pub ws: PathBuf,
    pub prompt_path: PathBuf,
    pub answer_path: PathBuf,
    pub precursor_path: PathBuf,
    pub precursor: Definition,
    pub enzymes: Vec<Enzyme>,
}

/// Lexical, as `path.resolve` is: `..` is taken off the path, never looked up.
pub fn resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in base.join(rel).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => {}
        }
    }
    out
}

fn executable(path: &Path) -> bool {
    CString::new(path.as_os_str().as_bytes())
        .map(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
        .unwrap_or(false)
}

fn resolve_precursor(cwd: &Path, name: &str) -> Result<(PathBuf, Definition, Vec<Enzyme>), String> {
    let path = cwd
        .join(PRECURSOR_DIR)
        .join(format!("{name}{PRECURSOR_EXT}"));
    let source = std::fs::read_to_string(&path).map_err(|_| {
        format!("precursor not found — expected {PRECURSOR_DIR}/{name}{PRECURSOR_EXT}")
    })?;
    let known: Vec<String> = TOOL_NAMES.iter().map(|t| t.to_string()).collect();
    let definition = parse_definition(
        &source,
        &Options {
            known_tools: &known,
            cell: true,
            seed: false,
        },
    )
    .map_err(|error| format!("precursor {name} {error}"))?;
    if definition.name != name {
        return Err(format!(
            "precursor {name} calls itself \"{}\" — the catalog lists precursors by file name, so a mismatch offers the agent one name and records another",
            definition.name
        ));
    }
    let mut enzymes = Vec::new();
    for entry in &definition.enzymes {
        let command = resolve(cwd, &entry.path);
        if !command.exists() {
            return Err(format!(
                "precursor {name} declares an enzyme that does not exist — {} at {}",
                entry.name, entry.path
            ));
        }
        if !executable(&command) {
            return Err(format!(
                "precursor {name} declares an enzyme that is not executable — {} at {}",
                entry.name, entry.path
            ));
        }
        let mut with = Vec::new();
        for needed in &entry.with {
            let path = resolve(cwd, needed);
            if !path.exists() {
                return Err(format!(
                    "precursor {name} says {} needs {needed}, which does not exist",
                    entry.name
                ));
            }
            with.push(path);
        }
        enzymes.push(Enzyme {
            name: entry.name.clone(),
            command,
            description: entry.description.clone(),
            with,
        });
    }
    Ok((path, definition, enzymes))
}

fn contained(ws: &Path, rel: &str, label: &str) -> Result<PathBuf, String> {
    safe_path(ws, rel, &[]).map_err(|refused| {
        format!(
            "{label} must be inside the workspace — {}",
            if refused.detail.is_empty() {
                refused.message
            } else {
                refused.detail
            }
        )
    })
}

/// `granted` says which sandbox grant, if any, holds a directory; a workspace inside one
/// cannot isolate a child confined beneath it.
/// A precursor's `model:` names one of its spore's `cell-models`; this gives the model it stands for.
/// A spore with none runs every cell on its parent's model, so the name is dropped; one with some
/// refuses a name it does not have, which is a typo rather than a precursor from elsewhere.
pub fn cell_model(
    precursor: &str,
    named: Option<&str>,
    cell_models: &BTreeMap<String, String>,
) -> Result<Option<String>, String> {
    match named {
        None => Ok(None),
        Some(_) if cell_models.is_empty() => Ok(None),
        Some(name) => cell_models.get(name).cloned().map(Some).ok_or_else(|| {
            format!(
                "precursor {precursor} runs on the cell model \"{name}\", which this spore's cell-models does not have — it has {}",
                cell_models.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        }),
    }
}

pub fn plan_spawn(
    asked: &Asked,
    cwd: &Path,
    cell_models: &BTreeMap<String, String>,
    granted: impl Fn(&Path, &[PathBuf]) -> Option<PathBuf>,
) -> Result<Plan, String> {
    let required = |label: &str, value: Option<&str>| -> Result<String, String> {
        value
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("{label} is required"))
    };
    let precursor = required("--precursor", asked.precursor)?;
    let ws = required("--ws", asked.ws)?;
    let prompt = required("--prompt", asked.prompt)?;
    let answer = required("--answer", asked.answer)?;

    // Before the workspace check, because what the cell may read is part of what would
    // make a directory an unusable place to confine it.
    let (precursor_path, mut definition, enzymes) = resolve_precursor(cwd, &precursor)?;
    definition.model = cell_model(&precursor, definition.model.as_deref(), cell_models)?;

    let ws_path = resolve(cwd, &ws);
    if !ws_path.is_dir() {
        return Err(format!("workspace is not a directory — {ws}"));
    }
    let ws_path = std::fs::canonicalize(&ws_path).map_err(|e| format!("{ws} — {e}"))?;
    let reads: Vec<PathBuf> = definition
        .reads
        .iter()
        .map(|r| PathBuf::from(&r.path))
        .collect();
    if let Some(grant) = granted(&ws_path, &reads) {
        return Err(format!(
            "workspace is inside a sandbox-granted path ({}) — a child there could read and write everything around it; use a directory outside the spore repo and outside /tmp",
            grant.display()
        ));
    }
    // The worker writes this the moment a cell starts, so a supervisor that died while
    // staging has not spent the name.
    if ws_path.join(SPAWN_FILE).exists() {
        return Err(format!(
            "workspace is already used — {ws} contains {SPAWN_FILE}, name another one"
        ));
    }

    let prompt_path = contained(&ws_path, &prompt, "--prompt")?;
    if !prompt_path.exists() {
        return Err(format!("prompt not found — {prompt}"));
    }
    let answer_path = contained(&ws_path, &answer, "--answer")?;
    if answer_path.exists() {
        return Err(format!("answer already exists — {answer}"));
    }
    // The child writes the answer from inside its own sandbox, where the workspace root is
    // a read path: a root-level answer is EACCES at the end of the work, not the start.
    if !writable_dirs(&ws_path)
        .iter()
        .any(|dir| answer_path.starts_with(dir) && answer_path != *dir)
    {
        return Err(format!(
            "answer must be inside the child's writable directories — {answer} is at the workspace root, which the child can read and not write; name {DATA_DIR}/{answer} instead"
        ));
    }

    Ok(Plan {
        ws: ws_path,
        prompt_path,
        answer_path,
        precursor_path,
        precursor: definition,
        enzymes,
    })
}

impl Plan {
    /// What `bin/spawn-worker.js` reads as `SPORE_PLAN`: the precursor as the parser
    /// serializes it, with each enzyme resolved and hashed.
    pub fn for_worker(&self, answer: &str, hashes: &[String]) -> Value {
        let mut precursor = serde_json::to_value(&self.precursor).expect("a definition serializes");
        let fields = precursor
            .as_object_mut()
            .expect("a definition is an object");
        fields.remove("retain");
        fields.remove("memory");
        fields.insert(
            "enzymes".into(),
            Value::Array(
                self.enzymes
                    .iter()
                    .zip(hashes)
                    .map(|(enzyme, hash)| {
                        json!({
                            "name": enzyme.name,
                            "command": enzyme.command,
                            "description": enzyme.description,
                            "hash": hash
                        })
                    })
                    .collect(),
            ),
        );
        json!({
            "ws": self.ws,
            "promptPath": self.prompt_path,
            "answerPath": self.answer_path,
            "precursorPath": self.precursor_path,
            "precursor": precursor,
            "answer": answer
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const SUMMARIZE: &str = "---\nname: summarize\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou summarize.\n";

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn root(name: &str) -> Root {
        let dir = std::env::temp_dir().join(format!("spore-plan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("work/1")).unwrap();
        fs::create_dir_all(dir.join("precursors")).unwrap();
        fs::write(dir.join("precursors/summarize.cmk"), SUMMARIZE).unwrap();
        fs::write(dir.join("work/1/in.md"), "material").unwrap();
        Root(fs::canonicalize(&dir).unwrap())
    }

    fn plan_with(root: &Root, over: &[(&str, Option<&str>)]) -> Result<Plan, String> {
        let get = |key: &str, default: &'static str| {
            over.iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| *v)
                .unwrap_or(Some(default))
        };
        let asked = Asked {
            precursor: get("precursor", "summarize"),
            ws: get("ws", "work/1"),
            prompt: get("prompt", "in.md"),
            answer: get("answer", "data/out.json"),
        };
        plan_spawn(&asked, &root.0, &BTreeMap::new(), |_, _| None)
    }

    fn error(root: &Root, over: &[(&str, Option<&str>)]) -> String {
        match plan_with(root, over) {
            Ok(_) => panic!("planned what it should have refused"),
            Err(e) => e,
        }
    }

    #[test]
    fn refuses_a_workspace_a_sandbox_grant_already_holds() {
        let r = root("granted");
        let asked = Asked {
            precursor: Some("summarize"),
            ws: Some("work/1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        let refused = plan_spawn(&asked, &r.0, &BTreeMap::new(), |_, _| {
            Some(PathBuf::from("/tmp"))
        })
        .err()
        .unwrap();
        assert!(refused.contains("inside a sandbox-granted path (/tmp)"));
        assert!(refused.contains("outside the spore repo and outside /tmp"));
    }

    #[test]
    fn runs_a_cell_on_the_model_its_name_stands_for_and_drops_the_name_where_there_are_none() {
        let map: BTreeMap<String, String> = [
            ("low".to_string(), "anthropic/claude-haiku-4-5".to_string()),
            ("strong".to_string(), "openai/gpt-6.1-sol".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            cell_model("summarize", Some("strong"), &map),
            Ok(Some("openai/gpt-6.1-sol".to_string()))
        );
        assert_eq!(cell_model("summarize", None, &map), Ok(None));
        assert_eq!(
            cell_model("summarize", Some("strong"), &BTreeMap::new()),
            Ok(None)
        );
        assert!(cell_model("summarize", Some("fast"), &map)
            .unwrap_err()
            .contains("does not have — it has low, strong"));
    }

    #[test]
    fn resolves_a_well_formed_spawn_into_what_the_worker_reads() {
        let r = root("well-formed");
        let p = plan_with(&r, &[]).unwrap();
        assert_eq!(p.ws, r.0.join("work/1"));
        assert_eq!(p.prompt_path, r.0.join("work/1/in.md"));
        assert_eq!(p.answer_path, r.0.join("work/1/data/out.json"));
        let worker = p.for_worker("data/out.json", &[]);
        assert_eq!(worker["answer"], "data/out.json");
        assert_eq!(
            worker["precursor"],
            json!({
                "name": "summarize",
                "identity": "You summarize.",
                "tools": ["read"],
                "reads": [],
                "writes": [],
                "sources": [],
                "plugins": [],
                "scopes": {},
                "limits": { "rounds": { "soft": 5.0, "hard": 7.0 }, "cost": { "soft": 0.1, "hard": 0.15 }, "wall": { "soft": 120000.0, "hard": 180000.0 } },
                "onWrap": "discard",
                "enzymes": []
            })
        );
    }

    #[test]
    fn refuses_a_workspace_that_has_already_been_used() {
        let r = root("used");
        fs::write(r.0.join("work/1/spawn.json"), "{}").unwrap();
        assert!(
            error(&r, &[]).contains("already used — work/1 contains spawn.json, name another one")
        );
    }

    #[test]
    fn does_not_spend_the_name_when_a_spawn_died_before_its_worker_ran() {
        let r = root("unspent");
        fs::write(r.0.join("work/1/spore.cmk"), SUMMARIZE).unwrap();
        assert!(plan_with(&r, &[]).is_ok());
    }

    #[test]
    fn keeps_prompt_and_answer_inside_the_workspace() {
        let r = root("contained");
        assert!(error(&r, &[("prompt", Some("../../secret.md"))])
            .contains("--prompt must be inside the workspace"));
        assert!(error(&r, &[("answer", Some("/etc/passwd"))])
            .contains("--answer must be inside the workspace"));
    }

    #[test]
    fn refuses_to_overwrite_an_existing_answer() {
        let r = root("answered");
        fs::create_dir_all(r.0.join("work/1/data")).unwrap();
        fs::write(r.0.join("work/1/data/out.json"), "previous").unwrap();
        assert!(error(&r, &[]).contains("answer already exists"));
    }

    #[test]
    fn reports_a_missing_workspace_prompt_or_precursor_distinctly() {
        let r = root("missing");
        assert!(error(&r, &[("ws", Some("work/absent"))]).contains("workspace is not a directory"));
        assert!(error(&r, &[("prompt", Some("absent.md"))]).contains("prompt not found"));
        assert!(error(&r, &[("precursor", Some("absent"))])
            .contains("precursor not found — expected precursors/absent.cmk"));
    }

    #[test]
    fn surfaces_a_malformed_precursor_with_its_name_attached() {
        let r = root("malformed");
        fs::write(r.0.join("precursors/bad.cmk"), "no frontmatter").unwrap();
        assert!(error(&r, &[("precursor", Some("bad"))])
            .contains("precursor bad must open with a --- frontmatter block"));
    }

    #[test]
    fn refuses_a_precursor_whose_name_disagrees_with_its_file_name() {
        let r = root("mismatch");
        fs::write(
            r.0.join("precursors/mismatch.cmk"),
            SUMMARIZE.replace("name: summarize", "name: something-else"),
        )
        .unwrap();
        assert!(error(&r, &[("precursor", Some("mismatch"))])
            .contains("calls itself \"something-else\""));
    }

    #[test]
    fn refuses_an_answer_the_child_could_not_write_before_anything_runs() {
        let r = root("island");
        let refused = error(&r, &[("answer", Some("out.json"))]);
        assert!(refused.contains("answer must be inside the child's writable directories"));
        assert!(refused.contains("name data/out.json instead"));
        assert!(plan_with(&r, &[("answer", Some("precursors/out.json"))]).is_ok());
    }

    #[test]
    fn refuses_a_precursor_that_grants_ask() {
        let r = root("ask");
        fs::write(
            r.0.join("precursors/summarize.cmk"),
            SUMMARIZE.replace("tools: [read]", "tools: [read, ask]"),
        )
        .unwrap();
        let refused = error(&r, &[]);
        assert!(
            refused.contains("grants \"ask\"") && refused.contains("a cell has no user"),
            "{refused}"
        );
    }

    #[test]
    fn refuses_an_enzyme_that_is_missing_or_not_executable() {
        let r = root("enzymes");
        fs::write(
            r.0.join("precursors/withenzyme.cmk"),
            "---\nname: withenzyme\ntools: [exec]\nenzymes: [tools/wordcount]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nbody\n\n:::enzyme wordcount\nCounts lines on stdin.\n:::\n",
        )
        .unwrap();
        let with = [("precursor", Some("withenzyme"))];
        assert!(error(&r, &with)
            .contains("declares an enzyme that does not exist — wordcount at tools/wordcount"));
        fs::create_dir_all(r.0.join("tools")).unwrap();
        fs::write(r.0.join("tools/wordcount"), "#!/bin/sh\nwc -l\n").unwrap();
        assert!(error(&r, &with).contains("not executable"));
        fs::set_permissions(
            r.0.join("tools/wordcount"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let p = plan_with(&r, &with).unwrap();
        assert_eq!(p.enzymes.len(), 1);
        assert_eq!(p.enzymes[0].command, r.0.join("tools/wordcount"));
        assert_eq!(
            p.enzymes[0].description.as_deref(),
            Some("Counts lines on stdin.")
        );
        let worker = p.for_worker("data/out.json", &["abc".into()]);
        assert_eq!(worker["precursor"]["enzymes"][0]["hash"], "abc");
    }

    #[test]
    fn requires_every_argument() {
        let r = root("required");
        for missing in ["precursor", "ws", "prompt", "answer"] {
            assert!(error(&r, &[(missing, None)]).contains(&format!("--{missing} is required")));
        }
    }

    #[test]
    fn resolves_lexically() {
        assert_eq!(
            resolve(Path::new("/a/b"), "../c/./d"),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(resolve(Path::new("/a"), "/etc/x"), PathBuf::from("/etc/x"));
    }

    #[test]
    fn refuses_an_enzyme_whose_declared_needs_are_missing() {
        let r = root("with");
        fs::create_dir_all(r.0.join("tools")).unwrap();
        fs::write(r.0.join("tools/chart.mjs"), "#!/usr/bin/env node\n").unwrap();
        fs::set_permissions(
            r.0.join("tools/chart.mjs"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(
            r.0.join("precursors/charts.cmk"),
            "---\nname: charts\ntools: [exec]\nenzymes: [chart=tools/chart.mjs]\nchart.with: [tools/lib/]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nbody\n\n:::enzyme chart\nDraws.\n:::\n",
        )
        .unwrap();
        let with = [("precursor", Some("charts"))];
        assert!(error(&r, &with).contains("says chart needs tools/lib/, which does not exist"));
        fs::create_dir_all(r.0.join("tools/lib")).unwrap();
        let p = plan_with(&r, &with).unwrap();
        assert_eq!(p.enzymes[0].with, vec![r.0.join("tools/lib")]);
    }
}

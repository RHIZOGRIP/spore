//! Resolving and validating one spawn before anything runs. Contract: ARCHITECTURE.md,
//! "Spawn".

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use spore_definition::{parse_definition, Definition, Options, Pair, TOOL_NAMES};
use spore_workspace::{
    safe_path, writable_dirs, CALLS_DIR, CELLS_DIR, CELL_PRECURSOR_FILE, CHECK_DIR, DATA_DIR,
    DEFINITION_FILE, PRECURSOR_DIR, PRECURSOR_EXT, SCHEDULE_DIR, SPAWN_FILE,
};

const CHECK_EXT: &str = ".check";

pub struct Asked<'a> {
    pub precursor: Option<&'a str>,
    /// A check's cell, `checks/<name>.cmk`, in place of a precursor.
    pub check: Option<&'a str>,
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

/// The answer check a precursor names, found in its spore's `checks/`.
pub struct Check {
    pub name: String,
    pub command: PathBuf,
    /// Run by Node: a `.check.js`, which need not be executable.
    pub script: bool,
    pub with: Vec<PathBuf>,
}

pub struct Plan {
    pub ws: PathBuf,
    pub prompt_path: PathBuf,
    pub answer_path: PathBuf,
    pub precursor_path: PathBuf,
    pub precursor: Definition,
    pub enzymes: Vec<Enzyme>,
    pub check: Option<Check>,
    pub super_reach: Option<SuperReach>,
    /// The cell has an entry under `cells/`, so it can be asked again.
    pub kept: bool,
    /// This run asks a kept cell again: its transcript is replayed ahead of the prompt.
    pub resumed: bool,
}

/// What a super cell reaches beyond its own directory, as real paths: the spore, read whole, with
/// the directories its `reads` and `writes` grant; and the directories it writes.
pub struct SuperReach {
    pub spore: PathBuf,
    pub reads: Vec<(String, PathBuf)>,
    pub writes: Vec<PathBuf>,
}

/// A super cell reaches what the root agent of the spore at `spore` reaches, one notch lower: the
/// root's `writes` grants and its precursors are read and never written. It writes the rest of
/// what the root writes — `data/`, `home/`, and `schedules/` when the root may write its own.
pub fn super_reach(spore: &Path, root: &Definition) -> Result<SuperReach, String> {
    let spore = std::fs::canonicalize(spore).map_err(|e| format!("{} — {e}", spore.display()))?;
    let real = |path: &Path| std::fs::canonicalize(path).ok();
    // The trail is the runtime's: the root's agent names nothing there either.
    let root_writes = writable_dirs(&spore)
        .into_iter()
        .filter(|dir| !dir.ends_with(CALLS_DIR))
        .chain(root.schedules.is_some().then(|| spore.join(SCHEDULE_DIR)));
    let writes = root_writes
        .filter(|dir| !dir.ends_with(PRECURSOR_DIR))
        .filter_map(|dir| real(&dir))
        .collect();
    let reads = root
        .reads
        .iter()
        .chain(&root.writes)
        .filter_map(|grant| real(Path::new(&grant.path)).map(|path| (grant.name.clone(), path)))
        .collect();
    Ok(SuperReach {
        spore,
        reads,
        writes,
    })
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

fn resolve_precursor(
    spore: &Path,
    dir: &str,
    name: &str,
) -> Result<(PathBuf, Definition, Vec<Enzyme>, Option<Check>), String> {
    let path = spore.join(dir).join(format!("{name}{PRECURSOR_EXT}"));
    let source = std::fs::read_to_string(&path)
        .map_err(|_| format!("precursor not found — expected {dir}/{name}{PRECURSOR_EXT}"))?;
    let (definition, enzymes, check) = read_precursor(spore, name, &source)?;
    Ok((path, definition, enzymes, check))
}

/// The precursor `name` as `source` writes it, with each enzyme it grants and the answer check
/// it names found in `spore`.
fn read_precursor(
    spore: &Path,
    name: &str,
    source: &str,
) -> Result<(Definition, Vec<Enzyme>, Option<Check>), String> {
    let known: Vec<String> = TOOL_NAMES.iter().map(|t| t.to_string()).collect();
    let definition = parse_definition(
        source,
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
        let command = resolve(spore, &entry.path);
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
            let path = resolve(spore, needed);
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
    let check = match &definition.check {
        None => None,
        Some(named) => {
            let program = spore
                .join(CHECK_DIR)
                .join(format!("{}{CHECK_EXT}", named.name));
            let script = spore
                .join(CHECK_DIR)
                .join(format!("{}{CHECK_EXT}.js", named.name));
            let (command, script) = match (program.is_file(), script.is_file()) {
                (true, _) if executable(&program) => (program, false),
                (true, _) => {
                    return Err(format!(
                        "precursor {name} names a check that is not executable — {CHECK_DIR}/{}{CHECK_EXT}",
                        named.name
                    ))
                }
                (false, true) => (script, true),
                (false, false) => {
                    return Err(format!(
                        "precursor {name} names a check its spore does not keep — expected {CHECK_DIR}/{0}{CHECK_EXT} or {CHECK_DIR}/{0}{CHECK_EXT}.js, a program given the cell's answer",
                        named.name
                    ))
                }
            };
            let mut with = Vec::new();
            for needed in &named.with {
                let path = resolve(spore, needed);
                if !path.exists() {
                    return Err(format!(
                        "precursor {name} says its check {} needs {needed}, which does not exist",
                        named.name
                    ));
                }
                with.push(path);
            }
            Some(Check {
                name: named.name.clone(),
                command,
                script,
                with,
            })
        }
    };
    Ok((definition, enzymes, check))
}

/// The text of the precursor `name` of the spore at `spore`, read once and held to everything a
/// spawn holds it to: what a kept cell's entry records as what the cell was made from.
pub fn kept_precursor(spore: &Path, name: &str) -> Result<String, String> {
    let path = spore
        .join(PRECURSOR_DIR)
        .join(format!("{name}{PRECURSOR_EXT}"));
    let source = std::fs::read_to_string(&path).map_err(|_| {
        format!("precursor not found — expected {PRECURSOR_DIR}/{name}{PRECURSOR_EXT}")
    })?;
    check_kept(spore, name, &source)?;
    Ok(source)
}

/// Whether the precursor `name`, as `source` writes it, still makes a cell in the spore at
/// `spore`: its enzymes are there and its model is one the spore offers.
pub fn check_kept(spore: &Path, name: &str, source: &str) -> Result<(), String> {
    let (definition, _, _) = read_precursor(spore, name, source)?;
    cell_model(name, definition.model.as_deref(), &spore_definition(spore)?)?;
    Ok(())
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

/// The definition of the spore at `spore`, which every cell it runs is read against.
pub fn spore_definition(spore: &Path) -> Result<Definition, String> {
    let path = spore.join(DEFINITION_FILE);
    let source = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {} — {e}", path.display()))?;
    let known: Vec<String> = TOOL_NAMES.iter().map(|t| t.to_string()).collect();
    parse_definition(
        &source,
        &Options {
            known_tools: &known,
            cell: false,
            seed: false,
        },
    )
    .map_err(|e| format!("{DEFINITION_FILE} {e}"))
}

/// A precursor's `model:` names one of its spore's `cell-models`, and the cell runs on the model
/// that name stands for; one naming none runs on its spore's `model:`. A spore with no
/// `cell-models` runs every cell on its own model, so the name is dropped; one with some refuses
/// a name it does not have, which is a typo rather than a precursor from elsewhere.
fn cell_model(precursor: &str, named: Option<&str>, spore: &Definition) -> Result<String, String> {
    let own = || {
        spore
            .model
            .clone()
            .expect("a root definition names its model")
    };
    match named {
        None => Ok(own()),
        Some(_) if spore.cell_models.is_empty() => Ok(own()),
        Some(name) => spore
            .cell_models
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.model.clone())
            .ok_or_else(|| {
                format!(
                    "precursor {precursor} runs on the cell model \"{name}\", which this spore's cell-models does not have — it has {}",
                    spore.cell_models.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>().join(", ")
                )
            }),
    }
}

/// `granted` says which sandbox grant, if any, holds a directory; a workspace inside one
/// cannot isolate a child confined beneath it. `spore` is the workspace of the spore the cell
/// runs under, whose precursors it runs and whose definition says what model it runs on; the
/// paths it is asked for are the caller's, read from `cwd`.
pub fn plan_spawn(
    asked: &Asked,
    cwd: &Path,
    spore: &Path,
    granted: impl Fn(&Path, &[PathBuf]) -> Option<PathBuf>,
) -> Result<Plan, String> {
    let required = |label: &str, value: Option<&str>| -> Result<String, String> {
        value
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("{label} is required"))
    };
    let (dir, precursor) = match (asked.precursor, asked.check) {
        (Some(_), Some(_)) => {
            return Err("--precursor and --check each name the definition — give one".to_string())
        }
        (None, Some(_)) => (CHECK_DIR, required("--check", asked.check)?),
        _ => (PRECURSOR_DIR, required("--precursor", asked.precursor)?),
    };
    required("--ws", asked.ws)?;
    required("--prompt", asked.prompt)?;
    required("--answer", asked.answer)?;

    // Before the workspace check, because what the cell may read is part of what would
    // make a directory an unusable place to confine it.
    let (precursor_path, mut definition, enzymes, check) =
        resolve_precursor(spore, dir, &precursor)?;
    if let (Some(_), Some(named)) = (asked.check, &check) {
        return Err(format!(
            "{CHECK_DIR}/{precursor}{PRECURSOR_EXT} names the check {} — a check's cell judges an answer, and its own is not checked",
            named.name
        ));
    }
    let root = spore_definition(spore)?;
    definition.model = Some(cell_model(&precursor, definition.model.as_deref(), &root)?);
    settle(
        asked,
        cwd,
        precursor_path,
        definition,
        enzymes,
        check,
        granted,
        false,
    )
}

/// The plan of a kept cell asked again: made from `source`, the copy of its precursor `name`
/// its entry holds, never from the spore's `precursors/`, and run in the directory it already
/// ran in.
pub fn plan_resume(
    asked: &Asked,
    cwd: &Path,
    spore: &Path,
    granted: impl Fn(&Path, &[PathBuf]) -> Option<PathBuf>,
    name: &str,
    source: &str,
) -> Result<Plan, String> {
    if asked.precursor.is_some() || asked.check.is_some() {
        return Err("--resume asks a kept cell again, and what it was made from is kept with it — give neither --precursor nor --check".to_string());
    }
    let (mut definition, enzymes, check) = read_precursor(spore, name, source)?;
    let root = spore_definition(spore)?;
    definition.model = Some(cell_model(name, definition.model.as_deref(), &root)?);
    let mut plan = settle(
        asked,
        cwd,
        PathBuf::new(),
        definition,
        enzymes,
        check,
        granted,
        true,
    )?;
    let cell = plan.ws.file_name().expect("a cell's directory has a name");
    plan.precursor_path = spore.join(CELLS_DIR).join(cell).join(CELL_PRECURSOR_FILE);
    Ok(plan)
}

/// Where a cell runs and what it reads and writes there, checked before anything starts.
fn settle(
    asked: &Asked,
    cwd: &Path,
    precursor_path: PathBuf,
    definition: Definition,
    enzymes: Vec<Enzyme>,
    check: Option<Check>,
    granted: impl Fn(&Path, &[PathBuf]) -> Option<PathBuf>,
    resumed: bool,
) -> Result<Plan, String> {
    let required = |label: &str, value: Option<&str>| -> Result<String, String> {
        value
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("{label} is required"))
    };
    let ws = required(if resumed { "--resume" } else { "--ws" }, asked.ws)?;
    let prompt = required("--prompt", asked.prompt)?;
    let answer = required("--answer", asked.answer)?;

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
    match (ws_path.join(SPAWN_FILE).exists(), resumed) {
        (true, false) => {
            return Err(format!(
                "workspace is already used — {ws} contains {SPAWN_FILE}, name another one"
            ))
        }
        (false, true) => {
            return Err(format!(
                "{ws} has run no cell — a kept cell is asked again once it has answered its first prompt"
            ))
        }
        _ => {}
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
        check,
        super_reach: None,
        kept: resumed,
        resumed,
    })
}

/// The plan made the dream of the spore at `spore`: a super cell, granted only to the precursor
/// that spore's `dream.precursor` names, run under the lower of its own limits and the dream's —
/// the agent writes its precursors, so its dream may ask for more and never gets it.
pub fn dream_for(spore: &Path, plan: &mut Plan) -> Result<(), String> {
    let root = spore_definition(spore)?;
    let Some(dream) = &root.dream else {
        return Err(format!("a super cell is a dream's, and this spore declares none — dream: [turns, quiet] in its {DEFINITION_FILE}"));
    };
    if dream.precursor != plan.precursor.name {
        return Err(format!(
            "a super cell runs the spore's dream, precursor {}, not {}",
            dream.precursor, plan.precursor.name
        ));
    }
    let lower = |own: &Pair, cap: &Pair| Pair {
        soft: own.soft.min(cap.soft),
        hard: own.hard.min(cap.hard),
    };
    let limits = &mut plan.precursor.limits;
    limits.cost = lower(&limits.cost, &dream.cost);
    limits.wall = lower(&limits.wall, &dream.wall);
    plan.super_reach = Some(super_reach(spore, &root)?);
    Ok(())
}

impl Plan {
    /// What `bin/spawn-worker.js` reads as `SPORE_PLAN`: the precursor as the parser
    /// serializes it, with each enzyme resolved and hashed, and the answer check's hash.
    pub fn for_worker(&self, answer: &str, hashes: &[String], check: Option<&str>) -> Value {
        let mut precursor = serde_json::to_value(&self.precursor).expect("a definition serializes");
        let fields = precursor
            .as_object_mut()
            .expect("a definition is an object");
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
        match (&self.check, check) {
            (Some(named), Some(hash)) => {
                fields.insert("check".into(), json!({ "name": named.name, "hash": hash }));
            }
            _ => {
                fields.remove("check");
            }
        }
        json!({
            "ws": self.ws,
            "promptPath": self.prompt_path,
            "answerPath": self.answer_path,
            "precursorPath": self.precursor_path,
            "precursor": precursor,
            "answer": answer,
            "kept": self.kept,
            "resumed": self.resumed,
            "superReach": self.super_reach.as_ref().map(|reach| json!({
                "spore": reach.spore,
                "reads": reach.reads.iter().map(|(name, path)| json!({ "name": name, "path": path })).collect::<Vec<_>>(),
                "writes": reach.writes
            }))
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
        fs::write(dir.join(DEFINITION_FILE), spore_cmk("")).unwrap();
        Root(fs::canonicalize(&dir).unwrap())
    }

    fn spore_cmk(extra: &str) -> String {
        format!("---\nname: main\nmodel: fake/parent\n{extra}tools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou work.\n")
    }

    fn spore(extra: &str) -> Definition {
        let known: Vec<String> = TOOL_NAMES.iter().map(|t| t.to_string()).collect();
        parse_definition(
            &spore_cmk(extra),
            &Options {
                known_tools: &known,
                cell: false,
                seed: false,
            },
        )
        .unwrap()
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
            check: None,
            ws: get("ws", "work/1"),
            prompt: get("prompt", "in.md"),
            answer: get("answer", "data/out.json"),
        };
        plan_spawn(&asked, &root.0, &root.0, |_, _| None)
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
            check: None,
            ws: Some("work/1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        let refused = plan_spawn(&asked, &r.0, &r.0, |_, _| Some(PathBuf::from("/tmp")))
            .err()
            .unwrap();
        assert!(refused.contains("inside a sandbox-granted path (/tmp)"));
        assert!(refused.contains("outside the spore repo and outside /tmp"));
    }

    #[test]
    fn runs_a_cell_on_the_model_its_name_stands_for_and_on_its_spores_otherwise() {
        let named =
            spore("cell-models: [low=anthropic/claude-haiku-4-5, strong=openai/gpt-6.1-sol]\n");
        assert_eq!(
            cell_model("summarize", Some("strong"), &named),
            Ok("openai/gpt-6.1-sol".to_string())
        );
        assert_eq!(
            cell_model("summarize", None, &named),
            Ok("fake/parent".to_string())
        );
        assert_eq!(
            cell_model("summarize", Some("strong"), &spore("")),
            Ok("fake/parent".to_string())
        );
        assert!(cell_model("summarize", Some("fast"), &named)
            .unwrap_err()
            .contains("does not have — it has low, strong"));
    }

    #[test]
    fn settles_the_cells_model_from_its_spore_before_anything_starts() {
        let r = root("model");
        assert_eq!(
            plan_with(&r, &[]).unwrap().precursor.model.as_deref(),
            Some("fake/parent")
        );

        fs::write(
            r.0.join("precursors/named.cmk"),
            SUMMARIZE.replace("name: summarize\n", "name: named\nmodel: low\n"),
        )
        .unwrap();
        let asked = Asked {
            precursor: Some("named"),
            check: None,
            ws: Some("work/1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        fs::write(
            r.0.join(DEFINITION_FILE),
            spore_cmk("cell-models: [low=fake/cheap]\n"),
        )
        .unwrap();
        let named = plan_spawn(&asked, &r.0, &r.0, |_, _| None).unwrap();
        assert_eq!(named.precursor.model.as_deref(), Some("fake/cheap"));
    }

    #[test]
    fn runs_the_spores_precursor_on_the_paths_the_caller_names_from_where_it_is() {
        let r = root("elsewhere");
        let asked = Asked {
            precursor: Some("summarize"),
            check: None,
            ws: Some("1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        let p = plan_spawn(&asked, &r.0.join("work"), &r.0, |_, _| None).unwrap();
        assert_eq!(p.precursor_path, r.0.join("precursors/summarize.cmk"));
        assert_eq!(p.ws, r.0.join("work/1"));
    }

    #[test]
    fn resolves_a_well_formed_spawn_into_what_the_worker_reads() {
        let r = root("well-formed");
        let p = plan_with(&r, &[]).unwrap();
        assert_eq!(p.ws, r.0.join("work/1"));
        assert_eq!(p.prompt_path, r.0.join("work/1/in.md"));
        assert_eq!(p.answer_path, r.0.join("work/1/data/out.json"));
        let worker = p.for_worker("data/out.json", &[], None);
        assert_eq!(worker["answer"], "data/out.json");
        assert_eq!(
            worker["precursor"],
            json!({
                "name": "summarize",
                "model": "fake/parent",
                "identity": "You summarize.",
                "tools": ["read"],
                "reads": [],
                "writes": [],
                "sources": [],
                "plugins": [],
                "pluginOptions": {},
                "scopes": {},
                "limits": { "rounds": { "soft": 5.0, "hard": 7.0 }, "cost": { "soft": 0.1, "hard": 0.15 }, "wall": { "soft": 120000.0, "hard": 180000.0 } },
                "onWrap": "discard",
                "enzymes": []
            })
        );
    }

    fn dreaming_spore(r: &Root, extra: &str) {
        for dir in ["data", "home", "corpus", "here", "schedules"] {
            fs::create_dir_all(r.0.join(dir)).unwrap();
        }
        let at = |dir: &str| r.0.join(dir).display().to_string();
        fs::write(
            r.0.join("spore.cmk"),
            format!(
                "---\nname: main\nmodel: m/1\ntools: [read]\nreads: [corpus={}]\nwrites: [here={}]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n{extra}---\n\nYou work.\n",
                at("corpus"),
                at("here")
            ),
        )
        .unwrap();
    }

    const DREAM: &str = "dream: [50, 1h]\ndream.cost: [0.05, 1.00]\ndream.wall: [10m, 15m]\ndream.precursor: summarize\n";

    #[test]
    fn makes_a_dream_read_the_spore_and_its_grants_and_write_only_its_data_and_home() {
        let r = root("dream");
        dreaming_spore(&r, DREAM);
        let mut p = plan_with(&r, &[]).unwrap();
        dream_for(&r.0, &mut p).unwrap();
        let reach = p.super_reach.as_ref().unwrap();
        assert_eq!(reach.spore, r.0);
        assert_eq!(
            reach.reads,
            vec![
                ("corpus".to_string(), r.0.join("corpus")),
                ("here".to_string(), r.0.join("here"))
            ]
        );
        assert_eq!(reach.writes, vec![r.0.join("data"), r.0.join("home")]);
        assert_eq!(
            (p.precursor.limits.cost.soft, p.precursor.limits.cost.hard),
            (0.05, 0.15)
        );
        assert_eq!(
            (p.precursor.limits.wall.soft, p.precursor.limits.wall.hard),
            (120_000.0, 180_000.0)
        );
        let worker = p.for_worker("data/out.json", &[], None);
        assert_eq!(worker["superReach"]["reads"][1]["name"], "here");
        assert_eq!(worker["superReach"]["writes"].as_array().unwrap().len(), 2);
        assert!(plan_with(&r, &[])
            .unwrap()
            .for_worker("data/out.json", &[], None)["superReach"]
            .is_null());
    }

    #[test]
    fn writes_the_schedules_of_a_spore_that_grants_them() {
        let r = root("dream-schedules");
        dreaming_spore(&r, &format!("schedules: [4, 1h]\n{DREAM}"));
        let mut p = plan_with(&r, &[]).unwrap();
        dream_for(&r.0, &mut p).unwrap();
        assert!(p
            .super_reach
            .unwrap()
            .writes
            .contains(&r.0.join("schedules")));
    }

    #[test]
    fn refuses_a_super_cell_but_for_the_dream_the_spore_names() {
        let r = root("dream-refused");
        dreaming_spore(&r, "");
        let mut p = plan_with(&r, &[]).unwrap();
        assert!(dream_for(&r.0, &mut p)
            .unwrap_err()
            .contains("declares none"));
        dreaming_spore(
            &r,
            &DREAM.replace("precursor: summarize", "precursor: tidy"),
        );
        assert!(dream_for(&r.0, &mut p)
            .unwrap_err()
            .contains("precursor tidy, not summarize"));
        assert!(p.super_reach.is_none());
    }

    #[test]
    fn hands_a_kept_cells_precursor_over_as_written_once_it_would_make_a_cell() {
        let r = root("kept");
        assert_eq!(kept_precursor(&r.0, "summarize").unwrap(), SUMMARIZE);
        assert!(kept_precursor(&r.0, "absent")
            .unwrap_err()
            .contains("expected precursors/absent.cmk"));
        fs::write(
            r.0.join("precursors/summarize.cmk"),
            SUMMARIZE.replace("tools: [read]", "model: strong\ntools: [read]"),
        )
        .unwrap();
        fs::write(
            r.0.join(DEFINITION_FILE),
            spore_cmk("cell-models: [low=a/fast]\n"),
        )
        .unwrap();
        assert!(kept_precursor(&r.0, "summarize")
            .unwrap_err()
            .contains("which this spore's cell-models does not have"));
    }

    #[test]
    fn plans_a_kept_cell_asked_again_from_its_entrys_copy_in_the_directory_it_ran_in() {
        let r = root("resume");
        fs::write(r.0.join("work/1/spawn.json"), "{}").unwrap();
        fs::remove_file(r.0.join("precursors/summarize.cmk")).unwrap();
        let ask = |precursor, ws| Asked {
            precursor,
            check: None,
            ws: Some(ws),
            prompt: Some("in.md"),
            answer: Some("data/out2.json"),
        };
        let resume =
            |asked: &Asked| plan_resume(asked, &r.0, &r.0, |_, _| None, "summarize", SUMMARIZE);
        let p = resume(&ask(None, "work/1")).unwrap();
        assert!(p.kept && p.resumed);
        assert_eq!(p.precursor.name, "summarize");
        assert_eq!(p.precursor.model.as_deref(), Some("fake/parent"));
        assert_eq!(p.precursor_path, r.0.join("cells/1/precursor.cmk"));
        assert_eq!(p.for_worker("data/out2.json", &[], None)["resumed"], true);

        assert!(resume(&ask(Some("summarize"), "work/1"))
            .err()
            .unwrap()
            .contains("give neither --precursor nor --check"));
        fs::create_dir_all(r.0.join("work/2")).unwrap();
        fs::write(r.0.join("work/2/in.md"), "material").unwrap();
        assert!(resume(&ask(None, "work/2"))
            .err()
            .unwrap()
            .contains("work/2 has run no cell"));
    }

    #[test]
    fn says_a_cell_that_is_not_kept_is_neither_kept_nor_resumed() {
        let r = root("plain");
        let p = plan_with(&r, &[]).unwrap();
        assert!(!p.kept && !p.resumed);
        assert_eq!(p.for_worker("data/out.json", &[], None)["kept"], false);
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
    fn plans_a_checks_cell_from_checks_and_nowhere_else() {
        let r = root("check");
        fs::create_dir_all(r.0.join("checks")).unwrap();
        fs::write(
            r.0.join("checks/answer.cmk"),
            SUMMARIZE.replace("name: summarize", "name: answer"),
        )
        .unwrap();
        let asked = |precursor: Option<&'static str>, check: Option<&'static str>| Asked {
            precursor,
            check,
            ws: Some("work/1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        let plan = plan_spawn(&asked(None, Some("answer")), &r.0, &r.0, |_, _| None).unwrap();
        assert_eq!(plan.precursor_path, r.0.join("checks/answer.cmk"));
        let elsewhere = plan_spawn(&asked(None, Some("summarize")), &r.0, &r.0, |_, _| None)
            .err()
            .unwrap();
        assert!(elsewhere.contains("precursor not found — expected checks/summarize.cmk"));
        let both = plan_spawn(
            &asked(Some("summarize"), Some("answer")),
            &r.0,
            &r.0,
            |_, _| None,
        )
        .err()
        .unwrap();
        assert!(both.contains("give one"));
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
        let worker = p.for_worker("data/out.json", &["abc".into()], None);
        assert_eq!(worker["precursor"]["enzymes"][0]["hash"], "abc");
    }

    #[test]
    fn finds_the_check_a_precursor_names_or_refuses_the_spawn() {
        let r = root("check");
        let cmk = |lines: &str| {
            format!("---\nname: extract\ncheck: extraction\n{lines}rounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nbody\n")
        };
        fs::write(r.0.join("precursors/extract.cmk"), cmk("")).unwrap();
        let with = [("precursor", Some("extract"))];
        assert!(plan_with(&r, &[]).unwrap().check.is_none());
        assert!(error(&r, &with).contains(
            "names a check its spore does not keep — expected checks/extraction.check or checks/extraction.check.js"
        ));
        fs::create_dir_all(r.0.join("checks")).unwrap();
        fs::write(r.0.join("checks/extraction.check.js"), "").unwrap();
        let p = plan_with(&r, &with).unwrap();
        let check = p.check.as_ref().unwrap();
        assert_eq!(check.command, r.0.join("checks/extraction.check.js"));
        assert!(check.script);
        assert_eq!(
            p.for_worker("data/out.json", &[], Some("abc"))["precursor"]["check"],
            json!({ "name": "extraction", "hash": "abc" })
        );
        fs::write(r.0.join("checks/extraction.check"), "#!/bin/sh\n").unwrap();
        assert!(error(&r, &with).contains("names a check that is not executable"));
        fs::set_permissions(
            r.0.join("checks/extraction.check"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let p = plan_with(&r, &with).unwrap();
        assert_eq!(
            p.check.as_ref().unwrap().command,
            r.0.join("checks/extraction.check")
        );
        assert!(!p.check.as_ref().unwrap().script);

        fs::write(
            r.0.join("precursors/extract.cmk"),
            cmk("extraction.with: [data/schema.json]\n"),
        )
        .unwrap();
        assert!(error(&r, &with)
            .contains("says its check extraction needs data/schema.json, which does not exist"));
        fs::create_dir_all(r.0.join("data")).unwrap();
        fs::write(r.0.join("data/schema.json"), "{}").unwrap();
        assert_eq!(
            plan_with(&r, &with).unwrap().check.unwrap().with,
            vec![r.0.join("data/schema.json")]
        );

        fs::write(r.0.join("checks/extract.cmk"), cmk("")).unwrap();
        let asked = Asked {
            precursor: None,
            check: Some("extract"),
            ws: Some("work/1"),
            prompt: Some("in.md"),
            answer: Some("data/out.json"),
        };
        let refused = plan_spawn(&asked, &r.0, &r.0, |_, _| None).err().unwrap();
        assert!(
            refused.contains("a check's cell judges an answer, and its own is not checked"),
            "{refused}"
        );
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

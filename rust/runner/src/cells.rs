//! The cell socket: how a turn's `spawn` has the cell it starts kept, and asks a kept one again.
//! The runner reads the precursor itself and writes the cell's entry under `cells/` at the
//! workspace root, which neither the agent nor a cell can write: a caller names a precursor and
//! a directory, never what the entry holds. Contract: ARCHITECTURE.md, "Kept cells".

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::{json, Value};
use spore_definition::{is_name, name_rule};
use spore_workspace::{
    iso_now, left_unfinished, lock_holder, CELLS_DIR, CELL_DEAD_FILE as DEAD_FILE, CELL_FILE,
    CELL_PRECURSOR_FILE as PRECURSOR_FILE, DATA_DIR, SPAWN_FILE,
};

use crate::broker::{answer, read_json, Refusal};
use crate::plan::{check_kept, kept_precursor};

const CRASHED: &str =
    "a run of it ended without being written down, so what it last did is not known";

pub struct Cells {
    ws: PathBuf,
    most: u64,
    writing: Mutex<()>,
}

struct Entry {
    name: String,
    path: String,
    dead: bool,
}

fn malformed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::BAD_REQUEST,
        "PROTOCOL_INVALID_REQUEST",
        "malformed cell request",
        detail,
    )
}

fn failed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "CELL_KEEP_FAILED",
        "the cell could not be kept",
        detail,
    )
}

fn refused(kind: &str, message: impl Into<String>, detail: impl Into<String>) -> Refusal {
    Refusal::new(StatusCode::CONFLICT, kind, message, detail)
}

/// Marks the cell whose entry is `record` dead, for good: written whole or not at all.
fn mark_dead(record: &Path, name: &str, why: &str) -> Result<(), Refusal> {
    let writing = |e: std::io::Error| failed(format!("cannot mark {name} dead — {e}"));
    let marking = record.join(format!(".{DEAD_FILE}"));
    let said = json!({ "why": why, "at": iso_now() });
    std::fs::write(&marking, format!("{said}\n")).map_err(writing)?;
    std::fs::rename(&marking, record.join(DEAD_FILE)).map_err(writing)
}

impl Cells {
    pub fn new(ws: PathBuf, most: u64) -> Cells {
        Cells {
            ws,
            most,
            writing: Mutex::new(()),
        }
    }

    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let (method, path) = (req.method().clone(), req.uri().path().to_string());
        if method != Method::POST || !matches!(path.as_str(), "/keep" | "/resume") {
            return not_found_response(&method, &path);
        }
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(refusal) => return refusal.response(),
        };
        let cells = self.clone();
        answer(
            tokio::task::spawn_blocking(move || match path.as_str() {
                "/keep" => cells.keep(&body),
                _ => cells.resume(&body),
            })
            .await
            .unwrap_or_else(|e| Err(failed(e.to_string()))),
        )
    }

    /// The workspace and, from it, the directory a request names: one of its own under `data/`.
    fn place(&self, asked: &str) -> Result<(PathBuf, PathBuf, String), Refusal> {
        let ws = std::fs::canonicalize(&self.ws)
            .map_err(|e| failed(format!("cannot resolve {} — {e}", self.ws.display())))?;
        let data = ws.join(DATA_DIR);
        let place = |detail: String| {
            refused(
                "CELL_PLACE",
                format!(
                    "a kept cell lives in a directory of its own under the spore's {DATA_DIR}/"
                ),
                detail,
            )
        };
        let dir = std::fs::canonicalize(asked).map_err(|e| place(format!("{asked} — {e}")))?;
        if !dir.is_dir() || !dir.starts_with(&data) || dir == data {
            return Err(place(format!("{asked} is not one")));
        }
        let rel = dir
            .strip_prefix(&ws)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| place(format!("{asked} is not a path that can be written down")))?
            .to_string();
        Ok((ws, dir, rel))
    }

    /// A kept cell asked again: the copy of its precursor its entry holds, once the cell can
    /// still run. One that cannot — its model or an enzyme is gone, or a run of it ended without
    /// being written down — is marked dead here and refused from then on.
    fn resume(&self, body: &Value) -> Result<Value, Refusal> {
        let asked = body["ws"]
            .as_str()
            .ok_or_else(|| malformed("ws is the cell's directory"))?;
        let (ws, dir, rel) = self.place(asked)?;
        let _writing = self
            .writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = self
            .entries(&ws)?
            .into_iter()
            .find(|entry| entry.path == rel)
        else {
            return Err(refused(
                "CELL_NOT_KEPT",
                format!("no kept cell is at {rel}"),
                if dir.join(SPAWN_FILE).exists() {
                    "the cell that ran there was not spawned with --keep, and is spent — spawn a fresh one"
                } else {
                    "only a cell spawned with --keep is asked again"
                },
            ));
        };
        let record = ws.join(CELLS_DIR).join(&entry.name);
        let dead =
            |why: String| refused("CELL_DEAD", format!("the cell {} is dead", entry.name), why);
        if entry.dead {
            let read = std::fs::read_to_string(record.join(DEAD_FILE))
                .map_err(|e| failed(format!("cannot read why {} is dead — {e}", entry.name)))?;
            let why = serde_json::from_str::<Value>(&read)
                .ok()
                .and_then(|mark| mark["why"].as_str().map(str::to_string))
                .ok_or_else(|| failed(format!("{} does not say why it is dead", entry.name)))?;
            return Err(dead(format!(
                "{why} — spawn a fresh cell, and delete {rel} to free its name"
            )));
        }
        let held = lock_holder(&dir)
            .map_err(|e| failed(format!("cannot tell whether {rel} is running — {e}")))?
            .is_some();
        if held {
            return Err(refused(
                "CELL_RUNNING",
                format!("the cell {} is running", entry.name),
                "a kept cell answers one prompt at a time — ask it again when this run has ended",
            ));
        }
        let precursor = std::fs::read_to_string(record.join(CELL_FILE))
            .ok()
            .and_then(|read| serde_json::from_str::<Value>(&read).ok())
            .and_then(|cell| cell["precursor"].as_str().map(str::to_string))
            .ok_or_else(|| failed(format!("{} does not name its precursor", entry.name)))?;
        let source = std::fs::read_to_string(record.join(PRECURSOR_FILE)).map_err(|e| {
            failed(format!(
                "cannot read what {} was made from — {e}",
                entry.name
            ))
        })?;
        if let Err(why) = check_kept(&ws, &precursor, &source) {
            mark_dead(&record, &entry.name, &why)?;
            return Err(dead(format!(
                "{why} — spawn a fresh cell, and delete {rel} to free its name"
            )));
        }
        Ok(json!({ "name": entry.name, "path": rel, "precursor": precursor, "source": source }))
    }

    /// What every turn starts from: `cells/` holding the cells that are still there, the ones
    /// that crashed marked.
    pub fn sweep(&self) -> Result<(), String> {
        let ws = std::fs::canonicalize(&self.ws)
            .map_err(|e| format!("cannot resolve {} — {e}", self.ws.display()))?;
        let _writing = self
            .writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.entries(&ws)
            .map(|_| ())
            .map_err(|refusal| format!("{} — {}", refusal.message, refusal.detail))
    }

    /// The entries whose cell is still where its entry says. One whose directory is gone or
    /// moved has ended, and one whose directory never ran a cell and is held by nobody was never
    /// started: both are dropped here. One a run of which ended without being written down is
    /// marked dead here.
    fn entries(&self, ws: &Path) -> Result<Vec<Entry>, Refusal> {
        let cells = ws.join(CELLS_DIR);
        let listed = match std::fs::read_dir(&cells) {
            Ok(listed) => listed,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(failed(format!("cannot read {} — {e}", cells.display()))),
        };
        let mut entries = Vec::new();
        for item in listed {
            let item =
                item.map_err(|e| failed(format!("cannot read {} — {e}", cells.display())))?;
            let Some(name) = item.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let entry = item.path();
            let record = entry.join(CELL_FILE);
            let read = std::fs::read_to_string(&record)
                .map_err(|e| failed(format!("cannot read {} — {e}", record.display())))?;
            let path = serde_json::from_str::<Value>(&read)
                .ok()
                .and_then(|cell| cell["path"].as_str().map(str::to_string))
                .ok_or_else(|| failed(format!("{} names no path", record.display())))?;
            let dir = ws.join(&path);
            let held = lock_holder(&dir)
                .map_err(|e| failed(format!("cannot tell whether {path} is running — {e}")))?
                .is_some();
            if !dir.is_dir() || !(dir.join(SPAWN_FILE).exists() || held) {
                std::fs::remove_dir_all(&entry)
                    .map_err(|e| failed(format!("cannot drop {} — {e}", entry.display())))?;
                continue;
            }
            let mut dead = entry.join(DEAD_FILE).exists();
            if !dead && !held && left_unfinished(&dir).map_err(|e| failed(e))? {
                mark_dead(&entry, &name, CRASHED)?;
                dead = true;
            }
            entries.push(Entry { name, path, dead });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    fn keep(&self, body: &Value) -> Result<Value, Refusal> {
        let precursor = body["precursor"]
            .as_str()
            .ok_or_else(|| malformed("precursor is a string"))?;
        let asked = body["ws"]
            .as_str()
            .ok_or_else(|| malformed("ws is the cell's directory"))?;
        if !is_name("precursor", precursor).expect("precursor is a kind of name") {
            return Err(malformed(format!("{precursor:?} names no precursor")));
        }
        let (ws, dir, rel) = self.place(asked)?;
        let name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .expect("a path written down has a last part that can be")
            .to_string();
        if !is_name("cell", &name).expect("cell is a kind of name") {
            return Err(refused(
                "CELL_NAME",
                "a kept cell is known by its directory's name",
                format!(
                    "{name:?} cannot be one — {}",
                    name_rule("cell").expect("cell is a kind of name")
                ),
            ));
        }
        if dir.join(SPAWN_FILE).exists() {
            return Err(refused(
                "CELL_SPENT",
                format!("{rel} has already run a cell"),
                "a cell is kept from its first run — name another directory",
            ));
        }
        let source = kept_precursor(&ws, precursor)
            .map_err(|problem| refused("CELL_PRECURSOR", "the precursor makes no cell", problem))?;

        let _writing = self
            .writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cells = ws.join(CELLS_DIR);
        let mut others = Vec::new();
        for entry in self.entries(&ws)? {
            // This directory has run nothing, so an entry naming it is from a start that never
            // came to anything.
            if entry.name == name && entry.path == rel {
                let stale = cells.join(&entry.name);
                std::fs::remove_dir_all(&stale)
                    .map_err(|e| failed(format!("cannot drop {} — {e}", stale.display())))?;
                continue;
            }
            others.push(entry);
        }
        if let Some(taken) = others.iter().find(|entry| entry.name == name) {
            return Err(refused(
                "CELL_NAME_TAKEN",
                format!("a cell named {name} is already kept"),
                format!(
                    "it is at {}{} — a kept cell is known by its directory's name: name this one's otherwise, or delete that directory to end that cell",
                    taken.path,
                    if taken.dead { ", dead" } else { "" }
                ),
            ));
        }
        let alive: Vec<&Entry> = others.iter().filter(|entry| !entry.dead).collect();
        if alive.len() as u64 >= self.most {
            return Err(refused(
                "CELL_CAP",
                format!(
                    "{} cell{} alive, the most this spore keeps",
                    alive.len(),
                    if alive.len() == 1 { " is" } else { "s are" }
                ),
                format!(
                    "alive: {} — delete a cell's directory to end it, or raise living-cells in spore.cmk",
                    alive
                        .iter()
                        .map(|entry| format!("{} at {}", entry.name, entry.path))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }

        let writing = |what: &Path, e: std::io::Error| failed(format!("{} — {e}", what.display()));
        std::fs::create_dir_all(&cells).map_err(|e| writing(&cells, e))?;
        // Made whole under a name no cell can have, then renamed: an entry is there or it is not.
        let making = cells.join(format!(".{name}.{}", std::process::id()));
        if making.exists() {
            std::fs::remove_dir_all(&making).map_err(|e| writing(&making, e))?;
        }
        std::fs::create_dir(&making).map_err(|e| writing(&making, e))?;
        std::fs::write(making.join(PRECURSOR_FILE), &source).map_err(|e| writing(&making, e))?;
        let cell = json!({ "path": rel, "precursor": precursor, "madeAt": iso_now() });
        std::fs::write(making.join(CELL_FILE), format!("{cell}\n"))
            .map_err(|e| writing(&making, e))?;
        let entry = cells.join(&name);
        std::fs::rename(&making, &entry).map_err(|e| writing(&entry, e))?;
        Ok(json!({ "name": name, "path": rel, "alive": alive.len() + 1, "most": self.most }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SUMMARIZE: &str = "---\nname: summarize\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou summarize.\n";
    const SPORE: &str = "---\nname: main\nmodel: fake/parent\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\n\nYou work.\n";

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn root(name: &str) -> Root {
        let dir = std::env::temp_dir().join(format!("spore-cells-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("precursors")).unwrap();
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("precursors/summarize.cmk"), SUMMARIZE).unwrap();
        fs::write(dir.join("spore.cmk"), SPORE).unwrap();
        Root(fs::canonicalize(&dir).unwrap())
    }

    fn place(root: &Root, rel: &str) -> String {
        let dir = root.0.join(rel);
        fs::create_dir_all(&dir).unwrap();
        dir.display().to_string()
    }

    fn ran(root: &Root, rel: &str) {
        fs::write(root.0.join(rel).join(SPAWN_FILE), "{}\n").unwrap();
    }

    fn keep(cells: &Cells, ws: &str) -> Result<Value, Refusal> {
        cells.keep(&json!({ "precursor": "summarize", "ws": ws }))
    }

    fn kept(root: &Root) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.0.join(CELLS_DIR))
            .map(|listed| {
                listed
                    .map(|item| item.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn writes_an_entry_holding_the_precursor_as_it_stood_and_where_the_cell_is() {
        let r = root("entry");
        let cells = Cells::new(r.0.clone(), 3);
        let said = keep(&cells, &place(&r, "data/cache-bug")).unwrap();
        assert_eq!(said["name"], "cache-bug");
        assert_eq!(said["path"], "data/cache-bug");
        assert_eq!(said["alive"], 1);
        let entry = r.0.join(CELLS_DIR).join("cache-bug");
        assert_eq!(
            fs::read_to_string(entry.join(PRECURSOR_FILE)).unwrap(),
            SUMMARIZE
        );
        let cell: Value =
            serde_json::from_str(&fs::read_to_string(entry.join(CELL_FILE)).unwrap()).unwrap();
        assert_eq!(cell["path"], "data/cache-bug");
        assert_eq!(cell["precursor"], "summarize");
        assert!(cell["madeAt"].is_string());
        assert!(!entry.join(DEAD_FILE).exists());
        assert_eq!(kept(&r), ["cache-bug"]);
    }

    #[test]
    fn keeps_the_precursor_of_the_day_whatever_becomes_of_the_file() {
        let r = root("copy");
        let cells = Cells::new(r.0.clone(), 3);
        keep(&cells, &place(&r, "data/a")).unwrap();
        fs::write(r.0.join("precursors/summarize.cmk"), "changed").unwrap();
        assert_eq!(
            fs::read_to_string(r.0.join(CELLS_DIR).join("a").join(PRECURSOR_FILE)).unwrap(),
            SUMMARIZE
        );
    }

    #[test]
    fn refuses_a_name_another_kept_cell_has() {
        let r = root("taken");
        let cells = Cells::new(r.0.clone(), 3);
        keep(&cells, &place(&r, "data/a")).unwrap();
        ran(&r, "data/a");
        let refusal = keep(&cells, &place(&r, "data/deeper/a")).unwrap_err();
        assert_eq!(refusal.kind, "CELL_NAME_TAKEN");
        assert!(refusal.detail.contains("it is at data/a"));
        assert_eq!(kept(&r), ["a"]);
    }

    #[test]
    fn refuses_one_more_than_the_spore_keeps_and_names_those_alive() {
        let r = root("cap");
        let cells = Cells::new(r.0.clone(), 2);
        for name in ["a", "b"] {
            keep(&cells, &place(&r, &format!("data/{name}"))).unwrap();
            ran(&r, &format!("data/{name}"));
        }
        let refusal = keep(&cells, &place(&r, "data/c")).unwrap_err();
        assert_eq!(refusal.kind, "CELL_CAP");
        assert_eq!(
            refusal.message,
            "2 cells are alive, the most this spore keeps"
        );
        assert!(refusal.detail.contains("a at data/a, b at data/b"));
        assert_eq!(kept(&r), ["a", "b"]);
    }

    #[test]
    fn frees_the_name_and_the_place_of_a_cell_whose_directory_is_gone_or_moved() {
        let r = root("gone");
        let cells = Cells::new(r.0.clone(), 2);
        for name in ["a", "b"] {
            keep(&cells, &place(&r, &format!("data/{name}"))).unwrap();
            ran(&r, &format!("data/{name}"));
        }
        fs::remove_dir_all(r.0.join("data/a")).unwrap();
        fs::rename(r.0.join("data/b"), r.0.join("data/elsewhere")).unwrap();
        assert_eq!(keep(&cells, &place(&r, "data/a")).unwrap()["alive"], 1);
        assert_eq!(kept(&r), ["a"]);
    }

    #[test]
    fn drops_an_entry_whose_cell_never_started() {
        let r = root("unstarted");
        let cells = Cells::new(r.0.clone(), 1);
        keep(&cells, &place(&r, "data/a")).unwrap();
        assert_eq!(keep(&cells, &place(&r, "data/b")).unwrap()["alive"], 1);
        assert_eq!(kept(&r), ["b"]);
    }

    #[test]
    fn holds_a_dead_cells_name_and_counts_it_no_longer() {
        let r = root("dead");
        let cells = Cells::new(r.0.clone(), 1);
        keep(&cells, &place(&r, "data/a")).unwrap();
        ran(&r, "data/a");
        fs::write(r.0.join(CELLS_DIR).join("a").join(DEAD_FILE), "{}\n").unwrap();
        assert_eq!(keep(&cells, &place(&r, "data/b")).unwrap()["alive"], 1);
        let refusal = keep(&cells, &place(&r, "data/deeper/a")).unwrap_err();
        assert_eq!(refusal.kind, "CELL_NAME_TAKEN");
        assert!(refusal.detail.contains("it is at data/a, dead"));
    }

    #[test]
    fn refuses_a_directory_outside_data_one_that_ran_and_a_name_no_cell_can_have() {
        let r = root("place");
        let cells = Cells::new(r.0.clone(), 3);
        for outside in ["precursors", "data", "elsewhere"] {
            let refusal = keep(&cells, &place(&r, outside)).unwrap_err();
            assert_eq!(refusal.kind, "CELL_PLACE", "{outside}");
        }
        assert_eq!(
            keep(&cells, &r.0.join("data/missing").display().to_string())
                .unwrap_err()
                .kind,
            "CELL_PLACE"
        );
        let used = place(&r, "data/used");
        ran(&r, "data/used");
        assert_eq!(keep(&cells, &used).unwrap_err().kind, "CELL_SPENT");
        assert_eq!(
            keep(&cells, &place(&r, "data/-odd")).unwrap_err().kind,
            "CELL_NAME"
        );
        assert!(kept(&r).is_empty());
    }

    #[test]
    fn reads_the_precursor_itself_and_refuses_one_that_makes_no_cell() {
        let r = root("precursor");
        let cells = Cells::new(r.0.clone(), 3);
        let ws = place(&r, "data/a");
        let unknown = cells
            .keep(&json!({ "precursor": "absent", "ws": ws }))
            .unwrap_err();
        assert_eq!(unknown.kind, "CELL_PRECURSOR");
        assert!(unknown.detail.contains("precursors/absent.cmk"));
        let outside = cells
            .keep(&json!({ "precursor": "../spore", "ws": ws }))
            .unwrap_err();
        assert_eq!(outside.kind, "PROTOCOL_INVALID_REQUEST");
        fs::write(r.0.join("precursors/summarize.cmk"), "not a definition").unwrap();
        assert_eq!(keep(&cells, &ws).unwrap_err().kind, "CELL_PRECURSOR");
        assert!(kept(&r).is_empty());
    }
    const SHOUT: &str = "---\nname: shout\nmodel: strong\ntools: [read, wsexec]\nenzymes: [upper=tools/upper.sh]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou shout.\n\n:::enzyme upper\nupper — writes its arguments upper-cased.\n:::\n";

    /// A spore offering the cell model `strong`, with a precursor that runs on it and grants an
    /// enzyme, and a cell kept from it that has run.
    fn shouting(name: &str) -> (Root, Cells, String) {
        use std::os::unix::fs::PermissionsExt;
        let r = root(name);
        fs::write(
            r.0.join("spore.cmk"),
            SPORE.replace(
                "tools: [read]",
                "cell-models: [strong=a/best]\ntools: [read]",
            ),
        )
        .unwrap();
        fs::create_dir_all(r.0.join("tools")).unwrap();
        fs::write(r.0.join("tools/upper.sh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(
            r.0.join("tools/upper.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::write(r.0.join("precursors/shout.cmk"), SHOUT).unwrap();
        let cells = Cells::new(r.0.clone(), 3);
        let ws = place(&r, "data/a");
        cells
            .keep(&json!({ "precursor": "shout", "ws": ws }))
            .unwrap();
        ran(&r, "data/a");
        (r, cells, ws)
    }

    fn resume(cells: &Cells, ws: &str) -> Result<Value, Refusal> {
        cells.resume(&json!({ "ws": ws }))
    }

    #[test]
    fn hands_a_kept_cell_asked_again_what_it_was_made_from_whatever_its_precursor_says_now() {
        let (r, cells, ws) = shouting("resume");
        fs::write(
            r.0.join("precursors/shout.cmk"),
            SHOUT.replace("You shout.", "You whisper."),
        )
        .unwrap();
        let said = resume(&cells, &ws).unwrap();
        assert_eq!(said["name"], "a");
        assert_eq!(said["path"], "data/a");
        assert_eq!(said["precursor"], "shout");
        assert_eq!(said["source"], SHOUT);
        fs::remove_file(r.0.join("precursors/shout.cmk")).unwrap();
        assert_eq!(resume(&cells, &ws).unwrap()["source"], SHOUT);
    }

    #[test]
    fn asks_again_only_a_cell_that_was_kept() {
        let r = root("unkept");
        let cells = Cells::new(r.0.clone(), 3);
        let spent = place(&r, "data/spent");
        ran(&r, "data/spent");
        let refusal = resume(&cells, &spent).unwrap_err();
        assert_eq!(refusal.kind, "CELL_NOT_KEPT");
        assert!(refusal.detail.contains("is spent"));
        let fresh = resume(&cells, &place(&r, "data/fresh")).unwrap_err();
        assert_eq!(fresh.kind, "CELL_NOT_KEPT");
        assert!(fresh.detail.contains("only a cell spawned with --keep"));
        assert_eq!(
            resume(&cells, &place(&r, "elsewhere")).unwrap_err().kind,
            "CELL_PLACE"
        );
    }

    #[test]
    fn marks_dead_a_cell_whose_model_the_spore_no_longer_offers_and_says_why_from_then_on() {
        let (r, cells, ws) = shouting("model-gone");
        fs::write(
            r.0.join("spore.cmk"),
            SPORE.replace("tools: [read]", "cell-models: [low=a/fast]\ntools: [read]"),
        )
        .unwrap();
        let refusal = resume(&cells, &ws).unwrap_err();
        assert_eq!(refusal.kind, "CELL_DEAD");
        assert!(refusal
            .detail
            .contains("which this spore's cell-models does not have"));
        let mark: Value = serde_json::from_str(
            &fs::read_to_string(r.0.join(CELLS_DIR).join("a").join(DEAD_FILE)).unwrap(),
        )
        .unwrap();
        assert!(mark["why"].as_str().unwrap().contains("cell-models"));
        assert!(mark["at"].is_string());
        fs::write(
            r.0.join("spore.cmk"),
            SPORE.replace(
                "tools: [read]",
                "cell-models: [strong=a/best]\ntools: [read]",
            ),
        )
        .unwrap();
        let again = resume(&cells, &ws).unwrap_err();
        assert_eq!(again.kind, "CELL_DEAD");
        assert!(again.detail.contains("cell-models does not have"));
    }

    #[test]
    fn marks_dead_a_cell_granted_an_enzyme_that_is_gone() {
        let (r, cells, ws) = shouting("enzyme-gone");
        fs::remove_file(r.0.join("tools/upper.sh")).unwrap();
        let refusal = resume(&cells, &ws).unwrap_err();
        assert_eq!(refusal.kind, "CELL_DEAD");
        assert!(refusal
            .detail
            .contains("declares an enzyme that does not exist"));
        assert!(r.0.join(CELLS_DIR).join("a").join(DEAD_FILE).exists());
    }

    #[test]
    fn runs_an_enzyme_as_it_is_now_when_only_its_code_changed() {
        let (r, cells, ws) = shouting("enzyme-changed");
        fs::write(r.0.join("tools/upper.sh"), "#!/bin/sh\necho changed\n").unwrap();
        assert!(resume(&cells, &ws).is_ok());
    }

    #[test]
    fn marks_dead_a_cell_whose_run_ended_without_being_written_down() {
        let (r, cells, ws) = shouting("crashed");
        spore_workspace::begin_turn(&r.0.join("data/a"), &iso_now(), None).unwrap();
        let refusal = resume(&cells, &ws).unwrap_err();
        assert_eq!(refusal.kind, "CELL_DEAD");
        assert!(refusal.detail.contains("ended without being written down"));
        assert!(r.0.join(CELLS_DIR).join("a").join(DEAD_FILE).exists());
    }
    #[test]
    fn leaves_every_turn_a_record_of_the_cells_still_there_with_the_crashed_marked() {
        let (r, cells, _) = shouting("sweep");
        keep(&cells, &place(&r, "data/b")).unwrap();
        ran(&r, "data/b");
        keep(&cells, &place(&r, "data/c")).unwrap();
        ran(&r, "data/c");
        fs::remove_dir_all(r.0.join("data/b")).unwrap();
        spore_workspace::begin_turn(&r.0.join("data/c"), &iso_now(), None).unwrap();
        cells.sweep().unwrap();
        assert_eq!(kept(&r), ["a", "c"]);
        let entry = |name: &str| r.0.join(CELLS_DIR).join(name);
        assert!(!entry("a").join(DEAD_FILE).exists());
        assert!(entry("c").join(DEAD_FILE).exists());
    }
}

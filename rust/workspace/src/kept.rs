//! What a plugin keeps of the host in view of a contained process, and why a process of a spore
//! cannot start with it: the runner refuses a turn on it, and `spore doctor` reports it.

use std::path::PathBuf;

/// A directory a plugin hides from a contained process and the one inside it the process keeps
/// in view, if any, as `confine --hide [--keep]` lays them out. `missing` says what an absent
/// `keep` means, and comes with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub plugin: String,
    pub hide: PathBuf,
    pub keep: Option<PathBuf>,
    pub missing: Option<String>,
}

/// `--contain-keep`, the spore's plugins' `contain` as `preparePlugins` fills them in.
pub fn kept_from(given: &str) -> Result<Vec<Kept>, String> {
    let shape = || {
        format!("--contain-keep is a JSON array of {{plugin, hide, keep?, missing?}}, keep and missing together — got {given}")
    };
    let entries: Vec<serde_json::Value> = serde_json::from_str(given).map_err(|_| shape())?;
    entries
        .iter()
        .map(|entry| {
            let field = |name: &str| {
                entry
                    .get(name)
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .ok_or_else(shape)
            };
            let optional = |name: &str| match entry.get(name) {
                None => Ok(None),
                Some(v) => v.as_str().map(|v| Some(v.to_string())).ok_or_else(shape),
            };
            let (keep, missing) = (optional("keep")?, optional("missing")?);
            if keep.is_some() != missing.is_some() {
                return Err(shape());
            }
            Ok(Kept {
                plugin: field("plugin")?,
                hide: PathBuf::from(field("hide")?),
                keep: keep.map(PathBuf::from),
                missing,
            })
        })
        .collect()
}

/// Why a process of a spore that keeps `kept` cannot start, as what is wrong and what to do:
/// it would not be contained, so it would see everything the plugins hide, or a directory to
/// hide or keep is not there.
pub fn kept_problem(kept: &[Kept], contained: bool) -> Option<(String, String)> {
    if kept.is_empty() {
        return None;
    }
    if !contained {
        let plugins: Vec<&str> = kept.iter().map(|k| k.plugin.as_str()).collect();
        return Some((
            format!(
                "plugin {} shows this spore only its own part of the host by containing it, and this one would not be contained",
                plugins.join(", ")
            ),
            "spore config set contain on".into(),
        ));
    }
    kept.iter().find_map(|k| match (&k.keep, &k.missing) {
        (Some(keep), Some(missing)) if !keep.is_dir() => Some((
            format!(
                "plugin {} needs {}, which is not there",
                k.plugin,
                keep.display()
            ),
            missing.clone(),
        )),
        (None, _) if !k.hide.is_dir() => Some((
            format!(
                "plugin {} hides {}, which is not there",
                k.plugin,
                k.hide.display()
            ),
            format!(
                "make it, or drop {} from plugins: in its spore.cmk",
                k.plugin
            ),
        )),
        _ => None,
    })
}

pub fn kept_refusal(kept: &[Kept], contained: bool) -> Option<String> {
    kept_problem(kept, contained).map(|(problem, fix)| format!("{problem} — {fix}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_a_plugin_keeps_and_refuses_what_it_cannot_lay_out() {
        let dir = std::env::temp_dir().join(format!("spore-kept-{}", std::process::id()));
        let keep = dir.join("spores").join("main");
        std::fs::create_dir_all(&keep).unwrap();
        let given = serde_json::json!([{
            "plugin": "sluice",
            "hide": dir,
            "keep": keep,
            "missing": "no rules for main"
        }])
        .to_string();
        let kept = kept_from(&given).unwrap();
        assert_eq!(kept[0].keep.as_ref(), Some(&keep));
        assert_eq!(kept_refusal(&kept, true), None);
        assert!(kept_refusal(&kept, false)
            .unwrap()
            .contains("plugin sluice"));
        assert_eq!(kept_refusal(&[], false), None);

        std::fs::remove_dir_all(&dir).unwrap();
        let absent = kept_refusal(&kept, true).unwrap();
        assert!(
            absent.ends_with("which is not there — no rules for main"),
            "{absent}"
        );
        assert!(kept_from(r#"[{"plugin": "sluice"}]"#).is_err());
        assert!(
            kept_from(r#"[{"plugin": "sluice", "hide": "/run/x", "keep": "/run/x/a"}]"#).is_err()
        );
        assert!(
            kept_from(r#"[{"plugin": "sluice", "hide": "/run/x", "missing": "why"}]"#).is_err()
        );
    }
}

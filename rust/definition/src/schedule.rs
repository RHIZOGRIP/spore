//! A schedule — `schedules/<name>.cmk` in a root workspace: when the clock says something to
//! the spore, and what it says. Contract: ARCHITECTURE.md, "Turns the clock starts".
//!
//! The grammar is the definition's, and so is every refusal. When a schedule is due is
//! computed here too, and the JavaScript pass that fires it reaches it through `spore-node`,
//! as it does the grammar.

use croner::parser::{CronParser, Seconds, Year};
use croner::Cron;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde::Serialize;

use crate::{duration_ms, parse_frontmatter, trim, Value, DOCUMENT};

const FIELDS: [&str; 3] = ["when", "tz", "late"];

/// How far ahead the shortest gap between two slots is looked for. A cron expression's
/// density shows within a day or a week; the year is there for what only a calendar or a
/// clock change reveals, and the slot cap for the expressions dense enough to reach it first.
const HORIZON_MS: i64 = 366 * 24 * 3_600_000;
const HORIZON_SLOTS: usize = 20_000;

const WHEN_SHAPE: &str =
    "a cron expression, as when: 0 9 * * 1-5 with tz: Europe/Paris, or one instant, as when: at 2026-10-01T09:00:00+02:00";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Schedule {
    /// As written.
    pub when: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
    /// The instant of an `at` schedule, in UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Milliseconds past its slot beyond which a firing is skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub late: Option<f64>,
    pub message: String,
}

/// Where a schedule stands at a moment, given the last slot it fired for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Due {
    Due {
        slot: String,
    },
    Later {
        next: String,
    },
    Stale {
        slot: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        next: Option<String>,
    },
    Spent,
}

fn cron(pattern: &str) -> Result<Cron, String> {
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .year(Year::Disallowed)
        .build()
        .parse(pattern)
        .map_err(|e| {
            format!("has a when that is not a cron expression — got \"{pattern}\" ({e}); five fields: minute hour day month weekday")
        })
}

fn zone(name: &str) -> Result<TimeZone, String> {
    TimeZone::get(name)
        .map_err(|e| format!("has a tz that is not a time zone — got \"{name}\" ({e})"))
}

fn instant(ms: i64) -> Result<Timestamp, String> {
    Timestamp::from_millisecond(ms).map_err(|e| format!("{ms} is not an instant — {e}"))
}

pub fn parse_schedule(source: &str) -> Result<Schedule, String> {
    let Some(document) = DOCUMENT.captures(source) else {
        return Err("must open with a --- frontmatter block".into());
    };
    let fields = parse_frontmatter(&document[1])?;
    for (key, _) in &fields.0 {
        if !FIELDS.contains(&key.as_str()) {
            return Err(format!(
                "unknown field \"{key}\" — a schedule takes {}",
                FIELDS.join(", ")
            ));
        }
    }
    let message = trim(&document[2]).to_string();
    if message.is_empty() {
        return Err(
            "has no message — the body below the frontmatter is what is said to the spore when it fires"
                .into(),
        );
    }

    let when = match fields.get("when") {
        Some(Value::Scalar(w)) if !w.is_empty() => w.clone(),
        Some(other) => {
            return Err(format!(
                "has a when it cannot read — got \"{}\", expected {WHEN_SHAPE}",
                other.text()
            ))
        }
        None => return Err(format!("declares no when — expected {WHEN_SHAPE}")),
    };
    let tz = match fields.get("tz") {
        None => None,
        Some(Value::Scalar(t)) if !t.is_empty() => Some(t.clone()),
        Some(other) => {
            return Err(format!(
                "has a tz it cannot read — got \"{}\", expected an IANA zone like Europe/Paris",
                other.text()
            ))
        }
    };
    let late = match fields.get("late") {
        None => None,
        Some(value) => {
            let read = match value {
                Value::Scalar(text) => duration_ms(text).filter(|ms| *ms > 0.0),
                Value::List(_) => None,
            };
            let Some(ms) = read else {
                return Err(format!(
                    "has a late it cannot read — got \"{}\", expected how late a firing may still be, as late: 3h",
                    value.text()
                ));
            };
            Some(ms)
        }
    };

    // An instant carries its own offset, and a cron expression means a wall clock, which
    // has to be one place's: the host's zone would make one file mean different things on
    // different machines.
    let at = match when.strip_prefix("at ") {
        Some(written) => {
            if tz.is_some() {
                return Err(
                    "declares tz with an at instant — the instant carries its own offset, so drop tz"
                        .into(),
                );
            }
            let written = trim(written);
            let at: Timestamp = written.parse().map_err(|e| {
                format!("has an at instant it cannot read — got \"{written}\" ({e}); write it with its offset, as at 2026-10-01T09:00:00+02:00")
            })?;
            Some(at.to_string())
        }
        None => {
            let Some(name) = &tz else {
                return Err(
                    "declares a cron when and no tz — a wall clock is one place's, as tz: Europe/Paris"
                        .into(),
                );
            };
            zone(name)?;
            cron(&when)?;
            None
        }
    };

    Ok(Schedule {
        when,
        tz,
        at,
        late,
        message,
    })
}

/// The latest slot at or before `now` and after `after`, which is the slot it last fired for
/// or when it was last changed, whichever is later. One slot, however many were missed: a
/// schedule that could not fire for three days fires once, for today.
pub fn due(schedule: &Schedule, after_ms: i64, now_ms: i64) -> Result<Due, String> {
    let after = instant(after_ms)?;
    let now = instant(now_ms)?;

    let (slot, next) = match &schedule.at {
        Some(at) => {
            let at: Timestamp = at.parse().map_err(|e| format!("{at} — {e}"))?;
            if at > now {
                return Ok(Due::Later {
                    next: at.to_string(),
                });
            }
            if at <= after {
                return Ok(Due::Spent);
            }
            (at, None)
        }
        None => {
            let cron = cron(&schedule.when)?;
            let name = schedule
                .tz
                .as_deref()
                .ok_or_else(|| "a cron schedule carries a tz".to_string())?;
            let here = now.to_zoned(zone(name)?);
            let next = cron
                .find_next_occurrence(&here, false)
                .ok()
                .map(|z| z.timestamp());
            let prev = cron
                .find_previous_occurrence(&here, true)
                .ok()
                .map(|z| z.timestamp());
            match (prev, next) {
                (Some(prev), _) if prev > after => (prev, next),
                (_, Some(next)) => {
                    return Ok(Due::Later {
                        next: next.to_string(),
                    })
                }
                (Some(_), None) => return Ok(Due::Spent),
                (None, None) => {
                    return Err(format!(
                        "has a when that matches no time — \"{}\"",
                        schedule.when
                    ))
                }
            }
        }
    };

    if let Some(late) = schedule.late {
        if (now_ms - slot.as_millisecond()) as f64 > late {
            return Ok(Due::Stale {
                slot: slot.to_string(),
                next: next.map(|n| n.to_string()),
            });
        }
    }
    Ok(Due::Due {
        slot: slot.to_string(),
    })
}

/// The shortest time between two consecutive slots, measured on the slots themselves over
/// the year from `from_ms`: `*/5 9 * * *` fires only in one hour of the day and is still five
/// minutes apart. Stops at the first gap under `floor_ms`, since that already decides a
/// bound. None for an `at` schedule, which has one slot.
pub fn shortest_gap(
    schedule: &Schedule,
    from_ms: i64,
    floor_ms: f64,
) -> Result<Option<f64>, String> {
    if schedule.at.is_some() {
        return Ok(None);
    }
    let cron = cron(&schedule.when)?;
    let name = schedule
        .tz
        .as_deref()
        .ok_or_else(|| "a cron schedule carries a tz".to_string())?;
    let start = instant(from_ms)?.to_zoned(zone(name)?);
    let end = from_ms + HORIZON_MS;

    let mut shortest: Option<f64> = None;
    let mut last: Option<i64> = None;
    for slot in cron.iter_after(start).take(HORIZON_SLOTS) {
        let at = slot.timestamp().as_millisecond();
        if at > end {
            break;
        }
        if let Some(previous) = last {
            let gap = (at - previous) as f64;
            if shortest.map_or(true, |s| gap < s) {
                shortest = Some(gap);
            }
            if gap < floor_ms {
                break;
            }
        }
        last = Some(at);
    }
    Ok(shortest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAILY: &str = "---\nwhen: 0 9 * * *\ntz: Europe/Paris\n---\n\nWhat changed?\n";

    #[test]
    fn reads_late_as_one_duration() {
        let with =
            |late: &str| parse_schedule(&DAILY.replace("tz:", &format!("late: {late}\ntz:")));
        assert!(with("3h").is_ok());
        assert!(with("[3h]")
            .unwrap_err()
            .contains("has a late it cannot read"));
    }

    fn ms(iso: &str) -> i64 {
        iso.parse::<Timestamp>().unwrap().as_millisecond()
    }

    fn daily() -> Schedule {
        parse_schedule(DAILY).unwrap()
    }

    #[test]
    fn reads_a_cron_schedule() {
        let s = daily();
        assert_eq!(s.when, "0 9 * * *");
        assert_eq!(s.tz.as_deref(), Some("Europe/Paris"));
        assert_eq!(s.message, "What changed?");
        assert!(s.at.is_none());
    }

    #[test]
    fn reads_an_instant_in_utc() {
        let s =
            parse_schedule("---\nwhen: at 2026-10-01T09:00:00+02:00\n---\nRemind me.\n").unwrap();
        assert_eq!(s.at.as_deref(), Some("2026-10-01T07:00:00Z"));
    }

    #[test]
    fn refuses_what_it_cannot_fire() {
        let refused = |source: &str| parse_schedule(source).unwrap_err();
        assert!(refused("---\nwhen: 0 9 * * *\n---\nx\n").contains("no tz"));
        assert!(
            refused("---\nwhen: 0 9 * * *\ntz: Mars/Olympus\n---\nx\n").contains("not a time zone")
        );
        assert!(
            refused("---\nwhen: 0 0 9 * * *\ntz: UTC\n---\nx\n").contains("not a cron expression")
        );
        assert!(refused("---\nwhen: at tomorrow\n---\nx\n").contains("at instant it cannot read"));
        assert!(
            refused("---\nwhen: at 2026-10-01T09:00:00Z\ntz: UTC\n---\nx\n").contains("drop tz")
        );
        assert!(refused("---\nwhen: 0 9 * * *\ntz: UTC\n---\n\n").contains("no message"));
        assert!(
            refused("---\nwhen: 0 9 * * *\ntz: UTC\nevery: 1h\n---\nx\n").contains("unknown field")
        );
        assert!(
            refused("---\nwhen: 0 9 * * *\ntz: UTC\nlate: soon\n---\nx\n")
                .contains("late it cannot read")
        );
    }

    #[test]
    fn fires_once_for_its_slot() {
        let s = daily();
        let fired = ms("2026-09-27T07:00:00Z");
        assert_eq!(
            due(&s, fired, ms("2026-09-28T07:00:30Z")).unwrap(),
            Due::Due {
                slot: "2026-09-28T07:00:00Z".into()
            }
        );
        assert_eq!(
            due(&s, ms("2026-09-28T07:00:00Z"), ms("2026-09-28T07:01:30Z")).unwrap(),
            Due::Later {
                next: "2026-09-29T07:00:00Z".into()
            }
        );
    }

    #[test]
    fn catches_up_once_after_downtime() {
        let s = daily();
        assert_eq!(
            due(&s, ms("2026-09-25T07:00:00Z"), ms("2026-09-28T07:10:00Z")).unwrap(),
            Due::Due {
                slot: "2026-09-28T07:00:00Z".into()
            }
        );
    }

    #[test]
    fn skips_a_slot_later_than_it_allows() {
        let s =
            parse_schedule("---\nwhen: 0 9 * * *\ntz: Europe/Paris\nlate: 3h\n---\nx\n").unwrap();
        assert_eq!(
            due(&s, ms("2026-09-27T07:00:00Z"), ms("2026-09-28T11:00:00Z")).unwrap(),
            Due::Stale {
                slot: "2026-09-28T07:00:00Z".into(),
                next: Some("2026-09-29T07:00:00Z".into())
            }
        );
    }

    #[test]
    fn a_new_schedule_waits_for_its_first_slot() {
        let s = daily();
        assert_eq!(
            due(&s, ms("2026-09-28T08:00:00Z"), ms("2026-09-28T08:01:00Z")).unwrap(),
            Due::Later {
                next: "2026-09-29T07:00:00Z".into()
            }
        );
    }

    #[test]
    fn runs_right_after_a_clock_that_jumps_over_it() {
        // Paris skips 02:00–03:00 on 2026-03-29; a 02:30 job runs at 03:00 CEST.
        let s = parse_schedule("---\nwhen: 30 2 * * *\ntz: Europe/Paris\n---\nx\n").unwrap();
        assert_eq!(
            due(&s, ms("2026-03-28T01:30:00Z"), ms("2026-03-29T01:05:00Z")).unwrap(),
            Due::Due {
                slot: "2026-03-29T01:00:00Z".into()
            }
        );
    }

    #[test]
    fn runs_once_in_an_hour_the_clock_repeats() {
        // Paris repeats 02:00–03:00 on 2026-10-25; a 02:30 job fires on the first pass only.
        let s = parse_schedule("---\nwhen: 30 2 * * *\ntz: Europe/Paris\n---\nx\n").unwrap();
        assert_eq!(
            due(&s, ms("2026-10-25T00:30:00Z"), ms("2026-10-25T01:45:00Z")).unwrap(),
            Due::Later {
                next: "2026-10-26T01:30:00Z".into()
            }
        );
    }

    #[test]
    fn an_instant_fires_once() {
        let s = parse_schedule("---\nwhen: at 2026-10-01T07:00:00Z\n---\nx\n").unwrap();
        let written = ms("2026-09-28T00:00:00Z");
        assert_eq!(
            due(&s, written, ms("2026-09-30T00:00:00Z")).unwrap(),
            Due::Later {
                next: "2026-10-01T07:00:00Z".into()
            }
        );
        assert_eq!(
            due(&s, written, ms("2026-10-01T07:00:10Z")).unwrap(),
            Due::Due {
                slot: "2026-10-01T07:00:00Z".into()
            }
        );
        assert_eq!(
            due(&s, ms("2026-10-01T07:00:00Z"), ms("2026-10-01T08:00:00Z")).unwrap(),
            Due::Spent
        );
    }

    #[test]
    fn measures_the_gap_on_the_slots() {
        let from = ms("2026-09-27T00:00:00Z");
        let dense = parse_schedule("---\nwhen: */5 9 * * *\ntz: UTC\n---\nx\n").unwrap();
        assert_eq!(
            shortest_gap(&dense, from, 3_600_000.0).unwrap(),
            Some(300_000.0)
        );
        // A year of a daily job in Paris crosses the spring change, which makes one day 23 h.
        assert_eq!(
            shortest_gap(&daily(), from, 3_600_000.0).unwrap(),
            Some(82_800_000.0)
        );
        let once = parse_schedule("---\nwhen: at 2026-10-01T07:00:00Z\n---\nx\n").unwrap();
        assert_eq!(shortest_gap(&once, from, 3_600_000.0).unwrap(), None);
    }

    #[test]
    fn serializes_its_state_by_name() {
        let json = serde_json::to_value(Due::Later {
            next: "2026-09-29T07:00:00Z".into(),
        })
        .unwrap();
        assert_eq!(json["state"], "later");
        assert_eq!(serde_json::to_value(Due::Spent).unwrap()["state"], "spent");
    }
}

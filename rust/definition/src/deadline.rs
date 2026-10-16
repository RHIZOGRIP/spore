//! When an approval stops waiting: its `within` read from the moment it is asked, in clock time
//! (`30m`, `2h`) or in working days (`2wd`) on a calendar's wall clock. Contract: ARCHITECTURE.md,
//! "Approvals". Computed once, when the approval is asked, so the deadline is a stored instant.

use jiff::civil::{Date, Weekday};
use jiff::tz::TimeZone;
use jiff::Timestamp;

use crate::duration_ms;

const WITHIN_SHAPE: &str = "a duration, as 30m or 2h, or working days, as 2wd";

const WEEKDAYS: [(&str, Weekday); 7] = [
    ("mon", Weekday::Monday),
    ("tue", Weekday::Tuesday),
    ("wed", Weekday::Wednesday),
    ("thu", Weekday::Thursday),
    ("fri", Weekday::Friday),
    ("sat", Weekday::Saturday),
    ("sun", Weekday::Sunday),
];

/// The days an approval counts in working days: its zone, the weekdays that work (Monday to
/// Friday when none are given) and the dates that do not.
pub struct Calendar<'a> {
    pub tz: &'a str,
    pub days: Option<&'a [String]>,
    pub holidays: &'a [String],
}

fn working_days(within: &str) -> Option<u32> {
    let count = within.strip_suffix("wd")?;
    if count.starts_with('0') || count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    count.parse().ok()
}

/// The instant `within` ends, in milliseconds, for an approval asked at `at_ms`. `<n>wd` ends at
/// the same wall-clock time on the n-th working day after the day it is asked, in the calendar's
/// zone, so a daylight-saving change keeps the hour; a time the change skips is read as the clock
/// shows it after the jump.
pub fn deadline(at_ms: i64, within: &str, calendar: Option<&Calendar>) -> Result<i64, String> {
    let Some(count) = working_days(within) else {
        if calendar.is_some() {
            return Err(format!(
                "has a calendar with a within in clock time — got \"{within}\"; a calendar counts working days, as 2wd"
            ));
        }
        return match duration_ms(within) {
            Some(ms) if ms > 0.0 => Ok(at_ms + ms as i64),
            _ => Err(format!(
                "has a within it cannot read — got \"{within}\", expected {WITHIN_SHAPE}"
            )),
        };
    };
    let Some(calendar) = calendar else {
        return Err(format!(
            "counts working days with no calendar — {within} needs one, as {{ \"tz\": \"Europe/Paris\" }}"
        ));
    };

    let zone = TimeZone::get(calendar.tz).map_err(|e| {
        format!(
            "has a calendar tz that is not a time zone — got \"{}\" ({e})",
            calendar.tz
        )
    })?;
    let days: Vec<Weekday> = match calendar.days {
        None => WEEKDAYS[..5].iter().map(|(_, day)| *day).collect(),
        Some(names) => names
            .iter()
            .map(|name| {
                WEEKDAYS
                    .iter()
                    .find(|(short, _)| *short == name.as_str())
                    .map(|(_, day)| *day)
                    .ok_or_else(|| {
                        format!("has a calendar day it does not know — got \"{name}\", expected mon, tue, wed, thu, fri, sat or sun")
                    })
            })
            .collect::<Result<_, _>>()?,
    };
    if days.is_empty() {
        return Err("has a calendar with no working days".into());
    }
    let holidays: Vec<Date> = calendar
        .holidays
        .iter()
        .map(|written| {
            written.parse::<Date>().map_err(|e| {
                format!("has a calendar holiday that is not a date — got \"{written}\" ({e}); write it as 2026-12-25")
            })
        })
        .collect::<Result<_, _>>()?;

    let asked = Timestamp::from_millisecond(at_ms)
        .map_err(|e| format!("{at_ms} is not an instant — {e}"))?
        .to_zoned(zone.clone());
    let mut date = asked.date();
    let mut left = count;
    while left > 0 {
        date = date
            .tomorrow()
            .map_err(|e| format!("{within} runs past the calendar — {e}"))?;
        if days.contains(&date.weekday()) && !holidays.contains(&date) {
            left -= 1;
        }
    }
    let ends = date
        .to_datetime(asked.time())
        .to_zoned(zone)
        .map_err(|e| format!("{within} ends at a time the zone does not have — {e}"))?;
    Ok(ends.timestamp().as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> i64 {
        iso.parse::<Timestamp>().unwrap().as_millisecond()
    }

    fn iso(ms: i64) -> String {
        Timestamp::from_millisecond(ms).unwrap().to_string()
    }

    fn paris() -> Calendar<'static> {
        Calendar {
            tz: "Europe/Paris",
            days: None,
            holidays: &[],
        }
    }

    #[test]
    fn reads_clock_time_from_the_moment_it_is_asked() {
        let at = ms("2026-10-16T14:00:00Z");
        assert_eq!(
            iso(deadline(at, "2h", None).unwrap()),
            "2026-10-16T16:00:00Z"
        );
        assert_eq!(
            iso(deadline(at, "24h", None).unwrap()),
            "2026-10-17T14:00:00Z"
        );
    }

    #[test]
    fn ends_a_working_day_at_the_same_hour_on_the_next_one() {
        // Friday 16:00 in Paris: one working day is Monday 16:00, past the weekend.
        let friday = ms("2026-10-16T14:00:00Z");
        assert_eq!(
            iso(deadline(friday, "1wd", Some(&paris())).unwrap()),
            "2026-10-19T14:00:00Z"
        );
        assert_eq!(
            iso(deadline(friday, "2wd", Some(&paris())).unwrap()),
            "2026-10-20T14:00:00Z"
        );
        let saturday = ms("2026-10-17T08:00:00Z");
        assert_eq!(
            iso(deadline(saturday, "1wd", Some(&paris())).unwrap()),
            "2026-10-19T08:00:00Z"
        );
    }

    #[test]
    fn skips_the_holidays_and_counts_the_days_its_calendar_works() {
        let holidays = ["2026-12-25".to_string()];
        let calendar = Calendar {
            tz: "Europe/Paris",
            days: None,
            holidays: &holidays,
        };
        let thursday = ms("2026-12-24T09:00:00Z");
        assert_eq!(
            iso(deadline(thursday, "1wd", Some(&calendar)).unwrap()),
            "2026-12-28T09:00:00Z"
        );
        let days = ["sun".to_string(), "mon".to_string()];
        let weekends = Calendar {
            tz: "UTC",
            days: Some(&days),
            holidays: &[],
        };
        assert_eq!(
            iso(deadline(ms("2026-10-16T10:00:00Z"), "1wd", Some(&weekends)).unwrap()),
            "2026-10-18T10:00:00Z"
        );
    }

    #[test]
    fn keeps_the_hour_across_a_daylight_saving_change() {
        // Paris leaves summer time on 2026-10-25: 16:00 is 14:00Z before and 15:00Z after.
        let friday = ms("2026-10-23T14:00:00Z");
        assert_eq!(
            iso(deadline(friday, "1wd", Some(&paris())).unwrap()),
            "2026-10-26T15:00:00Z"
        );
    }

    #[test]
    fn refuses_what_it_cannot_count() {
        let at = ms("2026-10-16T14:00:00Z");
        for bad in ["", "1d", "0wd", "02wd", "wd", "2 wd", "0m", "-1h"] {
            assert!(deadline(at, bad, None).is_err(), "{bad}");
        }
        assert!(deadline(at, "2wd", None)
            .unwrap_err()
            .contains("no calendar"));
        assert!(deadline(at, "2h", Some(&paris()))
            .unwrap_err()
            .contains("clock time"));
        let none: [String; 0] = [];
        let idle = Calendar {
            tz: "UTC",
            days: Some(&none),
            holidays: &[],
        };
        assert!(deadline(at, "1wd", Some(&idle)).is_err());
        let wrong = ["monday".to_string()];
        let misnamed = Calendar {
            tz: "UTC",
            days: Some(&wrong),
            holidays: &[],
        };
        assert!(deadline(at, "1wd", Some(&misnamed)).is_err());
        let nowhere = Calendar {
            tz: "Mars/Olympus",
            days: None,
            holidays: &[],
        };
        assert!(deadline(at, "1wd", Some(&nowhere)).is_err());
        let late = ["25/12/2026".to_string()];
        let unreadable = Calendar {
            tz: "UTC",
            days: None,
            holidays: &late,
        };
        assert!(deadline(at, "1wd", Some(&unreadable)).is_err());
    }
}

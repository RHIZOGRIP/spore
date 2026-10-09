//! What one user's spores have spent on model calls, by local day, and the limits that user
//! may set on it. Contract: ARCHITECTURE.md, "What a user's spores spend".

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use jiff::civil::Date;
use jiff::{ToSpan, Zoned};

use crate::Refusal;

/// In dollars.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Limits {
    pub day: Option<f64>,
    pub month: Option<f64>,
}

impl Limits {
    pub fn none(&self) -> bool {
        self.day.is_none() && self.month.is_none()
    }
}

/// In micros.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spent {
    pub date: Date,
    pub day: i64,
    pub month: i64,
}

pub fn spend_dir(slots: &Path) -> PathBuf {
    slots
        .parent()
        .expect("the slots live in a directory")
        .join("spend")
}

pub fn today() -> Date {
    Zoned::now().date()
}

pub fn add_spend(slots: &Path, micros: i64) -> io::Result<()> {
    add_spend_on(slots, today(), micros)
}

/// Added under a lock and renamed into place, so a reader never sees half a number.
pub fn add_spend_on(slots: &Path, date: Date, micros: i64) -> io::Result<()> {
    if micros <= 0 {
        return Ok(());
    }
    let dir = spend_dir(slots);
    DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(dir.join("lock"))?;
    while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EINTR) {
            return Err(err);
        }
    }
    let path = dir.join(date.to_string());
    let held = read_micros(&path)?;
    let temporary = dir.join(format!(".{date}.{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    write!(file, "{}", held.unwrap_or(0) + micros)?;
    fs::rename(&temporary, &path)?;
    if held.is_none() {
        prune(&dir, date)?;
    }
    Ok(())
}

fn read_micros(path: &Path) -> io::Result<Option<i64>> {
    match fs::read_to_string(path) {
        Ok(raw) => raw.trim().parse().map(Some).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} holds no amount", path.display()),
            )
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn days(dir: &Path) -> io::Result<Vec<(Date, PathBuf)>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut days = Vec::new();
    for entry in entries {
        let entry = entry?;
        if let Some(date) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<Date>().ok())
        {
            days.push((date, entry.path()));
        }
    }
    Ok(days)
}

/// Keeps this month and the one before.
fn prune(dir: &Path, date: Date) -> io::Result<()> {
    let kept = date
        .first_of_month()
        .checked_sub(1.month())
        .map_err(|e| io::Error::other(e.to_string()))?;
    for (day, path) in days(dir)? {
        if day < kept {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

pub fn spent(slots: &Path) -> io::Result<Spent> {
    spent_on(slots, today())
}

pub fn spent_on(slots: &Path, date: Date) -> io::Result<Spent> {
    let mut spent = Spent {
        date,
        day: 0,
        month: 0,
    };
    for (day, path) in days(&spend_dir(slots))? {
        if day.year() != date.year() || day.month() != date.month() || day > date {
            continue;
        }
        let micros = read_micros(&path)?.unwrap_or(0);
        spent.month += micros;
        if day == date {
            spent.day = micros;
        }
    }
    Ok(spent)
}

/// With no limit, nothing is read.
pub fn spend_refusal(slots: &Path, limits: &Limits) -> io::Result<Option<Refusal>> {
    spend_refusal_on(slots, limits, today())
}

pub fn spend_refusal_on(slots: &Path, limits: &Limits, date: Date) -> io::Result<Option<Refusal>> {
    if limits.none() {
        return Ok(None);
    }
    let spent = spent_on(slots, date)?;
    let dollars = |micros: i64| micros as f64 / 1_000_000.0;
    if let Some(limit) = limits.day {
        if dollars(spent.day) >= limit {
            return Ok(Some(Refusal {
                kind: "SPEND_LIMIT",
                message: format!(
                    "your spores have spent ${:.2} today, which reaches your daily limit of ${limit:.2}",
                    dollars(spent.day)
                ),
                detail: "turns start again tomorrow — spore config set spendPerDay <dollars> raises the limit".into(),
            }));
        }
    }
    if let Some(limit) = limits.month {
        if dollars(spent.month) >= limit {
            return Ok(Some(Refusal {
                kind: "SPEND_LIMIT",
                message: format!(
                    "your spores have spent ${:.2} this month, which reaches your monthly limit of ${limit:.2}",
                    dollars(spent.month)
                ),
                detail: "turns start again on the 1st — spore config set spendPerMonth <dollars> raises the limit".into(),
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::date;

    fn slots(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spore-spend-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("slots")
    }

    #[test]
    fn counts_a_day_and_its_month_and_keeps_two_months() {
        let slots = slots("count");
        add_spend_on(&slots, date(2026, 8, 31), 1).unwrap();
        add_spend_on(&slots, date(2026, 9, 30), 7).unwrap();
        add_spend_on(&slots, date(2026, 10, 1), 25).unwrap();
        add_spend_on(&slots, date(2026, 10, 8), 100).unwrap();
        add_spend_on(&slots, date(2026, 10, 8), 50).unwrap();
        add_spend_on(&slots, date(2026, 10, 8), 0).unwrap();

        let spent = spent_on(&slots, date(2026, 10, 8)).unwrap();
        assert_eq!((spent.day, spent.month), (150, 175));
        assert_eq!(spent_on(&slots, date(2026, 9, 30)).unwrap().month, 7);
        assert!(!spend_dir(&slots).join("2026-08-31").exists());
        assert!(spend_dir(&slots).join("2026-09-30").exists());
    }

    #[test]
    fn loses_nothing_to_writers_adding_at_once() {
        let slots = slots("together");
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let slots = slots.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        add_spend_on(&slots, date(2026, 10, 8), 1).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(spent_on(&slots, date(2026, 10, 8)).unwrap().day, 400);
    }

    #[test]
    fn refuses_once_a_limit_is_reached_and_reads_nothing_without_one() {
        let slots = slots("refuse");
        let on = date(2026, 10, 8);
        add_spend_on(&slots, date(2026, 10, 2), 600_000).unwrap();
        add_spend_on(&slots, on, 150_000).unwrap();
        let day = Limits {
            day: Some(0.2),
            month: None,
        };
        assert!(spend_refusal_on(&slots, &day, on).unwrap().is_none());
        add_spend_on(&slots, on, 50_000).unwrap();
        let refused = spend_refusal_on(&slots, &day, on).unwrap().unwrap();
        assert_eq!(refused.kind, "SPEND_LIMIT");
        assert!(
            refused.message.contains("$0.20 today"),
            "{}",
            refused.message
        );

        let month = Limits {
            day: None,
            month: Some(0.8),
        };
        let refused = spend_refusal_on(&slots, &month, on).unwrap().unwrap();
        assert!(
            refused.message.contains("$0.80 this month"),
            "{}",
            refused.message
        );
        assert!(spend_refusal_on(&slots, &month, date(2026, 11, 1))
            .unwrap()
            .is_none());

        fs::write(spend_dir(&slots).join(on.to_string()), "garbled").unwrap();
        assert!(spend_refusal_on(&slots, &Limits::default(), on)
            .unwrap()
            .is_none());
        assert!(spend_refusal_on(&slots, &day, on).is_err());
    }
}

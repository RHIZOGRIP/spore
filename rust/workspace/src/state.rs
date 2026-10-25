//! A workspace's runtime state: `<ws>/state.sqlite` (ARCHITECTURE §The
//! workspace database).
//!
//! The schema, its version and the journal rule, one implementation for the runner, the cell
//! supervisor and the JS host side. Tables are storage, prefixed `t_`; the plain-named views
//! over them are the contract readers use — the agent through `node:sqlite`, a person through
//! `spore sql`.
//!
//! **The journal rule.** WAL while a writer holds the database, rollback mode when none does:
//! the header keeps WAL after the last close, and opening a WAL database needs `-shm`, which a
//! confined reader cannot create. So the last writer to close switches back, and the next one
//! to open switches to WAL again.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::types::Value as SqlValue;
use rusqlite::{
    ffi::ErrorCode, params_from_iter, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde_json::value::RawValue;
use serde_json::{json, Value};

use crate::{Record, Settled, TURN_ID};

pub const STATE_FILE: &str = "state.sqlite";
pub const SCHEMA_VERSION: i64 = 14;
/// The event log's schema, `v` on every event: the agent's and the supervisor's alike.
pub const EVENT_SCHEMA: i64 = 1;

/// How long a writer waits for another to finish a transaction. Transactions are short and
/// never span a model call or a tool, so a wait this long is a writer that has stopped.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const LEAVE_WAL_PATIENCE: Duration = Duration::from_secs(2);

const SCHEMA: &str = r#"
CREATE TABLE t_workspace (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  schemaVersion      INTEGER NOT NULL,
  createdAt          TEXT    NOT NULL,
  lastSeq            INTEGER NOT NULL DEFAULT 0,
  inboxConsumed      INTEGER NOT NULL DEFAULT 0,
  lastTurnNo         INTEGER NOT NULL DEFAULT 0,
  treeMicros         INTEGER NOT NULL DEFAULT 0,
  workUnits          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE t_inbox (
  inboxNo      INTEGER PRIMARY KEY,
  at           TEXT    NOT NULL,
  text         TEXT,
  bodyPath     TEXT,
  bodyBytes    INTEGER,
  bodyHead     TEXT,
  bodyTail     TEXT,
  files        TEXT,
  schedule     TEXT,
  due          TEXT,
  traceparent  TEXT,
  requestId    TEXT UNIQUE,
  hook         TEXT,
  hookEvent    TEXT,
  hookDelivery TEXT,
  job          TEXT,
  jobEvent     TEXT,
  jobRun       TEXT,
  replyTo      TEXT,
  fromName     TEXT,
  fromId       TEXT,
  fromWhere    TEXT CHECK ((fromName IS NULL) = (fromId IS NULL) AND (fromName IS NULL) = (fromWhere IS NULL)
                           AND (fromName IS NULL OR (schedule IS NULL AND hook IS NULL AND job IS NULL))),
  overheard    INTEGER NOT NULL DEFAULT 0 CHECK (overheard IN (0, 1) AND (overheard = 0 OR (fromName IS NOT NULL AND replyTo IS NULL))),
  approval     TEXT CHECK (approval IS NULL OR (schedule IS NULL AND hook IS NULL AND job IS NULL AND overheard = 0 AND replyTo IS NOT NULL)),
  fromZone     TEXT CHECK (fromZone IS NULL OR (fromName IS NOT NULL AND fromZone <> '')),
  api          TEXT CHECK (api IS NULL OR (api <> '' AND schedule IS NULL AND hook IS NULL AND job IS NULL AND fromName IS NULL AND overheard = 0 AND approval IS NULL AND replyTo IS NULL)),
  startsTurn   INTEGER NOT NULL DEFAULT 1 CHECK (startsTurn IN (0, 1) AND (startsTurn = 1 OR hook IS NOT NULL OR job IS NOT NULL OR api IS NOT NULL)),
  UNIQUE (schedule, due),
  CHECK ((schedule IS NULL) = (due IS NULL)),
  CHECK ((hook IS NULL) = (hookDelivery IS NULL)),
  CHECK (hookEvent IS NULL OR hook IS NOT NULL),
  CHECK (coalesce(text, '') <> '' OR bodyPath IS NOT NULL OR files IS NOT NULL)
);
CREATE INDEX t_inbox_at ON t_inbox (at);

CREATE TABLE t_turns (
  turnId             TEXT    PRIMARY KEY,
  turnNo             INTEGER UNIQUE,
  runId              TEXT,
  state              TEXT    NOT NULL CHECK (state IN ('running', 'pending', 'final')),
  startedAt          TEXT    NOT NULL,
  endedAt            TEXT,
  stopReason         TEXT,
  concluded          INTEGER,
  because            TEXT,
  output             TEXT,
  error              TEXT,
  detail             TEXT,
  rounds             INTEGER,
  ownMicros          INTEGER,
  treeMicros         INTEGER,
  workUnits          INTEGER,
  workUnitsOwn       INTEGER,
  workUnitsChildren  INTEGER,
  inputTokens        INTEGER,
  outputTokens       INTEGER,
  thinkingTokens     INTEGER,
  cacheWriteTokens   INTEGER,
  cacheReadTokens    INTEGER,
  inboxFrom          INTEGER,
  inboxTo            INTEGER,
  cut                INTEGER,
  settled            INTEGER,
  deliverables       TEXT,
  deliverablesMore   INTEGER,
  recall             TEXT,
  traceparent        TEXT,
  model              TEXT,
  byPrecursor        TEXT,
  replyDefault       TEXT,
  dataBytes          INTEGER,
  historySent        INTEGER,
  historyBound       INTEGER,
  CHECK ((state = 'final') = (turnNo IS NOT NULL))
);

CREATE TABLE t_transcript (
  entryNo  INTEGER PRIMARY KEY,
  turnId   TEXT    REFERENCES t_turns (turnId),
  round    INTEGER,
  at       TEXT    NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('message', 'compaction')),
  role     TEXT,
  message  TEXT    NOT NULL,
  marks    TEXT
);
CREATE INDEX t_transcript_turn ON t_transcript (turnId);

CREATE TABLE t_events (
  seq      INTEGER PRIMARY KEY,
  v        INTEGER NOT NULL,
  at       TEXT    NOT NULL,
  runId    TEXT,
  turnId   TEXT    REFERENCES t_turns (turnId),
  event    TEXT    NOT NULL,
  payload  TEXT    NOT NULL
);
CREATE INDEX t_events_turn ON t_events (turnId);
CREATE INDEX t_events_run ON t_events (runId, event);

CREATE TABLE t_calls (
  runId       TEXT    NOT NULL,
  callNo      INTEGER NOT NULL,
  turnId      TEXT    REFERENCES t_turns (turnId),
  round       INTEGER,
  tool        TEXT    NOT NULL,
  startedAt   TEXT    NOT NULL,
  durationMs  INTEGER,
  exit        INTEGER,
  refused     INTEGER NOT NULL DEFAULT 0,
  outPath     TEXT,
  errPath     TEXT,
  record      TEXT    NOT NULL,
  PRIMARY KEY (runId, callNo)
);
CREATE INDEX t_calls_turn ON t_calls (turnId);

CREATE TABLE t_limits (
  limitNo    INTEGER PRIMARY KEY,
  turnId     TEXT    NOT NULL REFERENCES t_turns (turnId),
  at         TEXT    NOT NULL,
  dimension  TEXT    NOT NULL CHECK (dimension IN ('rounds', 'cost', 'wall')),
  soft       REAL    NOT NULL,
  hard       REAL    NOT NULL,
  why        TEXT    NOT NULL CHECK (why IN ('start', 'extend', 'wrap')),
  CHECK (hard > soft)
);
CREATE INDEX t_limits_turn ON t_limits (turnId, dimension);

CREATE VIEW turns AS
  SELECT turnNo, turnId, runId, startedAt, endedAt, stopReason, concluded, because, output,
         error, detail, rounds,
         ownMicros, ownMicros / 1e6 AS ownUsd, treeMicros, treeMicros / 1e6 AS treeUsd,
         workUnits, workUnitsOwn, workUnitsChildren,
         inputTokens, outputTokens, thinkingTokens, cacheWriteTokens, cacheReadTokens,
         inboxFrom, inboxTo, cut, settled, deliverables, deliverablesMore, recall, traceparent, model,
         byPrecursor, dataBytes, historySent, historyBound
    FROM t_turns
   WHERE state = 'final';

CREATE TABLE t_set_aside (
  inboxNo  INTEGER PRIMARY KEY REFERENCES t_inbox (inboxNo),
  at       TEXT    NOT NULL
);

CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.fromZone, i.overheard, i.approval, i.api, i.startsTurn,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside,
         NOT i.overheard AND NOT EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS asks
    FROM t_inbox i, t_workspace w;

CREATE VIEW transcript AS
  SELECT entryNo, turnId, round, at, kind, role, message, marks FROM t_transcript;

CREATE VIEW events AS
  SELECT seq, v, at, runId, turnId, event, payload FROM t_events;

CREATE VIEW calls AS
  SELECT runId, callNo, turnId, round, tool, startedAt, durationMs, exit, refused,
         outPath, errPath, record
    FROM t_calls;

CREATE VIEW limits AS
  SELECT limitNo, turnId, at, dimension, soft, hard, why FROM t_limits;

CREATE TABLE t_held (
  heldNo     INTEGER PRIMARY KEY,
  at         TEXT    NOT NULL,
  releaseAt  TEXT    NOT NULL,
  deadline   TEXT    NOT NULL,
  origin     TEXT    NOT NULL,
  requestId  TEXT    UNIQUE,
  summary    TEXT,
  entry      TEXT    NOT NULL,
  CHECK (releaseAt <= deadline)
);

CREATE VIEW held AS
  SELECT heldNo, at, releaseAt, deadline, origin, summary, entry FROM t_held;

CREATE TABLE t_cells (
  cellNo      INTEGER PRIMARY KEY,
  at          TEXT    NOT NULL,
  precursor   TEXT    NOT NULL,
  origin      TEXT    NOT NULL,
  ref         TEXT,
  cellWs      TEXT    NOT NULL,
  answer      TEXT,
  error       TEXT,
  costMicros  INTEGER NOT NULL,
  durationMs  INTEGER NOT NULL,
  afterTurn   INTEGER,
  dataBytes   INTEGER,
  changed     TEXT,
  CHECK ((answer IS NULL) <> (error IS NULL))
);
CREATE INDEX t_cells_origin ON t_cells (origin, at);

CREATE VIEW cells AS
  SELECT cellNo, at, precursor, origin, ref, cellWs, answer, error,
         costMicros, costMicros / 1e6 AS costUsd, durationMs, afterTurn, dataBytes, changed
    FROM t_cells;

CREATE TABLE t_jobs (
  jobNo      INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  run        TEXT    NOT NULL UNIQUE,
  command    TEXT    NOT NULL,
  wallMs     INTEGER NOT NULL,
  pid        INTEGER,
  startedAt  TEXT    NOT NULL,
  endedAt    TEXT,
  status     TEXT    NOT NULL CHECK (status IN ('running', 'ended', 'stopped', 'walled', 'interrupted')),
  exit       INTEGER,
  signal     TEXT,
  CHECK ((status = 'running') = (endedAt IS NULL))
);
CREATE INDEX t_jobs_running ON t_jobs (status, name);

CREATE VIEW jobs AS
  SELECT jobNo, name, run, command, wallMs, pid, startedAt, endedAt, status, exit, signal FROM t_jobs;

CREATE TABLE t_outbox (
  outboxNo   INTEGER PRIMARY KEY,
  at         TEXT    NOT NULL,
  turnId     TEXT    NOT NULL REFERENCES t_turns (turnId),
  recipient  TEXT    NOT NULL,
  answers    TEXT    NOT NULL,
  state      TEXT    NOT NULL CHECK (state IN ('pending', 'delivered', 'refused')),
  settledAt  TEXT,
  reason     TEXT,
  attemptedAt TEXT,
  CHECK ((state = 'pending') = (settledAt IS NULL)),
  CHECK ((state = 'refused') = (reason IS NOT NULL))
);
CREATE INDEX t_outbox_pending ON t_outbox (state, recipient);

CREATE VIEW outbox AS
  SELECT outboxNo, at, turnId, recipient, answers, state, settledAt, reason, attemptedAt FROM t_outbox;

CREATE TABLE t_approvals (
  approvalNo    INTEGER PRIMARY KEY,
  id            TEXT    NOT NULL UNIQUE,
  at            TEXT    NOT NULL,
  place         TEXT    NOT NULL,
  approvers     TEXT    NOT NULL,
  options       TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  within        TEXT    NOT NULL,
  calendar      TEXT,
  until         TEXT    NOT NULL,
  hook          TEXT,
  state         TEXT    NOT NULL CHECK (state IN ('asked', 'posted', 'answered', 'expired', 'refused')),
  shown         TEXT,
  note          TEXT,
  postedAt      TEXT,
  choice        TEXT,
  inputs        TEXT,
  answererId    TEXT,
  answererName  TEXT,
  answeredAt    TEXT,
  outcome       TEXT    CHECK (outcome IN ('confirmed', 'failed')),
  replaced      TEXT,
  tell          TEXT,
  reason        TEXT,
  settledAt     TEXT,
  fields        TEXT,
  CHECK ((postedAt IS NULL) = (state IN ('asked', 'refused'))),
  CHECK ((shown IS NULL) = (postedAt IS NULL)),
  CHECK ((answeredAt IS NULL) = (state <> 'answered')),
  CHECK ((choice IS NULL) = (answeredAt IS NULL) AND (answererId IS NULL) = (answeredAt IS NULL)
         AND (answererName IS NULL) = (answeredAt IS NULL)),
  CHECK (inputs IS NULL OR answeredAt IS NOT NULL),
  CHECK (outcome IS NULL OR (state = 'answered' AND settledAt IS NOT NULL)),
  CHECK ((reason IS NOT NULL) = (state = 'refused' OR coalesce(outcome, '') = 'failed')),
  CHECK (settledAt IS NULL OR state IN ('answered', 'expired', 'refused')),
  CHECK ((replaced IS NULL AND tell IS NULL) OR settledAt IS NOT NULL)
);
CREATE INDEX t_approvals_open ON t_approvals (settledAt, state);

CREATE VIEW approvals AS
  SELECT approvalNo, id, at, place, approvers, options, body, within, calendar, until, hook, state,
         shown, note, postedAt, choice, inputs, answererId, answererName, answeredAt, outcome,
         replaced, tell, reason, settledAt, fields
    FROM t_approvals;
"#;

/// What moves a database at `from` to the next version, in order. Each leaves it as a fresh one
/// at that version would be.
const MIGRATIONS: [(i64, &str); 13] = [
    (
        1,
        r#"
ALTER TABLE t_inbox ADD COLUMN replyTo TEXT;
ALTER TABLE t_turns ADD COLUMN replyDefault TEXT;

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.inboxNo <= w.inboxConsumed AS consumed
    FROM t_inbox i, t_workspace w;

CREATE TABLE t_outbox (
  outboxNo   INTEGER PRIMARY KEY,
  at         TEXT    NOT NULL,
  turnId     TEXT    NOT NULL REFERENCES t_turns (turnId),
  recipient  TEXT    NOT NULL,
  answers    TEXT    NOT NULL,
  state      TEXT    NOT NULL CHECK (state IN ('pending', 'delivered', 'refused')),
  settledAt  TEXT,
  reason     TEXT,
  CHECK ((state = 'pending') = (settledAt IS NULL)),
  CHECK ((state = 'refused') = (reason IS NOT NULL))
);
CREATE INDEX t_outbox_pending ON t_outbox (state, recipient);

CREATE VIEW outbox AS
  SELECT outboxNo, at, turnId, recipient, answers, state, settledAt, reason FROM t_outbox;
"#,
    ),
    (
        2,
        r#"
ALTER TABLE t_turns ADD COLUMN dataBytes INTEGER;
ALTER TABLE t_cells ADD COLUMN afterTurn INTEGER;
ALTER TABLE t_cells ADD COLUMN dataBytes INTEGER;
ALTER TABLE t_cells ADD COLUMN changed TEXT;

DROP VIEW turns;
CREATE VIEW turns AS
  SELECT turnNo, turnId, runId, startedAt, endedAt, stopReason, concluded, because, output,
         error, detail, rounds,
         ownMicros, ownMicros / 1e6 AS ownUsd, treeMicros, treeMicros / 1e6 AS treeUsd,
         workUnits, workUnitsOwn, workUnitsChildren,
         inputTokens, outputTokens, thinkingTokens, cacheWriteTokens, cacheReadTokens,
         inboxFrom, inboxTo, cut, settled, produced, producedMore, recall, traceparent, model,
         byPrecursor, dataBytes
    FROM t_turns
   WHERE state = 'final';

DROP VIEW cells;
CREATE VIEW cells AS
  SELECT cellNo, at, precursor, origin, ref, cellWs, answer, error,
         costMicros, costMicros / 1e6 AS costUsd, durationMs, afterTurn, dataBytes, changed
    FROM t_cells;
"#,
    ),
    (
        3,
        r#"
ALTER TABLE t_turns ADD COLUMN historySent INTEGER;
ALTER TABLE t_turns ADD COLUMN historyBound INTEGER;

DROP VIEW turns;
CREATE VIEW turns AS
  SELECT turnNo, turnId, runId, startedAt, endedAt, stopReason, concluded, because, output,
         error, detail, rounds,
         ownMicros, ownMicros / 1e6 AS ownUsd, treeMicros, treeMicros / 1e6 AS treeUsd,
         workUnits, workUnitsOwn, workUnitsChildren,
         inputTokens, outputTokens, thinkingTokens, cacheWriteTokens, cacheReadTokens,
         inboxFrom, inboxTo, cut, settled, produced, producedMore, recall, traceparent, model,
         byPrecursor, dataBytes, historySent, historyBound
    FROM t_turns
   WHERE state = 'final';
"#,
    ),
    (
        4,
        r#"
DROP VIEW turns;
ALTER TABLE t_turns RENAME COLUMN produced TO deliverables;
ALTER TABLE t_turns RENAME COLUMN producedMore TO deliverablesMore;
UPDATE t_turns
   SET deliverables = (SELECT json_group_array(json(json_remove(value, '$.delivered')))
                         FROM json_each(t_turns.deliverables)
                        WHERE json_extract(value, '$.delivered')),
       deliverablesMore = NULL
 WHERE deliverables IS NOT NULL;

CREATE VIEW turns AS
  SELECT turnNo, turnId, runId, startedAt, endedAt, stopReason, concluded, because, output,
         error, detail, rounds,
         ownMicros, ownMicros / 1e6 AS ownUsd, treeMicros, treeMicros / 1e6 AS treeUsd,
         workUnits, workUnitsOwn, workUnitsChildren,
         inputTokens, outputTokens, thinkingTokens, cacheWriteTokens, cacheReadTokens,
         inboxFrom, inboxTo, cut, settled, deliverables, deliverablesMore, recall, traceparent, model,
         byPrecursor, dataBytes, historySent, historyBound
    FROM t_turns
   WHERE state = 'final';
"#,
    ),
    (
        5,
        r#"
ALTER TABLE t_inbox ADD COLUMN fromName TEXT;
ALTER TABLE t_inbox ADD COLUMN fromId TEXT;
ALTER TABLE t_inbox ADD COLUMN fromWhere TEXT CHECK ((fromName IS NULL) = (fromId IS NULL) AND (fromName IS NULL) = (fromWhere IS NULL)
                           AND (fromName IS NULL OR (schedule IS NULL AND hook IS NULL AND job IS NULL)));

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere,
         i.inboxNo <= w.inboxConsumed AS consumed
    FROM t_inbox i, t_workspace w;
"#,
    ),
    (
        6,
        r#"
ALTER TABLE t_outbox ADD COLUMN attemptedAt TEXT;

DROP VIEW outbox;
CREATE VIEW outbox AS
  SELECT outboxNo, at, turnId, recipient, answers, state, settledAt, reason, attemptedAt FROM t_outbox;
"#,
    ),
    (
        7,
        r#"
CREATE TABLE t_set_aside (
  inboxNo  INTEGER PRIMARY KEY REFERENCES t_inbox (inboxNo),
  at       TEXT    NOT NULL
);

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside
    FROM t_inbox i, t_workspace w;
"#,
    ),
    (
        8,
        r#"
ALTER TABLE t_inbox ADD COLUMN overheard INTEGER NOT NULL DEFAULT 0 CHECK (overheard IN (0, 1) AND (overheard = 0 OR (fromName IS NOT NULL AND replyTo IS NULL)));

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.overheard,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside
    FROM t_inbox i, t_workspace w;
"#,
    ),
    (
        9,
        r#"
ALTER TABLE t_inbox ADD COLUMN approval TEXT CHECK (approval IS NULL OR (schedule IS NULL AND hook IS NULL AND job IS NULL AND overheard = 0 AND replyTo IS NOT NULL));

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.overheard, i.approval,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside
    FROM t_inbox i, t_workspace w;

CREATE TABLE t_approvals (
  approvalNo    INTEGER PRIMARY KEY,
  id            TEXT    NOT NULL UNIQUE,
  at            TEXT    NOT NULL,
  place         TEXT    NOT NULL,
  approvers     TEXT    NOT NULL,
  options       TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  within        TEXT    NOT NULL,
  calendar      TEXT,
  until         TEXT    NOT NULL,
  hook          TEXT,
  state         TEXT    NOT NULL CHECK (state IN ('asked', 'posted', 'answered', 'expired', 'refused')),
  shown         TEXT,
  note          TEXT,
  postedAt      TEXT,
  choice        TEXT,
  inputs        TEXT,
  answererId    TEXT,
  answererName  TEXT,
  answeredAt    TEXT,
  outcome       TEXT    CHECK (outcome IN ('confirmed', 'failed')),
  replaced      TEXT,
  tell          TEXT,
  reason        TEXT,
  settledAt     TEXT,
  CHECK ((postedAt IS NULL) = (state IN ('asked', 'refused'))),
  CHECK ((shown IS NULL) = (postedAt IS NULL)),
  CHECK ((answeredAt IS NULL) = (state <> 'answered')),
  CHECK ((choice IS NULL) = (answeredAt IS NULL) AND (answererId IS NULL) = (answeredAt IS NULL)
         AND (answererName IS NULL) = (answeredAt IS NULL)),
  CHECK (inputs IS NULL OR answeredAt IS NOT NULL),
  CHECK (outcome IS NULL OR (state = 'answered' AND settledAt IS NOT NULL)),
  CHECK ((reason IS NOT NULL) = (state = 'refused' OR coalesce(outcome, '') = 'failed')),
  CHECK (settledAt IS NULL OR state IN ('answered', 'expired', 'refused')),
  CHECK ((replaced IS NULL AND tell IS NULL) OR settledAt IS NOT NULL)
);
CREATE INDEX t_approvals_open ON t_approvals (settledAt, state);

CREATE VIEW approvals AS
  SELECT approvalNo, id, at, place, approvers, options, body, within, calendar, until, hook, state,
         shown, note, postedAt, choice, inputs, answererId, answererName, answeredAt, outcome,
         replaced, tell, reason, settledAt
    FROM t_approvals;
"#,
    ),
    (
        10,
        r#"
ALTER TABLE t_inbox ADD COLUMN fromZone TEXT CHECK (fromZone IS NULL OR (fromName IS NOT NULL AND fromZone <> ''));

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.fromZone, i.overheard, i.approval,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside
    FROM t_inbox i, t_workspace w;
"#,
    ),
    (
        11,
        r#"
ALTER TABLE t_approvals ADD COLUMN fields TEXT;

DROP VIEW approvals;
CREATE VIEW approvals AS
  SELECT approvalNo, id, at, place, approvers, options, body, within, calendar, until, hook, state,
         shown, note, postedAt, choice, inputs, answererId, answererName, answeredAt, outcome,
         replaced, tell, reason, settledAt, fields
    FROM t_approvals;
"#,
    ),
    (
        12,
        r#"
ALTER TABLE t_inbox ADD COLUMN api TEXT CHECK (api IS NULL OR (api <> '' AND schedule IS NULL AND hook IS NULL AND job IS NULL AND fromName IS NULL AND overheard = 0 AND approval IS NULL AND replyTo IS NULL));

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.fromZone, i.overheard, i.approval, i.api,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside
    FROM t_inbox i, t_workspace w;
"#,
    ),
    (
        13,
        r#"
ALTER TABLE t_inbox ADD COLUMN startsTurn INTEGER NOT NULL DEFAULT 1 CHECK (startsTurn IN (0, 1) AND (startsTurn = 1 OR hook IS NOT NULL OR job IS NOT NULL OR api IS NOT NULL));
CREATE INDEX t_inbox_at ON t_inbox (at);

DROP VIEW inbox;
CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId, i.replyTo,
         i.fromName, i.fromId, i.fromWhere, i.fromZone, i.overheard, i.approval, i.api, i.startsTurn,
         i.inboxNo <= w.inboxConsumed AS consumed,
         EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS setAside,
         NOT i.overheard AND NOT EXISTS (SELECT 1 FROM t_set_aside s WHERE s.inboxNo = i.inboxNo) AS asks
    FROM t_inbox i, t_workspace w;
"#,
    ),
];

/// Opens the workspace's database for writing — creating it and its schema the first time —
/// in WAL, with foreign keys and full sync. Refuses a schema this runtime does not know.
pub fn open_state(ws: &Path) -> Result<Connection, String> {
    let path = ws.join(STATE_FILE);
    let failed = |what: &str, e: rusqlite::Error| format!("{what} {} — {e}", path.display());
    let mut conn = Connection::open(&path).map_err(|e| failed("cannot open", e))?;
    conn.busy_timeout(Duration::ZERO)
        .map_err(|e| failed("cannot set a busy timeout on", e))?;
    let mode = switch_journal(&conn, "WAL", BUSY_TIMEOUT)
        .map_err(|e| failed("cannot put in WAL", e))?
        .ok_or_else(|| {
            format!(
                "cannot put {} in WAL — database is locked by another connection past {} ms",
                path.display(),
                BUSY_TIMEOUT.as_millis()
            )
        })?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| failed("cannot set a busy timeout on", e))?;
    if mode != "wal" {
        return Err(format!(
            "{} stays in {mode} journal mode, and a workspace database is written in WAL",
            path.display()
        ));
    }
    conn.execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")
        .map_err(|e| failed("cannot configure", e))?;

    let created = |conn: &Connection| -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT count(*) > 0 FROM sqlite_schema WHERE name = 't_workspace'",
            [],
            |row| row.get(0),
        )
    };
    if !created(&conn).map_err(|e| failed("cannot read the schema of", e))? {
        // Two first writers race here, so the look is taken again under the write lock: the
        // one that waited finds the schema the other made.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| failed("cannot begin creating", e))?;
        if !created(&*tx).map_err(|e| failed("cannot read the schema of", e))? {
            tx.execute_batch(SCHEMA)
                .map_err(|e| failed("cannot create the schema of", e))?;
            tx.execute(
                "INSERT INTO t_workspace (id, schemaVersion, createdAt) VALUES (1, ?1, ?2)",
                (SCHEMA_VERSION, crate::iso_now()),
            )
            .map_err(|e| failed("cannot record the schema of", e))?;
        }
        tx.commit().map_err(|e| failed("cannot create", e))?;
    }

    let version = |conn: &Connection| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT schemaVersion FROM t_workspace WHERE id = 1",
            [],
            |row| row.get(0),
        )
    };
    let found = version(&conn).map_err(|e| failed("cannot read the schema version of", e))?;
    if found > SCHEMA_VERSION {
        return Err(format!(
            "{} has schema {found}, and this runtime reads {SCHEMA_VERSION} — a newer spore made it, and that version reads it",
            path.display()
        ));
    }
    if found < SCHEMA_VERSION {
        // Looked at again under the write lock, as creation is: two writers opening an old
        // workspace at once migrate it once.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| failed("cannot begin migrating", e))?;
        let from = version(&*tx).map_err(|e| failed("cannot read the schema version of", e))?;
        for (at, migration) in MIGRATIONS.iter().filter(|(at, _)| *at >= from) {
            tx.execute_batch(migration)
                .map_err(|e| failed(&format!("cannot migrate from schema {at}"), e))?;
            tx.execute("UPDATE t_workspace SET schemaVersion = ?1", [at + 1])
                .map_err(|e| failed(&format!("cannot migrate from schema {at}"), e))?;
        }
        tx.commit().map_err(|e| failed("cannot migrate", e))?;
    }
    Ok(conn)
}

/// Lets go of a writer. The last one out puts the file back in rollback mode; one that finds
/// another connection still open leaves that to whoever closes last, without waiting for it.
pub fn close_state(conn: Connection) -> Result<(), String> {
    let _ = conn.busy_timeout(Duration::ZERO);
    match conn.query_row("PRAGMA journal_mode = DELETE", [], |row| {
        row.get::<_, String>(0)
    }) {
        Ok(_) => {}
        Err(e) if e.sqlite_error_code() == Some(ErrorCode::DatabaseBusy) => {}
        Err(e) => return Err(format!("cannot leave WAL — {e}")),
    }
    conn.close()
        .map_err(|(_, e)| format!("cannot close the workspace database — {e}"))
}

/// A supervisor's last act on its workspace: the file back in rollback mode, so `state.sqlite`
/// alone holds every committed record. `close_state` gives up when any other connection is
/// open, readers included, and a reader never switches, so a follower reading at the moment
/// the last writer closes would otherwise leave the file in WAL for good. The supervisor waits
/// a moment for readers to let go; a writer still open after that is a new turn's, and the
/// switch is its to make.
pub fn leave_wal(ws: &Path) -> Result<(), String> {
    leave_wal_within(ws, LEAVE_WAL_PATIENCE)
}

fn leave_wal_within(ws: &Path, patience: Duration) -> Result<(), String> {
    let path = ws.join(STATE_FILE);
    if !path.exists() {
        return Ok(());
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("cannot open {} — {e}", path.display()))?;
    conn.busy_timeout(Duration::ZERO)
        .map_err(|e| format!("cannot set a busy timeout on {} — {e}", path.display()))?;
    let left = match switch_journal(&conn, "DELETE", patience) {
        Ok(Some(mode)) if mode == "delete" => Ok(()),
        Ok(Some(mode)) => Err(format!("{} stays in {mode} journal mode", path.display())),
        Ok(None) => Err(format!(
            "{} stays in WAL — another connection held it past {} ms",
            path.display(),
            patience.as_millis()
        )),
        Err(e) => Err(format!("cannot leave WAL on {} — {e}", path.display())),
    };
    conn.close()
        .map_err(|(_, e)| format!("cannot close {} — {e}", path.display()))?;
    left
}

/// A journal-mode switch, retried while another connection holds the file: SQLite runs no busy
/// handler for it, so a writer opening an idle workspace beside another — two senders, or a
/// sender and a runner closing — would otherwise give up at once. `None` once `patience` is
/// spent.
fn switch_journal(
    conn: &Connection,
    mode: &str,
    patience: Duration,
) -> rusqlite::Result<Option<String>> {
    let deadline = Instant::now() + patience;
    loop {
        match conn.query_row(&format!("PRAGMA journal_mode = {mode}"), [], |row| {
            row.get::<_, String>(0)
        }) {
            Ok(now) => return Ok(Some(now)),
            Err(e) if e.sqlite_error_code() == Some(ErrorCode::DatabaseBusy) => {
                if Instant::now() >= deadline {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(e),
        }
    }
}

/// A reader's connection, or none when nothing has been written here yet. Read-only: the
/// runner deciding what is unread writes nothing through it.
pub fn open_reader(path: &Path) -> Result<Option<Connection>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("cannot open {} — {e}", path.display()))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("cannot set a busy timeout on {} — {e}", path.display()))?;
    Ok(Some(conn))
}

/// The workspace's database at this runtime's schema, for a reader: one an older spore made is
/// migrated by opening it as a writer would, and one a newer spore made is refused. Nothing to
/// do when nothing has been written here yet.
pub fn migrate_state(ws: &Path) -> Result<(), String> {
    let path = ws.join(STATE_FILE);
    let Some(reader) = open_reader(&path)? else {
        return Ok(());
    };
    let failed =
        |e: rusqlite::Error| format!("cannot read the schema version of {} — {e}", path.display());
    let created: bool = reader
        .query_row(
            "SELECT count(*) > 0 FROM sqlite_schema WHERE name = 't_workspace'",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let found: Option<i64> = if created {
        reader
            .query_row(
                "SELECT schemaVersion FROM t_workspace WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?
    } else {
        None
    };
    drop(reader);
    if found == Some(SCHEMA_VERSION) {
        return Ok(());
    }
    writing(ws, |_| Ok(()))
}

/// One short writer connection: opened, used, and let go whatever the work came to, the
/// work's own failure first.
fn writing<T>(
    ws: &Path,
    work: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut conn = open_state(ws)?;
    let done = work(&mut conn);
    let closed = close_state(conn);
    let value = done?;
    closed?;
    Ok(value)
}

fn reading<T>(
    ws: &Path,
    empty: T,
    work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let path = ws.join(STATE_FILE);
    match open_reader(&path)? {
        None => Ok(empty),
        Some(conn) => work(&conn).map_err(|e| format!("cannot read {} — {e}", path.display())),
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Integer,
    Flag,
    Json,
}

/// What an inbox entry may say, by column. `inboxNo` is the database's to give.
const INBOX_COLUMNS: [(&str, Kind); 26] = [
    ("at", Kind::Text),
    ("text", Kind::Text),
    ("bodyPath", Kind::Text),
    ("bodyBytes", Kind::Integer),
    ("bodyHead", Kind::Text),
    ("bodyTail", Kind::Text),
    ("files", Kind::Json),
    ("schedule", Kind::Text),
    ("due", Kind::Text),
    ("traceparent", Kind::Text),
    ("requestId", Kind::Text),
    ("hook", Kind::Text),
    ("hookEvent", Kind::Text),
    ("hookDelivery", Kind::Text),
    ("job", Kind::Text),
    ("jobEvent", Kind::Text),
    ("jobRun", Kind::Text),
    ("replyTo", Kind::Text),
    ("fromName", Kind::Text),
    ("fromId", Kind::Text),
    ("fromWhere", Kind::Text),
    ("overheard", Kind::Flag),
    ("approval", Kind::Text),
    ("fromZone", Kind::Text),
    ("api", Kind::Text),
    ("startsTurn", Kind::Flag),
];

/// What a turn record carries into its row. `turnNo` and `inboxFrom` are finalization's to
/// assign, and `ownUsd` and `treeUsd` are the view's reading of the micros.
const TURN_COLUMNS: [(&str, Kind); 32] = [
    ("turnId", Kind::Text),
    ("runId", Kind::Text),
    ("startedAt", Kind::Text),
    ("endedAt", Kind::Text),
    ("stopReason", Kind::Text),
    ("concluded", Kind::Flag),
    ("because", Kind::Text),
    ("output", Kind::Text),
    ("error", Kind::Text),
    ("detail", Kind::Text),
    ("rounds", Kind::Integer),
    ("ownMicros", Kind::Integer),
    ("treeMicros", Kind::Integer),
    ("workUnits", Kind::Integer),
    ("workUnitsOwn", Kind::Integer),
    ("workUnitsChildren", Kind::Integer),
    ("inputTokens", Kind::Integer),
    ("outputTokens", Kind::Integer),
    ("thinkingTokens", Kind::Integer),
    ("cacheWriteTokens", Kind::Integer),
    ("cacheReadTokens", Kind::Integer),
    ("inboxTo", Kind::Integer),
    ("cut", Kind::Integer),
    ("deliverables", Kind::Json),
    ("deliverablesMore", Kind::Integer),
    ("recall", Kind::Json),
    ("traceparent", Kind::Text),
    ("model", Kind::Text),
    ("byPrecursor", Kind::Json),
    ("dataBytes", Kind::Integer),
    ("historySent", Kind::Integer),
    ("historyBound", Kind::Integer),
];

const ASSIGNED: [&str; 2] = ["turnNo", "inboxFrom"];
const DERIVED: [&str; 2] = ["ownUsd", "treeUsd"];

fn bind(name: &str, kind: Kind, raw: &RawValue) -> Result<SqlValue, String> {
    let json = raw.get();
    if json == "null" {
        return Ok(SqlValue::Null);
    }
    let wrong = |what: &str| format!("{name} is {what}, got {json}");
    match kind {
        Kind::Json => Ok(SqlValue::Text(json.to_string())),
        Kind::Text => serde_json::from_str::<String>(json)
            .ok()
            .filter(|text| !text.contains('\0'))
            .map(SqlValue::Text)
            .ok_or_else(|| wrong("text, as well-formed Unicode with no NUL")),
        Kind::Integer => serde_json::from_str::<i64>(json)
            .map(SqlValue::Integer)
            .map_err(|_| wrong("an integer")),
        Kind::Flag => serde_json::from_str::<bool>(json)
            .map(|flag| SqlValue::Integer(flag.into()))
            .map_err(|_| wrong("true or false")),
    }
}

/// The record's fields as columns, refusing one the table does not have rather than
/// dropping it.
fn columns(
    record: &Record,
    table: &[(&'static str, Kind)],
    skipped: &[&str],
) -> Result<Vec<(&'static str, SqlValue)>, String> {
    let mut out = Vec::new();
    for (name, raw) in record.fields() {
        if skipped.contains(&name) {
            continue;
        }
        let Some((column, kind)) = table.iter().find(|(column, _)| *column == name) else {
            return Err(format!("{name} is not a field of this record"));
        };
        out.push((*column, bind(name, *kind, raw)?));
    }
    Ok(out)
}

fn insert(tx: &Connection, table: &str, row: &[(&str, SqlValue)]) -> rusqlite::Result<usize> {
    let names: Vec<&str> = row.iter().map(|(name, _)| *name).collect();
    let marks: Vec<String> = (1..=row.len()).map(|i| format!("?{i}")).collect();
    tx.execute(
        &format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            names.join(", "),
            marks.join(", ")
        ),
        params_from_iter(row.iter().map(|(_, value)| value)),
    )
}

/// Adds one entry to the inbox and answers its `inboxNo` — the position a turn that reads it
/// records in `inboxTo`, so a sender can tell which turn answered its message — and whether it
/// was already there. An entry carrying a `requestId` the inbox already holds is the same
/// message sent again, by a sender retrying after it lost track: nothing is added, and the
/// answer is the first one's position.
pub fn append_inbox(ws: &Path, entry: &str) -> Result<(i64, bool), String> {
    let record =
        Record::parse(entry).map_err(|e| format!("an inbox entry is a JSON object — {e}"))?;
    origin_of(&record)?;
    if let Some(reply_to) = record.get::<String>("replyTo") {
        check_reply_to(&reply_to)?;
    }
    if record.get::<bool>("overheard") == Some(true)
        && (!record.has("fromName") || record.has("replyTo"))
    {
        return Err(
            "an overheard entry says who said it and where, and has no reply-to: it asked nothing"
                .into(),
        );
    }
    let row = columns(&record, &INBOX_COLUMNS, &[])?;
    let request_id = record.get::<String>("requestId");
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        if let Some(key) = &request_id {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT inboxNo FROM t_inbox WHERE requestId = ?1",
                    [key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed_to("look the request up"))?;
            if let Some(inbox_no) = known {
                return Ok((inbox_no, true));
            }
        }
        insert(&tx, "t_inbox", &row).map_err(|e| format!("cannot add to the inbox — {e}"))?;
        let inbox_no = tx.last_insert_rowid();
        tx.commit().map_err(failed_to("add to the inbox"))?;
        Ok((inbox_no, false))
    })
}

/// Where an answer goes: `terminal`, or `<kind>:<place>` — `telegram:main/42`,
/// `discord:ops/1234` — whose kind is lowercase letters, digits and `-`.
pub fn check_reply_to(reply_to: &str) -> Result<(), String> {
    if reply_to == "terminal" {
        return Ok(());
    }
    let valid = reply_to.split_once(':').is_some_and(|(kind, place)| {
        kind.starts_with(|c: char| c.is_ascii_lowercase())
            && kind
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !place.is_empty()
            && !place.chars().any(char::is_whitespace)
    });
    if valid {
        Ok(())
    } else {
        Err(format!(
            "a reply-to is terminal or <kind>:<place>, as telegram:main/42 — got {reply_to:?}"
        ))
    }
}

/// What says an entry when no person does, each kind named by its inbox column.
const ORIGIN_KINDS: [&str; 4] = ["schedule", "hook", "job", "api"];

/// How many deliveries from `origin` (`hook:forge`) the spore at `ws` was handed after `since`
/// that were let start a turn — in its inbox, or still held — what the origin's `perHour` counts.
/// Read through a writer, so a workspace an older spore made is migrated before it is counted.
pub fn starting_since(ws: &Path, origin: &str, since: &str) -> Result<i64, String> {
    let (kind, name) = origin
        .split_once(':')
        .filter(|(kind, name)| ORIGIN_KINDS.contains(kind) && !name.is_empty())
        .ok_or_else(|| {
            format!(
                "\"{origin}\" is no origin — expected {}",
                ORIGIN_KINDS.map(|kind| format!("{kind}:<name>")).join(", ")
            )
        })?;
    writing(ws, |conn| {
        conn.query_row(
            &format!(
                "SELECT (SELECT count(*) FROM t_inbox WHERE {kind} = ?1 AND at > ?2 AND startsTurn = 1)
                      + (SELECT count(*) FROM t_held WHERE origin = ?3 AND at > ?2
                           AND coalesce(json_extract(entry, '$.startsTurn'), 1) = 1)"
            ),
            (name, since, origin),
            |row| row.get(0),
        )
        .map_err(failed_to("count what an origin started"))
    })
}

/// Who said an inbox entry, when no person did: `schedule:<name>`, `hook:<name>`, `job:<name>` or
/// `api:<caller>`, from the field naming it. None for a person's message, which may say who the person is with
/// `fromName`, `fromId` and `fromWhere`, all three, and their clock with `fromZone`. Refused when
/// it names two speakers.
pub fn origin_of(entry: &Record) -> Result<Option<String>, String> {
    let named: Vec<String> = ORIGIN_KINDS
        .iter()
        .filter_map(|kind| {
            entry
                .get::<String>(kind)
                .map(|name| format!("{kind}:{name}"))
        })
        .collect();
    let from = ["fromName", "fromId", "fromWhere"];
    let given = |field: &str| {
        entry
            .get::<Value>(field)
            .is_some_and(|value| !value.is_null())
    };
    if from.iter().any(|field| given(field))
        && !from.iter().all(|field| {
            entry
                .get::<String>(field)
                .is_some_and(|value| !value.is_empty())
        })
    {
        return Err(
            "an entry says who said it with fromName, fromId and fromWhere, all three and none empty"
                .into(),
        );
    }
    if given("fromZone")
        && !(given("fromName")
            && entry
                .get::<String>("fromZone")
                .is_some_and(|zone| !zone.is_empty()))
    {
        return Err("an entry gives fromZone only beside who said it, and not empty".into());
    }
    match named.as_slice() {
        [] => Ok(None),
        [one] if given("fromName") => Err(format!(
            "an entry from a person does not also come from {one}"
        )),
        [one] => Ok(Some(one.clone())),
        _ => Err(format!(
            "an entry says it came from {}, one at most",
            named.join(" and ")
        )),
    }
}

/// A delivery nobody typed — a webhook's or a job's — held until `release_at`, and at the latest
/// `deadline`, past which it reaches even a running turn; kept as the inbox entry it becomes, its
/// files already in `inbox.d/`, under its origin (`hook:forge`, `job:scan`). Answers `{ held }`,
/// its number, or `{ repeated }` when its `requestId` is already held or delivered.
pub fn hold_delivery(
    ws: &Path,
    entry: &str,
    release_at: &str,
    deadline: &str,
) -> Result<Value, String> {
    let record =
        Record::parse(entry).map_err(|e| format!("a held entry is a JSON object — {e}"))?;
    columns(&record, &INBOX_COLUMNS, &[])?;
    let origin = origin_of(&record)?
        .ok_or("a person's message is never held — only one from a schedule, a webhook or a job")?;
    if record.has("replyTo") {
        return Err(
            "a delivery nobody typed has no reply-to: its answer goes to the spore's default"
                .into(),
        );
    }
    let request_id = record.get::<String>("requestId");
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        if let Some(key) = &request_id {
            let known: Option<String> = tx
                .query_row(
                    "SELECT 'inbox' FROM t_inbox WHERE requestId = ?1
                     UNION ALL SELECT 'held' FROM t_held WHERE requestId = ?1",
                    [key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed_to("look the request up"))?;
            if let Some(place) = known {
                return Ok(json!({ "repeated": place }));
            }
        }
        tx.execute(
            "INSERT INTO t_held (at, releaseAt, deadline, origin, requestId, entry) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (crate::iso_now(), release_at, deadline, &origin, &request_id, entry),
        )
        .map_err(failed_to("hold the delivery"))?;
        let held = tx.last_insert_rowid();
        tx.commit().map_err(failed_to("hold the delivery"))?;
        Ok(json!({ "held": held }))
    })
}

/// A held delivery's release moved to `release_at`, never past its deadline — and its deadline
/// with it when `urgent`, so it reaches a running turn too — with a summary for its entry's text.
/// `replaces` drops every other delivery still held from the same origin: only the latest one
/// matters. False when it is no longer held.
pub fn reschedule_held(
    ws: &Path,
    held_no: i64,
    release_at: &str,
    urgent: bool,
    summary: Option<&str>,
    replaces: bool,
) -> Result<bool, String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        if replaces {
            tx.execute(
                "DELETE FROM t_held WHERE heldNo <> ?1 AND origin = (SELECT origin FROM t_held WHERE heldNo = ?1)",
                [held_no],
            )
            .map_err(failed_to("replace what was held"))?;
        }
        let changed = tx
            .execute(
                "UPDATE t_held
                    SET releaseAt = min(?2, deadline),
                        deadline = CASE WHEN ?3 THEN min(?2, deadline) ELSE deadline END,
                        summary = coalesce(?4, summary)
                  WHERE heldNo = ?1",
                (held_no, release_at, urgent, summary),
            )
            .map_err(failed_to("reschedule the delivery"))?;
        tx.commit().map_err(failed_to("reschedule the delivery"))?;
        Ok(changed == 1)
    })
}

/// A held delivery's files replaced by `files`, a JSON array of the entry's file records, already
/// written in `inbox.d/`: what a prepare step attached, or the line saying why nothing was.
/// False when it is no longer held.
pub fn attach_held(ws: &Path, held_no: i64, files: &str) -> Result<bool, String> {
    let files: Vec<Value> =
        serde_json::from_str(files).map_err(|e| format!("files is a JSON array — {e}"))?;
    if !files.iter().all(Value::is_object) {
        return Err("each of files is a file record, a JSON object".into());
    }
    writing(ws, |conn| {
        let changed = conn
            .execute(
                "UPDATE t_held SET entry = json_set(entry, '$.files', json(?2)) WHERE heldNo = ?1",
                (held_no, json!(files).to_string()),
            )
            .map_err(failed_to("attach to the delivery"))?;
        Ok(changed == 1)
    })
}

/// A job begun: `{ name, run, command, wallMs, pid }` as JSON, recorded running — unless `most`
/// are running already, or one by that name is. Answers `{ jobNo }` or `{ refused, running }`.
pub fn begin_job(ws: &Path, job: &str, most: i64) -> Result<Value, String> {
    let job: Value =
        serde_json::from_str(job).map_err(|e| format!("a job is a JSON object — {e}"))?;
    let text = |field: &str| job[field].as_str().map(str::to_string);
    let (Some(name), Some(run), Some(command)) = (text("name"), text("run"), text("command"))
    else {
        return Err("a job names itself, its run and its command".into());
    };
    let wall = job["wallMs"].as_i64().ok_or("a job says its wall")?;
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let running: Vec<String> = {
            let mut statement = tx
                .prepare("SELECT name FROM t_jobs WHERE status = 'running' ORDER BY jobNo")
                .map_err(failed_to("read the running jobs"))?;
            let names = statement
                .query_map([], |row| row.get(0))
                .map_err(failed_to("read the running jobs"))?;
            names
                .collect::<rusqlite::Result<_>>()
                .map_err(failed_to("read the running jobs"))?
        };
        if running.contains(&name) {
            return Ok(json!({ "refused": "named", "running": running }));
        }
        if running.len() as i64 >= most {
            return Ok(json!({ "refused": "full", "running": running }));
        }
        tx.execute(
            "INSERT INTO t_jobs (name, run, command, wallMs, pid, startedAt, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running')",
            (&name, &run, &command, wall, job["pid"].as_i64(), crate::iso_now()),
        )
        .map_err(failed_to("begin the job"))?;
        let job_no = tx.last_insert_rowid();
        tx.commit().map_err(failed_to("begin the job"))?;
        Ok(json!({ "jobNo": job_no }))
    })
}

/// A job's run ended — `ended`, `stopped`, `walled` or `interrupted` — with its exit code or signal.
/// False when that run was not running.
pub fn end_job(
    ws: &Path,
    run: &str,
    status: &str,
    exit: Option<i64>,
    signal: Option<&str>,
) -> Result<bool, String> {
    writing(ws, |conn| {
        let changed = conn
            .execute(
                "UPDATE t_jobs SET status = ?2, exit = ?3, signal = ?4, endedAt = ?5 WHERE run = ?1 AND status = 'running'",
                (run, status, exit, signal, crate::iso_now()),
            )
            .map_err(failed_to("end the job"))?;
        Ok(changed == 1)
    })
}

/// One cell run outside any turn, in the spore whose precursor it ran — who asked for it and what
/// for, where it ran, what it answered or why it did not, and what it cost — as JSON `{ precursor,
/// origin, ref?, cellWs, answer | error, costUsd, durationMs, afterTurn?, dataBytes?, changed? }`,
/// the last three a dream's: the turn it ran after, the bytes in `data/` then, and what it changed.
/// Every such run is recorded, so its spend is the spore's whatever asked for it.
pub fn record_cell(ws: &Path, run: &str) -> Result<i64, String> {
    let run: Value =
        serde_json::from_str(run).map_err(|e| format!("a cell run is a JSON object — {e}"))?;
    let text = |field: &str| run[field].as_str().map(str::to_string);
    let (Some(precursor), Some(origin), Some(cell_ws)) =
        (text("precursor"), text("origin"), text("cellWs"))
    else {
        return Err("a cell run names its precursor, its origin and where it ran".into());
    };
    let (answer, error) = (text("answer"), text("error"));
    if answer.is_some() == error.is_some() {
        return Err("a cell run has an answer or an error, never both".into());
    }
    let cost = (run["costUsd"]
        .as_f64()
        .ok_or("a cell run says what it cost")?
        * 1e6)
        .round() as i64;
    let duration = run["durationMs"]
        .as_i64()
        .ok_or("a cell run says how long it took")?;
    let count = |field: &str| -> Result<Option<i64>, String> {
        match &run[field] {
            Value::Null => Ok(None),
            value => value
                .as_i64()
                .filter(|n| *n >= 0)
                .map(Some)
                .ok_or_else(|| format!("a cell run's {field} is a whole number, got {value}")),
        }
    };
    let (after_turn, data_bytes) = (count("afterTurn")?, count("dataBytes")?);
    let changed = match &run["changed"] {
        Value::Null => None,
        value => Some(value.to_string()),
    };
    writing(ws, |conn| {
        conn.execute(
            "INSERT INTO t_cells (at, precursor, origin, ref, cellWs, answer, error, costMicros, durationMs, afterTurn, dataBytes, changed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            (crate::iso_now(), &precursor, &origin, text("ref"), &cell_ws, &answer, &error, cost, duration, after_turn, data_bytes, changed),
        )
        .map_err(failed_to("record the cell"))?;
        Ok(conn.last_insert_rowid())
    })
}

/// Held deliveries moved into the inbox in the order they were held: those past their deadline,
/// and with `due` those whose release has come too. Answers the inbox numbers they took, so the
/// inbox order is the order of release.
pub fn release_held(ws: &Path, now: &str, due: bool) -> Result<Vec<i64>, String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let rows: Vec<(i64, String, Option<String>)> = {
            let mut statement = tx
                .prepare(
                    "SELECT heldNo, entry, summary FROM t_held
                      WHERE deadline <= ?1 OR (?2 AND releaseAt <= ?1)
                      ORDER BY heldNo",
                )
                .map_err(failed_to("read what is held"))?;
            let found = statement
                .query_map((now, due), |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(failed_to("read what is held"))?;
            found
                .collect::<rusqlite::Result<_>>()
                .map_err(failed_to("read what is held"))?
        };
        let mut released = Vec::new();
        for (held_no, entry, summary) in rows {
            let mut record = Record::parse(&entry)
                .map_err(|e| format!("held delivery {held_no} is not a JSON object — {e}"))?;
            let silent = record
                .get::<String>("text")
                .map_or(true, |text| text.is_empty());
            if let (true, Some(summary)) = (silent, summary.filter(|s| !s.is_empty())) {
                record.set("text", json!(summary));
            }
            let row = columns(&record, &INBOX_COLUMNS, &[])?;
            insert(&tx, "t_inbox", &row)
                .map_err(|e| format!("cannot release a held delivery — {e}"))?;
            released.push(tx.last_insert_rowid());
            tx.execute("DELETE FROM t_held WHERE heldNo = ?1", [held_no])
                .map_err(failed_to("release a held delivery"))?;
        }
        tx.commit().map_err(failed_to("release what is held"))?;
        Ok(released)
    })
}

/// Everything said to `from` up to `upto`, in `to` at the same positions — a fork's inbox. `from`
/// is read through a writer, so one an older spore made is migrated first.
pub fn copy_inbox(from: &Path, to: &Path, upto: i64) -> Result<(), String> {
    if !from.join(STATE_FILE).exists() {
        return Ok(());
    }
    let names: Vec<&str> = std::iter::once("inboxNo")
        .chain(INBOX_COLUMNS.iter().map(|(name, _)| *name))
        .collect();
    let (rows, set_aside): (Vec<Vec<SqlValue>>, Vec<(i64, String)>) = writing(from, |conn| {
        let read = || -> rusqlite::Result<(Vec<Vec<SqlValue>>, Vec<(i64, String)>)> {
            let mut statement = conn.prepare(&format!(
                "SELECT {} FROM t_inbox WHERE inboxNo <= ?1 ORDER BY inboxNo",
                names.join(", ")
            ))?;
            let rows = statement.query_map([upto], |row| {
                (0..names.len())
                    .map(|i| row.get::<_, SqlValue>(i))
                    .collect::<rusqlite::Result<Vec<SqlValue>>>()
            })?;
            let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut marks = conn.prepare(
                "SELECT inboxNo, at FROM t_set_aside WHERE inboxNo <= ?1 ORDER BY inboxNo",
            )?;
            let set_aside = marks
                .query_map([upto], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((rows, set_aside))
        };
        read().map_err(|e| format!("cannot read the inbox of {} — {e}", from.display()))
    })?;
    writing(to, |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("cannot begin copying the inbox — {e}"))?;
        for row in &rows {
            let named: Vec<(&str, SqlValue)> =
                names.iter().copied().zip(row.iter().cloned()).collect();
            insert(&tx, "t_inbox", &named).map_err(|e| format!("cannot copy the inbox — {e}"))?;
        }
        for (inbox_no, at) in &set_aside {
            tx.execute(
                "INSERT INTO t_set_aside (inboxNo, at) VALUES (?1, ?2)",
                (inbox_no, at),
            )
            .map_err(|e| format!("cannot copy the inbox — {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("cannot copy the inbox — {e}"))
    })
}

/// How far the last finished turn read the inbox; nothing read is 0.
pub fn inbox_consumed(ws: &Path) -> Result<i64, String> {
    reading(ws, 0, |conn| {
        conn.query_row("SELECT inboxConsumed FROM t_workspace", [], |row| {
            row.get(0)
        })
    })
}

/// Whether anything has been said past where the last turn stopped reading that a turn answers:
/// what was overheard, or delivered past its origin's `perHour`, starts none.
pub fn unread(ws: &Path) -> Result<bool, String> {
    reading(ws, false, |conn| {
        conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM inbox WHERE NOT consumed AND asks AND startsTurn)",
            [],
            |row| row.get(0),
        )
    })
}

/// The `traceparent` of each message the next turn will answer that carries one, in the order
/// they were said. The turn's trace is the first one's.
pub fn unanswered_traceparents(ws: &Path) -> Result<Vec<String>, String> {
    reading(ws, Vec::new(), |conn| {
        let mut statement = conn.prepare(
            "SELECT traceparent FROM inbox WHERE NOT consumed AND asks AND traceparent IS NOT NULL ORDER BY inboxNo",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect()
    })
}

/// What a channel frame may be, newline included. A transcript entry is the largest thing
/// sent, and a tool result reaching the transcript is bounded by the context it has to fit.
pub const MAX_FRAME: usize = 32 << 20;

const TRANSCRIPT_COLUMNS: [(&str, Kind); 6] = [
    ("at", Kind::Text),
    ("kind", Kind::Text),
    ("role", Kind::Text),
    ("message", Kind::Json),
    ("marks", Kind::Json),
    ("round", Kind::Integer),
];

/// What a host writing a whole transcript may also say: where each entry sits, and which turn
/// said it.
const TRANSCRIPT_HOST_COLUMNS: [(&str, Kind); 2] =
    [("entryNo", Kind::Integer), ("turnId", Kind::Text)];

const EVENT_ENVELOPE: [(&str, Kind); 4] = [
    ("v", Kind::Integer),
    ("at", Kind::Text),
    ("runId", Kind::Text),
    ("event", Kind::Text),
];

const CALL_COLUMNS: [(&str, Kind); 11] = [
    ("runId", Kind::Text),
    ("callNo", Kind::Integer),
    ("round", Kind::Integer),
    ("tool", Kind::Text),
    ("startedAt", Kind::Text),
    ("durationMs", Kind::Integer),
    ("exit", Kind::Integer),
    ("refused", Kind::Flag),
    ("outPath", Kind::Text),
    ("errPath", Kind::Text),
    ("record", Kind::Json),
];

fn failed_to(what: &'static str) -> impl Fn(rusqlite::Error) -> String {
    move |e| format!("cannot {what} — {e}")
}

fn immediate(conn: &mut Connection) -> Result<rusqlite::Transaction<'_>, String> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failed_to("begin a transaction"))
}

/// A turn from the moment its supervisor starts it: a `running` row, under a `turnId` the
/// supervisor mints, that the turn's records refer to. `reply_default` is where its answer goes
/// for what it reads with no reply-to — the spore's default as its owner set it when the turn began.
pub fn begin_turn(
    ws: &Path,
    started_at: &str,
    reply_default: Option<&str>,
) -> Result<String, String> {
    if let Some(reply_to) = reply_default {
        check_reply_to(reply_to)?;
    }
    let turn_id = crate::new_turn_id().map_err(|e| format!("cannot name the turn — {e}"))?;
    writing(ws, |conn| {
        conn.execute(
            "INSERT INTO t_turns (turnId, state, startedAt, replyDefault) VALUES (?1, 'running', ?2, ?3)",
            (&turn_id, started_at, reply_default),
        )
        .map_err(failed_to("begin the turn"))?;
        Ok(())
    })?;
    Ok(turn_id)
}

const DIMENSIONS: [&str; 3] = ["rounds", "cost", "wall"];

/// Where a running turn's limits start, one row per dimension, as `(dimension, soft, hard)`.
/// Every change its owner makes is a later row, so the latest row of a dimension is the limit.
pub fn start_limits(ws: &Path, turn: &str, limits: &[(&str, f64, f64)]) -> Result<(), String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let at = crate::iso_now();
        for (dimension, soft, hard) in limits {
            tx.execute(
                "INSERT INTO t_limits (turnId, at, dimension, soft, hard, why) VALUES (?1, ?2, ?3, ?4, ?5, 'start')",
                (turn, &at, dimension, soft, hard),
            )
            .map_err(failed_to("record the turn's limits"))?;
        }
        tx.commit().map_err(failed_to("record the turn's limits"))
    })
}

/// The latest `(dimension, soft, hard)` of each dimension a turn recorded.
pub fn turn_limits(ws: &Path, turn: &str) -> Result<Vec<(String, f64, f64)>, String> {
    reading(ws, Vec::new(), |conn| {
        let mut statement = conn.prepare(
            "SELECT dimension, soft, hard FROM t_limits l
              WHERE turnId = ?1
                AND limitNo = (SELECT max(limitNo) FROM t_limits WHERE turnId = l.turnId AND dimension = l.dimension)
              ORDER BY dimension",
        )?;
        let rows =
            statement.query_map([turn], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect()
    })
}

/// A change to the running turn's limits, asked for by its owner, as JSON: `{ why: "extend",
/// dimension, by, ceiling }` raises soft and hard together by `by`, never past `ceiling`;
/// `{ why: "wrap", in }` brings the soft wall to `in` milliseconds from now, when that is
/// sooner than it is. Answers the row written, or `{ refused }` naming why nothing was: `idle`
/// when nothing runs, `unrecorded` when the turn kept no such limit, `ungranted` with no
/// ceiling, `ceiling` past it — with the `room` left — and `later` for a wrap that would come
/// after the turn already wraps. Saying it is the caller's.
pub fn change_limits(ws: &Path, request: &str) -> Result<Value, String> {
    let request: Value = serde_json::from_str(request)
        .map_err(|e| format!("a change to a turn's limits is a JSON object — {e}"))?;
    let why = request["why"].as_str().unwrap_or_default().to_string();
    let dimension = match why.as_str() {
        "extend" => request["dimension"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "wrap" => "wall".to_string(),
        other => {
            return Err(format!(
                "a change to a turn's limits is extend or wrap, not \"{other}\""
            ))
        }
    };
    if !DIMENSIONS.contains(&dimension.as_str()) {
        return Err(format!(
            "a turn's limits are {}, not \"{dimension}\"",
            DIMENSIONS.join(", ")
        ));
    }
    let refused = |kind: &str, more: Value| -> Result<Value, String> {
        let mut answer = json!({ "refused": kind, "dimension": dimension });
        if let (Some(answer), Value::Object(more)) = (answer.as_object_mut(), more) {
            answer.extend(more);
        }
        Ok(answer)
    };
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let running: Option<(String, f64)> = tx
            .query_row(
                "SELECT turnId, (julianday('now') - julianday(startedAt)) * 86400000.0
                   FROM t_turns WHERE state = 'running'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(failed_to("look for the running turn"))?;
        let Some((turn, elapsed)) = running else {
            return refused("idle", Value::Null);
        };
        let current: Option<(f64, f64)> = tx
            .query_row(
                "SELECT soft, hard FROM t_limits WHERE turnId = ?1 AND dimension = ?2 ORDER BY limitNo DESC LIMIT 1",
                (&turn, &dimension),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(failed_to("read the turn's limits"))?;
        let Some((soft, hard)) = current else {
            return refused("unrecorded", Value::Null);
        };
        let (new_soft, new_hard) = if why == "extend" {
            let by = request["by"]
                .as_f64()
                .filter(|by| by.is_finite() && *by > 0.0);
            let Some(by) = by else {
                return Err("an extension raises a limit by a positive amount".into());
            };
            let Some(ceiling) = request["ceiling"].as_f64() else {
                return refused("ungranted", Value::Null);
            };
            if hard + by > ceiling {
                return refused(
                    "ceiling",
                    json!({ "ceiling": ceiling, "hard": hard, "room": (ceiling - hard).max(0.0) }),
                );
            }
            (soft + by, hard + by)
        } else {
            let wait = request["in"]
                .as_f64()
                .filter(|w| w.is_finite() && *w >= 0.0);
            let Some(wait) = wait else {
                return Err("a wrap comes now or after a positive wait".into());
            };
            let at = elapsed + wait;
            if at >= soft {
                return refused("later", json!({ "soft": soft }));
            }
            (at, hard)
        };
        tx.execute(
            "INSERT INTO t_limits (turnId, at, dimension, soft, hard, why) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&turn, crate::iso_now(), &dimension, new_soft, new_hard, &why),
        )
        .map_err(failed_to("change the turn's limits"))?;
        tx.commit().map_err(failed_to("change the turn's limits"))?;
        Ok(json!({
            "turnId": turn,
            "dimension": dimension,
            "why": why,
            "soft": new_soft,
            "hard": new_hard,
            "was": { "soft": soft, "hard": hard }
        }))
    })
}

/// The line an embedder adds to what the running turn shows, or `None` to take it away: an
/// `annotation` event on that turn, written in the transaction that finds it running, so it
/// never lands after its `turn_end`. Answers `{ seq }`, or `{ refused: "idle" }`.
pub fn annotate(ws: &Path, text: Option<&str>) -> Result<Value, String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let Some(turn) = tx
            .query_row(
                "SELECT turnId FROM t_turns WHERE state = 'running'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(failed_to("look for the running turn"))?
        else {
            return Ok(json!({ "refused": "idle" }));
        };
        let run: Option<String> = tx
            .query_row(
                "SELECT runId FROM t_events WHERE turnId = ?1 AND runId IS NOT NULL ORDER BY seq LIMIT 1",
                [&turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed_to("look for the turn's run"))?;
        let mut event = json!({ "v": EVENT_SCHEMA, "at": crate::iso_now(), "event": "annotation", "text": text });
        if let Some(run) = run {
            event["runId"] = json!(run);
        }
        let seq = append_event(&tx, Some(&turn), &Record::from_value(&event))?;
        tx.commit().map_err(failed_to("annotate the turn"))?;
        Ok(json!({ "seq": seq }))
    })
}

/// `running` until the agent says how it ended, `pending` once it has, `final` once the
/// supervisor has finalized it; none when there is no such turn.
pub fn turn_state(ws: &Path, turn_id: &str) -> Result<Option<String>, String> {
    reading(ws, None, |conn| {
        conn.query_row(
            "SELECT state FROM t_turns WHERE turnId = ?1",
            [turn_id],
            |row| row.get(0),
        )
        .optional()
    })
}

/// One request, answered. `turn` is the turn the channel belongs to — none for a host writing
/// fixtures, which then may not say how a turn ended. Each request is one transaction, so an
/// answer that says it is written means it is.
pub fn handle(conn: &mut Connection, turn: Option<&str>, frame: &str) -> String {
    let request = match Record::parse(frame) {
        Ok(request) => request,
        Err(e) => {
            return json!({ "id": null, "error": format!("a frame is one JSON object — {e}") })
                .to_string()
        }
    };
    let id = request
        .fields()
        .find(|(name, _)| *name == "id")
        .map(|(_, raw)| raw.get().to_string())
        .unwrap_or_else(|| "null".into());
    let result = match request.get::<String>("op") {
        None => Err("a frame names its op".to_string()),
        Some(op) => immediate(conn).and_then(|tx| {
            let answered = answer(&tx, turn, &op, &request)?;
            tx.commit().map_err(failed_to("commit"))?;
            Ok(answered)
        }),
    };
    let body = match result {
        Ok(Value::Object(mut fields)) => {
            fields.insert("ok".into(), Value::Bool(true));
            Value::Object(fields)
        }
        Ok(other) => json!({ "ok": true, "result": other }),
        Err(error) => json!({ "error": error }),
    };
    let mut text = body.to_string();
    text.insert_str(1, &format!("\"id\":{id},"));
    text
}

fn raw_list(request: &Record, name: &str) -> Result<Vec<Record>, String> {
    let raw = request
        .fields()
        .find(|(field, _)| *field == name)
        .map(|(_, raw)| raw)
        .ok_or_else(|| format!("the request carries no {name}"))?;
    let items: Vec<Box<RawValue>> =
        serde_json::from_str(raw.get()).map_err(|_| format!("{name} is a list"))?;
    items
        .iter()
        .map(|item| Record::parse(item.get()).map_err(|_| format!("each of {name} is an object")))
        .collect()
}

fn raw_one(request: &Record, name: &str) -> Result<Record, String> {
    let raw = request
        .fields()
        .find(|(field, _)| *field == name)
        .map(|(_, raw)| raw)
        .ok_or_else(|| format!("the request carries no {name}"))?;
    Record::parse(raw.get()).map_err(|_| format!("{name} is an object"))
}

fn with_turn(row: &mut Vec<(&'static str, SqlValue)>, turn: Option<&str>) {
    if let Some(turn) = turn {
        row.push(("turnId", SqlValue::Text(turn.into())));
    }
}

fn answer(
    tx: &Connection,
    turn: Option<&str>,
    op: &str,
    request: &Record,
) -> Result<Value, String> {
    match op {
        "transcript.append" => {
            let mut entries = Vec::new();
            for entry in raw_list(request, "entries")? {
                let mut row = columns(&entry, &TRANSCRIPT_COLUMNS, &[])?;
                with_turn(&mut row, turn);
                insert(tx, "t_transcript", &row).map_err(failed_to("append to the transcript"))?;
                entries.push(tx.last_insert_rowid());
            }
            Ok(json!({ "entryNos": entries }))
        }
        "events.append" => {
            let mut seqs = Vec::new();
            for event in raw_list(request, "events")? {
                seqs.push(append_event(tx, turn, &event)?);
            }
            Ok(json!({ "seqs": seqs }))
        }
        "call.record" => {
            let call = raw_one(request, "call")?;
            let mut row = columns(&call, &CALL_COLUMNS, &[])?;
            with_turn(&mut row, turn);
            let names: Vec<&str> = row.iter().map(|(name, _)| *name).collect();
            let marks: Vec<String> = (1..=row.len()).map(|i| format!("?{i}")).collect();
            let updates: Vec<String> = names
                .iter()
                .filter(|name| !["runId", "callNo"].contains(*name))
                .map(|name| format!("{name} = excluded.{name}"))
                .collect();
            tx.execute(
                &format!(
                    "INSERT INTO t_calls ({}) VALUES ({}) ON CONFLICT (runId, callNo) DO UPDATE SET {}",
                    names.join(", "),
                    marks.join(", "),
                    updates.join(", ")
                ),
                params_from_iter(row.iter().map(|(_, value)| value)),
            )
            .map_err(failed_to("record the call"))?;
            Ok(json!({}))
        }
        "turn.outcome" => {
            let turn = turn.ok_or("only a turn's own channel says how it ended")?;
            outcome(tx, turn, &raw_one(request, "turn")?)?;
            Ok(json!({}))
        }
        other => Err(format!("{other} is not an operation")),
    }
}

/// An event numbered after the last one the workspace ever had, which is what a follower
/// resumes on: `lastSeq` survives pruning, so no number is handed out twice. A host fixture may
/// name its own `seq`, past the last.
fn append_event(tx: &Connection, turn: Option<&str>, event: &Record) -> Result<i64, String> {
    let last: i64 = tx
        .query_row("SELECT lastSeq FROM t_workspace", [], |row| row.get(0))
        .map_err(failed_to("number the event"))?;
    if event.has("seq") {
        return Err("an event is numbered by the store, never by its writer".into());
    }
    let seq = last + 1;
    let mut row: Vec<(&'static str, SqlValue)> = Vec::new();
    // Kept as the JSON text each field was written as, so a string no Rust string can hold
    // survives.
    let mut payload: std::collections::BTreeMap<&str, &RawValue> =
        std::collections::BTreeMap::new();
    for (name, raw) in event.fields() {
        match EVENT_ENVELOPE.iter().find(|(column, _)| *column == name) {
            Some((column, kind)) => row.push((*column, bind(name, *kind, raw)?)),
            None => {
                payload.insert(name, raw);
            }
        }
    }
    with_turn(&mut row, turn);
    row.push(("seq", SqlValue::Integer(seq)));
    row.push((
        "payload",
        SqlValue::Text(serde_json::to_string(&payload).expect("raw values serialize as written")),
    ));
    insert(tx, "t_events", &row).map_err(failed_to("append the event"))?;
    tx.execute("UPDATE t_workspace SET lastSeq = ?1", [seq])
        .map_err(failed_to("number the event"))?;
    Ok(seq)
}

/// How the turn ended as its agent saw it — or as its supervisor did, when the agent could not
/// say. The turn goes `pending`; nothing is settled here.
fn outcome(tx: &Connection, turn: &str, record: &Record) -> Result<(), String> {
    let skipped: Vec<&str> = ASSIGNED.iter().chain(DERIVED.iter()).copied().collect();
    let row = columns(record, &TURN_COLUMNS, &skipped)?;
    if row.iter().any(|(name, _)| *name == TURN_ID) {
        return Err(format!("{TURN_ID} is the channel's, not the record's"));
    }
    let sets: Vec<String> = row
        .iter()
        .enumerate()
        .map(|(i, (name, _))| format!("{name} = ?{}", i + 1))
        .chain(std::iter::once("state = 'pending'".to_string()))
        .collect();
    let changed = tx
        .execute(
            &format!(
                "UPDATE t_turns SET {} WHERE turnId = ?{} AND state IN ('running', 'pending')",
                sets.join(", "),
                row.len() + 1
            ),
            params_from_iter(
                row.iter()
                    .map(|(_, value)| value.clone())
                    .chain(std::iter::once(SqlValue::Text(turn.into()))),
            ),
        )
        .map_err(failed_to("record how the turn ended"))?;
    if changed == 0 {
        return Err(format!("no turn {turn} is running"));
    }
    Ok(())
}

/// How a turn ended when its agent could not say: the supervisor's own account, on its own
/// connection.
pub fn write_outcome(ws: &Path, turn: &str, record: &Record) -> Result<(), String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        outcome(&tx, turn, record)?;
        tx.commit().map_err(failed_to("record how the turn ended"))
    })
}

/// The channel a turn's agent writes its records through, served until the agent closes its
/// end. One writer connection for the turn; each request is one transaction.
pub fn serve(
    ws: &Path,
    turn: String,
    stream: UnixStream,
) -> std::thread::JoinHandle<Result<(), String>> {
    let ws = ws.to_path_buf();
    std::thread::spawn(move || {
        let mut conn = open_state(&ws)?;
        let served = serve_on(&mut conn, &turn, stream);
        close_state(conn)?;
        served
    })
}

fn serve_on(conn: &mut Connection, turn: &str, stream: UnixStream) -> Result<(), String> {
    let mut writer = stream
        .try_clone()
        .map_err(|e| format!("cannot answer on the channel — {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut frame = Vec::new();
    loop {
        frame.clear();
        let read = (&mut reader)
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut frame)
            .map_err(|e| format!("cannot read the channel — {e}"))?;
        if read == 0 {
            return Ok(());
        }
        let answer = if frame.last() != Some(&b'\n') {
            if read > MAX_FRAME {
                let answer =
                    json!({ "id": null, "error": format!("a frame is at most {MAX_FRAME} bytes") })
                        .to_string();
                let _ = writer.write_all(format!("{answer}\n").as_bytes());
                return Err(format!("a frame past {MAX_FRAME} bytes"));
            }
            return Ok(());
        } else {
            match std::str::from_utf8(&frame[..frame.len() - 1]) {
                Ok(text) => {
                    let answer = handle(conn, Some(turn), text);
                    // The acknowledgement lost after the commit: the turn's outcome is written,
                    // and the agent is told nothing.
                    if crate::crash_asked("outcome-unanswered")
                        && Record::parse(text).ok().and_then(|r| r.get::<String>("op"))
                            == Some("turn.outcome".into())
                    {
                        let _ = writer.shutdown(std::net::Shutdown::Both);
                        return Ok(());
                    }
                    answer
                }
                Err(_) => json!({ "id": null, "error": "a frame is UTF-8" }).to_string(),
            }
        };
        writer
            .write_all(format!("{answer}\n").as_bytes())
            .map_err(|e| format!("cannot answer on the channel — {e}"))?;
    }
}

/// The channel ended once its agent is gone. Shut from the supervisor's side too, so a
/// descendant that still holds the agent's end cannot keep it open past the turn.
pub fn end_channel(
    watcher: UnixStream,
    serving: std::thread::JoinHandle<Result<(), String>>,
) -> Result<(), String> {
    let _ = watcher.shutdown(std::net::Shutdown::Both);
    serving
        .join()
        .map_err(|_| "the turn's channel stopped abnormally".to_string())?
}

/// One request from the host side, on a connection of its own.
pub fn request(ws: &Path, turn: Option<&str>, frame: &str) -> Result<String, String> {
    writing(ws, |conn| Ok(handle(conn, turn, frame)))
}

/// The turn made final, in one transaction: settled from `settled` when the calls went through
/// a ledger its supervisor kept, given the next `turnNo` and the messages it answered as
/// `(inboxFrom, inboxTo]` — `inboxTo` absent means it read nothing — and added to the
/// workspace's totals. A turn already final is left as it is, which is what makes finalizing
/// again after a crash safe. Answers the turn as the `turns` view has it.
pub fn finalize_turn(ws: &Path, turn: &str, settled: Option<&Settled>) -> Result<Value, String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        finalize_row(&tx, turn, settled, true)?;
        let row = turn_row(&tx, turn)?;
        tx.commit().map_err(failed_to("finalize the turn"))?;
        Ok(row)
    })
}

fn finalize_row(
    tx: &Connection,
    turn: &str,
    settled: Option<&Settled>,
    announce: bool,
) -> Result<(), String> {
    let failed = failed_to("finalize the turn");
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM t_turns WHERE turnId = ?1",
            [turn],
            |row| row.get(0),
        )
        .optional()
        .map_err(&failed)?;
    match state.as_deref() {
        None => return Err(format!("no turn {turn}")),
        Some("final") => return Ok(()),
        Some("running") => return Err(format!("turn {turn} has not said how it ended")),
        _ => {}
    }
    if let Some(settled) = settled {
        tx.execute(
            "UPDATE t_turns SET treeMicros = ?2,
                    ownMicros = CASE WHEN ownMicros IS NULL THEN NULL ELSE ?3 END,
                    workUnits = CASE WHEN workUnits IS NULL THEN NULL ELSE ?4 END,
                    workUnitsOwn = CASE WHEN workUnits IS NULL THEN NULL ELSE ?5 END,
                    workUnitsChildren = CASE WHEN workUnits IS NULL THEN NULL ELSE ?6 END,
                    cut = CASE WHEN ?7 > 0 THEN ?7 ELSE cut END,
                    byPrecursor = ?8
              WHERE turnId = ?1",
            (
                turn,
                crate::micros(settled.tree),
                crate::micros(settled.own),
                crate::work_units(settled.own_rounds, settled.child_rounds) as i64,
                settled.own_rounds as i64,
                settled.child_rounds as i64,
                settled.cut as i64,
                (!settled.by_precursor.is_empty()).then(|| {
                    json!(settled
                        .by_precursor
                        .iter()
                        .map(|(name, (spend, rounds))| (
                            name.clone(),
                            json!({ "micros": crate::micros(*spend), "rounds": rounds })
                        ))
                        .collect::<serde_json::Map<String, Value>>())
                    .to_string()
                }),
            ),
        )
        .map_err(&failed)?;
    }
    let (last, consumed): (i64, i64) = tx
        .query_row(
            "SELECT lastTurnNo, inboxConsumed FROM t_workspace",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(&failed)?;
    let (inbox_to, tree, units): (Option<i64>, Option<i64>, Option<i64>) = tx
        .query_row(
            "SELECT inboxTo, treeMicros, workUnits FROM t_turns WHERE turnId = ?1",
            [turn],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(&failed)?;
    let inbox_to = inbox_to.unwrap_or(consumed);
    if inbox_to < consumed {
        return Err(format!(
            "the turn read the inbox to {inbox_to}, behind the {consumed} already read"
        ));
    }
    let turn_no = last + 1;
    tx.execute(
        "UPDATE t_turns SET state = 'final', turnNo = ?2, inboxFrom = ?3, inboxTo = ?4, settled = ?5
          WHERE turnId = ?1",
        (turn, turn_no, consumed, inbox_to, settled.is_some()),
    )
    .map_err(&failed)?;
    tx.execute(
        "UPDATE t_workspace SET lastTurnNo = ?1, inboxConsumed = ?2,
                treeMicros = treeMicros + ?3, workUnits = workUnits + ?4",
        (turn_no, inbox_to, tree.unwrap_or(0), units.unwrap_or(0)),
    )
    .map_err(&failed)?;
    if announce {
        address(tx, turn, consumed, inbox_to)?;
        turn_end(tx, turn)?;
    }
    Ok(())
}

/// The turn's answer, addressed: one outbox entry per place the messages it read in
/// `(from, to]` asked from, and its default for those that asked from none — unless it ended
/// `quiet`, which chose to say nothing to anyone who did not ask. What was overheard asked
/// nothing, and is owed nothing. `terminal` is delivered as it is written: the terminal that
/// asked follows the turn itself.
fn address(tx: &Connection, turn: &str, from: i64, to: i64) -> Result<(), String> {
    let failed = failed_to("address the turn's answer");
    let (stop_reason, reply_default): (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT stopReason, replyDefault FROM t_turns WHERE turnId = ?1",
            [turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(&failed)?;
    let read: Vec<(i64, Option<String>)> = {
        let mut statement = tx
            .prepare(
                "SELECT inboxNo, replyTo FROM inbox WHERE inboxNo > ?1 AND inboxNo <= ?2 AND asks ORDER BY inboxNo",
            )
            .map_err(&failed)?;
        let rows = statement
            .query_map([from, to], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(&failed)?;
        rows.collect::<rusqlite::Result<_>>().map_err(&failed)?
    };
    let quiet = stop_reason.as_deref() == Some("quiet");
    let mut places: std::collections::BTreeMap<String, Vec<i64>> =
        std::collections::BTreeMap::new();
    for (inbox_no, reply_to) in read {
        let place = match (reply_to, &reply_default) {
            (Some(reply_to), _) => reply_to,
            (None, Some(default)) if !quiet => default.clone(),
            (None, _) => continue,
        };
        places.entry(place).or_default().push(inbox_no);
    }
    let at = crate::iso_now();
    for (recipient, answers) in places {
        let delivered = recipient == "terminal";
        tx.execute(
            "INSERT INTO t_outbox (at, turnId, recipient, answers, state, settledAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                &at,
                turn,
                &recipient,
                json!(answers).to_string(),
                if delivered { "delivered" } else { "pending" },
                delivered.then_some(&at),
            ),
        )
        .map_err(&failed)?;
    }
    Ok(())
}

/// The outbox entries whose recipient is of `kind` (`discord` for `discord:…`), or all of them,
/// in `state` or any, oldest first — each with the `inboxNo`s it answers as a list and its turn's
/// `turnNo`. Read through a writer, so a workspace an older spore made is migrated before it is
/// read.
pub fn outbox(ws: &Path, kind: Option<&str>, state: Option<&str>) -> Result<Value, String> {
    writing(ws, |conn| {
        let failed = failed_to("read the outbox");
        let mut statement = conn
            .prepare(
                "SELECT o.outboxNo, o.at, o.turnId, o.recipient, o.answers, o.state, o.settledAt,
                        o.reason, t.turnNo, o.attemptedAt
                   FROM outbox o JOIN turns t ON t.turnId = o.turnId
                  WHERE (?1 IS NULL OR substr(o.recipient, 1, length(?1) + 1) = ?1 || ':')
                    AND (?2 IS NULL OR o.state = ?2)
                  ORDER BY o.outboxNo",
            )
            .map_err(&failed)?;
        let rows = statement
            .query_map((kind, state), |row| {
                let answers: String = row.get(4)?;
                let answers: Value = serde_json::from_str(&answers).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(json!({
                    "outboxNo": row.get::<_, i64>(0)?,
                    "at": row.get::<_, String>(1)?,
                    "turnId": row.get::<_, String>(2)?,
                    "recipient": row.get::<_, String>(3)?,
                    "answers": answers,
                    "state": row.get::<_, String>(5)?,
                    "settledAt": row.get::<_, Option<String>>(6)?,
                    "reason": row.get::<_, Option<String>>(7)?,
                    "turnNo": row.get::<_, i64>(8)?,
                    "attemptedAt": row.get::<_, Option<String>>(9)?
                }))
            })
            .map_err(&failed)?;
        let entries = rows
            .collect::<rusqlite::Result<Vec<Value>>>()
            .map_err(&failed)?;
        Ok(Value::Array(entries))
    })
}

/// A pending outbox entry marked as about to be posted, so that whoever delivers it again knows a
/// post may have reached its place already. The first time only — false when it was marked before,
/// is not pending, or was never written.
pub fn attempt_outbox(ws: &Path, outbox_no: i64) -> Result<bool, String> {
    writing(ws, |conn| {
        let changed = conn
            .execute(
                "UPDATE t_outbox SET attemptedAt = ?2
                  WHERE outboxNo = ?1 AND state = 'pending' AND attemptedAt IS NULL",
                (outbox_no, crate::iso_now()),
            )
            .map_err(failed_to("mark the outbox entry attempted"))?;
        Ok(changed == 1)
    })
}

/// What `reply_to` said up to `upto` and no turn has read, set aside: no turn reads it,
/// starts for it or answers it. None while a runner holds the workspace — what its turn has read is
/// known only once it ends — and the check is made inside the write, so a runner that takes the
/// lock meanwhile begins its turn after the mark and skips what it marks.
pub fn set_aside(ws: &Path, reply_to: &str, upto: i64) -> Result<Option<Vec<i64>>, String> {
    writing(ws, |conn| {
        let failed = failed_to("set aside the inbox entries");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(&failed)?;
        if crate::lock_holder(ws)
            .map_err(|e| format!("cannot tell whether a turn is running — {e}"))?
            .is_some()
        {
            return Ok(None);
        }
        let marked: Vec<i64> = {
            let mut statement = tx
                .prepare(
                    "SELECT i.inboxNo FROM t_inbox i, t_workspace w
                      WHERE i.replyTo = ?1 AND i.inboxNo <= ?2 AND i.inboxNo > w.inboxConsumed
                        AND i.inboxNo NOT IN (SELECT inboxNo FROM t_set_aside)
                      ORDER BY i.inboxNo",
                )
                .map_err(&failed)?;
            let rows = statement
                .query_map((reply_to, upto), |row| row.get(0))
                .map_err(&failed)?;
            rows.collect::<rusqlite::Result<_>>().map_err(&failed)?
        };
        let at = crate::iso_now();
        for inbox_no in &marked {
            tx.execute(
                "INSERT INTO t_set_aside (inboxNo, at) VALUES (?1, ?2)",
                (inbox_no, &at),
            )
            .map_err(&failed)?;
        }
        tx.commit().map_err(&failed)?;
        Ok(Some(marked))
    })
}

/// A pending outbox entry settled: delivered, or refused for `refused`. Once — false when it is
/// not pending, settled already or never written.
pub fn settle_outbox(ws: &Path, outbox_no: i64, refused: Option<&str>) -> Result<bool, String> {
    writing(ws, |conn| {
        let changed = conn
            .execute(
                "UPDATE t_outbox SET state = ?2, settledAt = ?3, reason = ?4
                  WHERE outboxNo = ?1 AND state = 'pending'",
                (
                    outbox_no,
                    if refused.is_some() {
                        "refused"
                    } else {
                        "delivered"
                    },
                    crate::iso_now(),
                    refused,
                ),
            )
            .map_err(failed_to("settle the outbox entry"))?;
        Ok(changed == 1)
    })
}

/// What an approval asks, as columns. The library checks the request and computes `until`.
const APPROVAL_COLUMNS: [(&str, Kind); 11] = [
    ("id", Kind::Text),
    ("at", Kind::Text),
    ("place", Kind::Text),
    ("approvers", Kind::Json),
    ("options", Kind::Json),
    ("body", Kind::Json),
    ("within", Kind::Text),
    ("calendar", Kind::Json),
    ("until", Kind::Text),
    ("hook", Kind::Text),
    ("fields", Kind::Json),
];

/// An approval asked of the people it names, in the conversation `place` names — never a
/// terminal, which has no button to press. Answers its `approvalNo`.
pub fn ask_approval(ws: &Path, request: &str) -> Result<i64, String> {
    let record =
        Record::parse(request).map_err(|e| format!("an approval is a JSON object — {e}"))?;
    let place = record
        .get::<String>("place")
        .ok_or("an approval names the place it is asked in")?;
    check_reply_to(&place)?;
    if place == "terminal" {
        return Err("an approval is asked in a conversation, and a terminal is none".into());
    }
    let mut row = columns(&record, &APPROVAL_COLUMNS, &[])?;
    row.push(("state", SqlValue::Text("asked".into())));
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        insert(&tx, "t_approvals", &row).map_err(|e| format!("cannot ask the approval — {e}"))?;
        let approval_no = tx.last_insert_rowid();
        tx.commit().map_err(failed_to("ask the approval"))?;
        Ok(approval_no)
    })
}

fn update_approval(
    ws: &Path,
    what: &'static str,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<bool, String> {
    writing(ws, |conn| {
        let changed = conn.execute(sql, params).map_err(failed_to(what))?;
        Ok(changed == 1)
    })
}

/// An asked approval posted: `shown`, the payload the platform was given with its buttons, and
/// `note`, the platform's id for it. False when it is no longer asked.
pub fn post_approval(ws: &Path, id: &str, shown: &str, note: Option<&str>) -> Result<bool, String> {
    serde_json::from_str::<Value>(shown).map_err(|e| format!("what was shown is JSON — {e}"))?;
    update_approval(
        ws,
        "post the approval",
        "UPDATE t_approvals SET state = 'posted', shown = ?2, note = ?3, postedAt = ?4
          WHERE id = ?1 AND state = 'asked'",
        (id, shown, note, crate::iso_now()),
    )
}

/// The first press on a posted approval before its deadline, by someone the relay checked it
/// names, with what the person filled in. False when it is no longer posted or its time is up:
/// a second press, or a late one, changes nothing.
pub fn answer_approval(
    ws: &Path,
    id: &str,
    choice: &str,
    inputs: Option<&str>,
    answerer_id: &str,
    answerer_name: &str,
) -> Result<bool, String> {
    if let Some(inputs) = inputs {
        serde_json::from_str::<Value>(inputs)
            .map_err(|e| format!("what was filled in is JSON — {e}"))?;
    }
    let now = crate::iso_now();
    update_approval(
        ws,
        "answer the approval",
        "UPDATE t_approvals SET state = 'answered', choice = ?2, inputs = ?3, answererId = ?4,
                answererName = ?5, answeredAt = ?6
          WHERE id = ?1 AND state = 'posted' AND until > ?6",
        (id, choice, inputs, answerer_id, answerer_name, now),
    )
}

/// A posted approval whose deadline has passed, expired. False when it is not posted, or not due.
pub fn expire_approval(ws: &Path, id: &str) -> Result<bool, String> {
    update_approval(
        ws,
        "expire the approval",
        "UPDATE t_approvals SET state = 'expired' WHERE id = ?1 AND state = 'posted' AND until <= ?2",
        (id, crate::iso_now()),
    )
}

/// An asked approval that will not be posted, refused for `reason`. False when it is no longer
/// asked.
pub fn refuse_approval(ws: &Path, id: &str, reason: &str) -> Result<bool, String> {
    update_approval(
        ws,
        "refuse the approval",
        "UPDATE t_approvals SET state = 'refused', reason = ?2 WHERE id = ?1 AND state = 'asked'",
        (id, reason),
    )
}

/// An answered, expired or refused approval seen through to its end: the hook's word on an
/// answer — `confirmed`, or `failed` for `reason` — `replaced`, the payload the question was
/// replaced with, and `tell`, what the hook said the spore should know. Once: false when it was
/// settled already or has not ended.
pub fn settle_approval(
    ws: &Path,
    id: &str,
    outcome: Option<&str>,
    reason: Option<&str>,
    replaced: Option<&str>,
    tell: Option<&str>,
) -> Result<bool, String> {
    if let Some(replaced) = replaced {
        serde_json::from_str::<Value>(replaced)
            .map_err(|e| format!("what replaced the question is JSON — {e}"))?;
    }
    update_approval(
        ws,
        "settle the approval",
        "UPDATE t_approvals SET settledAt = ?2, outcome = ?3, reason = coalesce(?4, reason), replaced = ?5, tell = ?6
          WHERE id = ?1 AND settledAt IS NULL AND state IN ('answered', 'expired', 'refused')",
        (id, crate::iso_now(), outcome, reason, replaced, tell),
    )
}

/// `turn_end`: the turn as it was made final, in the same transaction, so a follower never sees
/// one without the other. Where `complete` is the agent's account the moment its loop ends — the
/// answer, but its own spend only and a stop reason the record may yet revise — this is the
/// record: settled, numbered, and the last word on how the turn ended.
fn turn_end(tx: &Connection, turn: &str) -> Result<(), String> {
    let failed = failed_to("announce the turn's end");
    let (run_id, payload): (Option<String>, Value) = tx
        .query_row(
            "SELECT runId, turnNo, stopReason, concluded, error, rounds, ownMicros, treeMicros,
                    workUnits, settled, inboxFrom, inboxTo
               FROM t_turns WHERE turnId = ?1",
            [turn],
            |row| {
                let usd = |i| {
                    row.get::<_, Option<i64>>(i)
                        .map(|m| m.map(|m| m as f64 / 1e6))
                };
                Ok((
                    row.get(0)?,
                    json!({
                        "turnNo": row.get::<_, i64>(1)?,
                        "stopReason": row.get::<_, Option<String>>(2)?,
                        "concluded": row.get::<_, Option<bool>>(3)?,
                        "error": row.get::<_, Option<String>>(4)?,
                        "rounds": row.get::<_, Option<i64>>(5)?,
                        "ownUsd": usd(6)?,
                        "treeUsd": usd(7)?,
                        "workUnits": row.get::<_, Option<i64>>(8)?,
                        "settled": row.get::<_, Option<bool>>(9)?,
                        "inboxFrom": row.get::<_, i64>(10)?,
                        "inboxTo": row.get::<_, i64>(11)?
                    }),
                ))
            },
        )
        .map_err(&failed)?;
    let last: i64 = tx
        .query_row("SELECT lastSeq FROM t_workspace", [], |row| row.get(0))
        .map_err(&failed)?;
    tx.execute(
        "INSERT INTO t_events (seq, v, at, runId, turnId, event, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, 'turn_end', ?6)",
        (
            last + 1,
            EVENT_SCHEMA,
            crate::iso_now(),
            run_id,
            turn,
            payload.to_string(),
        ),
    )
    .map_err(&failed)?;
    tx.execute("UPDATE t_workspace SET lastSeq = ?1", [last + 1])
        .map_err(&failed)?;
    Ok(())
}

/// A turn's row as the `turns` view shows it — or, before it is final, as the table holds it.
fn turn_row(tx: &Connection, turn: &str) -> Result<Value, String> {
    let mut statement = tx
        .prepare(
            "SELECT t.*, t.ownMicros / 1e6 AS ownUsd, t.treeMicros / 1e6 AS treeUsd
               FROM t_turns t WHERE turnId = ?1",
        )
        .map_err(failed_to("read the turn"))?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect();
    statement
        .query_row([turn], |row| {
            let mut fields = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get::<_, SqlValue>(i)? {
                    SqlValue::Null => Value::Null,
                    SqlValue::Integer(n) => json!(n),
                    SqlValue::Real(x) => json!(x),
                    SqlValue::Text(text) => Value::String(text),
                    SqlValue::Blob(_) => Value::Null,
                };
                fields.insert(name.clone(), value);
            }
            Ok(Value::Object(fields))
        })
        .map_err(failed_to("read the turn"))
}

/// Every turn a supervisor that died left behind, made final: one that said how it ended as it
/// said it, unsettled — what its calls came to died with that supervisor's ledger — and one
/// that never said, as a turn that ended in error.
pub fn recover(ws: &Path) -> Result<(), String> {
    if !ws.join(STATE_FILE).exists() {
        return Ok(());
    }
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        let left: Vec<(String, String)> = {
            let mut statement = tx
                .prepare("SELECT turnId, state FROM t_turns WHERE state <> 'final' ORDER BY startedAt, rowid")
                .map_err(failed_to("read the turns left behind"))?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(failed_to("read the turns left behind"))?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(failed_to("read the turns left behind"))?
        };
        for (turn, state) in &left {
            if state == "running" {
                outcome(
                    &tx,
                    turn,
                    &crate::unanswered(&crate::Unanswered {
                        started_at: "",
                        stop_reason: "error",
                        error: "SUPERVISOR_DIED",
                        detail: "its supervisor ended before the turn was written down",
                        tree: 0.0,
                    })
                    .without("startedAt"),
                )?;
            }
            finalize_row(&tx, turn, None, true)?;
        }
        tx.commit()
            .map_err(failed_to("finalize the turns left behind"))
    })
}

/// A finished turn written down whole — the runner's record of a turn its agent never started,
/// and a host's fixtures: inserted `pending` and finalized in the same transaction. A turn
/// already final under this `turnId` is left as it is. The record comes back with what was
/// assigned.
pub fn finalize(ws: &Path, record: &mut Record) -> Result<(), String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        finalize_in(&tx, record, true)?;
        tx.commit().map_err(failed_to("finalize the turn"))
    })
}

/// A workspace's turns, replaced by `records` in order, each finalized as the runner would but
/// with no `turn_end` — host side, for a fork and for fixtures. A record without a `turnId` is
/// given one.
pub fn replace_turns(ws: &Path, records: &mut [Record]) -> Result<(), String> {
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        tx.execute_batch(
            "DELETE FROM t_limits;
             DELETE FROM t_turns;
             UPDATE t_workspace SET lastTurnNo = 0, inboxConsumed = 0, treeMicros = 0, workUnits = 0;",
        )
        .map_err(failed_to("clear the turns"))?;
        for record in records.iter_mut() {
            if !record.has(TURN_ID) {
                record.set(
                    TURN_ID,
                    json!(crate::new_turn_id().map_err(|e| e.to_string())?),
                );
            }
            // A history copied in is not turns ending now, so it announces none.
            finalize_in(&tx, record, false)?;
        }
        tx.commit().map_err(failed_to("replace the turns"))
    })
}

/// A workspace's transcript, replaced by `entries` in order — host side, for a fork's cut and
/// for fixtures. An entry keeps its `entryNo` when it names one, since memory points at it.
pub fn replace_transcript(ws: &Path, entries: &[Record]) -> Result<(), String> {
    let allowed: Vec<(&'static str, Kind)> = TRANSCRIPT_COLUMNS
        .iter()
        .chain(TRANSCRIPT_HOST_COLUMNS.iter())
        .copied()
        .collect();
    writing(ws, |conn| {
        let tx = immediate(conn)?;
        tx.execute("DELETE FROM t_transcript", [])
            .map_err(failed_to("clear the transcript"))?;
        for entry in entries {
            let row = columns(entry, &allowed, &[])?;
            insert(&tx, "t_transcript", &row).map_err(failed_to("write the transcript"))?;
        }
        tx.commit().map_err(failed_to("replace the transcript"))
    })
}

fn finalize_in(tx: &Connection, record: &mut Record, announce: bool) -> Result<(), String> {
    let failed = failed_to("finalize the turn");
    let turn_id: String = record
        .get(TURN_ID)
        .ok_or_else(|| format!("a turn is finalized under its {TURN_ID}"))?;
    let final_already: bool = tx
        .query_row(
            "SELECT count(*) > 0 FROM t_turns WHERE turnId = ?1 AND state = 'final'",
            [&turn_id],
            |row| row.get(0),
        )
        .map_err(&failed)?;
    if !final_already {
        let (last, consumed): (i64, i64) = tx
            .query_row(
                "SELECT lastTurnNo, inboxConsumed FROM t_workspace",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(&failed)?;
        for (name, assigned) in [("turnNo", last + 1), ("inboxFrom", consumed)] {
            if let Some(carried) = record.get::<i64>(name) {
                if carried != assigned {
                    return Err(format!(
                        "the turn carries {name} {carried}, and this workspace's next is {assigned}"
                    ));
                }
            }
        }
        let skipped: Vec<&str> = ASSIGNED
            .iter()
            .chain(DERIVED.iter())
            .chain(std::iter::once(&"settled"))
            .copied()
            .collect();
        let mut row = columns(record, &TURN_COLUMNS, &skipped)?;
        row.push(("state", SqlValue::Text("pending".into())));
        insert(tx, "t_turns", &row).map_err(&failed)?;
        finalize_row(tx, &turn_id, None, announce)?;
        // A turn copied from another workspace keeps what its own supervisor did with it.
        if let Some(settled) = record.get::<bool>("settled") {
            tx.execute(
                "UPDATE t_turns SET settled = ?2 WHERE turnId = ?1",
                (&turn_id, settled),
            )
            .map_err(&failed)?;
        }
    }
    let (turn_no, from, to): (i64, i64, i64) = tx
        .query_row(
            "SELECT turnNo, inboxFrom, inboxTo FROM t_turns WHERE turnId = ?1",
            [&turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(&failed)?;
    record.set("turnNo", json!(turn_no));
    record.set("inboxFrom", json!(from));
    record.set("inboxTo", json!(to));
    Ok(())
}

/// Keeps the newest `keep` runs of the call trail, this one included, and returns the ids
/// dropped: their calls, their streams under `calls/`, and the events about them — an event
/// about a dropped run is one nobody can follow up. `seq` keeps climbing, so a consumer resuming
/// on one it no longer has is told by its absence. A run is as new as its latest call; a
/// directory with no call written down is older than any. Runs rather than calls, because a
/// call's streams live in its directory and one of them can be a hundred megabytes.
pub fn prune_trail(ws: &Path, keep: u32) -> Result<Vec<String>, String> {
    let recorded: Vec<String> = reading(ws, Vec::new(), |conn| {
        let mut statement =
            conn.prepare("SELECT runId FROM t_calls GROUP BY runId ORDER BY max(rowid) DESC")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect()
    })?;
    let root = ws.join(crate::CALLS_DIR);
    let mut unrecorded: Vec<String> = match std::fs::read_dir(&root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !recorded.contains(name))
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot list {} — {e}", root.display())),
    };
    unrecorded.sort();
    let dropped: Vec<String> = recorded
        .into_iter()
        .chain(unrecorded)
        .skip(keep.saturating_sub(1) as usize)
        .collect();
    if dropped.is_empty() {
        return Ok(dropped);
    }
    for id in &dropped {
        let path = root.join(id);
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match removed {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {} — {e}", path.display())),
        }
    }
    if ws.join(STATE_FILE).exists() {
        writing(ws, |conn| {
            let tx = immediate(conn)?;
            for id in &dropped {
                tx.execute("DELETE FROM t_calls WHERE runId = ?1", [id])
                    .map_err(failed_to("drop the run's calls"))?;
                tx.execute("DELETE FROM t_events WHERE runId = ?1", [id])
                    .map_err(failed_to("drop the run's events"))?;
                tx.execute(
                    "DELETE FROM t_events WHERE runId IS NULL AND turnId IN (SELECT turnId FROM t_turns WHERE runId = ?1)",
                    [id],
                )
                .map_err(failed_to("drop the run's events"))?;
            }
            tx.commit().map_err(failed_to("prune the trail"))
        })?;
    }
    Ok(dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spore-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(conn: &Connection, kind: &str) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = ?1 AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        statement
            .query_map([kind], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn creates_the_schema_once_and_opens_it_again() {
        let ws = scratch("create");
        let conn = open_state(&ws).unwrap();
        assert_eq!(
            names(&conn, "view"),
            [
                "approvals",
                "calls",
                "cells",
                "events",
                "held",
                "inbox",
                "jobs",
                "limits",
                "outbox",
                "transcript",
                "turns"
            ]
        );
        assert_eq!(
            names(&conn, "table"),
            [
                "t_approvals",
                "t_calls",
                "t_cells",
                "t_events",
                "t_held",
                "t_inbox",
                "t_jobs",
                "t_limits",
                "t_outbox",
                "t_set_aside",
                "t_transcript",
                "t_turns",
                "t_workspace"
            ]
        );
        close_state(conn).unwrap();
        let again = open_state(&ws).unwrap();
        let rows: i64 = again
            .query_row("SELECT count(*) FROM t_workspace", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        close_state(again).unwrap();
    }

    #[test]
    fn refuses_a_schema_it_does_not_know() {
        let ws = scratch("newer");
        let conn = open_state(&ws).unwrap();
        conn.execute("UPDATE t_workspace SET schemaVersion = 99", [])
            .unwrap();
        close_state(conn).unwrap();
        assert!(open_state(&ws).unwrap_err().contains("has schema 99"));
        assert!(migrate_state(&ws).unwrap_err().contains("has schema 99"));
    }

    #[test]
    fn brings_an_older_workspace_to_this_schema_for_a_reader_and_leaves_none_made() {
        let none = scratch("migrate-none");
        migrate_state(&none).unwrap();
        assert!(!none.join(STATE_FILE).exists());

        let old = scratch("migrate-old");
        let conn = Connection::open(old.join(STATE_FILE)).unwrap();
        conn.execute_batch(include_str!("../tests/fixtures/schema-1.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO t_workspace (id, schemaVersion, createdAt) VALUES (1, 1, 'a')",
            [],
        )
        .unwrap();
        conn.close().unwrap();
        migrate_state(&old).unwrap();
        let reader = open_reader(&old.join(STATE_FILE)).unwrap().unwrap();
        let version: i64 = reader
            .query_row("SELECT schemaVersion FROM t_workspace", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        migrate_state(&old).unwrap();
    }

    #[test]
    fn shows_only_final_turns_and_their_dollars_to_the_micro() {
        let ws = scratch("turns");
        let conn = open_state(&ws).unwrap();
        conn.execute_batch(
            "INSERT INTO t_turns (turnId, turnNo, state, startedAt, ownMicros, treeMicros)
               VALUES ('t1', 1, 'final', 'a', 123, 9877);
             INSERT INTO t_turns (turnId, state, startedAt) VALUES ('t2', 'running', 'b');",
        )
        .unwrap();
        let (count, own, tree): (i64, f64, f64) = conn
            .query_row(
                "SELECT count(*), max(ownUsd), max(treeUsd) FROM turns",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(own, 0.000123);
        assert_eq!(tree, 0.009877);
        close_state(conn).unwrap();
    }

    #[test]
    fn says_which_inbox_entries_are_consumed() {
        let ws = scratch("inbox");
        let conn = open_state(&ws).unwrap();
        conn.execute_batch(
            "INSERT INTO t_inbox (at, text) VALUES ('a', 'one'), ('b', 'two');
             UPDATE t_workspace SET inboxConsumed = 1;",
        )
        .unwrap();
        let consumed: Vec<i64> = conn
            .prepare("SELECT consumed FROM inbox ORDER BY inboxNo")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(consumed, [1, 0]);
        close_state(conn).unwrap();
    }

    #[test]
    fn keeps_its_records_consistent() {
        let ws = scratch("constraints");
        let conn = open_state(&ws).unwrap();
        conn.execute(
            "INSERT INTO t_inbox (at, text, schedule, due) VALUES ('a', 'x', 'daily', 'd1')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO t_inbox (at, text, schedule, due) VALUES ('b', 'x', 'daily', 'd1')",
                []
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO t_calls (runId, callNo, turnId, tool, startedAt, record) VALUES ('r', 1, 'nobody', 'exec', 'a', '{}')",
                []
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO t_turns (turnId, state, startedAt) VALUES ('t', 'final', 'a')",
                []
            )
            .is_err());
        close_state(conn).unwrap();
    }

    #[test]
    fn the_last_writer_out_leaves_a_plain_file() {
        let ws = scratch("journal");
        let first = open_state(&ws).unwrap();
        let second = open_state(&ws).unwrap();
        close_state(first).unwrap();
        assert!(ws.join("state.sqlite-wal").exists());
        close_state(second).unwrap();
        assert!(!ws.join("state.sqlite-wal").exists());
        assert!(!ws.join("state.sqlite-shm").exists());
        let plain = Connection::open(ws.join(STATE_FILE)).unwrap();
        let mode: String = plain
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
    }

    fn mode_of(ws: &Path) -> String {
        Connection::open_with_flags(ws.join(STATE_FILE), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap()
    }

    fn left_in_wal(name: &str) -> PathBuf {
        let ws = scratch(name);
        let writer = open_state(&ws).unwrap();
        let reader = open_reader(&ws.join(STATE_FILE)).unwrap().unwrap();
        let _: i64 = reader
            .query_row("SELECT count(*) FROM t_inbox", [], |row| row.get(0))
            .unwrap();
        close_state(writer).unwrap();
        drop(reader);
        assert_eq!(mode_of(&ws), "wal");
        ws
    }

    #[test]
    fn a_writer_closing_beside_a_reader_leaves_wal_for_the_supervisor_to_end() {
        let ws = left_in_wal("wal-left");
        leave_wal(&ws).unwrap();
        assert_eq!(mode_of(&ws), "delete");
        assert!(!ws.join("state.sqlite-wal").exists());
    }

    #[test]
    fn waits_for_a_reader_to_let_go() {
        let ws = left_in_wal("wal-wait");
        let reader = open_reader(&ws.join(STATE_FILE)).unwrap().unwrap();
        let held = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(reader);
        });
        leave_wal_within(&ws, Duration::from_millis(1500)).unwrap();
        held.join().unwrap();
        assert_eq!(mode_of(&ws), "delete");
    }

    #[test]
    fn says_so_when_a_connection_outlasts_its_patience() {
        let ws = left_in_wal("wal-held");
        let writer = open_state(&ws).unwrap();
        let refused = leave_wal_within(&ws, Duration::from_millis(100)).unwrap_err();
        assert!(refused.contains("stays in WAL"), "{refused}");
        close_state(writer).unwrap();
        assert_eq!(mode_of(&ws), "delete");
    }

    #[test]
    fn a_writer_opening_an_idle_workspace_waits_for_another_to_let_go() {
        let ws = scratch("wal-enter");
        close_state(open_state(&ws).unwrap()).unwrap();
        assert_eq!(mode_of(&ws), "delete");
        let other = Connection::open(ws.join(STATE_FILE)).unwrap();
        other.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let held = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            other.execute_batch("COMMIT").unwrap();
        });
        let started = Instant::now();
        let conn = open_state(&ws).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
        held.join().unwrap();
        close_state(conn).unwrap();
    }

    #[test]
    fn leaves_a_workspace_with_no_database_alone() {
        let ws = scratch("wal-none");
        leave_wal(&ws).unwrap();
        assert!(!ws.join(STATE_FILE).exists());
    }

    #[test]
    fn answers_each_sender_the_position_of_its_entry() {
        let ws = scratch("senders");
        let senders: Vec<_> = (0..8)
            .map(|i| {
                let ws = ws.clone();
                std::thread::spawn(move || {
                    let entry = format!(r#"{{"at":"t","text":"message {i}"}}"#);
                    (i, append_inbox(&ws, &entry).unwrap().0)
                })
            })
            .collect();
        let answered: Vec<(usize, i64)> = senders.into_iter().map(|s| s.join().unwrap()).collect();
        let conn = open_reader(&ws.join(STATE_FILE)).unwrap().unwrap();
        for (i, at) in answered {
            let text: String = conn
                .query_row("SELECT text FROM inbox WHERE inboxNo = ?1", [at], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(text, format!("message {i}"));
        }
        assert!(!ws.join("state.sqlite-wal").exists());
    }

    #[test]
    fn refuses_an_entry_that_says_nothing_or_names_a_field_it_does_not_have() {
        let ws = scratch("inbox-refused");
        assert!(append_inbox(&ws, r#"{"at":"t"}"#).is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":""}"#).is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","offset":3}"#).is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","schedule":"daily"}"#).is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","fromName":"Alice"}"#).is_err());
        assert!(append_inbox(
            &ws,
            r#"{"at":"t","text":"x","fromName":"","fromId":"telegram:1","fromWhere":"a chat"}"#
        )
        .is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","hook":"forge","hookDelivery":"d","fromName":"Alice","fromId":"telegram:1","fromWhere":"a chat"}"#).is_err());
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","fromZone":"Asia/Dubai"}"#).is_err());
        assert!(append_inbox(
            &ws,
            r#"{"at":"t","text":"x","fromName":"Alice","fromId":"teams:1","fromWhere":"a chat","fromZone":""}"#
        )
        .is_err());
        assert_eq!(
            append_inbox(&ws, r#"{"at":"t","files":[{"path":"a"}]}"#)
                .unwrap()
                .0,
            1
        );
    }

    #[test]
    fn reads_an_entry_nobody_named_as_one_no_person_said() {
        let read_back = Record::from_value(&json!({
            "text": "x", "schedule": null, "hook": null, "job": null,
            "fromName": null, "fromId": null, "fromWhere": null
        }));
        assert_eq!(origin_of(&read_back), Ok(None));
        let clock = Record::from_value(&json!({
            "text": "x", "schedule": "daily", "fromName": null, "fromId": null, "fromWhere": null
        }));
        assert_eq!(origin_of(&clock), Ok(Some("schedule:daily".into())));
    }

    #[test]
    fn keeps_who_said_an_entry_beside_what_they_said() {
        let ws = scratch("inbox-from");
        append_inbox(
            &ws,
            r#"{"at":"t","text":"hello","fromName":"Alice","fromId":"telegram:1","fromWhere":"a private chat on Telegram"}"#,
        )
        .unwrap();
        assert_eq!(
            row(
                &ws,
                "SELECT text, fromName, fromId, fromWhere, fromZone FROM inbox"
            ),
            json!({ "text": "hello", "fromName": "Alice", "fromId": "telegram:1", "fromWhere": "a private chat on Telegram", "fromZone": null })
        );
        append_inbox(
            &ws,
            r#"{"at":"t","text":"later","fromName":"Alice","fromId":"teams:1","fromWhere":"a personal chat in Teams","fromZone":"Asia/Dubai"}"#,
        )
        .unwrap();
        assert_eq!(
            row(&ws, "SELECT fromZone FROM inbox WHERE text = 'later'"),
            json!({ "fromZone": "Asia/Dubai" })
        );
    }

    #[test]
    fn reads_the_traceparents_of_what_the_next_turn_answers() {
        let ws = scratch("traceparents");
        assert!(unanswered_traceparents(&ws).unwrap().is_empty());
        assert!(!unread(&ws).unwrap());
        for entry in [
            r#"{"at":"t1","text":"answered","traceparent":"00-11111111111111111111111111111111-1111111111111111-01"}"#,
            r#"{"at":"t2","text":"untraced"}"#,
            r#"{"at":"t3","text":"traced","traceparent":"00-33333333333333333333333333333333-3333333333333333-01"}"#,
        ] {
            append_inbox(&ws, entry).unwrap();
        }
        replace_turns(
            &ws,
            &mut [Record::from_value(
                &json!({ "startedAt": "t", "inboxTo": 1 }),
            )],
        )
        .unwrap();
        assert_eq!(
            row(&ws, "SELECT count(*) AS n FROM events")["n"],
            0,
            "a history written in is not turns ending now"
        );
        assert_eq!(inbox_consumed(&ws).unwrap(), 1);
        assert!(unread(&ws).unwrap());
        assert_eq!(
            unanswered_traceparents(&ws).unwrap(),
            vec!["00-33333333333333333333333333333333-3333333333333333-01".to_string()]
        );
    }

    #[test]
    fn changes_the_running_turns_limits_within_its_grant_and_refuses_the_rest() {
        let ws = scratch("limits");
        let extend = |dimension: &str, by: f64, ceiling: Option<f64>| {
            change_limits(
                &ws,
                &json!({ "why": "extend", "dimension": dimension, "by": by, "ceiling": ceiling })
                    .to_string(),
            )
            .unwrap()
        };
        assert_eq!(extend("wall", 60_000.0, Some(600_000.0))["refused"], "idle");

        let turn = begin_turn(&ws, &crate::iso_now(), None).unwrap();
        assert_eq!(
            extend("wall", 60_000.0, Some(600_000.0))["refused"],
            "unrecorded"
        );
        start_limits(
            &ws,
            &turn,
            &[
                ("rounds", 40.0, 45.0),
                ("cost", 0.5, 0.75),
                ("wall", 1_200_000.0, 1_500_000.0),
            ],
        )
        .unwrap();

        let raised = extend("wall", 600_000.0, Some(3_600_000.0));
        assert_eq!(
            (raised["soft"].as_f64(), raised["hard"].as_f64()),
            (Some(1_800_000.0), Some(2_100_000.0))
        );
        let over = extend("wall", 3_600_000.0, Some(3_600_000.0));
        assert_eq!(
            (over["refused"].as_str(), over["room"].as_f64()),
            (Some("ceiling"), Some(1_500_000.0))
        );
        assert_eq!(extend("cost", 1.0, None)["refused"], "ungranted");

        let wrapped = change_limits(&ws, &json!({ "why": "wrap", "in": 0 }).to_string()).unwrap();
        assert_eq!(wrapped["hard"].as_f64(), Some(2_100_000.0));
        assert!(wrapped["soft"].as_f64().unwrap() < 60_000.0);
        assert_eq!(
            change_limits(&ws, &json!({ "why": "wrap", "in": 3_600_000 }).to_string()).unwrap()
                ["refused"],
            "later"
        );

        let now: Vec<(String, f64, f64)> = turn_limits(&ws, &turn).unwrap();
        assert_eq!(now.len(), 3);
        assert_eq!(now[0], ("cost".to_string(), 0.5, 0.75));
        assert_eq!(now[2].2, 2_100_000.0);
        assert!(change_limits(&ws, r#"{"why":"raise"}"#)
            .unwrap_err()
            .contains("extend or wrap"));
    }

    #[test]
    fn annotates_only_the_running_turn_under_its_run() {
        let ws = scratch("annotate");
        assert_eq!(
            annotate(&ws, Some("usually 2 min")).unwrap()["refused"],
            "idle"
        );

        let turn = begin_turn(&ws, &crate::iso_now(), None).unwrap();
        assert_eq!(annotate(&ws, Some("usually 2 min")).unwrap()["seq"], 1);
        ask(
            &ws,
            Some(&turn),
            json!({ "id": 1, "op": "events.append", "events": [{ "v": 1, "at": "a", "runId": "r", "event": "round", "index": 0 }] }),
        );
        assert_eq!(annotate(&ws, None).unwrap()["seq"], 3);
        assert_eq!(
            row(
                &ws,
                "SELECT group_concat(coalesce(runId, '-'), ' ' ORDER BY seq) AS runs, group_concat(coalesce(json_extract(payload, '$.text'), '-'), ' | ' ORDER BY seq) AS texts, count(DISTINCT turnId) AS turns
                   FROM events WHERE event = 'annotation'"
            ),
            json!({ "runs": "- r", "texts": "usually 2 min | -", "turns": 1 })
        );
    }

    #[test]
    fn holds_a_delivery_and_releases_it_into_the_inbox_in_order() {
        let ws = scratch("held");
        let entry = |delivery: &str| {
            json!({ "at": "t", "hook": "forge", "hookDelivery": delivery, "requestId": format!("webhook:forge:{delivery}"),
                    "files": [{ "path": "inbox.d/x/payload.json", "name": "payload.json", "mime": "application/json", "bytes": 2 }] })
                .to_string()
        };
        let first = hold_delivery(
            &ws,
            &entry("a"),
            "2026-10-03T12:30:00.000Z",
            "2026-10-03T14:00:00.000Z",
        )
        .unwrap();
        let second = hold_delivery(
            &ws,
            &entry("b"),
            "2026-10-03T12:10:00.000Z",
            "2026-10-03T13:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            hold_delivery(&ws, &entry("a"), "x", "y").unwrap()["repeated"],
            "held"
        );
        assert!(
            hold_delivery(&ws, r#"{"at":"t","text":"no hook"}"#, "x", "y")
                .unwrap_err()
                .contains("a person's message is never held")
        );

        assert!(release_held(&ws, "2026-10-03T12:00:00.000Z", true)
            .unwrap()
            .is_empty());
        let a = first["held"].as_i64().unwrap();
        assert!(reschedule_held(
            &ws,
            a,
            "2026-10-03T12:05:00.000Z",
            false,
            Some("forge push to main"),
            false
        )
        .unwrap());
        assert_eq!(
            release_held(&ws, "2026-10-03T12:06:00.000Z", false).unwrap(),
            Vec::<i64>::new()
        );
        assert_eq!(
            release_held(&ws, "2026-10-03T12:06:00.000Z", true).unwrap(),
            vec![1]
        );
        assert_eq!(
            row(&ws, "SELECT text, hook FROM inbox WHERE inboxNo = 1")["text"],
            "forge push to main"
        );

        let b = second["held"].as_i64().unwrap();
        assert!(reschedule_held(&ws, b, "2026-10-03T12:07:00.000Z", true, None, false).unwrap());
        assert_eq!(
            release_held(&ws, "2026-10-03T12:08:00.000Z", false).unwrap(),
            vec![2]
        );
        assert!(!reschedule_held(&ws, b, "z", false, None, false).unwrap());
        assert_eq!(
            hold_delivery(&ws, &entry("b"), "x", "y").unwrap()["repeated"],
            "inbox"
        );
    }

    #[test]
    fn replaces_a_held_deliverys_files_while_it_is_held() {
        let ws = scratch("attach");
        let held = hold_delivery(
            &ws,
            &json!({ "at": "t", "hook": "scans", "hookDelivery": "d1",
                     "files": [{ "path": null, "name": "pages' output", "missing": "the router did not finish" }] })
            .to_string(),
            "2026-10-03T12:01:00.000Z",
            "2026-10-03T12:01:00.000Z",
        )
        .unwrap()["held"]
            .as_i64()
            .unwrap();
        let files = json!([{ "path": "inbox.d/x/pages.json", "name": "pages.json", "mime": "application/json", "bytes": 9 }]);
        assert!(attach_held(&ws, held, &files.to_string()).unwrap());
        assert!(attach_held(&ws, held, "{}")
            .unwrap_err()
            .contains("JSON array"));
        assert!(attach_held(&ws, held, "[1]")
            .unwrap_err()
            .contains("file record"));
        assert_eq!(
            release_held(&ws, "2026-10-03T12:01:00.000Z", false).unwrap(),
            vec![1]
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                row(&ws, "SELECT files FROM inbox WHERE inboxNo = 1")["files"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            files
        );
        assert!(!attach_held(&ws, held, "[]").unwrap());
    }

    #[test]
    fn names_who_said_an_entry_when_no_person_did() {
        let of = |entry: serde_json::Value| origin_of(&Record::from_value(&entry));
        assert_eq!(of(json!({ "text": "hi" })).unwrap(), None);
        assert_eq!(
            of(json!({ "schedule": "daily", "due": "x" }))
                .unwrap()
                .as_deref(),
            Some("schedule:daily")
        );
        assert_eq!(
            of(json!({ "hook": "forge" })).unwrap().as_deref(),
            Some("hook:forge")
        );
        assert_eq!(
            of(json!({ "job": "scan" })).unwrap().as_deref(),
            Some("job:scan")
        );
        assert!(of(json!({ "hook": "forge", "job": "scan" }))
            .unwrap_err()
            .contains("one at most"));
        assert_eq!(
            of(json!({ "api": "pipeline" })).unwrap().as_deref(),
            Some("api:pipeline")
        );
        assert!(of(json!({ "api": "pipeline", "hook": "forge" }))
            .unwrap_err()
            .contains("one at most"));
        assert!(of(
            json!({ "api": "pipeline", "fromName": "A", "fromId": "x:1", "fromWhere": "w" })
        )
        .unwrap_err()
        .contains("does not also come from api:pipeline"));
    }

    #[test]
    fn holds_and_keeps_a_delivery_from_a_caller_of_the_api() {
        let ws = scratch("api-origin");
        let held = hold_delivery(
            &ws,
            &json!({ "at": "t", "text": "analyse it", "api": "pipeline", "requestId": "api:pipeline:report-1" })
                .to_string(),
            "2026-10-03T12:00:00.000Z",
            "2026-10-03T12:00:00.000Z",
        )
        .unwrap();
        assert!(held["held"].as_i64().is_some());
        assert_eq!(
            row(&ws, "SELECT origin FROM held")["origin"],
            "api:pipeline"
        );
        assert_eq!(
            release_held(&ws, "2026-10-03T12:00:00.000Z", true).unwrap(),
            vec![1]
        );
        assert_eq!(
            row(&ws, "SELECT api, text, requestId FROM inbox"),
            json!({ "api": "pipeline", "text": "analyse it", "requestId": "api:pipeline:report-1" })
        );
        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","api":""}"#).is_err());
        assert!(append_inbox(
            &ws,
            r#"{"at":"t","text":"x","api":"pipeline","replyTo":"terminal"}"#
        )
        .is_err());
    }

    #[test]
    fn counts_the_deliveries_of_an_origin_let_start_a_turn() {
        let ws = scratch("starting-since");
        let hook = |at: &str, delivery: &str, starts: Option<bool>| {
            let mut entry =
                json!({ "at": at, "text": "pushed", "hook": "forge", "hookDelivery": delivery });
            if let Some(starts) = starts {
                entry["startsTurn"] = json!(starts);
            }
            entry.to_string()
        };
        append_inbox(&ws, &hook("2026-10-03T10:00:00.000Z", "old", None)).unwrap();
        append_inbox(&ws, &hook("2026-10-03T12:00:00.000Z", "d1", None)).unwrap();
        append_inbox(&ws, &hook("2026-10-03T12:01:00.000Z", "d2", Some(false))).unwrap();
        append_inbox(
            &ws,
            r#"{"at":"2026-10-03T12:02:00.000Z","text":"pushed","hook":"other","hookDelivery":"d3"}"#,
        )
        .unwrap();
        hold_delivery(
            &ws,
            &hook("2026-10-03T12:03:00.000Z", "d4", None),
            "2026-10-03T13:00:00.000Z",
            "2026-10-03T13:00:00.000Z",
        )
        .unwrap();
        hold_delivery(
            &ws,
            &hook("2026-10-03T12:04:00.000Z", "d5", Some(false)),
            "2026-10-03T13:00:00.000Z",
            "2026-10-03T13:00:00.000Z",
        )
        .unwrap();
        let since = "2026-10-03T11:00:00.000Z";
        assert_eq!(starting_since(&ws, "hook:forge", since), Ok(2));
        assert_eq!(starting_since(&ws, "hook:other", since), Ok(1));
        assert_eq!(starting_since(&ws, "job:forge", since), Ok(0));
        assert!(starting_since(&ws, "forge", since)
            .unwrap_err()
            .contains("is no origin"));

        assert_eq!(
            release_held(&ws, "2026-10-03T13:00:00.000Z", true).unwrap(),
            vec![5, 6]
        );
        assert_eq!(
            row(
                &ws,
                "SELECT startsTurn FROM inbox WHERE hookDelivery = 'd5'"
            )["startsTurn"],
            0
        );
        assert_eq!(starting_since(&ws, "hook:forge", since), Ok(2));

        assert!(append_inbox(&ws, r#"{"at":"t","text":"x","startsTurn":false}"#).is_err());
        assert!(append_inbox(
            &ws,
            r#"{"at":"t","text":"x","schedule":"daily","due":"t","startsTurn":false}"#
        )
        .is_err());

        let quiet = scratch("starts-none");
        append_inbox(&quiet, &hook("2026-10-03T12:00:00.000Z", "d1", Some(false))).unwrap();
        assert_eq!(unread(&quiet), Ok(false));
        append_inbox(&quiet, &hook("2026-10-03T12:01:00.000Z", "d2", None)).unwrap();
        assert_eq!(unread(&quiet), Ok(true));
    }

    #[test]
    fn holds_a_jobs_delivery_and_keeps_only_the_latest_of_an_origin_that_replaces() {
        let ws = scratch("replaces");
        let said = |text: &str, request: &str| {
            json!({ "at": "t", "text": text, "job": "scan", "jobEvent": "said", "jobRun": "r1", "requestId": request }).to_string()
        };
        let first = hold_delivery(
            &ws,
            &said("page 100", "job:r1:1"),
            "2026-10-03T13:00:00.000Z",
            "2026-10-03T14:00:00.000Z",
        )
        .unwrap();
        let second = hold_delivery(
            &ws,
            &said("page 200", "job:r1:2"),
            "2026-10-03T13:00:00.000Z",
            "2026-10-03T14:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            row(&ws, "SELECT origin FROM held WHERE heldNo = 1")["origin"],
            "job:scan"
        );
        let (a, b) = (
            first["held"].as_i64().unwrap(),
            second["held"].as_i64().unwrap(),
        );
        assert!(reschedule_held(&ws, b, "2026-10-03T13:00:00.000Z", false, None, true).unwrap());
        assert!(!reschedule_held(&ws, a, "z", false, None, false).unwrap());
        assert_eq!(
            release_held(&ws, "2026-10-03T13:30:00.000Z", true).unwrap(),
            vec![1]
        );
        assert_eq!(
            row(&ws, "SELECT text, job, jobEvent FROM inbox")["text"],
            "page 200"
        );
    }

    #[test]
    fn begins_a_job_within_its_count_and_ends_it_once() {
        let ws = scratch("jobs");
        let job = |name: &str, run: &str| {
            json!({ "name": name, "run": run, "command": "node data/bin/scan.js", "wallMs": 3_600_000, "pid": 42 }).to_string()
        };
        assert!(begin_job(&ws, &job("scan", "r1"), 2).unwrap()["jobNo"]
            .as_i64()
            .is_some());
        assert_eq!(
            begin_job(&ws, &job("scan", "r2"), 2).unwrap()["refused"],
            "named"
        );
        begin_job(&ws, &job("fetch", "r3"), 2).unwrap();
        assert_eq!(
            begin_job(&ws, &job("build", "r4"), 2).unwrap()["refused"],
            "full"
        );
        assert!(end_job(&ws, "r1", "ended", Some(0), None).unwrap());
        assert!(!end_job(&ws, "r1", "stopped", None, Some("SIGTERM")).unwrap());
        assert!(begin_job(&ws, &job("build", "r4"), 2).unwrap()["jobNo"]
            .as_i64()
            .is_some());
        assert_eq!(
            row(&ws, "SELECT status, exit FROM jobs WHERE run = 'r1'")["status"],
            "ended"
        );
    }

    #[test]
    fn records_a_cell_run_outside_any_turn_with_its_answer_or_its_error() {
        let ws = scratch("cells");
        let run = |extra: Value| {
            let mut run = json!({ "precursor": "route-alerts", "origin": "hook:alerts", "ref": "d-1", "cellWs": "/state/spore/cells/x/1", "costUsd": 0.0123, "durationMs": 4200 });
            run.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            record_cell(&ws, &run.to_string())
        };
        run(json!({ "answer": "{\"wait\":\"0\"}" })).unwrap();
        run(json!({ "error": "ended 1 — past its wall" })).unwrap();
        assert!(run(json!({}))
            .unwrap_err()
            .contains("an answer or an error"));
        assert!(run(json!({ "answer": "x", "error": "y" }))
            .unwrap_err()
            .contains("never both"));
        let unasked = json!({ "precursor": "p", "cellWs": "/c", "answer": "a", "costUsd": 0.0, "durationMs": 1 });
        assert!(record_cell(&ws, &unasked.to_string())
            .unwrap_err()
            .contains("its origin"));
        assert_eq!(
            row(
                &ws,
                "SELECT sum(costMicros) AS c FROM cells WHERE origin = 'hook:alerts'"
            )["c"],
            24600
        );
        assert_eq!(
            row(&ws, "SELECT ref FROM cells WHERE cellNo = 2")["ref"],
            "d-1"
        );
        assert!(row(&ws, "SELECT afterTurn FROM cells WHERE cellNo = 1")["afterTurn"].is_null());
    }

    #[test]
    fn records_where_a_dream_started_from_and_what_it_changed() {
        let ws = scratch("dream-cell");
        let run = |extra: Value| {
            let mut run = json!({ "precursor": "tidy", "origin": "dream", "cellWs": "/state/spore/cells/x/dream/1", "answer": "moved", "costUsd": 0.2, "durationMs": 60000 });
            run.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            record_cell(&ws, &run.to_string())
        };
        run(json!({ "afterTurn": 105, "dataBytes": 800_000_000, "changed": { "removed": [{ "path": "data/pipx", "files": 28113, "bytes": 697_000_000 }] } }))
            .unwrap();
        let dream = row(
            &ws,
            "SELECT afterTurn, dataBytes, json_extract(changed, '$.removed[0].path') AS path FROM cells",
        );
        assert_eq!(dream["afterTurn"], 105);
        assert_eq!(dream["dataBytes"], 800_000_000);
        assert_eq!(dream["path"], "data/pipx");
        assert!(run(json!({ "afterTurn": -1 }))
            .unwrap_err()
            .contains("afterTurn is a whole number"));
        assert!(run(json!({ "dataBytes": "lots" }))
            .unwrap_err()
            .contains("dataBytes is a whole number"));
    }

    #[test]
    fn copies_an_inbox_up_to_a_position_at_the_same_positions() {
        let from = scratch("copy-from");
        let to = scratch("copy-to");
        for text in ["one", "two", "three"] {
            append_inbox(
                &from,
                &format!(r#"{{"at":"t","text":"{text}","files":null}}"#),
            )
            .unwrap();
        }
        copy_inbox(&from, &to, 2).unwrap();
        let conn = open_reader(&to.join(STATE_FILE)).unwrap().unwrap();
        let rows: Vec<(i64, String)> = conn
            .prepare("SELECT inboxNo, text FROM inbox ORDER BY inboxNo")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows, [(1, "one".to_string()), (2, "two".to_string())]);
        assert_eq!(
            append_inbox(&to, r#"{"at":"t","text":"four"}"#).unwrap().0,
            3
        );
    }

    #[test]
    fn numbers_turns_in_the_order_they_finish_and_keeps_the_totals() {
        let ws = scratch("finalize");
        let mut first = Record::from_value(
            &json!({ "turnId": "a", "startedAt": "t", "treeMicros": 5, "workUnits": 2, "inboxTo": 2 }),
        );
        finalize(&ws, &mut first).unwrap();
        let mut again = Record::from_value(
            &json!({ "turnId": "a", "startedAt": "t", "treeMicros": 5, "workUnits": 2, "inboxTo": 2 }),
        );
        finalize(&ws, &mut again).unwrap();
        let mut second =
            Record::from_value(&json!({ "turnId": "b", "startedAt": "t", "treeMicros": 7 }));
        finalize(&ws, &mut second).unwrap();
        assert_eq!(
            (
                second.get::<i64>("turnNo"),
                second.get::<i64>("inboxFrom"),
                second.get::<i64>("inboxTo")
            ),
            (Some(2), Some(2), Some(2))
        );
        let conn = open_reader(&ws.join(STATE_FILE)).unwrap().unwrap();
        let totals: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT lastTurnNo, inboxConsumed, treeMicros, workUnits FROM t_workspace",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(totals, (2, 2, 12, 2));

        let mut behind =
            Record::from_value(&json!({ "turnId": "c", "startedAt": "t", "inboxTo": 1 }));
        assert!(finalize(&ws, &mut behind).unwrap_err().contains("behind"));
        let mut misnumbered =
            Record::from_value(&json!({ "turnId": "d", "startedAt": "t", "turnNo": 7 }));
        assert!(finalize(&ws, &mut misnumbered)
            .unwrap_err()
            .contains("turnNo 7"));
        let mut read_row = Record::from_value(
            &json!({ "turnId": "e", "turnNo": 3, "inboxFrom": 2, "startedAt": "t", "ownUsd": 0.1, "treeUsd": 0.1 }),
        );
        finalize(&ws, &mut read_row).unwrap();
    }

    fn ask(ws: &Path, turn: Option<&str>, frame: Value) -> Value {
        serde_json::from_str(&request(ws, turn, &frame.to_string()).unwrap()).unwrap()
    }

    fn row(ws: &Path, sql: &str) -> Value {
        let conn = open_reader(&ws.join(STATE_FILE)).unwrap().unwrap();
        let mut statement = conn.prepare(sql).unwrap();
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|n| n.to_string())
            .collect();
        statement
            .query_row([], |row| {
                let mut fields = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let value = match row.get::<_, SqlValue>(i)? {
                        SqlValue::Null => Value::Null,
                        SqlValue::Integer(n) => json!(n),
                        SqlValue::Real(x) => json!(x),
                        SqlValue::Text(t) => Value::String(t),
                        SqlValue::Blob(_) => Value::Null,
                    };
                    fields.insert(name.clone(), value);
                }
                Ok(Value::Object(fields))
            })
            .unwrap()
    }

    #[test]
    fn writes_a_turns_records_through_its_channel_and_settles_it_once() {
        let ws = scratch("channel-ops");
        append_inbox(&ws, r#"{"at":"t","text":"one"}"#).unwrap();
        let turn = begin_turn(&ws, "2026-09-27T00:00:00.000Z", None).unwrap();
        assert_eq!(turn_state(&ws, &turn).unwrap().as_deref(), Some("running"));

        let entries = ask(
            &ws,
            Some(&turn),
            json!({ "id": 1, "op": "transcript.append", "entries": [
            { "at": "a", "kind": "message", "role": "user", "message": { "role": "user", "content": "hi" } },
            { "at": "b", "kind": "message", "role": "assistant", "message": { "role": "assistant", "content": "yo" } }
        ] }),
        );
        assert_eq!(entries, json!({ "id": 1, "ok": true, "entryNos": [1, 2] }));
        let events = ask(
            &ws,
            Some(&turn),
            json!({ "id": 2, "op": "events.append", "events": [
            { "v": 1, "at": "a", "runId": "r", "event": "round", "index": 0 },
            { "v": 1, "at": "b", "runId": "r", "event": "complete", "output": "yo" }
        ] }),
        );
        assert_eq!(events["seqs"], json!([1, 2]));
        let call = json!({ "runId": "r", "callNo": 1, "tool": "exec", "startedAt": "a", "exit": 0, "refused": false, "record": { "tool": "exec", "exit": 0 } });
        assert_eq!(
            ask(
                &ws,
                Some(&turn),
                json!({ "id": 3, "op": "call.record", "call": call })
            )["ok"],
            true
        );
        let call = json!({ "runId": "r", "callNo": 1, "tool": "exec", "startedAt": "a", "exit": 2, "refused": false, "record": { "tool": "exec", "exit": 2 } });
        assert_eq!(
            ask(
                &ws,
                Some(&turn),
                json!({ "id": 4, "op": "call.record", "call": call })
            )["ok"],
            true
        );
        let outcome = json!({ "runId": "r", "endedAt": "c", "stopReason": "answer", "concluded": true, "ownMicros": 1, "treeMicros": 1, "workUnits": 2, "workUnitsOwn": 1, "workUnitsChildren": 0, "inboxTo": 1 });
        assert_eq!(
            ask(
                &ws,
                Some(&turn),
                json!({ "id": 5, "op": "turn.outcome", "turn": outcome })
            )["ok"],
            true
        );
        assert_eq!(turn_state(&ws, &turn).unwrap().as_deref(), Some("pending"));

        let settled = Settled {
            own: 0.03,
            tree: 0.05,
            own_rounds: 2,
            child_rounds: 3,
            cut: 1,
            by_precursor: [("summarize".to_string(), (0.015, 3))]
                .into_iter()
                .collect(),
        };
        let done = finalize_turn(&ws, &turn, Some(&settled)).unwrap();
        assert_eq!(
            (
                done["turnNo"].clone(),
                done["ownMicros"].clone(),
                done["treeMicros"].clone(),
                done["workUnits"].clone(),
                done["cut"].clone()
            ),
            (json!(1), json!(30000), json!(50000), json!(7), json!(1))
        );
        assert_eq!(
            serde_json::from_str::<Value>(done["byPrecursor"].as_str().unwrap()).unwrap(),
            json!({ "summarize": { "micros": 15000, "rounds": 3 } })
        );
        assert_eq!(
            (
                done["inboxFrom"].clone(),
                done["inboxTo"].clone(),
                done["concluded"].clone(),
                done["settled"].clone()
            ),
            (json!(0), json!(1), json!(1), json!(1))
        );
        let again = finalize_turn(
            &ws,
            &turn,
            Some(&Settled {
                tree: 9.0,
                ..Settled::default()
            }),
        )
        .unwrap();
        assert_eq!(again["treeMicros"], 50000);
        assert!(!unread(&ws).unwrap());

        let calls = row(
            &ws,
            "SELECT count(*) AS n, max(exit) AS exit, max(turnId) AS turn FROM calls",
        );
        assert_eq!(
            (
                calls["n"].clone(),
                calls["exit"].clone(),
                calls["turn"].clone()
            ),
            (json!(1), json!(2), json!(turn))
        );
        let event = row(&ws, "SELECT payload, turnId FROM events WHERE seq = 2");
        assert_eq!(event["payload"], r#"{"output":"yo"}"#);
        let totals = row(
            &ws,
            "SELECT lastSeq, lastTurnNo, treeMicros FROM t_workspace",
        );
        assert_eq!(
            totals,
            json!({ "lastSeq": 3, "lastTurnNo": 1, "treeMicros": 50000 })
        );
        let end = row(
            &ws,
            "SELECT event, turnId, payload FROM events WHERE seq = 3",
        );
        assert_eq!(
            (end["event"].clone(), end["turnId"].clone()),
            (json!("turn_end"), json!(turn))
        );
        let told: Value = serde_json::from_str(end["payload"].as_str().unwrap()).unwrap();
        assert_eq!(
            (
                told["turnNo"].clone(),
                told["treeUsd"].clone(),
                told["settled"].clone(),
                told["concluded"].clone(),
                told["inboxTo"].clone()
            ),
            (json!(1), json!(0.05), json!(true), json!(true), json!(1))
        );
    }

    #[test]
    fn refuses_what_a_request_cannot_mean_and_writes_none_of_it() {
        let ws = scratch("channel-refused");
        let turn = begin_turn(&ws, "t", None).unwrap();
        let refused = [
            json!({ "id": 1, "op": "transcript.append", "entries": [{ "at": "a", "kind": "message", "message": {} }, { "at": "b", "kind": "gossip", "message": {} }] }),
            json!({ "id": 2, "op": "events.append", "events": [{ "v": 1, "at": "a", "event": "round", "seq": 1 }] }),
            json!({ "id": 3, "op": "turn.outcome", "turn": { "stopReason": "answer", "asked": "what" } }),
            json!({ "id": 4, "op": "turn.outcome", "turn": { "turnId": "someone-else" } }),
            json!({ "id": 5, "op": "call.record", "call": { "runId": "r", "callNo": 1, "tool": "exec", "record": {} } }),
            json!({ "id": 6, "op": "forget" }),
        ];
        for frame in refused {
            let answer = ask(&ws, Some(&turn), frame.clone());
            assert!(
                answer["error"].is_string() && answer["id"] == frame["id"],
                "{frame} → {answer}"
            );
        }
        assert_eq!(row(&ws, "SELECT count(*) AS n FROM transcript")["n"], 0);
        assert_eq!(turn_state(&ws, &turn).unwrap().as_deref(), Some("running"));
        let hosted = ask(
            &ws,
            None,
            json!({ "id": 7, "op": "turn.outcome", "turn": { "stopReason": "answer" } }),
        );
        assert!(hosted["error"].as_str().unwrap().contains("channel"));
    }

    #[test]
    fn numbers_events_itself_and_keeps_what_rust_cannot_hold() {
        let ws = scratch("events");
        let frame = "{\"id\":1,\"op\":\"events.append\",\"events\":[{\"v\":1,\"at\":\"a\",\"event\":\"stream\",\"delta\":\"a\\ud800b\"}]}";
        let answer: Value = serde_json::from_str(&request(&ws, None, frame).unwrap()).unwrap();
        assert_eq!(answer["seqs"], json!([1]));
        assert_eq!(
            row(&ws, "SELECT payload FROM events")["payload"],
            "{\"delta\":\"a\\ud800b\"}"
        );
        let next = ask(
            &ws,
            None,
            json!({ "id": 2, "op": "events.append", "events": [{ "v": 1, "at": "b", "event": "round" }] }),
        );
        assert_eq!(next["seqs"], json!([2]));
    }

    #[test]
    fn serves_a_channel_until_the_agent_closes_its_end() {
        let ws = scratch("serve");
        let turn = begin_turn(&ws, "t", None).unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        let served = serve(&ws, turn.clone(), ours);
        let mut writer = theirs.try_clone().unwrap();
        let mut reader = BufReader::new(theirs);
        let mut answer = String::new();
        writer
            .write_all(b"{\"id\":7,\"op\":\"turn.outcome\",\"turn\":{\"stopReason\":\"quiet\",\"concluded\":true}}\nnot json\n")
            .unwrap();
        reader.read_line(&mut answer).unwrap();
        assert_eq!(answer, "{\"id\":7,\"ok\":true}\n");
        answer.clear();
        reader.read_line(&mut answer).unwrap();
        assert!(answer.contains("\"error\""), "{answer}");
        drop(writer);
        drop(reader);
        served.join().unwrap().unwrap();
        assert_eq!(turn_state(&ws, &turn).unwrap().as_deref(), Some("pending"));
        assert!(!ws.join("state.sqlite-wal").exists());
    }

    #[test]
    fn finalizes_what_a_supervisor_that_died_left_behind() {
        let ws = scratch("recover");
        let said = begin_turn(&ws, "2026-09-27T00:00:01.000Z", None).unwrap();
        ask(
            &ws,
            Some(&said),
            json!({ "id": 1, "op": "turn.outcome", "turn": { "stopReason": "answer", "concluded": true, "ownMicros": 5, "treeMicros": 5 } }),
        );
        let silent = begin_turn(&ws, "2026-09-27T00:00:02.000Z", None).unwrap();
        recover(&ws).unwrap();
        let first = row(&ws, "SELECT * FROM turns WHERE turnNo = 1");
        assert_eq!(
            (
                first["turnId"].clone(),
                first["treeMicros"].clone(),
                first["settled"].clone()
            ),
            (json!(said), json!(5), json!(0))
        );
        let second = row(&ws, "SELECT * FROM turns WHERE turnNo = 2");
        assert_eq!(
            (
                second["turnId"].clone(),
                second["error"].clone(),
                second["concluded"].clone(),
                second["startedAt"].clone()
            ),
            (
                json!(silent),
                json!("SUPERVISOR_DIED"),
                json!(0),
                json!("2026-09-27T00:00:02.000Z")
            )
        );
        recover(&ws).unwrap();
        assert_eq!(row(&ws, "SELECT count(*) AS n FROM turns")["n"], 2);
        assert_eq!(
            row(
                &ws,
                "SELECT count(*) AS n FROM events WHERE event = 'turn_end'"
            )["n"],
            2
        );
    }

    #[test]
    fn settles_only_the_tree_of_a_record_the_supervisor_wrote() {
        let ws = scratch("settle-supervisor");
        let turn = begin_turn(&ws, "t", None).unwrap();
        let unanswered = crate::unanswered(&crate::Unanswered {
            started_at: "t",
            stop_reason: "cancelled",
            error: "KILLED",
            detail: "why",
            tree: 0.0,
        });
        let frame = format!(
            "{{\"id\":1,\"op\":\"turn.outcome\",\"turn\":{}}}",
            unanswered.to_json()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&request(&ws, Some(&turn), &frame).unwrap()).unwrap()
                ["ok"],
            true
        );
        let done = finalize_turn(
            &ws,
            &turn,
            Some(&Settled {
                own: 0.2,
                tree: 0.3,
                own_rounds: 1,
                ..Settled::default()
            }),
        )
        .unwrap();
        assert_eq!(done["treeMicros"], 300000);
        assert!(
            done["ownMicros"].is_null() && done["workUnits"].is_null() && done["cut"].is_null()
        );
    }

    #[test]
    fn keeps_the_newest_runs_with_their_streams_and_events() {
        let ws = scratch("prune");
        let turn = begin_turn(&ws, "t", None).unwrap();
        annotate(&ws, Some("usually 2 min")).unwrap();
        for (no, run) in ["old", "mid", "new", "mid"].iter().enumerate() {
            let call = json!({ "runId": run, "callNo": no + 1, "tool": "exec", "startedAt": "a", "record": {} });
            ask(
                &ws,
                Some(&turn),
                json!({ "id": no, "op": "call.record", "call": call }),
            );
            ask(
                &ws,
                Some(&turn),
                json!({ "id": no, "op": "events.append", "events": [{ "v": 1, "at": "a", "runId": run, "event": "round" }] }),
            );
            std::fs::create_dir_all(ws.join(crate::CALLS_DIR).join(run)).unwrap();
        }
        std::fs::create_dir_all(ws.join(crate::CALLS_DIR).join("unrecorded")).unwrap();
        writing(&ws, |conn| {
            conn.execute(
                "UPDATE t_turns SET runId = 'old' WHERE turnId = ?1",
                [&turn],
            )
            .map_err(failed_to("name the turn's run"))
        })
        .unwrap();
        assert_eq!(prune_trail(&ws, 3).unwrap(), ["old", "unrecorded"]);
        assert!(!ws.join(crate::CALLS_DIR).join("old").exists());
        assert!(ws.join(crate::CALLS_DIR).join("new").exists());
        assert_eq!(
            row(
                &ws,
                "SELECT count(DISTINCT runId) AS n, sum(runId = 'old') AS old FROM calls"
            ),
            json!({ "n": 2, "old": 0 })
        );
        assert_eq!(
            row(&ws, "SELECT count(*) AS n, max(seq) AS last FROM events"),
            json!({ "n": 3, "last": 5 })
        );
        assert_eq!(
            row(&ws, "SELECT count(*) AS n, runId FROM t_turns"),
            json!({ "n": 1, "runId": "old" })
        );
    }

    #[test]
    fn numbers_events_on_past_the_newest_one_pruned() {
        let ws = scratch("prune-seq");
        let turn = begin_turn(&ws, "t", None).unwrap();
        for (no, run) in ["old", "new"].iter().enumerate() {
            let call = json!({ "runId": run, "callNo": no + 1, "tool": "exec", "startedAt": "a", "record": {} });
            ask(
                &ws,
                Some(&turn),
                json!({ "id": no, "op": "call.record", "call": call }),
            );
            std::fs::create_dir_all(ws.join(crate::CALLS_DIR).join(run)).unwrap();
        }
        let events = json!([
            { "v": 1, "at": "a", "runId": "old", "event": "round" },
            { "v": 1, "at": "a", "runId": "new", "event": "round" },
            { "v": 1, "at": "a", "runId": "old", "event": "complete" }
        ]);
        ask(
            &ws,
            Some(&turn),
            json!({ "id": 2, "op": "events.append", "events": events }),
        );
        assert_eq!(prune_trail(&ws, 2).unwrap(), ["old"]);
        ask(
            &ws,
            Some(&turn),
            json!({ "id": 3, "op": "events.append", "events": [{ "v": 1, "at": "a", "runId": "next", "event": "round" }] }),
        );
        assert_eq!(
            row(
                &ws,
                "SELECT group_concat(seq) AS seqs FROM (SELECT seq FROM events ORDER BY seq)"
            ),
            json!({ "seqs": "2,4" })
        );
    }

    #[test]
    fn drops_nothing_with_room_or_with_no_trail() {
        let ws = scratch("prune-room");
        assert!(prune_trail(&ws, 3).unwrap().is_empty());
        let turn = begin_turn(&ws, "t", None).unwrap();
        let call =
            json!({ "runId": "only", "callNo": 1, "tool": "exec", "startedAt": "a", "record": {} });
        ask(
            &ws,
            Some(&turn),
            json!({ "id": 0, "op": "call.record", "call": call }),
        );
        std::fs::create_dir_all(ws.join(crate::CALLS_DIR).join("only")).unwrap();
        assert!(prune_trail(&ws, 10).unwrap().is_empty());
        assert!(ws.join(crate::CALLS_DIR).join("only").exists());
    }

    #[test]
    fn takes_a_message_sent_again_under_its_request_id_as_the_first() {
        let ws = scratch("request-id");
        let first = append_inbox(&ws, r#"{"at":"a","text":"yes","requestId":"u-7"}"#).unwrap();
        let again = append_inbox(&ws, r#"{"at":"b","text":"yes","requestId":"u-7"}"#).unwrap();
        let other = append_inbox(&ws, r#"{"at":"c","text":"yes","requestId":"u-8"}"#).unwrap();
        let unkeyed = append_inbox(&ws, r#"{"at":"d","text":"yes"}"#).unwrap();
        assert_eq!(
            (first, again, other, unkeyed),
            ((1, false), (1, true), (2, false), (3, false))
        );
    }

    fn shape(conn: &Connection) -> Vec<(String, String, Value)> {
        let objects: Vec<(String, String, Option<String>)> = conn
            .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        objects
            .into_iter()
            .map(|(kind, name, sql)| {
                // A column added later sits last in a fresh table too, so a table is compared by
                // its columns: ALTER TABLE rewrites the text it was created with.
                let described = if kind == "table" {
                    let columns: Vec<Value> = conn
                        .prepare(&format!("PRAGMA table_info({name})"))
                        .unwrap()
                        .query_map([], |row| {
                            Ok(json!([
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, Option<String>>(4)?,
                                row.get::<_, i64>(5)?
                            ]))
                        })
                        .unwrap()
                        .map(Result::unwrap)
                        .collect();
                    json!(columns)
                } else {
                    json!(sql)
                };
                (kind, name, described)
            })
            .collect()
    }

    #[test]
    fn migrates_a_workspace_an_older_spore_made_into_what_a_fresh_one_is() {
        let fresh = scratch("schema-fresh");
        let made = open_state(&fresh).unwrap();
        let expected = shape(&made);
        close_state(made).unwrap();

        let old = scratch("schema-1");
        let conn = Connection::open(old.join(STATE_FILE)).unwrap();
        conn.execute_batch(include_str!("../tests/fixtures/schema-1.sql"))
            .unwrap();
        conn.execute_batch(
            r#"INSERT INTO t_workspace (id, schemaVersion, createdAt, inboxConsumed, lastTurnNo) VALUES (1, 1, 'a', 1, 1);
             INSERT INTO t_inbox (at, text) VALUES ('a', 'said before');
             INSERT INTO t_turns (turnId, turnNo, state, startedAt, inboxFrom, inboxTo, produced, producedMore) VALUES ('t1', 1, 'final', 'a', 0, 1,
               '[{"path":"data/out/r.md","bytes":1,"mtime":"a","mime":"text/markdown","delivered":true},{"path":"data/x.json","bytes":2,"mtime":"a","mime":"application/json","delivered":false}]', 3);"#,
        )
        .unwrap();
        conn.close().unwrap();

        let migrated = open_state(&old).unwrap();
        assert_eq!(shape(&migrated), expected);
        let kept: (String, Option<String>, i64) = migrated
            .query_row("SELECT text, replyTo, consumed FROM inbox", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(kept, ("said before".into(), None, 1));
        let handed: (String, Option<i64>) = migrated
            .query_row(
                "SELECT deliverables, deliverablesMore FROM turns",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            handed,
            (
                r#"[{"path":"data/out/r.md","bytes":1,"mtime":"a","mime":"text/markdown"}]"#.into(),
                None
            )
        );
        let version: i64 = migrated
            .query_row("SELECT schemaVersion FROM t_workspace", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        close_state(migrated).unwrap();
        close_state(open_state(&old).unwrap()).unwrap();
    }

    #[test]
    fn knows_a_reply_to_when_it_sees_one() {
        for good in [
            "terminal",
            "telegram:main/42",
            "discord:ops/1234",
            "my-bot2:x",
        ] {
            assert!(check_reply_to(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "Terminal",
            "discord",
            "discord:",
            ":x",
            "Discord:x",
            "2fa:x",
            "discord:a b",
        ] {
            assert!(check_reply_to(bad).is_err(), "{bad:?}");
        }
        let ws = scratch("reply-to-refused");
        assert!(
            append_inbox(&ws, r#"{"at":"a","text":"x","replyTo":"nowhere"}"#)
                .unwrap_err()
                .contains("reply-to")
        );
        assert!(hold_delivery(
            &ws,
            r#"{"at":"a","text":"x","hook":"forge","hookDelivery":"d1","replyTo":"terminal"}"#,
            "a",
            "b"
        )
        .unwrap_err()
        .contains("reply-to"));
        assert!(begin_turn(&ws, "t", Some("nowhere")).is_err());
    }

    fn answered(
        ws: &Path,
        reply_default: Option<&str>,
        said: &[Option<&str>],
        stop: &str,
    ) -> String {
        for reply_to in said {
            let entry = match reply_to {
                Some(reply_to) => json!({ "at": "a", "text": "x", "replyTo": reply_to }),
                None => json!({ "at": "a", "text": "x" }),
            };
            append_inbox(ws, &entry.to_string()).unwrap();
        }
        let to = row(ws, "SELECT max(inboxNo) AS n FROM t_inbox")["n"].clone();
        let turn = begin_turn(ws, "t", reply_default).unwrap();
        ask(
            ws,
            Some(&turn),
            json!({ "id": 1, "op": "turn.outcome", "turn": { "stopReason": stop, "concluded": true, "inboxTo": to } }),
        );
        finalize_turn(ws, &turn, None).unwrap();
        turn
    }

    fn entries(ws: &Path) -> Vec<(String, Value, String)> {
        let all = outbox(ws, None, None).unwrap();
        all.as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["recipient"].as_str().unwrap().to_string(),
                    entry["answers"].clone(),
                    entry["state"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn addresses_an_answer_to_where_each_message_asked_from_and_the_rest_to_the_default() {
        let ws = scratch("address");
        answered(
            &ws,
            Some("discord:ops/1"),
            &[
                Some("telegram:main/42"),
                None,
                Some("telegram:main/42"),
                Some("terminal"),
            ],
            "answer",
        );
        assert_eq!(
            entries(&ws),
            [
                ("discord:ops/1".into(), json!([2]), "pending".into()),
                ("telegram:main/42".into(), json!([1, 3]), "pending".into()),
                ("terminal".into(), json!([4]), "delivered".into()),
            ]
        );

        let merged = scratch("address-merged");
        answered(
            &merged,
            Some("discord:ops/1"),
            &[Some("discord:ops/1"), None],
            "answer",
        );
        assert_eq!(
            entries(&merged),
            [("discord:ops/1".into(), json!([1, 2]), "pending".into())]
        );

        let nowhere = scratch("address-no-default");
        answered(&nowhere, None, &[None, Some("telegram:main/42")], "answer");
        assert_eq!(
            entries(&nowhere),
            [("telegram:main/42".into(), json!([2]), "pending".into())]
        );
    }

    #[test]
    fn a_quiet_turn_answers_who_asked_and_tells_its_default_nothing() {
        let ws = scratch("address-quiet");
        answered(
            &ws,
            Some("discord:ops/1"),
            &[None, Some("telegram:main/42")],
            "quiet",
        );
        assert_eq!(
            entries(&ws),
            [("telegram:main/42".into(), json!([2]), "pending".into())]
        );
    }

    #[test]
    fn addresses_nothing_for_a_turn_that_read_nothing_a_copied_history_or_a_second_finalize() {
        let ws = scratch("address-none");
        append_inbox(&ws, r#"{"at":"a","text":"x","replyTo":"telegram:main/42"}"#).unwrap();
        let turn = begin_turn(&ws, "t", Some("discord:ops/1")).unwrap();
        ask(
            &ws,
            Some(&turn),
            json!({ "id": 1, "op": "turn.outcome", "turn": { "stopReason": "error", "concluded": false } }),
        );
        finalize_turn(&ws, &turn, None).unwrap();
        assert!(entries(&ws).is_empty());

        let read = answered(&ws, None, &[], "answer");
        assert_eq!(entries(&ws).len(), 1);
        finalize_turn(&ws, &read, None).unwrap();
        assert_eq!(entries(&ws).len(), 1);

        let copied = scratch("address-copied");
        append_inbox(
            &copied,
            r#"{"at":"a","text":"x","replyTo":"telegram:main/42"}"#,
        )
        .unwrap();
        replace_turns(
            &copied,
            &mut [Record::from_value(
                &json!({ "startedAt": "t", "inboxTo": 1 }),
            )],
        )
        .unwrap();
        assert!(entries(&copied).is_empty());
    }

    #[test]
    fn reads_the_outbox_by_kind_and_state_and_settles_an_entry_once() {
        let ws = scratch("outbox");
        answered(
            &ws,
            None,
            &[
                Some("telegram:main/42"),
                Some("discord:ops/1"),
                Some("discordx:a"),
            ],
            "answer",
        );
        let discord = outbox(&ws, Some("discord"), Some("pending")).unwrap();
        assert_eq!(discord.as_array().unwrap().len(), 1);
        let first = discord[0]["outboxNo"].as_i64().unwrap();
        assert_eq!(discord[0]["turnNo"], 1);
        assert!(settle_outbox(&ws, first, None).unwrap());
        assert!(!settle_outbox(&ws, first, Some("too late")).unwrap());
        assert!(outbox(&ws, Some("discord"), Some("pending"))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        let telegram = outbox(&ws, Some("telegram"), None).unwrap()[0]["outboxNo"]
            .as_i64()
            .unwrap();
        assert!(settle_outbox(&ws, telegram, Some("chat 42 blocked the bot")).unwrap());
        let telegram = outbox(&ws, Some("telegram"), None).unwrap();
        let refused = &telegram[0];
        assert_eq!(
            (refused["state"].clone(), refused["reason"].clone()),
            (json!("refused"), json!("chat 42 blocked the bot"))
        );
        assert!(!settle_outbox(&ws, 99, None).unwrap());
    }

    #[test]
    fn sets_aside_what_a_conversation_said_and_no_turn_read_so_no_turn_starts_for_reads_or_answers_it(
    ) {
        let ws = scratch("set-aside");
        answered(&ws, None, &[Some("telegram:main/42")], "answer");
        for (at, reply_to) in [
            ("b", "telegram:main/42"),
            ("c", "telegram:main/7"),
            ("d", "telegram:main/42"),
            ("f", "telegram:main/42"),
        ] {
            append_inbox(
                &ws,
                &json!({ "at": at, "text": "x", "replyTo": reply_to }).to_string(),
            )
            .unwrap();
        }
        assert_eq!(
            set_aside(&ws, "telegram:main/42", 4).unwrap(),
            Some(vec![2, 4])
        );
        assert_eq!(set_aside(&ws, "telegram:main/42", 4).unwrap(), Some(vec![]));
        let flags: Vec<i64> = (1..=5)
            .map(|n| {
                row(
                    &ws,
                    &format!("SELECT setAside FROM inbox WHERE inboxNo = {n}"),
                )["setAside"]
                    .as_i64()
                    .unwrap()
            })
            .collect();
        assert_eq!(flags, [0, 1, 0, 1, 0]);
        assert!(unread(&ws).unwrap());

        answered(&ws, None, &[], "answer");
        assert_eq!(
            entries(&ws)
                .into_iter()
                .map(|(recipient, answers, _)| (recipient, answers))
                .collect::<Vec<_>>(),
            [
                ("telegram:main/42".to_string(), json!([1])),
                ("telegram:main/42".to_string(), json!([5])),
                ("telegram:main/7".to_string(), json!([3]))
            ]
        );
        assert!(!unread(&ws).unwrap());

        append_inbox(
            &ws,
            &json!({ "at": "g", "text": "x", "replyTo": "telegram:main/42" }).to_string(),
        )
        .unwrap();
        assert!(unread(&ws).unwrap());
        set_aside(&ws, "telegram:main/42", 6).unwrap();
        assert!(!unread(&ws).unwrap());

        let copy = scratch("set-aside-copy");
        copy_inbox(&ws, &copy, 6).unwrap();
        assert_eq!(
            row(
                &copy,
                "SELECT group_concat(inboxNo) AS marked FROM inbox WHERE setAside"
            )["marked"],
            json!("2,4,6")
        );
    }

    #[test]
    fn takes_what_was_overheard_as_asking_nothing_so_no_turn_starts_for_or_answers_it() {
        let ws = scratch("overheard");
        let overheard = |at: &str| {
            json!({ "at": at, "text": "x", "overheard": true, "fromName": "Bob", "fromId": "telegram:2", "fromWhere": "the Telegram group \"ops\"" })
                .to_string()
        };
        append_inbox(&ws, &overheard("a")).unwrap();
        assert!(!unread(&ws).unwrap());
        append_inbox(
            &ws,
            &json!({ "at": "b", "text": "x", "replyTo": "telegram:main/-5", "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" })
                .to_string(),
        )
        .unwrap();
        append_inbox(&ws, &overheard("c")).unwrap();
        assert!(unread(&ws).unwrap());
        assert_eq!(unanswered_traceparents(&ws).unwrap().len(), 1);

        answered(&ws, Some("discord:ops/1"), &[], "answer");
        assert_eq!(
            entries(&ws),
            [("telegram:main/-5".into(), json!([2]), "pending".into())]
        );
        assert!(!unread(&ws).unwrap());

        for refused in [
            json!({ "at": "d", "text": "x", "overheard": true }),
            json!({ "at": "d", "text": "x", "overheard": true, "fromName": "Bob", "fromId": "telegram:2", "fromWhere": "a group", "replyTo": "telegram:main/-5" }),
        ] {
            assert!(append_inbox(&ws, &refused.to_string())
                .unwrap_err()
                .contains("overheard"));
        }
    }

    #[test]
    fn sets_aside_nothing_while_a_runner_holds_the_workspace() {
        let ws = scratch("set-aside-held");
        append_inbox(
            &ws,
            &json!({ "at": "a", "text": "x", "replyTo": "telegram:main/42" }).to_string(),
        )
        .unwrap();
        let held = match crate::acquire_lock(&ws).unwrap() {
            crate::Acquired::Held(file, _) => file,
            crate::Acquired::Taken(by) => panic!("the lock was taken by {by}"),
        };
        assert_eq!(set_aside(&ws, "telegram:main/42", 1).unwrap(), None);
        drop(held);
        assert_eq!(
            set_aside(&ws, "telegram:main/42", 1).unwrap(),
            Some(vec![1])
        );
    }

    #[test]
    fn marks_an_outbox_entry_attempted_once_and_only_while_it_is_pending() {
        let ws = scratch("outbox-attempted");
        answered(
            &ws,
            None,
            &[Some("telegram:main/42"), Some("telegram:main/43")],
            "answer",
        );
        let entries = outbox(&ws, Some("telegram"), None).unwrap();
        let (first, second) = (
            entries[0]["outboxNo"].as_i64().unwrap(),
            entries[1]["outboxNo"].as_i64().unwrap(),
        );
        assert_eq!(entries[0]["attemptedAt"], Value::Null);
        assert!(attempt_outbox(&ws, first).unwrap());
        let marked = outbox(&ws, Some("telegram"), None).unwrap()[0]["attemptedAt"].clone();
        assert!(marked.is_string());
        assert!(!attempt_outbox(&ws, first).unwrap());
        assert_eq!(
            outbox(&ws, Some("telegram"), None).unwrap()[0]["attemptedAt"],
            marked
        );
        assert!(settle_outbox(&ws, second, None).unwrap());
        assert!(!attempt_outbox(&ws, second).unwrap());
        assert!(!attempt_outbox(&ws, 99).unwrap());
    }

    fn asked(ws: &Path, id: &str, until: &str) {
        ask_approval(
            ws,
            &json!({
                "id": id, "at": "a", "place": "telegram:main/42", "approvers": ["42"],
                "options": [{ "id": "apply", "label": "Apply" }], "body": { "default": { "text": "x" } },
                "within": "2h", "until": until
            })
            .to_string(),
        )
        .unwrap();
    }

    fn approval(
        ws: &Path,
        id: &str,
    ) -> (String, Option<String>, Option<String>, Option<String>, bool) {
        let conn = Connection::open(ws.join(STATE_FILE)).unwrap();
        conn.query_row(
            "SELECT state, choice, outcome, reason, settledAt IS NOT NULL FROM approvals WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap()
    }

    #[test]
    fn takes_the_first_press_on_a_posted_approval_and_settles_it_once() {
        let ws = scratch("approval-answered");
        asked(&ws, "a1", "2999-01-01T00:00:00.000Z");
        assert!(!answer_approval(&ws, "a1", "apply", None, "42", "Ann").unwrap());
        assert!(post_approval(&ws, "a1", r#"{"text":"x"}"#, Some("7")).unwrap());
        assert!(!post_approval(&ws, "a1", r#"{"text":"x"}"#, Some("7")).unwrap());
        assert!(
            answer_approval(&ws, "a1", "apply", Some(r#"{"note":"ok"}"#), "42", "Ann").unwrap()
        );
        assert!(!answer_approval(&ws, "a1", "apply", None, "43", "Bob").unwrap());
        assert!(!expire_approval(&ws, "a1").unwrap());
        assert!(settle_approval(&ws, "a1", Some("failed"), None, None, None).is_err());
        assert!(settle_approval(
            &ws,
            "a1",
            Some("confirmed"),
            None,
            Some(r#"{"text":"done"}"#),
            Some("82 % is in")
        )
        .unwrap());
        assert!(!settle_approval(&ws, "a1", Some("confirmed"), None, None, None).unwrap());
        let kept: (String, String) = Connection::open(ws.join(STATE_FILE))
            .unwrap()
            .query_row(
                "SELECT replaced, tell FROM approvals WHERE id = 'a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept, (r#"{"text":"done"}"#.into(), "82 % is in".into()));
        assert_eq!(
            approval(&ws, "a1"),
            (
                "answered".into(),
                Some("apply".into()),
                Some("confirmed".into()),
                None,
                true
            )
        );
    }

    #[test]
    fn takes_no_press_past_the_deadline_and_expires_what_was_posted() {
        let ws = scratch("approval-expired");
        asked(&ws, "a1", "2000-01-01T00:00:00.000Z");
        assert!(!expire_approval(&ws, "a1").unwrap());
        assert!(post_approval(&ws, "a1", r#"{"text":"x"}"#, None).unwrap());
        assert!(!answer_approval(&ws, "a1", "apply", None, "42", "Ann").unwrap());
        assert!(expire_approval(&ws, "a1").unwrap());
        assert!(!expire_approval(&ws, "a1").unwrap());
        assert!(settle_approval(&ws, "a1", Some("confirmed"), None, None, None).is_err());
        assert!(
            settle_approval(&ws, "a1", None, None, Some(r#"{"text":"expired"}"#), None).unwrap()
        );
        assert_eq!(
            approval(&ws, "a1"),
            ("expired".into(), None, None, None, true)
        );

        asked(&ws, "a2", "2999-01-01T00:00:00.000Z");
        assert!(post_approval(&ws, "a2", r#"{"text":"x"}"#, None).unwrap());
        assert!(!expire_approval(&ws, "a2").unwrap());
        assert!(answer_approval(&ws, "a2", "apply", None, "42", "Ann").unwrap());
        assert!(settle_approval(
            &ws,
            "a2",
            Some("failed"),
            Some("the hook answered 500"),
            None,
            None
        )
        .unwrap());
        assert_eq!(
            approval(&ws, "a2"),
            (
                "answered".into(),
                Some("apply".into()),
                Some("failed".into()),
                Some("the hook answered 500".into()),
                true
            )
        );
    }

    #[test]
    fn refuses_an_approval_it_will_not_post_and_keeps_why_when_it_settles() {
        let ws = scratch("approval-refused");
        asked(&ws, "a1", "2999-01-01T00:00:00.000Z");
        assert!(refuse_approval(&ws, "a1", "Telegram cannot show it").unwrap());
        assert!(!refuse_approval(&ws, "a1", "again").unwrap());
        assert!(!post_approval(&ws, "a1", r#"{"text":"x"}"#, None).unwrap());
        assert!(settle_approval(&ws, "a1", None, None, None, None).unwrap());
        assert_eq!(
            approval(&ws, "a1"),
            (
                "refused".into(),
                None,
                None,
                Some("Telegram cannot show it".into()),
                true
            )
        );
        assert!(!settle_approval(&ws, "a1", None, None, None, None).unwrap());
    }

    #[test]
    fn asks_an_approval_only_in_a_conversation_and_only_once_under_its_id() {
        let ws = scratch("approval-asked");
        let request = |place: Value, id: &str| {
            json!({
                "id": id, "at": "a", "place": place, "approvers": ["42"], "options": [],
                "body": {}, "within": "2h", "until": "b"
            })
            .to_string()
        };
        assert!(ask_approval(&ws, &request(json!("terminal"), "a1")).is_err());
        assert!(ask_approval(&ws, &request(json!("telegram"), "a1")).is_err());
        assert!(ask_approval(&ws, &request(Value::Null, "a1")).is_err());
        assert_eq!(
            ask_approval(&ws, &request(json!("telegram:main/42"), "a1")).unwrap(),
            1
        );
        assert!(ask_approval(&ws, &request(json!("telegram:main/42"), "a1")).is_err());
        let mut extra = Record::parse(&request(json!("telegram:main/42"), "a2")).unwrap();
        extra.set("secret", json!("x"));
        assert!(ask_approval(&ws, &extra.to_json()).is_err());
    }

    #[test]
    fn keeps_the_fields_an_approval_asks_to_be_filled_in() {
        let ws = scratch("approval-fields");
        let fields = json!([{ "id": "reason", "label": "Why?", "required": true }]);
        ask_approval(
            &ws,
            &json!({
                "id": "a1", "at": "a", "place": "telegram:main/42", "approvers": ["42"],
                "options": [{ "id": "apply", "label": "Apply" }], "body": { "default": { "text": "x" } },
                "within": "2h", "until": "b", "fields": fields
            })
            .to_string(),
        )
        .unwrap();
        asked(&ws, "a2", "b");
        let conn = Connection::open(ws.join(STATE_FILE)).unwrap();
        let kept = |id: &str| -> Option<String> {
            conn.query_row("SELECT fields FROM approvals WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
        };
        assert_eq!(
            kept("a1").map(|text| serde_json::from_str::<Value>(&text).unwrap()),
            Some(fields)
        );
        assert_eq!(kept("a2"), None);
    }

    #[test]
    fn tells_of_an_approval_only_with_a_place_to_answer_in() {
        let ws = scratch("approval-told");
        append_inbox(
            &ws,
            &json!({ "at": "a", "text": "Ann chose Apply", "approval": "a1", "replyTo": "telegram:main/42",
                     "fromName": "Ann", "fromId": "telegram:42", "fromWhere": "a private chat on Telegram" })
                .to_string(),
        )
        .unwrap();
        for refused in [
            json!({ "at": "b", "text": "x", "approval": "a1" }),
            json!({ "at": "b", "text": "x", "approval": "a1", "replyTo": "telegram:main/42", "schedule": "s", "due": "c" }),
        ] {
            assert!(append_inbox(&ws, &refused.to_string()).is_err());
        }
    }
}

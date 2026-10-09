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
  UNIQUE (schedule, due),
  CHECK ((schedule IS NULL) = (due IS NULL)),
  CHECK ((hook IS NULL) = (hookDelivery IS NULL)),
  CHECK (hookEvent IS NULL OR hook IS NOT NULL),
  CHECK (coalesce(text, '') <> '' OR bodyPath IS NOT NULL OR files IS NOT NULL)
);

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
  produced           TEXT,
  producedMore       INTEGER,
  recall             TEXT,
  traceparent        TEXT,
  model              TEXT,
  byPrecursor        TEXT,
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
         inboxFrom, inboxTo, cut, settled, produced, producedMore, recall, traceparent, model,
         byPrecursor
    FROM t_turns
   WHERE state = 'final';

CREATE VIEW inbox AS
  SELECT i.inboxNo, i.at, i.text, i.bodyPath, i.bodyBytes, i.bodyHead, i.bodyTail,
         i.files, i.schedule, i.due, i.hook, i.hookEvent, i.hookDelivery,
         i.job, i.jobEvent, i.jobRun, i.traceparent, i.requestId,
         i.inboxNo <= w.inboxConsumed AS consumed
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
  CHECK ((answer IS NULL) <> (error IS NULL))
);
CREATE INDEX t_cells_origin ON t_cells (origin, at);

CREATE VIEW cells AS
  SELECT cellNo, at, precursor, origin, ref, cellWs, answer, error,
         costMicros, costMicros / 1e6 AS costUsd, durationMs
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

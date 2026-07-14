// Agent HQ — persistence layer built on Node's built-in SQLite (node:sqlite).
// Zero external dependencies: the whole platform runs on the Node standard library.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.HQ_DB_PATH || './data/agenthq.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

// Block this thread for `ms`. Opening the database is synchronous, so a retry has to be too.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'generalist',
  status        TEXT NOT NULL DEFAULT 'idle',      -- idle | working | offline
  current_task  TEXT,
  avatar        TEXT,                              -- emoji
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen     TEXT
);

CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS columns (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL,
  wip_limit INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id   TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  assignee    TEXT,                                -- agent id
  priority    TEXT NOT NULL DEFAULT 'medium',      -- low | medium | high | urgent
  labels      TEXT NOT NULL DEFAULT '[]',          -- json array
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT,                                 -- null = shared / org-wide
  namespace  TEXT NOT NULL DEFAULT 'default',
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',           -- json array
  importance INTEGER NOT NULL DEFAULT 3,           -- 1..5
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id        TEXT PRIMARY KEY,
  ts        TEXT NOT NULL,
  actor     TEXT,
  type      TEXT NOT NULL,                         -- e.g. task.created, memory.write
  entity    TEXT,
  entity_id TEXT,
  summary   TEXT NOT NULL,
  data      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  from_agent TEXT,
  to_agent   TEXT,                                -- null = broadcast to all
  task_id    TEXT,                                -- optional context
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- run/cost ledger: each unit of agent work, with token usage and cost
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT,
  task_id       TEXT,
  label         TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  duration_ms   INTEGER,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);

-- per-agent read receipts so broadcasts have correct unread state per agent
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_board   ON tasks(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_col     ON tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_mem_agent     ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts   ON activity(ts);
CREATE INDEX IF NOT EXISTS idx_msg_to        ON messages(to_agent, read);
`;

// 🔑 WAL LETS READERS AND A WRITER COEXIST. IT DOES NOTHING FOR TWO WRITERS. Without busy_timeout the
// second writer does not WAIT for the lock — it fails INSTANTLY with SQLITE_BUSY. HQ normally runs as
// one server, but the MCP server, the CLI and a second container can all open this file; measured on
// cortex (same store shape), two concurrent writers lost 45 of 60 writes. And busy_timeout does not
// save the OPEN itself — `PRAGMA journal_mode = WAL` takes a brief exclusive lock and SQLite answers
// SQLITE_BUSY for it immediately — so the open retries, and the schema goes up atomically.
function openDb() {
  for (let attempt = 0; ; attempt++) {
    let d;
    try {
      d = new DatabaseSync(DB_PATH);
      d.exec('PRAGMA busy_timeout = 5000;');
      d.exec('PRAGMA journal_mode = WAL;');
      d.exec('PRAGMA foreign_keys = ON;');
      d.exec('BEGIN IMMEDIATE;');
      d.exec(SCHEMA);
      d.exec('COMMIT;');
      return d;
    } catch (e) {
      try { d?.close(); } catch { /* already gone */ }
      // Only a lock is worth retrying — a loop that hides a real fault is worse than the fault.
      if (attempt >= 40 || !/lock|busy/i.test(e.message)) throw e;
      sleepSync(25);
    }
  }
}

export const db = openDb();


// Lightweight migration: add columns introduced after first release.
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('tasks', 'claimed_at', 'TEXT');     // when the current assignee claimed it
ensureColumn('tasks', 'lease_until', 'TEXT');    // claim expires at this time (auto-released)

export const now = () => new Date().toISOString();
export const uid = (p = '') => p + randomUUID().slice(0, 8);

// Small helpers -----------------------------------------------------------
export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export function logActivity({ actor, type, entity, entity_id, summary, data }) {
  const row = {
    id: uid('act_'), ts: now(), actor: actor || null, type,
    entity: entity || null, entity_id: entity_id || null,
    summary, data: data ? JSON.stringify(data) : null,
  };
  run(
    `INSERT INTO activity (id,ts,actor,type,entity,entity_id,summary,data)
     VALUES (?,?,?,?,?,?,?,?)`,
    row.id, row.ts, row.actor, row.type, row.entity, row.entity_id, row.summary, row.data,
  );
  return row;
}

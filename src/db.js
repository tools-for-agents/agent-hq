// Agent HQ — persistence layer built on Node's built-in SQLite (node:sqlite).
// Zero external dependencies: the whole platform runs on the Node standard library.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.HQ_DB_PATH || './data/agenthq.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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

CREATE INDEX IF NOT EXISTS idx_tasks_board   ON tasks(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_col     ON tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_mem_agent     ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts   ON activity(ts);
`);

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

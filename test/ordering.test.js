// agent-hq ordering test — the activity feed, comments, messages and the default-board pick all
// order by a timestamp (ts / created_at), which is not unique: it is now() at millisecond
// resolution, and agent-hq is written by many agents at once, so rows created in the same tick
// tie. ORDER BY a tied column falls back to rowid, an order SQLite never promised and a delete can
// disturb. Every timestamp ordering now tie-breaks on id (the primary key). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const work = mkdtempSync(join(tmpdir(), 'hq-order-'));
const dbPath = join(work, 'hq.db');
process.env.HQ_DB_PATH = dbPath;
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { Activity } = await import('../src/services.js');
const { logActivity } = await import('../src/db.js');

// a burst of activity — then force every ts to the same value, the tie a busy company produces
const ids = [];
for (let i = 0; i < 6; i++) ids.push(logActivity({ type: 'task.moved', entity: 'task', entity_id: `t${i}`, summary: `moved ${i}` }).id);
const TIED = '2026-07-10T12:00:00.000Z';
{
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE activity SET ts = ?').run(TIED);
  db.close();
}

const feedIds = () => Activity.recent({ limit: 100 }).map((a) => a.id);

test('the activity feed orders tied timestamps deterministically, by id', () => {
  const order = feedIds();
  // recent() is ts DESC, id DESC — with every ts tied, that is purely id DESC
  const byIdDesc = [...order].sort().reverse();
  assert.deepEqual(order, byIdDesc,
    `a feed of same-tick events must have a defined order (id DESC), not rowid order — got ${order}`);

  // and it is the same order on a second read — a feed that reshuffles itself between refreshes is
  // the specific thing a tie-break prevents
  assert.deepEqual(feedIds(), order, 'the feed must not reorder between two reads');
});

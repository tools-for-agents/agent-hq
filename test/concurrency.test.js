// agent-hq concurrency test — the claim is meant to be atomic under REAL contention, not just when
// two claims are made one after the other. The kit has been bitten here: db.js records that before
// PRAGMA busy_timeout was set, two concurrent writers to this store lost 45 of 60 writes. The
// single-threaded "a second claimant is refused" test cannot see that — it never has two writers at
// once. This one spawns N workers that all race for the SAME task from a barrier, and asserts the
// invariant that must hold no matter the timing: exactly one wins, and NOBODY crashes on a lock.
// Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const work = mkdtempSync(join(tmpdir(), 'hq-conc-'));
const dbPath = join(work, 'hq.db');
process.env.HQ_DB_PATH = dbPath;
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { Boards, Tasks } = await import('../src/services.js');

// Each worker: set the db path, import services fresh, wait for the "go" barrier, then claim.
const WORKER = `
  const { workerData, parentPort } = require('node:worker_threads');
  process.env.HQ_DB_PATH = workerData.dbPath;
  (async () => {
    const { Tasks } = await import(${JSON.stringify(new URL('../src/services.js', import.meta.url).href)});
    parentPort.postMessage({ ready: true });
    await new Promise((r) => parentPort.once('message', r));   // barrier: all workers start together
    let res;
    try { res = { ok: Tasks.claim(workerData.taskId, workerData.agent).ok }; }
    catch (e) { res = { error: String(e && e.message || e) }; }
    parentPort.postMessage(res);
  })();
`;

async function raceForTask(taskId, workers) {
  const ws = Array.from({ length: workers }, (_, i) =>
    new Worker(WORKER, { eval: true, workerData: { dbPath, taskId, agent: `agent-${i}` } }));
  // wait for every worker to be ready (imported + at the barrier)
  await Promise.all(ws.map((w) => new Promise((r) => w.once('message', r))));
  const results = ws.map((w) => new Promise((r) => w.once('message', r)));
  ws.forEach((w) => w.postMessage('go'));               // release the barrier
  const out = await Promise.all(results);
  await Promise.all(ws.map((w) => w.terminate()));
  return out;
}

test('under real contention, exactly one worker claims a task and none crash on the lock', async () => {
  const board = Boards.create({ name: 'race' });
  // several independent tasks, each fought over by a pack of workers — more rounds, more chances
  // to hit the window where two writers overlap
  for (let round = 0; round < 5; round++) {
    const t = Tasks.create({ board_id: board.id, column: 'Todo', title: `race ${round}` });
    const results = await raceForTask(t.id, 6);

    const winners = results.filter((r) => r.ok === true).length;
    const errors = results.filter((r) => r.error);

    assert.equal(winners, 1, `exactly one worker must win task ${round}, got ${winners}: ${JSON.stringify(results)}`);
    assert.deepEqual(errors, [], `no worker may crash on a lock — busy_timeout is what prevents it: ${JSON.stringify(errors)}`);

    // and the DB agrees on who holds it
    const held = Tasks.get(t.id).assignee;
    assert.ok(held && /^agent-\d$/.test(held), `the task must record a single real holder, got ${held}`);
  }
});

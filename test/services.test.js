// agent-hq service tests — run with `node --test`. Exercises the kanban
// dependency logic and shared memory against a throwaway database. Each test
// that pulls work uses its own board, so tests don't contend for tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'hq-test-'));
process.env.HQ_DB_PATH = join(work, 'hq.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { Boards, Tasks, Memory } = await import('../src/services.js');
const newBoard = () => Boards.create({ name: 'Test board' }).id;

test('ensureDefault provides a board with the standard columns', () => {
  const names = Boards.ensureDefault().columns.map((c) => c.name);
  assert.ok(names.includes('Todo') && names.includes('Done'));
});

test('a dependency blocks kanban_next until the blocker reaches Done', () => {
  const bid = newBoard();
  const a = Tasks.create({ board_id: bid, column: 'Todo', title: 'A', priority: 'high' });
  const b = Tasks.create({ board_id: bid, column: 'Todo', title: 'B', priority: 'high' });
  Tasks.addDep(a.id, b.id);
  assert.equal(Tasks.next('w1', { board_id: bid }).task.title, 'B', 'A is blocked, B is handed out');
  Tasks.update(b.id, { column: 'Done' });
  assert.equal(Tasks.next('w2', { board_id: bid }).task.title, 'A', 'A unblocks once B is Done');
});

test('addDep rejects a circular dependency', () => {
  const bid = newBoard();
  const x = Tasks.create({ board_id: bid, column: 'Todo', title: 'X' });
  const y = Tasks.create({ board_id: bid, column: 'Todo', title: 'Y' });
  Tasks.addDep(x.id, y.id);
  assert.throws(() => Tasks.addDep(y.id, x.id), /circular/i);
});

test('rmDep unblocks a task', () => {
  const bid = newBoard();
  const p = Tasks.create({ board_id: bid, column: 'Todo', title: 'P', priority: 'high' });
  const q = Tasks.create({ board_id: bid, column: 'Todo', title: 'Q', priority: 'low' });
  Tasks.addDep(p.id, q.id);
  assert.equal(Tasks.next('a', { board_id: bid }).task.title, 'Q', 'P blocked → only Q available');
  Tasks.rmDep(p.id, q.id);
  assert.equal(Tasks.next('b', { board_id: bid }).task.title, 'P', 'P now unblocked (Q is leased)');
});

test('next reports when nothing is available', () => {
  assert.equal(Tasks.next('x', { board_id: newBoard() }).ok, false);
});

test('claiming a task is atomic — a second claimant is refused', () => {
  const bid = newBoard();
  const t = Tasks.create({ board_id: bid, column: 'Todo', title: 'Solo', priority: 'urgent' });
  const first = Tasks.claim(t.id, 'a1');
  assert.equal(first.ok, true);
  const second = Tasks.claim(t.id, 'a2');
  assert.equal(second.ok, false);
});

test('memory: write then search finds it', () => {
  Memory.write({ title: 'Token rotation', content: 'JWTs rotate every 15 minutes', importance: 5, tags: ['auth'] });
  assert.ok(Memory.search({ q: 'rotate' }).some((m) => m.title === 'Token rotation'));
});

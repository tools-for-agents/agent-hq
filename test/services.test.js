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

const { Boards, Tasks, Memory, Agents, Graph, Activity, Messages, Ledger, Flow } = await import('../src/services.js');
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

test('Tasks.get hydrates comments and deps (the task-detail modal contract)', () => {
  const bid = newBoard();
  const a = Tasks.create({ board_id: bid, column: 'Todo', title: 'A', description: 'do the thing' });
  const b = Tasks.create({ board_id: bid, column: 'Todo', title: 'B' });
  Tasks.addDep(a.id, b.id);
  Tasks.comment(a.id, { author: 'Forge', body: 'started this' });
  const t = Tasks.get(a.id);
  assert.equal(t.description, 'do the thing');
  assert.deepEqual(t.deps, [b.id], 'deps is an array of dependency ids');
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0].author, 'Forge');
  assert.equal(t.comments[0].body, 'started this');
  assert.equal(Tasks.get('tsk_nope'), null, 'unknown id → null');
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

test('memory: agent_id filter surfaces an agent\'s authored memories (the agent-detail modal)', () => {
  const a = Agents.register({ name: 'Scribe', role: 'writer', avatar: '✍️' });
  const m = Memory.write({ agent_id: a.id, title: 'Authored note', content: 'x', namespace: 'authors' });
  const mine = Memory.search({ agent_id: a.id, limit: 100 }).find((x) => x.id === m.id);
  assert.ok(mine, 'the authored memory is returned for its agent');
  assert.equal(mine.agent_id, a.id, 'the memory carries its author id (the modal client-filters on this)');
});

test('memory: namespace filter narrows to one namespace (drives the dashboard filter chips)', () => {
  Memory.write({ title: 'Infra note', content: 'x', namespace: 'nsfilter-ops' });
  Memory.write({ title: 'Design note', content: 'y', namespace: 'nsfilter-design' });
  const ops = Memory.search({ namespace: 'nsfilter-ops', limit: 100 });
  assert.ok(ops.length >= 1 && ops.every((m) => m.namespace === 'nsfilter-ops'), 'only the requested namespace is returned');
  assert.ok(!ops.some((m) => m.namespace === 'nsfilter-design'), 'other namespaces are excluded');
});

test('graph: memories link to their namespace, tags, and author', () => {
  const author = Agents.register({ name: 'Cartographer', role: 'graph tester', avatar: '🗺️' });
  const m1 = Memory.write({ title: 'Graph node A', content: 'x', namespace: 'gtest', tags: ['shared-tag', 'a-only'], agent_id: author.id });
  const m2 = Memory.write({ title: 'Graph node B', content: 'y', namespace: 'gtest', tags: ['shared-tag'] });

  const g = Graph.build();
  const has = (id) => g.nodes.some((n) => n.id === id);
  const edge = (s, t, type) => g.edges.some((e) => e.source === s && e.target === t && e.type === type);

  // nodes of every type exist
  assert.ok(has('mem:' + m1.id) && has('mem:' + m2.id), 'memory nodes present');
  assert.ok(has('ns:gtest'), 'namespace node present');
  assert.ok(has('tag:shared-tag'), 'tag node present');
  assert.ok(has('agt:' + author.id), 'author node present');

  // edges wire memory → namespace/tag and author → memory
  assert.ok(edge('mem:' + m1.id, 'ns:gtest', 'namespace'), 'memory→namespace edge');
  assert.ok(edge('mem:' + m1.id, 'tag:shared-tag', 'tagged'), 'memory→tag edge');
  assert.ok(edge('agt:' + author.id, 'mem:' + m1.id, 'authored'), 'author→memory edge');

  // the shared tag is a hub touching both memories; a null-author memory has no author edge
  const sharedTag = g.nodes.find((n) => n.id === 'tag:shared-tag');
  assert.equal(sharedTag.count, 2, 'shared tag counts both memories');
  assert.ok(!g.edges.some((e) => e.target === 'mem:' + m2.id && e.type === 'authored'), 'org-wide memory has no author');

  // the compact digest ranks the shared tag as the top hub for this namespace
  const s = Graph.summary({ top: 5 });
  assert.ok(s.stats.memories >= 2 && s.top_tags.length && s.namespaces.length, 'summary has stats + rankings');
  const shared = s.top_tags.find((t) => t.label === 'shared-tag');
  assert.ok(shared && shared.memories === 2, 'digest counts the shared tag hub');
  assert.ok(s.top_authors.some((a) => a.agent === 'Cartographer'), 'digest lists the author');
});

test('activity: recent can filter to one agent\'s timeline', () => {
  const alfa = Agents.register({ name: 'Alfa-timeline', role: 'r', avatar: '🅰️' });
  const beta = Agents.register({ name: 'Beta-timeline', role: 'r', avatar: '🅱️' });
  // each register + a status change emits activity attributed to that agent
  Agents.update(alfa.id, { status: 'working' });
  Agents.update(beta.id, { status: 'working' });

  const mine = Activity.recent({ actor: alfa.id });
  assert.ok(mine.length >= 1, 'the agent has activity');
  assert.ok(mine.every((a) => a.actor === alfa.id), 'only this agent\'s activity is returned');
  assert.ok(!mine.some((a) => a.actor === beta.id), 'no other agent leaks in');

  const all = Activity.recent({});
  assert.ok(all.length > mine.length, 'unfiltered returns more than one agent\'s slice');
});

test('activity: recent can filter to one category (the type-filter chips)', () => {
  const def = Boards.ensureDefault();
  const t = Tasks.create({ board_id: def.id, column: def.columns[0].name, title: 'Categorised task', created_by: null });
  Tasks.comment(t.id, { author: null, body: 'a comment' });          // → task.comment
  const gk = Agents.register({ name: 'Gekko-cat', role: 'r', avatar: '🦎' });
  Memory.write({ agent_id: gk.id, title: 'Cat memo', content: 'x', namespace: 'n' });  // → memory.write

  const tasks = Activity.recent({ type: 'task' });
  assert.ok(tasks.length >= 1, 'there is task activity');
  assert.ok(tasks.every((a) => a.type.startsWith('task.')), 'only task.* events are returned');
  assert.ok(!tasks.some((a) => a.type.startsWith('memory.')), 'memory events do not leak into the task category');

  const mem = Activity.recent({ type: 'memory' });
  assert.ok(mem.some((a) => a.type === 'memory.write'), 'the memory category surfaces memory.write');

  // a non-numeric limit (from ?limit=abc) must not empty or error the feed
  assert.equal(Activity.recent({ limit: 'abc' }).length, Activity.recent({}).length, 'bad limit falls back to the default');
});

test('messages: compose send posts a directed message, and a null recipient is a broadcast (the compose-bar contract)', () => {
  const gus = Agents.register({ name: 'Gus-compose', role: 'r', avatar: '🧑' });
  const pam = Agents.register({ name: 'Pam-compose', role: 'r', avatar: '👩' });

  // directed: from Gus → Pam, exactly what the compose form POSTs
  const direct = Messages.send({ from_agent: gus.id, to_agent: pam.id, body: 'ship it' });
  assert.equal(direct.from_agent, gus.id);
  assert.equal(direct.to_agent, pam.id);
  assert.ok(Messages.recent().some((m) => m.id === direct.id), 'appears in the recent feed the tab renders');

  // 📢 everyone: a null recipient is a broadcast that reaches Pam's inbox
  const bcast = Messages.send({ from_agent: gus.id, to_agent: null, body: 'standup in 5' });
  assert.equal(bcast.to_agent, null);
  assert.ok(Messages.inbox({ agent: pam.id }).some((m) => m.id === bcast.id), 'broadcast lands in every other agent\'s inbox');

  // an empty body is rejected (the form guards this client-side too)
  assert.throws(() => Messages.send({ from_agent: gus.id, body: '' }), /body required/);
});

test('ledger: summary exposes a chronological spend series (drives the sparkline)', () => {
  const gil = Agents.register({ name: 'Gil-ledger', role: 'r', avatar: '💠' });
  Ledger.record({ agent_id: gil.id, label: 'plan', model: 'claude-haiku-4-5-20251001', input_tokens: 100, output_tokens: 50, cost_usd: 0.01 });
  Ledger.record({ agent_id: gil.id, label: 'build', model: 'claude-haiku-4-5-20251001', input_tokens: 200, output_tokens: 80, cost_usd: 0.02 });

  const s = Ledger.summary();
  assert.ok(Array.isArray(s.spend_series), 'summary carries a spend_series array');
  assert.ok(s.spend_series.length >= 2, 'the recorded runs appear in the series');
  const ts = s.spend_series.map((x) => new Date(x.started_at).getTime());
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'the series is in chronological order');
  // the sparkline's cumulative endpoint must equal the reported total spend
  const cum = s.spend_series.reduce((a, x) => a + x.cost_usd, 0);
  assert.ok(Math.abs(cum - s.total_cost_usd) < 1e-9, 'the cumulative series sums to total spend');
});

test('list/summary functions coerce a bad limit/top — closes the input-robustness sweep', () => {
  const a = Agents.register({ name: 'Ada-posint', role: 'r', avatar: '🅰️' });
  const b = Agents.register({ name: 'Bo-posint', role: 'r', avatar: '🅱️' });
  Messages.send({ from_agent: a.id, to_agent: b.id, body: 'hi' });
  Ledger.record({ agent_id: a.id, label: 'r', model: 'claude-haiku-4-5-20251001', input_tokens: 1, output_tokens: 1, cost_usd: 0.001 });
  Memory.write({ agent_id: a.id, title: 'Posint memo', content: 'x', namespace: 'n', tags: ['posint'] });

  // a bad limit (NaN from ?limit=abc, or ≤0) used to bind LIMIT NaN (SQL error)
  // or LIMIT 0 (empty) — every list fn must fall back to its default set instead
  for (const bad of [NaN, 0, -5, 'abc', undefined]) {
    assert.equal(Messages.recent(bad).length, Messages.recent().length, `Messages.recent limit=${String(bad)}`);
    assert.equal(Ledger.list(bad).length, Ledger.list().length, `Ledger.list limit=${String(bad)}`);
    assert.equal(Memory.list(bad).length, Memory.list().length, `Memory.list limit=${String(bad)}`);
    assert.equal(Memory.search({ limit: bad }).length, Memory.search({}).length, `Memory.search limit=${String(bad)}`);
    assert.equal(Messages.inbox({ agent: b.id, limit: bad }).length, Messages.inbox({ agent: b.id }).length, `Messages.inbox limit=${String(bad)}`);
  }
  // Graph.summary top: a bad top must not slice(0, NaN) → empty rankings
  assert.equal(Graph.summary({ top: 'abc' }).top_tags.length, Graph.summary({}).top_tags.length, 'Graph.summary top=abc recovers the default');
  // a valid small limit is still honoured
  assert.ok(Messages.recent(1).length <= 1, 'a valid small limit is respected');
});

test('a WIP limit stops a column taking on more work than it can finish', () => {
  const bid = newBoard();
  const t1 = Tasks.create({ board_id: bid, column: 'Todo', title: 'one' });
  const t2 = Tasks.create({ board_id: bid, column: 'Todo', title: 'two' });
  const t3 = Tasks.create({ board_id: bid, column: 'Todo', title: 'three' });

  // no limit by default — a column takes whatever it is given
  Tasks.update(t1.id, { column: 'In Progress' });
  Tasks.update(t2.id, { column: 'In Progress' });

  const col = Boards.setWipLimit({ board_id: bid, column: 'In Progress', wip_limit: 2 });
  assert.equal(col.wip_limit, 2);
  assert.equal(col.at_limit, true, 'two tasks against a limit of two is AT the limit');
  assert.equal(col.over_limit, false);

  // the third task cannot join a full column…
  assert.throws(() => Tasks.update(t3.id, { column: 'In Progress' }), /WIP limit \(2\/2\)/);
  const colOf = (id) => Tasks.list({ board_id: bid }).find((t) => t.id === id).column_name;
  assert.equal(colOf(t3.id), 'Todo', 'the refused task did not move');
  // …nor can a new one be created straight into it
  assert.throws(() => Tasks.create({ board_id: bid, column: 'In Progress', title: 'four' }), /WIP limit/);

  // force is the escape hatch, and it puts the column OVER its limit
  Tasks.update(t3.id, { column: 'In Progress', force: true });
  const board = Boards.full(bid);
  const ip = board.columns.find((c) => c.name === 'In Progress');
  assert.equal(ip.tasks.length, 3);
  assert.equal(ip.over_limit, true, 'the board reports the column as over its limit');

  // finishing work frees the column up again
  Tasks.update(t1.id, { column: 'Done' });
  Tasks.update(t2.id, { column: 'Done' });
  assert.equal(Boards.full(bid).columns.find((c) => c.name === 'In Progress').over_limit, false);
  const t5 = Tasks.create({ board_id: bid, column: 'In Progress', title: 'five' });
  assert.equal(colOf(t5.id), 'In Progress', 'room again, so the task lands');

  // lifting the limit removes the guard entirely
  assert.equal(Boards.setWipLimit({ board_id: bid, column: 'In Progress', wip_limit: 0 }).wip_limit, null);
  Tasks.create({ board_id: bid, column: 'In Progress', title: 'six' });
  const lifted = Boards.full(bid).columns.find((c) => c.name === 'In Progress');
  assert.equal(lifted.at_limit, false);
  assert.equal(lifted.wip_limit, null);
});

test('Flow: throughput, cycle time and what is still in flight', () => {
  const bid = newBoard();
  const before = Flow.summary();

  const a = Tasks.create({ board_id: bid, column: 'Todo', title: 'flow-a' });
  const b = Tasks.create({ board_id: bid, column: 'Todo', title: 'flow-b' });
  Tasks.create({ board_id: bid, column: 'Todo', title: 'flow-c' });   // never finished — stays WIP

  // moving to a non-Done column is not finishing
  Tasks.update(a.id, { column: 'In Progress' });
  const mid = Flow.summary();
  assert.equal(mid.done, before.done, 'moving to In Progress does not count as done');

  Tasks.update(a.id, { column: 'Done' });
  Tasks.update(b.id, { column: 'Done' });

  const f = Flow.summary();
  assert.equal(f.done, before.done + 2, 'two tasks finished');
  assert.equal(f.created, before.created + 3, 'three were created');
  assert.equal(f.wip, before.wip + 1, 'the unfinished one is still in flight');

  // today's bucket carries them, and the window is contiguous
  assert.equal(f.by_day.length, f.days);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(f.by_day.at(-1).day === today, 'the last bucket is today');
  assert.equal(f.by_day.reduce((n, d) => n + d.done, 0), f.done, 'the daily buckets sum to the total');

  // cycle time is measured from creation, and the finished tasks are ranked
  assert.equal(f.cycle.n, f.done, 'every finished task has a cycle time');
  assert.ok(f.cycle.median_hours >= 0, 'a cycle time is not negative');
  assert.ok(f.slowest.length > 0 && f.slowest[0].hours >= (f.slowest.at(-1)?.hours ?? 0), 'slowest first');
  assert.ok(f.slowest.some((s) => s.title === 'flow-a' || s.title === 'flow-b'));

  // the move records WHERE it went, so flow never has to parse a sentence
  const moved = Activity.recent({ type: 'task', limit: 200 })
    .find((x) => x.type === 'task.moved' && x.entity_id === b.id);
  const md = typeof moved.data === 'string' ? JSON.parse(moved.data) : moved.data;   // Activity.recent parses it; the raw row does not
  assert.equal(md.to, 'Done', 'the move records where it went');
  assert.equal(md.from, 'Todo', 'and where it came from');

  // a bad ?days falls back rather than emptying the window
  assert.equal(Flow.summary({ days: 'abc' }).days, 14);
  assert.equal(Flow.summary({ days: 3 }).by_day.length, 3);
});

test('Flow: one agent\'s flow is their own — what they finished, and what they still hold', () => {
  const bid = newBoard();
  const alice = Agents.register({ name: 'Alice-flow' }).id;
  const bob = Agents.register({ name: 'Bob-flow' }).id;

  const a1 = Tasks.create({ board_id: bid, column: 'Todo', title: 'alice-1', created_by: alice, assignee: alice });
  const a2 = Tasks.create({ board_id: bid, column: 'Todo', title: 'alice-2', created_by: alice, assignee: alice });
  const b1 = Tasks.create({ board_id: bid, column: 'Todo', title: 'bob-1', created_by: bob, assignee: bob });

  Tasks.update(a1.id, { column: 'Done' }, alice);      // alice finished one
  Tasks.update(b1.id, { column: 'Done' }, bob);        // bob finished one

  const fa = Flow.summary({ actor: alice });
  const fb = Flow.summary({ actor: bob });
  const co = Flow.summary();

  assert.equal(fa.actor, alice);
  assert.equal(fa.done, 1, 'alice finished exactly her own');
  assert.equal(fa.created, 2, 'and started two');
  assert.equal(fb.done, 1, "bob's finish is not credited to alice");
  assert.ok(co.done >= fa.done + fb.done, 'the company sees both');

  // in flight = what is ASSIGNED to them and still open, not everything they touched
  assert.equal(fa.wip, 1, 'alice still holds alice-2');
  assert.equal(fb.wip, 0, 'bob holds nothing');

  // an agent who moved someone else's task gets the credit for finishing it
  Tasks.update(a2.id, { column: 'Done' }, bob);
  assert.equal(Flow.summary({ actor: bob }).done, 2, 'bob finished it, so bob is credited');
  assert.equal(Flow.summary({ actor: alice }).done, 1, 'alice is not');
  assert.equal(Flow.summary({ actor: alice }).wip, 0, 'and alice now holds nothing open');
});

// ── HTTP layer: the dashboard's new-task form posts here, and depends on the
// server telling it the truth when a WIP limit refuses the task.
const { createHqServer } = await import('../src/server.js');

test('serve: POST /api/tasks creates a task — and says so when a WIP limit refuses it', async () => {
  const server = createHqServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (body) => fetch(base + '/api/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const bid = newBoard();
    const made = await post({ board_id: bid, column: 'Todo', title: 'from the dashboard',
      priority: 'high', labels: ['ops'] }).then((r) => r.json());
    assert.equal(made.title, 'from the dashboard');
    assert.equal(made.priority, 'high');
    assert.deepEqual(made.labels, ['ops']);
    assert.equal(Tasks.list({ board_id: bid }).find((t) => t.id === made.id).column_name, 'Todo');

    // cap the column, fill it, then aim another task at it
    Boards.setWipLimit({ board_id: bid, column: 'Review', wip_limit: 1 });
    await post({ board_id: bid, column: 'Review', title: 'fills review' });

    const refused = await post({ board_id: bid, column: 'Review', title: 'one too many' });
    assert.equal(refused.status, 400, 'the server refuses it');
    const body = await refused.json();
    // the form shows this string verbatim — it has to name the column and the cap
    assert.match(body.error, /Review/);
    assert.match(body.error, /WIP limit \(1\/1\)/);
    assert.ok(!Tasks.list({ board_id: bid }).some((t) => t.title === 'one too many'),
      'and the task really was not created');

    // aiming it somewhere with room works — which is what the error tells you to do
    const ok = await post({ board_id: bid, column: 'Todo', title: 'one too many' }).then((r) => r.json());
    assert.ok(ok.id);
  } finally { server.close(); }
});

test('the board says what is blocked — and what finishing would free', () => {
  const bid = newBoard();
  const found = Tasks.create({ board_id: bid, column: 'Todo', title: 'foundation' });
  const a = Tasks.create({ board_id: bid, column: 'Todo', title: 'waits on foundation' });
  const b = Tasks.create({ board_id: bid, column: 'Todo', title: 'also waits on foundation' });
  Tasks.addDep(a.id, found.id);
  Tasks.addDep(b.id, found.id);

  const cardsOf = (board) => Object.fromEntries(board.columns.flatMap((c) => c.tasks).map((t) => [t.id, t]));

  let cards = cardsOf(Boards.full(bid));
  assert.equal(cards[a.id].blocked, true, 'a task waiting on an unfinished task is blocked');
  assert.deepEqual(cards[a.id].blocked_by, [found.id], 'and says what it is waiting on');
  assert.equal(cards[b.id].blocked, true);
  // the other side: finishing the foundation frees both
  assert.equal(cards[found.id].blocked, false, 'the foundation itself is ready');
  assert.equal(cards[found.id].blocks, 2, 'and two tasks are waiting on it');
  assert.equal(cards[a.id].blocks, 0);

  // the board agrees with who actually gets handed work
  assert.equal(Tasks.next('w1', { board_id: bid }).task.id, found.id, 'only the unblocked task is handed out');

  // finish it — both dependants become startable, and nothing is waiting any more
  Tasks.update(found.id, { column: 'Done' });
  cards = cardsOf(Boards.full(bid));
  assert.equal(cards[a.id].blocked, false, 'the blocker is Done, so the task is startable');
  assert.equal(cards[b.id].blocked, false);
  assert.equal(cards[found.id].blocks, 0, 'a finished task holds nobody up');

  // a dependency on a task that no longer exists cannot block forever
  const c = Tasks.create({ board_id: bid, column: 'Todo', title: 'waits on a ghost' });
  const doomed = Tasks.create({ board_id: bid, column: 'Todo', title: 'about to be deleted' });
  Tasks.addDep(c.id, doomed.id);
  assert.equal(cardsOf(Boards.full(bid))[c.id].blocked, true);
  Tasks.remove(doomed.id);
  assert.equal(cardsOf(Boards.full(bid))[c.id].blocked, false, 'a deleted blocker does not block forever');
});

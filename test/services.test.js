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

// priority is a finite enum. The MCP schema declares it, but the HTTP API and any direct caller go
// straight to Tasks.create/update — so "CRITICAL" was stored verbatim (and the priority sort, which
// only knows low/medium/high/urgent, buried it below "low"). Enforce it in the core, every path.
test('a task priority outside the enum is refused — in create AND update', () => {
  const bid = newBoard();
  assert.throws(() => Tasks.create({ board_id: bid, column: 'Todo', title: 'Bad', priority: 'CRITICAL' }),
    (e) => {
      assert.match(e.message, /priority "CRITICAL" is not one of/, 'it names the bad priority');
      assert.match(e.message, /low, medium, high, urgent/, 'and lists the valid ones');
      return true;
    });
  // Over-fire guards: every valid priority works, omitting it defaults, and update is guarded too.
  for (const p of ['low', 'medium', 'high', 'urgent']) {
    assert.equal(Tasks.create({ board_id: bid, column: 'Todo', title: `ok-${p}`, priority: p }).priority, p);
  }
  assert.equal(Tasks.create({ board_id: bid, column: 'Todo', title: 'def' }).priority, 'medium', 'omitting priority defaults, not errors');
  const t = Tasks.create({ board_id: bid, column: 'Todo', title: 'movable', priority: 'low' });
  assert.throws(() => Tasks.update(t.id, { priority: 'CRITICAL' }), /not one of/, 'update refuses a bad priority too');
  assert.doesNotThrow(() => Tasks.update(t.id, { title: 'renamed' }), 'an update that does not touch priority is fine');
  Tasks.update(t.id, { priority: 'urgent' });
  assert.equal(Tasks.get(t.id).priority, 'urgent', 'and a valid priority update sticks');
});

// labels is an ARRAY. A bare string reaches the core via the HTTP API, JSON.stringify stores it, and a
// consumer spreads it — so one label "urgent" becomes six: u, r, g, e, n, t. A string is not a list.
test('task labels must be an array — a bare string is refused, not spread into letters', () => {
  const bid = newBoard();
  assert.throws(() => Tasks.create({ board_id: bid, column: 'Todo', title: 'Bad', labels: 'urgent' }),
    /labels must be an array/, 'a string label is refused');
  // Over-fire guards: a real array works, omitting labels defaults to [], and update is guarded too.
  assert.deepEqual(Tasks.create({ board_id: bid, column: 'Todo', title: 'ok', labels: ['urgent', 'bug'] }).labels,
    ['urgent', 'bug'], 'a proper array is kept intact');
  assert.deepEqual(Tasks.create({ board_id: bid, column: 'Todo', title: 'def' }).labels, [], 'omitting labels defaults to []');
  const t = Tasks.create({ board_id: bid, column: 'Todo', title: 't', labels: ['x'] });
  assert.throws(() => Tasks.update(t.id, { labels: 'oops' }), /labels must be an array/, 'update refuses a string label too');
  assert.doesNotThrow(() => Tasks.update(t.id, { title: 'renamed' }), 'an update that does not touch labels is fine');
});

// The kit's remaining declared enums, enforced in the core (the MCP schema only guards the MCP path):
// an agent status the reaper/dashboard don't understand, or a run status the ledger buckets as neither.
test('agent status and run status are enforced against their enums, every path', () => {
  const a = Agents.register({ name: 'St' });
  assert.throws(() => Agents.update(a.id, { status: 'busy' }), /agent status "busy" is not one of idle, working, offline/, 'a bogus agent status is refused');
  assert.doesNotThrow(() => Agents.update(a.id, { status: 'working' }), 'a valid agent status works');
  assert.doesNotThrow(() => Agents.update(a.id, { role: 'dev' }), 'an update with no status is untouched');

  const r = Ledger.start({ agent_id: a.id, label: 'x' });
  assert.throws(() => Ledger.end(r.id, { status: 'cancelled' }), /run status "cancelled" is not one of done, error/, 'ending a run with a bogus status is refused');
  assert.doesNotThrow(() => Ledger.end(r.id, { status: 'error' }), 'a valid run status works');
  assert.throws(() => Ledger.record({ label: 'y', status: 'weird' }), /run status "weird"/, 'recording a run with a bogus status is refused');
  assert.doesNotThrow(() => Ledger.record({ label: 'z' }), 'the default run status (done) is fine');
});

test('the cost ledger refuses numbers that would poison the company total', () => {
  // The ledger SUMs tokens and cost across every run. Unvalidated, a negative token count stored a
  // NEGATIVE cost (silent under-bill); a NaN/string hit a raw "NOT NULL constraint failed: runs.cost_usd";
  // a bad explicit cost_usd stored garbage or crashed on `cost.toFixed`. The HTTP route passes these
  // straight through, past the MCP schema.
  const neg = Ledger.record({ label: 'neg', model: 'opus', input_tokens: -1000000, output_tokens: 0 });
  assert.equal(neg.input_tokens, 0, 'a negative token count floors to 0');
  assert.ok(neg.cost_usd >= 0, 'and never yields a negative cost');
  const str = Ledger.record({ label: 'str', model: 'opus', input_tokens: 'abc', output_tokens: NaN });
  assert.equal(str.input_tokens, 0, 'a non-numeric token count is 0, not a constraint crash');
  assert.equal(str.output_tokens, 0);
  const badCost = Ledger.record({ label: 'badcost', model: 'opus', input_tokens: 10, output_tokens: 10, cost_usd: 'x' });
  assert.ok(Number.isFinite(badCost.cost_usd) && badCost.cost_usd >= 0, "a non-numeric cost_usd is priced from tokens, not a toFixed crash");
  const negCost = Ledger.record({ label: 'negcost', model: 'opus', input_tokens: 10, output_tokens: 10, cost_usd: -5 });
  assert.ok(negCost.cost_usd >= 0, 'a negative explicit cost_usd is dropped for the token price');
  const zeroCost = Ledger.record({ label: 'zerocost', model: 'opus', input_tokens: 10, output_tokens: 10, cost_usd: 0 });
  assert.equal(zeroCost.cost_usd, 0, 'a legitimate cost of exactly 0 is preserved (?? not ||)');
  // The integrity property: whatever anyone records, the company total stays finite and non-negative.
  const total = Ledger.summary().total_cost_usd;
  assert.ok(Number.isFinite(total) && total >= 0, 'the company cost total is never NaN or negative');
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

test('a bad lease_ms defaults instead of crashing claim/next with "Invalid time value"', () => {
  const bid = newBoard();
  const t = Tasks.create({ board_id: bid, column: 'Todo', title: 'Lease' });
  // lease_ms arrives from a query param / JSON body / direct caller — the HTTP route passes body.lease_ms
  // straight through, and the MCP schema's `type:integer` guards only the MCP path. Unvalidated, a NaN
  // ('?lease_ms=abc'), Infinity, or an astronomically large value pushed `Date.now() + lease` outside the
  // valid Date range, and `.toISOString()` threw "RangeError: Invalid time value" on claim() — the throw
  // then propagated through next(), the two calls an agent makes most.
  for (const bad of [NaN, Infinity, 'abc', 1e19]) {
    const r = Tasks.claim(t.id, 'agent-A', bad);          // before the fix this LINE threw, not returned
    assert.equal(r.ok, true, `lease_ms=${bad} still claims`);
    assert.ok(!Number.isNaN(new Date(r.task.lease_until).getTime()),
      `lease_ms=${bad} yields a valid lease_until, not an Invalid Date`);
    Tasks.release(t.id, 'agent-A');
  }
  // Over/under-fire guards: a legit small lease keeps the 30s floor; a giant one is capped, not overflowed.
  const small = Tasks.claim(t.id, 'agent-A', 5000);
  assert.ok(new Date(small.task.lease_until) - Date.now() >= 29_000, 'a small lease is floored to ~30s, not defaulted away');
  Tasks.release(t.id, 'agent-A');
  const huge = Tasks.claim(t.id, 'agent-A', 1e19);
  const year = 365 * 24 * 60 * 60 * 1000;
  assert.ok(new Date(huge.task.lease_until) - Date.now() <= year + 60_000, 'a giant lease is capped at ~1 year');
});

test('memory: write then search finds it — AND EXCLUDES WHAT DOES NOT MATCH', () => {
  Memory.write({ title: 'Token rotation', content: 'JWTs rotate every 15 minutes', importance: 5, tags: ['auth'] });
  Memory.write({ title: 'Lunch order', content: 'nobody wants the anchovies', importance: 1 });

  const hits = Memory.search({ q: 'rotate' });
  assert.ok(hits.some((m) => m.title === 'Token rotation'), 'the memory that matches comes back');

  // THE NEEDLE BEING IN THE HAYSTACK IS NOT EVIDENCE THAT THE HAYSTACK WAS FILTERED.
  // This assertion used to be a bare `.some()`, and it could not fail: delete the `q` clause
  // outright and memory_search returns EVERY memory in the database — the needle is still
  // among them, and the test stays green. An agent would get the entire team's memory back
  // for any query, pay for all of it, and believe it had searched.
  assert.ok(!hits.some((m) => m.title === 'Lunch order'),
    'a memory that matches nothing in the query must NOT come back — this is a search, not a list');
});

test('memory: a tag filter with a LIKE metacharacter matches literally, not as a wildcard', () => {
  // The tag filter is a LIKE over the JSON tags array, so a `_` in the tag would match any char
  // ('a_b' → 'axb') and a `%` any run ('ci%' → 'cicd') unless the metacharacters are escaped.
  const under = Memory.write({ title: 'Underscore memo', content: 'x', tags: ['a_b'] });
  const axb = Memory.write({ title: 'Decoy memo', content: 'x', tags: ['axb'] });
  const hits = Memory.search({ tag: 'a_b', limit: 200 }).map((m) => m.id);
  assert.ok(hits.includes(under.id), "the literal 'a_b' tag is found");
  assert.ok(!hits.includes(axb.id), "'a_b' does not wildcard-match 'axb'");

  // the free-text `q` search is a LIKE too — 'node_modules' must not match 'nodexmodules'
  const real = Memory.write({ title: 'node_modules woes', content: 'deps' });
  const decoy = Memory.write({ title: 'nodexmodules typo', content: 'decoy' });
  const q = Memory.search({ q: 'node_modules', limit: 200 }).map((m) => m.id);
  assert.ok(q.includes(real.id) && !q.includes(decoy.id), "q='node_modules' matches literally, not 'nodexmodules'");
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

test('messages: a recipient addressed by NAME is delivered (not silently lost), a nonexistent one refused', () => {
  const ann = Agents.register({ name: 'Ann-msg', role: 'r', avatar: '🅰️' });
  const ben = Agents.register({ name: 'Ben-msg', role: 'r', avatar: '🅱️' });
  // to_agent may be an id OR a name (Agents.get accepts both, and the activity feed already resolves it for
  // display) — but send stored the RAW value while inbox matches on the reader's id, so a name-addressed
  // message was shown as delivered and never reached the inbox. It must resolve to the canonical id.
  const byName = Messages.send({ from_agent: ann.id, to_agent: 'Ben-msg', body: 'ping by name' });
  assert.equal(byName.to_agent, ben.id, 'the recipient name is resolved to the canonical agent id');
  assert.ok(Messages.inbox({ agent: ben.id }).some((m) => m.id === byName.id), 'and the message actually reaches the inbox');
  // a recipient that resolves to nobody is a typo, not a message to send into the void
  assert.throws(() => Messages.send({ from_agent: ann.id, to_agent: 'nobody-here', body: 'x' }),
    /no such agent/, 'a nonexistent recipient is refused, not silently stored undeliverable');
  // and a broadcast (null recipient) is untouched
  assert.equal(Messages.send({ from_agent: ann.id, to_agent: null, body: 'all' }).to_agent, null, 'a null recipient is still a broadcast');
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

test('messages: the feed says who has actually read it, not just who it was sent to', () => {
  const a = Agents.register({ name: 'Reader-A' }).id;
  const b = Agents.register({ name: 'Reader-B' }).id;
  const sender = Agents.register({ name: 'Sender' }).id;

  Messages.send({ from_agent: sender, to_agent: null, body: 'heads up, everyone' });   // broadcast
  Messages.send({ from_agent: sender, to_agent: a, body: 'just for you' });            // direct

  const find = (body) => Messages.recent(50).find((m) => m.body === body);

  // a broadcast is addressed to every agent EXCEPT its author — nobody has to read
  // their own message, and counting them would make "read by everyone" a lie
  const bc = find('heads up, everyone');
  assert.ok(!bc.audience.includes(sender), "the author is not an audience for their own message");
  assert.ok(bc.audience.includes(a) && bc.audience.includes(b));
  assert.equal(bc.read_count, 0, 'sent is not seen');
  assert.equal(bc.unread_by.length, bc.audience_count);

  // reading the inbox is what marks it read — per agent
  Messages.inbox({ agent: a, mark_read: true });
  const bc2 = find('heads up, everyone');
  assert.deepEqual(bc2.read_by, [a], 'A has read it');
  assert.ok(bc2.unread_by.includes(b), 'B has not');
  assert.equal(bc2.read_count, 1);
  assert.ok(bc2.read_count < bc2.audience_count, 'so it is not read by everyone yet');

  // the direct message to A was in the same inbox pull, so it is read too
  const dm = find('just for you');
  assert.deepEqual(dm.audience, [a], 'a direct message has an audience of one');
  assert.equal(dm.read_count, 1);
  assert.equal(dm.audience_count, 1, 'and is read by everyone it was for');

  // a broadcast is addressed to EVERY agent in the company (this DB has others from
  // earlier tests), so it is only "read by everyone" once all of them have read it
  Messages.inbox({ agent: b, mark_read: true });
  const bc3 = find('heads up, everyone');
  assert.equal(bc3.read_count, 2, 'two of them have read it');
  assert.ok(bc3.unread_by.length > 0, 'and the rest of the company has not');

  for (const id of bc3.unread_by) Messages.inbox({ agent: id, mark_read: true });
  const bc4 = find('heads up, everyone');
  assert.equal(bc4.read_count, bc4.audience_count, 'now it is read by everyone');
  assert.equal(bc4.unread_by.length, 0);
});

test('ledger: spend by model — the rate you can act on, not just the total', () => {
  const before = Ledger.summary();
  const costOfModel = (m) => (Ledger.summary().by_model.find((x) => x.model === m) || {});

  // an expensive model doing a little, and a cheap one doing a lot
  Ledger.record({ model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 1000, cost_usd: 0.09 });
  Ledger.record({ model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 0, cost_usd: 0.03 });
  Ledger.record({ model: 'claude-haiku-4-5', input_tokens: 100000, output_tokens: 20000, cost_usd: 0.12 });

  const opus = costOfModel('claude-opus-4-8');
  const haiku = costOfModel('claude-haiku-4-5');

  assert.equal(opus.runs, 2, 'runs are grouped by model');
  assert.ok(Math.abs(opus.cost_usd - 0.12) < 1e-6);
  assert.equal(opus.input_tokens + opus.output_tokens, 3000, 'and carry their tokens, so a rate can be computed');
  assert.equal(haiku.input_tokens + haiku.output_tokens, 120000);

  // the point of the feature: the two models cost the SAME in total, and wildly
  // different per token — which is the number you can actually do something about
  const rate = (m) => (m.cost_usd / (m.input_tokens + m.output_tokens)) * 1000;
  assert.ok(Math.abs(opus.cost_usd - haiku.cost_usd) < 1e-6, 'same total spend');
  assert.ok(rate(opus) > rate(haiku) * 10, 'but a wildly different cost per token');

  // a run with no model recorded still shows up, rather than silently vanishing
  Ledger.record({ input_tokens: 10, output_tokens: 10, cost_usd: 0.001 });
  assert.ok(Ledger.summary().by_model.some((m) => m.model === 'unknown'), 'unattributed spend is still spend');

  // and the totals still reconcile with the per-model rows
  const s = Ledger.summary();
  const sum = s.by_model.reduce((a, m) => a + m.cost_usd, 0);
  assert.ok(Math.abs(sum - s.total_cost_usd) < 1e-6, 'the model rows add up to the total');
  assert.ok(s.total_runs > before.total_runs);
});

// ── Is the thing you fixed the thing that is running? ───────────────────────────
// The container serving this dashboard was built on 2026-06-27 and nobody noticed for
// two weeks: `docker compose up -d` REUSES an existing image, only `--build` rebuilds
// it, and the difference is silent. The dashboard came up, it looked fine, and it was
// two weeks old. A green build on code that is not deployed tells you nothing.
test('the build fingerprint changes when the code does, and not when it does not', async () => {
  const { fingerprint } = await import('../src/build.js');
  const { mkdirSync, writeFileSync, cpSync } = await import('node:fs');

  const a = mkdtempSync(join(tmpdir(), 'hq-fp-'));
  mkdirSync(join(a, 'src')); mkdirSync(join(a, 'public')); mkdirSync(join(a, 'mcp'));
  writeFileSync(join(a, 'src', 'server.js'), 'console.log(1)');
  writeFileSync(join(a, 'public', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(a, 'package.json'), '{"name":"x"}');

  const before = fingerprint(a);
  assert.match(before, /^[0-9a-f]{12}$/, 'a fingerprint is a fingerprint');
  assert.equal(fingerprint(a), before, 'the same bytes hash the same — otherwise every check is a false alarm');

  // A copy is the same deployment: the image lives at a different path than the repo.
  const b = mkdtempSync(join(tmpdir(), 'hq-fp-'));
  cpSync(a, b, { recursive: true });
  assert.equal(fingerprint(b), before, 'the same code in a different directory is still the same code');

  // One changed byte in the UI is a different deployment. That is the whole point:
  // the fix that CI passed and nobody shipped has to be VISIBLE.
  writeFileSync(join(a, 'public', 'index.html'), '<h1>hi </h1>');
  assert.notEqual(fingerprint(a), before, 'a UI change that was never deployed must not look identical');

  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

// ── An error an agent cannot act on is an error you have not finished writing ────
test('with HQ down, the MCP server says what is wrong and what to do about it', async () => {
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    // Point it at a closed port: this is exactly what an agent hits when it installs
    // the kit and calls a tool before starting the platform.
    const p = spawn('node', ['mcp/mcp-server.js'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HQ_URL: 'http://127.0.0.1:9' },
    });
    let buf = '';
    const done = (v) => { try { p.kill('SIGKILL'); } catch {} resolve(v); };
    setTimeout(() => done(''), 12000);
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 3) done((m.result?.content || []).map((c) => c.text).join(' '));
      }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'company_stats', arguments: {} } });
  });

  // It used to say, in full: "error: fetch failed". Three words that name no cause and
  // suggest no action, so the model's next move is to guess.
  assert.match(out, /not running/, 'it says what is wrong');
  assert.match(out, /127\.0\.0\.1:9/, 'and WHERE it looked, so a wrong HQ_URL is visible');
  assert.match(out, /docker compose up|npm start/, 'and what to do about it');
});

// ── Wrong data written confidently is worse than an error ────────────────────────
// Every tool declares its argument TYPES and enums in inputSchema. Nothing enforced
// them, and unlike a missing argument these do not crash — they corrupt, in silence.
// `kanban_create_task labels:"urgent"` cheerfully created a task whose labels were the
// letters u, r, g, e, n, t. Nothing announced it. That is the worst kind of bug: the
// caller is told it worked.
test('a wrong argument type is refused, not written', async () => {
  const { spawn } = await import('node:child_process');
  const call = (name, args) => new Promise((resolve) => {
    const p = spawn('node', ['mcp/mcp-server.js'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HQ_URL: process.env.HQ_URL || 'http://localhost:7700' },
    });
    let buf = '';
    const done = (v) => { try { p.kill('SIGKILL'); } catch {} resolve(v); };
    setTimeout(() => done({}), 10000);
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { let m; try { m = JSON.parse(l); } catch { continue; } if (m.id === 3) done(m); }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  });

  const badArray = await call('kanban_create_task', { title: 'x', labels: 'urgent' });
  assert.match(badArray.error?.message || '', /"labels" must be array, got string/,
    'a string where an array was declared is refused — it used to become a task');

  const badEnum = await call('kanban_create_task', { title: 'x', priority: 'CRITICAL' });
  assert.match(badEnum.error?.message || '', /must be one of low \| medium \| high \| urgent/,
    'and the enum says which values exist, so the caller can fix it without reading the docs');

  // And the refusal must be a refusal: nothing was created.
  const r = await fetch((process.env.HQ_URL || 'http://localhost:7700') + '/api/tasks').catch(() => null);
  if (r?.ok) {
    const tasks = await r.json();
    assert.ok(!(Array.isArray(tasks) ? tasks : tasks.tasks || []).some((t) => t.title === 'x'),
      'the rejected task does not exist');
  }
});

// ── A filter that is WRONG looks exactly like a filter that matched NOTHING ──────
test('a misspelled column is a mistake, not an empty board', () => {
  const b = newBoard();
  Tasks.create({ board_id: b, column: 'Todo', title: 'real work' });

  // `kanban_list_tasks { status: "In Progres" }` — one letter short — returned []. An
  // agent asks what is in progress, is told NOTHING IS, and starts work someone else is
  // already doing. On a coordination board that is the most expensive lie in the kit.
  assert.throws(() => Tasks.list({ board_id: b, status: 'In Progres' }), /no column named "In Progres"/,
    'the typo is named');
  assert.throws(() => Tasks.list({ board_id: b, status: 'In Progres' }), /NOT "no tasks there"/,
    'and it says explicitly that this is not an empty result');
  assert.throws(() => Tasks.list({ board_id: b, status: 'In Progres' }), /Backlog, Todo, In Progress/,
    'and lists the columns that DO exist, so the fix is in the sentence');

  // And the real thing still works, including a legitimately empty column.
  assert.equal(Tasks.list({ board_id: b, status: 'Todo' }).length, 1);
  assert.deepEqual(Tasks.list({ board_id: b, status: 'Review' }), [], 'an empty REAL column is still an empty list');
});

test('creating into a column that does not exist does not quietly land in Backlog', () => {
  const b = newBoard();
  // It used to fall back to the FIRST column. You said "Done", you got "Backlog", and you
  // were told it worked. Omitting the column is a choice; misspelling it is a mistake.
  assert.throws(() => Tasks.create({ board_id: b, column: 'Doen', title: 'x' }),
    /no column named "Doen" — the task was NOT created/);
  assert.equal(Tasks.list({ board_id: b }).length, 0, 'and nothing was created');

  // Omitting it is still the default, and still works.
  const t = Tasks.create({ board_id: b, title: 'defaulted' });
  assert.ok(t.id);
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// WHO IS ALIVE? That is the question the board exists to answer, and nothing was guarding it.
//
// reapStale() marks an agent offline when its heartbeat goes quiet:
//
//   const cutoff = new Date(Date.now() - threshold_ms).toISOString();
//
// A canary flipped that minus to a plus and the entire suite stayed green. With a plus the
// cutoff lands in the FUTURE, so EVERY agent is older than it — an agent that heartbeated one
// second ago is marked offline, and an "went offline" event is emitted for every agent on
// every call. The board would show a working team as an empty room.
//
// Both directions, because one alone is a half-truth: a FRESH heartbeat must survive the reap,
// and a STALE one must not.
test('reapStale offlines the quiet agent and leaves the live one alone', async () => {
  const { run } = await import('../src/db.js');
  const live = Agents.register({ name: 'Live-reaper', role: 'worker', avatar: '🟢' });
  const quiet = Agents.register({ name: 'Quiet-reaper', role: 'worker', avatar: '🔴' });

  Agents.heartbeat(live.id);
  // backdate the other one's heartbeat past the threshold — the only way to be stale
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  run('UPDATE agents SET last_seen=?, status=? WHERE id=?', longAgo, 'working', quiet.id);

  const { offlined } = Agents.reapStale(90_000);
  assert.ok(offlined >= 1, 'the agent that went quiet ten minutes ago is offlined');

  assert.equal(Agents.get(quiet.id).status, 'offline', 'a stale heartbeat means offline');
  assert.notEqual(Agents.get(live.id).status, 'offline',
    'AN AGENT THAT JUST HEARTBEATED IS NOT OFFLINE — the reaper must not sweep the living');

  // and a heartbeat brings it back: offline is a statement about silence, not a death sentence
  Agents.heartbeat(quiet.id);
  assert.notEqual(Agents.get(quiet.id).status, 'offline', 'a heartbeat revives it');
});

// READING YOUR INBOX MUST NOT CONSUME IT.
//
// message_inbox LOOKS LIKE A GETTER, and it is the one tool in the kit that is a getter with a
// mutation inside it — which is exactly why it is annotated destructive (cycle 11). `mark_read`
// defaults to false ON PURPOSE: an agent that peeks at its inbox must not silently mark every
// message read, because then nothing is ever unread again and the next agent to look sees an
// empty inbox that is not empty.
//
// Nothing was guarding it. TWO canaries survived here: flip the default to `true`, or turn
// `if (mark_read && rows.length)` into `||` — and either way, merely LOOKING consumes the
// messages, with the whole suite green.
test('reading the inbox does not consume it — unless you say so', () => {
  const a = Agents.register({ name: 'Reader-inbox', role: 'worker', avatar: '📬' });
  const b = Agents.register({ name: 'Sender-inbox', role: 'worker', avatar: '📮' });
  const sent = Messages.send({ from_agent: b.id, to_agent: a.id, body: 'the build is red' });
  // NB: an inbox also carries BROADCASTS (to_agent IS NULL), and other tests send them — so
  // find OUR message rather than counting. (My first cut asserted length===1 and failed on a
  // broadcast from another test: the tool was right and the test was wrong.)
  const mine = (opts = {}) => Messages.inbox({ agent: a.id, ...opts }).find((m) => m.id === sent.id);

  assert.ok(mine(), 'the message is there');
  assert.equal(mine().is_read, false, 'and it is unread');

  // LOOK AGAIN. It must still be unread — the first look did not consume it.
  assert.equal(mine().is_read, false,
    'READING IS NOT CONSUMING: a plain inbox() call must never mark a message read');
  assert.ok(mine({ unread_only: true }), 'and it is still returned by an unread_only query');

  // …and when you DO ask, it is marked read, and stays read.
  assert.ok(mine({ mark_read: true }), 'asking for it with mark_read still returns it');
  assert.equal(mine({ unread_only: true }), undefined,
    'mark_read: true is the only thing that consumes the message');
  assert.equal(mine().is_read, true, 'and it stays read');
});

// AN AGENT THAT DIES MUST NOT TAKE THE TASK WITH IT.
//
// A claim is a LEASE, not a deed. The whole point of the lease_until column is that an agent
// which crashes, hangs or is killed mid-task eventually lets go — and somebody else picks the
// work up. Without that, one dead agent silently removes a task from the board forever, and an
// all-agent company deadlocks one task at a time with nothing to show for it.
//
// The suite proved a LIVE lease blocks a second claimant. It never proved an EXPIRED one lets
// go — the direction that actually rescues you. Both halves, or it is a half-truth.
test('a lease that has expired can be claimed by somebody else — a live one cannot', async () => {
  const { run, get } = await import('../src/db.js');
  const b = Boards.create({ name: 'Lease board' });
  const t = Tasks.create({ board_id: b.id, title: 'the task the dead agent was holding' });

  assert.equal(Tasks.claim(t.id, 'agent-alive').ok, true, 'the first agent takes it');
  const blocked = Tasks.claim(t.id, 'agent-other');
  assert.equal(blocked.ok, false, 'a LIVE lease blocks everyone else');
  assert.equal(blocked.held_by, 'agent-alive', 'and says who is holding it');

  // The agent dies. Nothing announces that; the lease simply runs out.
  run('UPDATE tasks SET lease_until=? WHERE id=?', new Date(Date.now() - 60_000).toISOString(), t.id);

  const rescued = Tasks.claim(t.id, 'agent-other');
  assert.equal(rescued.ok, true,
    'AN EXPIRED LEASE LETS GO — otherwise one dead agent removes a task from the board forever');
  assert.equal(get('SELECT assignee FROM tasks WHERE id=?', t.id).assignee, 'agent-other',
    'and the work now belongs to whoever picked it up');
});

// A WRONG NUMBER DRESSED AS A MEASUREMENT.
//
// kanban_flow is an MCP tool: an agent asks "how is the team actually doing?" and gets back a
// median cycle time, an average, and the five slowest tasks. FOUR separate mutants survived in
// that arithmetic — the sort could be reversed, the median could SUBTRACT instead of add, the
// average could subtract, and "slowest" could return the fastest. The suite was green for all of
// them, because nothing ever checked a number it knew the answer to.
//
// So: four tasks, created a known number of hours ago, all finished now. The maths is not a
// matter of opinion.
//     cycles = [1, 2, 10, 20]  ->  median = (2 + 10) / 2 = 6   avg = 33/4 = 8.3   slowest = 20
test('flow reports the cycle time it actually measured — median, average and slowest', async () => {
  const { run } = await import('../src/db.js');
  const b = Boards.create({ name: 'Flow board' });
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

  for (const h of [1, 2, 10, 20]) {
    const t = Tasks.create({ board_id: b.id, title: `took ${h}h` });
    run('UPDATE tasks SET created_at=? WHERE id=?', hoursAgo(h), t.id);
    Tasks.update(t.id, { column: 'Done' }, 'flow-agent');      // finished, now
  }

  // Scope to OUR actor. flow() aggregates every finished task in the window, and the other
  // tests in this file create-and-finish tasks in milliseconds — a pile of ~0h cycles that drag
  // the median to zero. My first cut of this test asserted against that pile and failed: the
  // tool was right and the test was measuring the wrong population.
  const f = Flow.summary({ days: 2, actor: 'flow-agent' });
  const mine = f.slowest.filter((s) => /^took \d+h$/.test(s.title));
  assert.equal(f.cycle.n, 4, 'it measured exactly the four tasks this test finished');
  assert.equal(f.cycle.median_hours, 6, `the median of [1,2,10,20] is 6, got ${f.cycle.median_hours}`);
  assert.equal(f.cycle.avg_hours, 8.3, `the average of [1,2,10,20] is 8.3, got ${f.cycle.avg_hours}`);
  assert.equal(mine[0].hours, 20, `the SLOWEST is the 20h task, got ${mine[0]?.hours}`);
});

// THE LEDGER IS HOW AN ALL-AGENT COMPANY KNOWS WHAT IT IS SPENDING, and not one number in it was
// checked. The existing test records two runs and then asserts only that `spend_series` is an
// array with at least two entries in it — never what any of the numbers say.
//
// So `total_tokens: input + output` could become `input - output` and the suite stayed green. An
// agent calls ledger_summary, asks what the work has cost, and is handed a difference dressed up
// as a total — often a NEGATIVE one. A wrong number dressed as a measurement, and this one is
// about money.
//
// Measured as a DELTA, because Ledger.summary() sums the whole table and the other tests in this
// file record runs of their own. (Four times today a test of mine measured the wrong population.
// The tool was right every time.)
test('the ledger adds up: tokens, cost, and the per-model breakdown', () => {
  const before = Ledger.summary();
  const agent = Agents.register({ name: 'Accountant', role: 'ledger', avatar: '🧾' });
  const MODEL = 'model-for-the-ledger-test';

  Ledger.record({ agent_id: agent.id, label: 'plan',  model: MODEL, input_tokens: 100, output_tokens: 50, cost_usd: 0.01 });
  Ledger.record({ agent_id: agent.id, label: 'build', model: MODEL, input_tokens: 200, output_tokens: 80, cost_usd: 0.02 });

  const after = Ledger.summary();
  assert.equal(after.total_input_tokens - before.total_input_tokens, 300, 'input tokens are summed');
  assert.equal(after.total_output_tokens - before.total_output_tokens, 130, 'output tokens are summed');
  assert.equal(after.total_tokens - before.total_tokens, 430,
    'AND THE TOTAL IS THE SUM OF THE TWO — 300 + 130 = 430, not the difference between them');
  assert.equal(Math.round((after.total_cost_usd - before.total_cost_usd) * 1e6) / 1e6, 0.03, 'and the money adds up');

  // …and the per-model row, which is what tells you the rate that actually matters.
  const model = after.by_model.find((m) => m.model === MODEL);
  assert.ok(model, 'the model appears in the breakdown');
  assert.equal(model.runs, 2);
  assert.equal(model.input_tokens, 300);
  assert.equal(model.output_tokens, 130);

  // …and the per-agent row, so you can see who spent it.
  const mine = after.by_agent.find((a) => a.agent_id === agent.id);
  assert.ok(mine, 'the agent appears in the breakdown');
  assert.equal(mine.runs, 2);
  assert.equal(Math.round(mine.cost_usd * 1e6) / 1e6, 0.03, 'and is billed for exactly what it spent');
});

// THE LEDGER'S NUMBERS ONLY MEAN SOMETHING IF THE PRICING BEHIND THEM IS RIGHT.
//
// An agent logs a run with token counts and NO cost, and agent-hq prices it — costOf(model, in,
// out). Every test until now passed an explicit cost_usd, so the auto-pricing path (the one an
// agent actually takes) was never exercised. If costOf were wrong — wrong arithmetic, wrong
// model match, wrong fallback — every auto-priced run mischarges, and the ledger, the thing a
// company uses to know what it spent, is quietly wrong in a way nothing announces.
test('costOf prices tokens by the model rate, matches by substring, and falls back to default', async () => {
  const { costOf } = await import('../src/pricing.js');
  // arithmetic: USD per 1M tokens, input rate + output rate
  assert.equal(costOf('claude-opus-4-8', 1e6, 1e6), 90, 'opus 1M+1M = 15 + 75');
  assert.equal(costOf('claude-haiku-4-5', 1e6, 0), 1, 'haiku 1M input = 1');
  assert.equal(costOf('claude-sonnet-5', 0, 2e6), 30, 'sonnet 2M output = 2 × 15');
  // substring match: the full model id contains the family key
  assert.equal(costOf('claude-opus-4-8', 1000, 0), costOf('opus', 1000, 0), 'full id matches the family');
  // a model on no list falls back to the default rate, not to zero (free tokens hide real spend)
  assert.equal(costOf('some-unlisted-model', 1e6, 1e6), 18, 'unknown model → default 3 + 15');
  assert.notEqual(costOf('some-unlisted-model', 1e6, 1e6), 0, 'and NEVER free — that would hide real cost');
  assert.equal(costOf('opus', 0, 0), 0, 'zero tokens cost zero');
});

// …and the same, through the door an agent uses: record a run with tokens and no cost, and the
// ledger must show the computed price — not zero, not undefined.
test('run.record auto-prices a run when the agent gives tokens but no cost', () => {
  const before = Ledger.summary().total_cost_usd;
  const r = Ledger.record({ label: 'auto', model: 'claude-opus-4-8', input_tokens: 1e6, output_tokens: 1e6 });
  assert.equal(r.cost_usd, 90, 'the run was priced from its tokens (opus 1M+1M = 90)');
  assert.equal(Math.round((Ledger.summary().total_cost_usd - before) * 1e6) / 1e6, 90, 'and it landed in the ledger total');
  // and an explicit cost still wins over the auto-price
  const r2 = Ledger.record({ label: 'explicit', model: 'claude-opus-4-8', input_tokens: 1e6, output_tokens: 1e6, cost_usd: 0.5 });
  assert.equal(r2.cost_usd, 0.5, 'an explicit cost_usd is honoured over the computed one');
});

// HQ_PRICE_<model>="in,out" IS HOW A USER SETS THEIR REAL CONTRACT RATES — and it was untested.
//
// The default table is a placeholder; a real deployment overrides it via env. If that override
// silently did nothing, the user would configure their rates, see the ledger, and trust numbers
// computed at the wrong price — the config saying one thing and the tool doing another, on money.
//
// TABLE is built at module load, so the env must be set BEFORE a fresh import (cache-busted).
test('a HQ_PRICE_ env override sets the rate for that model, and a malformed one is ignored', async () => {
  const saved = { ...process.env };
  process.env.HQ_PRICE_opus = '10,50';        // half the default opus rate
  process.env.HQ_PRICE_widget = 'not,numbers'; // malformed → must be ignored, not crash
  try {
    const { costOf } = await import(`../src/pricing.js?override=${Date.now()}`);
    assert.equal(costOf('claude-opus-4-8', 1e6, 1e6), 60,
      'the override rate is used (10 + 50), NOT the default 90 — a user who sets a rate must get it');
    assert.equal(costOf('widget-model', 1e6, 1e6), 18,
      'a malformed override is ignored and falls back to the default, not to 0 or NaN');
    assert.equal(costOf('claude-sonnet-5', 1e6, 0), 3, 'a model the user did not override keeps the default');
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

// THE ONE THING A COORDINATION BOARD MUST NEVER DO: hand the same task to two agents.
//
// A live all-agent company has many agents talking to ONE agent-hq over HTTP, racing for work. This
// drives the real deployment: twelve clients lunge for one task, all requests in flight at once, and
// the outcome must be exactly one winner — the rest refused, not silently dropped, all told the same
// holder.
//
// Honest about what this guards: the property is DOUBLY assured, so no single mutation to claim()
// breaks it. node:sqlite is synchronous and the server is one event loop, so each claim runs to
// completion before the next even under a stampede — and on top of that, claim() is a single atomic
// UPDATE ... WHERE. I checked: replacing the atomic UPDATE with a read-then-write still passes here,
// because the serialization alone already prevents the double-claim. So this is a standing guarantee
// of the OUTCOME, not a proof of the UPDATE's atomicity — and it is the regression guard that fires
// the day claiming becomes async (an async DB driver, an await between the read and the write), which
// is exactly when the atomic UPDATE stops being redundant and starts being the only thing saving you.
test('serve: a stampede of concurrent claims on one task yields exactly ONE winner', async () => {
  const server = createHqServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  try {
    const board = await post('/api/boards', { name: 'Stampede' });
    const task = await post('/api/tasks', { board_id: board.id, title: 'the one contested task' });

    // twelve agents lunge for it at the same instant — all requests in flight before any resolves
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post(`/api/tasks/${task.id}/claim`, { agent: `racer-${i}` })));

    const winners = results.filter((r) => r.ok === true);
    const refused = results.filter((r) => r.ok === false);
    assert.equal(winners.length, 1, `exactly one claim may succeed — got ${winners.length}`);
    assert.equal(refused.length, 11, 'and the other eleven are refused, not silently dropped');
    // every refusal names the SAME holder — the winner — so nobody is told a different story
    const holder = winners[0].task.assignee;
    assert.ok(refused.every((r) => r.held_by === holder), 'all refusals cite the one true holder');
    // and the board itself agrees there is a single assignee
    const tasks = await fetch(`${base}/api/tasks?board_id=${board.id}`).then((r) => r.json());
    assert.equal(tasks.find((t) => t.id === task.id).assignee, holder, 'the board shows one owner');
  } finally { server.close(); }
});

test('memory_search bounds HOW MUCH it returns, not just HOW MANY — one memory dumped 1.1M tokens', () => {
  // `SELECT *` handed back the FULL content of every match, unbounded. One 4MB memory made
  // memory_search return 4.23MB — ~1,110,000 TOKENS — in 9ms. It never hangs and it never errors: it
  // just quietly empties a million tokens into the model's context. `limit` capped how MANY rows came
  // back and said nothing about how BIG they were. A LIMIT ON HOW MANY IS NOT A LIMIT ON HOW MUCH.
  const big = 'zzbudgetmem lorem ipsum dolor sit amet '.repeat(20_000);   // ~760KB ≈ 190k tokens
  Memory.write({ title: 'Enormous', content: big, namespace: 'default' });
  Memory.write({ title: 'Tiny', content: 'a small zzbudgetmem note', namespace: 'default' });

  const hits = Memory.search({ q: 'zzbudgetmem' });
  const bytes = JSON.stringify(hits).length;
  assert.ok(bytes / 4 < 5000, `the default budget holds — got ~${Math.round(bytes / 4)} tokens`);

  const huge = hits.find((m) => m.title === 'Enormous');
  assert.ok(huge, 'the memory is still RETURNED — bounding it must not drop it');
  assert.equal(huge.truncated, true, 'and it SAYS it was cut — never a silent truncation');
  assert.ok(huge.full_tokens > 100_000, 'reporting how big it really is, so the cut is not a dead end');
  assert.match(huge.content, /raise max_tokens/, 'and what to do about it');

  // A BUDGET, not a wall — Memory has no get(), so search is the only way to read the content, and a
  // hard cap would make a long memory permanently unreadable.
  const raised = Memory.search({ q: 'zzbudgetmem', max_tokens: 300_000 });
  assert.ok(JSON.stringify(raised).length / 4 > 100_000, 'raising max_tokens returns the rest');

  // A normal memory is completely unaffected.
  const tiny = hits.find((m) => m.title === 'Tiny');
  assert.equal(tiny.truncated, undefined, 'a normal memory is not flagged truncated');
  assert.ok(!/truncated at/.test(tiny.content), 'and carries no truncation notice');
});

test('a LIST is not a RECORD — the board shipped a full description for every task, and nothing read it', () => {
  // kanban_board and kanban_list_tasks returned the FULL description of EVERY task: one 1.2MB
  // description made each of them ~300,000 tokens. And nothing was even reading it — the dashboard
  // renders cards from title/labels and fetches the body separately (GET /api/tasks/:id) when you
  // open a task. Every board payload carried a megabyte that NOTHING RENDERS.
  const b = Boards.ensureDefault();
  const big = 'zz card description '.repeat(30_000);   // ~600KB ≈ 150k tokens
  Tasks.create({ board_id: b.id, title: 'Huge card', description: big });
  Tasks.create({ board_id: b.id, title: 'Normal card', description: 'a short description' });

  const tok = (o) => JSON.stringify(o).length / 4;
  assert.ok(tok(Boards.full(b.id)) < 20_000, `the board is a summary — got ${Math.round(tok(Boards.full(b.id)))} tokens`);

  const list = Tasks.list({ board_id: b.id });
  assert.ok(tok(list) < 20_000, `the list is a summary — got ${Math.round(tok(list))} tokens`);

  const huge = list.find((t) => t.title === 'Huge card');
  assert.equal(huge.description_truncated, true, 'a clipped card SAYS so — silence reads as "the description just ends there"');
  assert.ok(huge.description_tokens > 100_000, 'and reports the real size, so it is not a dead end');

  const normal = list.find((t) => t.title === 'Normal card');
  assert.equal(normal.description, 'a short description', 'a normal card is byte-identical');
  assert.equal(normal.description_truncated, undefined, 'and unflagged');

  // The RECORD does carry the body — that is what a record is for — but not without a ceiling.
  const rec = Tasks.get(huge.id);
  assert.ok(tok(rec) <= 21_000, `kanban_get_task is bounded — got ${Math.round(tok(rec))} tokens`);
  assert.equal(rec.description_truncated, true, 'and says it was cut');
  assert.match(rec.description, /raise max_tokens/, 'and what to do about it');
  // A budget, not a wall.
  assert.ok(tok(Tasks.get(huge.id, { max_tokens: 400_000 })) > 100_000, 'raising max_tokens returns the rest');
});

test('a RECORD HAS MORE THAN ONE BODY — the comment thread and the inbox were unbounded too', () => {
  // My own first fix was incomplete: I bounded a task's `description` and left its COMMENT THREAD
  // alone, so a huge comment STILL returned 413,000 tokens from kanban_get_task. Bounding the field
  // that happened to be big in your test is not bounding the record. A message body is the same shape.
  const b = Boards.ensureDefault();
  const a = Agents.register({ name: 'budget-probe', role: 'qa' });
  const big = 'zz payload text '.repeat(20_000);   // ~320KB ≈ 80k tokens

  const t = Tasks.create({ board_id: b.id, title: 'Commented', description: 'short' });
  Tasks.comment(t.id, { author: a.id, body: big });
  const rec = Tasks.get(t.id);
  const tok = (o) => JSON.stringify(o).length / 4;
  assert.ok(tok(rec) <= 21_000, `the record is bounded across ALL its bodies — got ${Math.round(tok(rec))} tokens`);
  assert.equal(rec.comments[0].body_truncated, true, 'the COMMENT says it was cut, not just the description');
  assert.ok(rec.comments[0].body_tokens > 50_000, 'and reports its real size');

  Messages.send({ from: a.id, to: a.id, body: big });
  const inbox = Messages.inbox({ agent: a.id });
  assert.ok(tok(inbox) <= 5000, `the inbox is bounded — got ${Math.round(tok(inbox))} tokens`);
  const m = inbox.find((x) => x.body_truncated);
  assert.ok(m, 'a huge message body says it was cut');
  assert.ok(m.body_tokens > 50_000, 'and reports its real size');
  // A budget, not a wall.
  assert.ok(tok(Messages.inbox({ agent: a.id, max_tokens: 200_000 })) > 50_000, 'raising max_tokens returns the rest');

  // A normal comment and a normal message are byte-identical.
  const nt = Tasks.create({ board_id: b.id, title: 'Plain', description: 'short' });
  Tasks.comment(nt.id, { author: a.id, body: 'a normal comment' });
  assert.equal(Tasks.get(nt.id).comments[0].body, 'a normal comment', 'a normal comment is untouched');
  assert.equal(Tasks.get(nt.id).comments[0].body_truncated, undefined, 'and unflagged');
});

test('the budget is spent ACROSS rows — not handed out in full to each one', () => {
  // A surviving canary found this hole: I neutered the `spent` accumulator and every test still
  // passed, because each of them had exactly ONE big row — and one big row is truncated to the
  // budget whether or not the accumulator works. Without it, EVERY row gets the full budget and N
  // big rows return N × it. The accumulator IS what makes a budget a budget, and nothing watched it.
  const a = Agents.register({ name: 'across-probe', role: 'qa' });
  const big = 'zz spread text '.repeat(20_000);   // ~300KB ≈ 75k tokens EACH

  for (let i = 0; i < 4; i++) Messages.send({ from: a.id, to: a.id, body: big });

  const inbox = Messages.inbox({ agent: a.id, max_tokens: 4000 });
  const tokens = JSON.stringify(inbox).length / 4;
  assert.ok(inbox.length >= 4, 'all four messages come back');
  assert.ok(tokens <= 5000, `FOUR big rows share ONE budget — got ${Math.round(tokens)} tokens, not 4×`);
});

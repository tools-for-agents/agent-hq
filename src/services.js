// Domain operations for Agent HQ. Each mutating op records activity and
// emits a live event so the dashboard updates in real time.
import { get, all, run, uid, now, logActivity } from './db.js';
import { broadcast } from './events.js';
import { costOf, priceTable } from './pricing.js';

function emit(activity) {
  if (activity) broadcast('activity', activity);
  broadcast('refresh', { ts: now() });
}

// Coerce a user-supplied count (which may arrive as NaN or a numeric string from
// a query param) to a positive integer, capped, else the default — so a bad
// `?limit=abc` can't bind `LIMIT NaN` (SQL error) or slice(0, NaN) to nothing.
const posInt = (v, def, cap = 500) => (Number.isFinite(+v) && +v > 0 ? Math.min(Math.floor(+v), cap) : def);
// A lease is a duration in ms and, exactly like the counts above, arrives from a query param / JSON
// body / direct caller — so it needs the same coercion. Beyond honesty it is a hard safety bound:
// `Date.now() + lease` must stay inside the valid Date range, or `.toISOString()` throws a raw
// "RangeError: Invalid time value" on claim()/next() — an agent's most-used calls — for a NaN
// ('?lease_ms=abc'), Infinity, or an astronomically large number. Capped at a year: a task auto-locked
// longer than that is a mistake, not a lease.
const MAX_LEASE_MS = 365 * 24 * 60 * 60 * 1000;   // 1 year
// The cost ledger SUMs tokens and cost across EVERY run, so one bad number poisons the company total.
// Token counts must be non-negative integers — 0 is VALID (a run can emit no output), so this is NOT
// posInt (which rejects 0). Unguarded, a negative count silently under-bills the company, and a NaN or a
// string hit a raw "NOT NULL constraint failed: runs.cost_usd" (naming an internal column, not the real
// problem) or crash on `cost.toFixed`. The HTTP route passes these straight through, past the MCP schema.
const tokenCount = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);
// An explicit cost_usd is honoured only if it is a usable non-negative number; otherwise we PRICE from the
// (now-clean) tokens rather than store garbage. `?? ` not `||`, so a legitimate cost of exactly 0 stands.
const usableCost = (v) => (v != null && Number.isFinite(+v) && +v >= 0 ? +v : null);
// ≈4 chars/token — the same estimate every other tool in this kit uses, so the budgets mean the
// same thing across them.
const estTokens = (s) => Math.ceil(String(s || '').length / 4);
// The token budget for what memory_search hands back. It returned the FULL content of every match:
// one 4MB memory made a single search return ~1,110,000 tokens. `limit` capped how MANY rows came
// back and said nothing about how BIG they were — a limit on how many is not a limit on how much.
const MEM_MAX_TOKENS = 4000;

// 🔑 A LIST IS NOT A RECORD. kanban_board and kanban_list_tasks shipped the FULL description of EVERY
// task: one 1.2MB description made each of them return ~300,000 tokens. And nothing was even reading
// it — the dashboard renders cards from title/labels and fetches the body separately when you open a
// task (`GET /api/tasks/:id`), so every board payload carried a megabyte that NOTHING RENDERS.
// A list gives you enough to CHOOSE; the record gives you the thing. Cards get a preview.
const CARD_DESC_CHARS = 400;
const preview = (t) => {
  const d = String(t.description || '');
  if (d.length <= CARD_DESC_CHARS) return t;
  // Say so. A body silently cut to 400 chars reads as a task whose description simply ends there.
  return { ...t, description: d.slice(0, CARD_DESC_CHARS) + '…', description_truncated: true,
    description_tokens: estTokens(d) };
};
// The single-record read. Generous — a real description must never be clipped in the dashboard modal
// — but not unbounded: kanban_get_task on a 1.2MB description handed a model ~300,000 tokens.
const TASK_MAX_TOKENS = 20_000;
const INBOX_MAX_TOKENS = 4000;

// Spend a token budget across a list of rows, cutting the named field and SAYING SO. One helper,
// because there are now four readers that need it and three hand-rolled copies is how they drift.
//
// 🔑 IT TAKES A LIST OF FIELDS BECAUSE MY OWN FIRST FIX WAS INCOMPLETE. I bounded a task's
// `description` and left its COMMENT THREAD unbounded — a huge comment still returned 413,000 tokens
// from kanban_get_task. A RECORD HAS MORE THAN ONE BODY, and I had only bounded the one I was looking
// at. Bounding the field that happened to be big in your test is not bounding the record.
function spendBudget(rows, field, max_tokens,
  { spent = 0, flag = `${field}_truncated`, size = `${field}_tokens` } = {}) {
  for (const r of rows) {
    const v = String(r[field] || '');
    const full = estTokens(v);
    const room = Math.max(0, max_tokens - spent);
    if (full > room) {
      r[field] = v.slice(0, room * 4)
        + `\n…[truncated at ${room} of ${full} tokens — raise max_tokens to read the rest]`;
      r[flag] = true;
      r[size] = full;
    }
    spent += estTokens(r[field]);
  }
  return spent;
}
// A user's search term or tag can contain LIKE metacharacters (`%`, `_`). Left raw they act as
// wildcards — a `q` of 'node_modules' matches 'nodexmodules', a tag 'a_b' matches 'axb'. Escape
// them (and the escape char) and pair every use with `ESCAPE '\'`.
const likeEsc = (s) => String(s).replace(/[\\%_]/g, '\\$&');
const tagLike = (tag) => `%"${likeEsc(tag)}"%`;

const parse = (row, ...fields) => {
  if (!row) return row;
  for (const f of fields) {
    try { row[f] = JSON.parse(row[f]); } catch { row[f] = []; }
  }
  return row;
};

// ── Agents ───────────────────────────────────────────────────────────────
export const Agents = {
  list: () => all(`SELECT * FROM agents ORDER BY name`),
  get: (id) => get(`SELECT * FROM agents WHERE id=? OR name=?`, id, id),

  register({ name, role = 'generalist', avatar = '🤖' }) {
    const existing = get(`SELECT * FROM agents WHERE name=?`, name);
    if (existing) {
      run(`UPDATE agents SET role=?, avatar=?, status='idle', last_seen=?, updated_at=? WHERE id=?`,
        role, avatar, now(), now(), existing.id);
      return Agents.get(existing.id);
    }
    const id = uid('agt_');
    run(`INSERT INTO agents (id,name,role,status,avatar,created_at,updated_at,last_seen)
         VALUES (?,?,?,'idle',?,?,?,?)`, id, name, role, avatar, now(), now(), now());
    emit(logActivity({ actor: id, type: 'agent.joined', entity: 'agent', entity_id: id,
      summary: `${avatar} ${name} joined as ${role}` }));
    return Agents.get(id);
  },

  update(id, patch) {
    const a = Agents.get(id);
    if (!a) throw new Error('agent not found');
    assertEnum('agent status', patch.status, AGENT_STATUSES);
    const status = patch.status ?? a.status;
    const role = patch.role ?? a.role;
    const current_task = patch.current_task !== undefined ? patch.current_task : a.current_task;
    run(`UPDATE agents SET status=?, role=?, current_task=?, last_seen=?, updated_at=? WHERE id=?`,
      status, role, current_task, now(), now(), a.id);
    if (patch.status && patch.status !== a.status) {
      emit(logActivity({ actor: a.id, type: 'agent.status', entity: 'agent', entity_id: a.id,
        summary: `${a.avatar} ${a.name} → ${patch.status}` }));
    } else { emit(null); }
    return Agents.get(a.id);
  },

  heartbeat(id) {
    const a = Agents.get(id);
    if (!a) throw new Error('agent not found');
    run(`UPDATE agents SET last_seen=?, status=CASE WHEN status='offline' THEN 'idle' ELSE status END WHERE id=?`, now(), a.id);
    return { ok: true, ts: now() };
  },

  // Mark agents whose heartbeat went stale as offline (keeps the board honest).
  reapStale(threshold_ms = 90_000) {
    const cutoff = new Date(Date.now() - threshold_ms).toISOString();
    const stale = all(`SELECT id,name,avatar FROM agents WHERE status!='offline' AND (last_seen IS NULL OR last_seen < ?)`, cutoff);
    for (const a of stale) {
      run(`UPDATE agents SET status='offline', updated_at=? WHERE id=?`, now(), a.id);
      emit(logActivity({ actor: a.id, type: 'agent.offline', entity: 'agent', entity_id: a.id,
        summary: `${a.avatar || '🤖'} ${a.name} went offline (stale heartbeat)` }));
    }
    return { offlined: stale.length };
  },
};

// ── Boards / Columns ───────────────────────────────────────────────────────
export const Boards = {
  list: () => all(`SELECT * FROM boards ORDER BY created_at`),

  create({ name, description = '', columns }) {
    const id = uid('brd_');
    run(`INSERT INTO boards (id,name,description,created_at) VALUES (?,?,?,?)`,
      id, name, description, now());
    const cols = columns || ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'];
    cols.forEach((cn, i) => run(
      `INSERT INTO columns (id,board_id,name,position) VALUES (?,?,?,?)`,
      uid('col_'), id, cn, i));
    emit(logActivity({ type: 'board.created', entity: 'board', entity_id: id,
      summary: `Board "${name}" created` }));
    return Boards.full(id);
  },

  full(id) {
    const board = get(`SELECT * FROM boards WHERE id=?`, id);
    if (!board) return null;

    // Dependencies decide what can actually be worked — Tasks.next already refuses
    // to hand out a blocked task — but the board never said so: a task waiting on
    // three others looked exactly like one you could start now. Resolve the whole
    // dependency picture once, for every card.
    const doneCols = new Set(all(`SELECT id FROM columns WHERE board_id=? AND lower(name)='done'`, id).map((c) => c.id));
    const colOf = new Map(all(`SELECT id, column_id, title FROM tasks WHERE board_id=?`, id)
      .map((t) => [t.id, { column_id: t.column_id, title: t.title }]));
    const isDone = (tid) => { const t = colOf.get(tid); return !t || doneCols.has(t.column_id); };   // a dep that no longer exists can't block

    const depsOf = new Map(), blocksCount = new Map();
    for (const d of all(`SELECT task_id, depends_on FROM task_deps`)) {
      if (!colOf.has(d.task_id)) continue;                       // another board's task
      if (!depsOf.has(d.task_id)) depsOf.set(d.task_id, []);
      depsOf.get(d.task_id).push(d.depends_on);
      if (!isDone(d.depends_on)) blocksCount.set(d.depends_on, (blocksCount.get(d.depends_on) || 0) + 1);
    }

    board.columns = all(`SELECT * FROM columns WHERE board_id=? ORDER BY position`, id);
    for (const col of board.columns) {
      col.tasks = all(`SELECT * FROM tasks WHERE column_id=? ORDER BY position, created_at`, col.id)
        .map((t) => preview(parse(t, 'labels')))
        .map((t) => {
          const deps = depsOf.get(t.id) || [];
          const blockers = deps.filter((d) => !isDone(d));
          return {
            ...t,
            deps,
            blocked_by: blockers,                                 // what this task is waiting on, right now
            blocked: blockers.length > 0,
            // …and the other side of it: finishing this unblocks that many others.
            // A task nobody can start until you finish it is the one to do next.
            blocks: blocksCount.get(t.id) || 0,
          };
        });
      // Surface the WIP state so every consumer — dashboard, MCP, an agent
      // deciding what to pick up — sees a column that is full without counting.
      col.at_limit = col.wip_limit != null && col.tasks.length >= col.wip_limit;
      col.over_limit = col.wip_limit != null && col.tasks.length > col.wip_limit;
    }
    return board;
  },

  // A WIP limit caps how many tasks may sit in a column at once — the whole point
  // of kanban: finish work before starting more. Pass null (or 0) to lift it.
  setWipLimit({ board_id, column, wip_limit, actor = null }) {
    const bid = board_id || Boards.ensureDefault().id;
    const col = columnByName(bid, column);
    if (!col) throw new Error('column not found');
    const limit = wip_limit == null || +wip_limit <= 0 ? null : posInt(wip_limit, null, 999);
    if (wip_limit != null && +wip_limit > 0 && limit == null) throw new Error('wip_limit must be a positive integer');
    run(`UPDATE columns SET wip_limit=? WHERE id=?`, limit, col.id);
    const n = colCount(col.id);
    emit(logActivity({ actor, type: 'column.wip', entity: 'column', entity_id: col.id,
      summary: limit == null ? `🚦 WIP limit lifted on ${col.name}` : `🚦 WIP limit on ${col.name} set to ${limit} (${n} now)` }));
    return { ...col, wip_limit: limit, tasks: n, at_limit: limit != null && n >= limit, over_limit: limit != null && n > limit };
  },

  // Returns the first board, creating a default company board if none exist.
  ensureDefault() {
    let b = get(`SELECT * FROM boards ORDER BY created_at LIMIT 1`);
    if (!b) return Boards.create({ name: 'Company Operations', description: 'Primary board for the agent collective' });
    return Boards.full(b.id);
  },
};

// ── Flow: is the company finishing what it starts? ─────────────────────────
// Everything here is read from the ACTIVITY LOG, because it is the only thing
// that remembers *when* work moved — the tasks table only knows where a task is
// now, not how long it took to get there.
const DAY_MS = 86_400_000;
export const Flow = {
  // Pass `actor` for one agent's flow: what THEY started, what THEY finished, and
  // what is still on their plate. Same question as the company's, asked of one.
  summary({ days = 14, actor } = {}) {
    days = posInt(days, 14, 90);
    const since = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    let sql = `SELECT ts, type, entity_id, summary, data FROM activity
               WHERE entity='task' AND type IN ('task.created','task.moved') AND ts >= ?`;
    const args = [since];
    if (actor) { sql += ` AND actor = ?`; args.push(actor); }
    const acts = all(sql + ` ORDER BY ts`, ...args);

    // Did this move finish the task? Prefer the structured data we now record;
    // fall back to the summary for rows written before it existed.
    const finishes = (a) => {
      try { const d = JSON.parse(a.data || 'null'); if (d && d.to) return String(d.to).toLowerCase() === 'done'; } catch {}
      return /moved to done\s*$/i.test(a.summary || '');
    };

    const buckets = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
      buckets[d] = { day: d, created: 0, done: 0 };
    }
    const doneAt = {};
    for (const a of acts) {
      const d = a.ts.slice(0, 10);
      if (!buckets[d]) continue;
      if (a.type === 'task.created') buckets[d].created++;
      else if (finishes(a)) { buckets[d].done++; doneAt[a.entity_id] = a.ts; }   // last finish wins if reopened
    }
    const by_day = Object.values(buckets);
    const created = by_day.reduce((n, b) => n + b.created, 0);
    const done = by_day.reduce((n, b) => n + b.done, 0);

    // Cycle time: how long a finished task sat between being created and being
    // done. created_at comes from the task row, so it counts even if the task was
    // created before this window.
    const cycles = [];
    for (const [id, ts] of Object.entries(doneAt)) {
      const t = get(`SELECT title, created_at FROM tasks WHERE id=?`, id);
      if (!t || !t.created_at) continue;                       // deleted since — nothing to measure
      const hours = (new Date(ts) - new Date(t.created_at)) / 3_600_000;
      if (hours >= 0) cycles.push({ id, title: t.title, hours: Math.round(hours * 10) / 10 });
    }
    const sorted = [...cycles].sort((a, b) => a.hours - b.hours);
    const median = sorted.length
      ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2].hours
        : Math.round((sorted[sorted.length / 2 - 1].hours + sorted[sorted.length / 2].hours) / 2 * 10) / 10)
      : null;

    // In flight = what is still open. For an agent, that means what is assigned to
    // them — not what they touched.
    const wip = actor
      ? get(`SELECT COUNT(*) AS n FROM tasks t JOIN columns c ON c.id=t.column_id
             WHERE lower(c.name) != 'done' AND t.assignee = ?`, actor).n
      : get(`SELECT COUNT(*) AS n FROM tasks t JOIN columns c ON c.id=t.column_id
             WHERE lower(c.name) != 'done'`).n;

    return {
      days, actor: actor || null, by_day, created, done, wip,
      throughput_per_day: Math.round(done / days * 100) / 100,
      // >1 means the company is taking on work faster than it finishes it
      arrival_ratio: done ? Math.round(created / done * 100) / 100 : (created ? null : 0),
      cycle: { n: cycles.length, median_hours: median,
        avg_hours: cycles.length ? Math.round(cycles.reduce((a, c) => a + c.hours, 0) / cycles.length * 10) / 10 : null },
      slowest: [...cycles].sort((a, b) => b.hours - a.hours).slice(0, 5),
    };
  },
};

// ── Tasks ──────────────────────────────────────────────────────────────────
const colCount = (column_id) => get(`SELECT COUNT(*) AS n FROM tasks WHERE column_id=?`, column_id).n;

// Refuse to put another task into a column that is already at its WIP limit.
// Columns have no limit by default, so this is inert until a board opts in — and
// `force` is always available for the case where a human (or an agent) means it.
function assertWip(col, force = false) {
  if (force || !col || col.wip_limit == null) return;
  const n = colCount(col.id);
  if (n >= col.wip_limit) {
    throw new Error(`column "${col.name}" is at its WIP limit (${n}/${col.wip_limit}) — finish or move a task out first, or pass force:true`);
  }
}

function columnByName(board_id, name) {
  return get(`SELECT * FROM columns WHERE board_id=? AND lower(name)=lower(?)`, board_id, name);
}

// priority is a FINITE, KNOWN set (the DB comments it, the MCP schema declares it as an enum) — but
// the schema only guards the MCP path. The HTTP API (POST /api/tasks) and any direct caller go straight
// to Tasks.create/update, so an out-of-enum value like "CRITICAL" was stored verbatim: wrong data written
// confidently, and the priority-sort CASE doesn't know it, so a "critical" task sorts BELOW low. Enforce
// it at the one choke point every path shares, and name the values that exist.
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const assertPriority = (p) => {
  if (p != null && !PRIORITIES.includes(p)) {
    throw new Error(`priority "${p}" is not one of ${PRIORITIES.join(', ')} — the task was not saved.`);
  }
};
// labels is an ARRAY of strings (the MCP schema says so). But the schema only guards the MCP path; the
// HTTP API and direct callers reach create/update with whatever they pass, and `JSON.stringify("urgent")`
// happily stores the STRING "urgent" as if it were the labels — then a consumer spreads it and the one
// label becomes six: u, r, g, e, n, t. A string is not a one-element list; refuse it.
const assertLabels = (l) => {
  if (l != null && !Array.isArray(l)) {
    throw new Error(`labels must be an array of strings, not a ${typeof l} ("${l}") — the task was not saved.`);
  }
};
// The kit's other declared enums, enforced at the core so the HTTP API and direct callers can't slip a
// value past the MCP schema: an agent "status" that the reaper and the dashboard don't understand, or a
// run "status" the ledger buckets as neither done nor error.
const AGENT_STATUSES = ['idle', 'working', 'offline'];
const RUN_STATUSES = ['done', 'error'];
const assertEnum = (label, val, set) => {
  if (val != null && !set.includes(val)) {
    throw new Error(`${label} "${val}" is not one of ${set.join(', ')}.`);
  }
};

export const Tasks = {
  get(id, { max_tokens = TASK_MAX_TOKENS } = {}) {
    const t = parse(get(`SELECT * FROM tasks WHERE id=?`, id), 'labels');
    if (!t) return null;
    t.comments = all(`SELECT * FROM comments WHERE task_id=? ORDER BY created_at`, id);
    t.deps = all(`SELECT depends_on FROM task_deps WHERE task_id=?`, id).map((r) => r.depends_on);
    // The record DOES carry the body — that is what a record is for — but not without a ceiling.
    // A budget, not a wall: raise max_tokens and the rest comes back. The budget covers the
    // description AND the comment thread: a record has more than one body, and bounding only the
    // field that happened to be big in your test is not bounding the record (a huge COMMENT still
    // returned 413,000 tokens after the description was capped).
    max_tokens = posInt(max_tokens, TASK_MAX_TOKENS, 1_000_000);
    const spent = spendBudget([t], 'description', max_tokens);
    spendBudget(t.comments, 'body', max_tokens, { spent });
    return t;
  },

  // A FILTER THAT IS WRONG LOOKS EXACTLY LIKE A FILTER THAT MATCHED NOTHING.
  //
  // `kanban_list_tasks { status: "In Progres" }` — one letter short — returned []. An
  // agent asks what is in progress, is told NOTHING IS, and starts work someone else is
  // already doing. On a coordination board that is the most expensive lie in the kit.
  //
  // Columns and agents are FINITE, KNOWN sets. A filter that names something not in the
  // set is not a query with no results, it is a mistake — so say so, and say what the
  // real values are, because the fix is then in the sentence.
  list({ board_id, assignee, status } = {}) {
    if (status) {
      const known = all(`SELECT DISTINCT c.name FROM columns c` + (board_id ? ` WHERE c.board_id=?` : ''),
        ...(board_id ? [board_id] : [])).map((r) => r.name);
      if (!known.some((n) => n.toLowerCase() === String(status).toLowerCase())) {
        throw new Error(`no column named "${status}" — this is NOT "no tasks there". `
          + `The columns are: ${known.join(', ')}`);
      }
    }
    if (assignee) {
      const who = get(`SELECT id FROM agents WHERE id=? OR name=?`, assignee, assignee);
      if (!who) {
        const names = all(`SELECT name FROM agents ORDER BY name LIMIT 12`).map((r) => r.name);
        throw new Error(`no agent "${assignee}" is registered — this is NOT "they have no tasks". `
          + `Registered: ${names.join(', ') || 'nobody yet — call agent_register'}`);
      }
    }
    let sql = `SELECT t.*, c.name AS column_name FROM tasks t JOIN columns c ON c.id=t.column_id WHERE 1=1`;
    const args = [];
    if (board_id) { sql += ` AND t.board_id=?`; args.push(board_id); }
    if (assignee) { sql += ` AND t.assignee=?`; args.push(assignee); }
    if (status) { sql += ` AND lower(c.name)=lower(?)`; args.push(status); }
    sql += ` ORDER BY t.position, t.created_at`;
    return all(sql, ...args).map((t) => preview(parse(t, 'labels')));
  },

  create({ board_id, column, title, description = '', assignee = null, priority = 'medium', labels = [], created_by = null, force = false }) {
    assertPriority(priority);
    assertLabels(labels);
    const board = board_id ? get(`SELECT * FROM boards WHERE id=?`, board_id) : Boards.ensureDefault();
    const bid = board.id;
    // Asking for a column that does not exist used to drop the task quietly into the FIRST
    // one. You said "Done", you got "Backlog", and you were told it worked. Omitting the
    // column is a choice (the default); MISSPELLING it is a mistake, and they must not
    // look the same.
    let col = null;
    if (column) {
      col = columnByName(bid, column);
      if (!col) {
        const known = all(`SELECT name FROM columns WHERE board_id=? ORDER BY position`, bid).map((r) => r.name);
        throw new Error(`no column named "${column}" — the task was NOT created. `
          + `The columns are: ${known.join(', ')}`);
      }
    }
    if (!col) col = get(`SELECT * FROM columns WHERE board_id=? ORDER BY position LIMIT 1`, bid);
    assertWip(col, force);
    const id = uid('tsk_');
    const pos = (get(`SELECT COALESCE(MAX(position),0)+1 AS p FROM tasks WHERE column_id=?`, col.id)).p;
    run(`INSERT INTO tasks (id,board_id,column_id,title,description,assignee,priority,labels,position,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, bid, col.id, title, description, assignee, priority, JSON.stringify(labels), pos, created_by, now(), now());
    emit(logActivity({ actor: created_by, type: 'task.created', entity: 'task', entity_id: id,
      summary: `📌 New task: "${title}" in ${col.name}` }));
    return Tasks.get(id);
  },

  update(id, patch, actor = null) {
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) throw new Error('task not found');
    assertPriority(patch.priority);   // undefined (not patched) is fine; a bad value is not
    assertLabels(patch.labels);
    const fields = { title: t.title, description: t.description, assignee: t.assignee, priority: t.priority };
    let columnChange = null, moveData = null;

    if (patch.column || patch.status) {
      const col = columnByName(t.board_id, patch.column || patch.status);
      if (col && col.id !== t.column_id) {
        assertWip(col, patch.force);        // moving INTO a full column is the case WIP limits exist to stop
        const pos = (get(`SELECT COALESCE(MAX(position),0)+1 AS p FROM tasks WHERE column_id=?`, col.id)).p;
        const from = get(`SELECT name FROM columns WHERE id=?`, t.column_id);
        run(`UPDATE tasks SET column_id=?, position=? WHERE id=?`, col.id, pos, id);
        columnChange = col.name;
        moveData = { from: from ? from.name : null, to: col.name };   // structured, so flow doesn't have to parse a sentence
      }
    }
    for (const k of Object.keys(fields)) if (k in patch) fields[k] = patch[k];
    const labels = patch.labels ? JSON.stringify(patch.labels) : t.labels;
    run(`UPDATE tasks SET title=?, description=?, assignee=?, priority=?, labels=?, updated_at=? WHERE id=?`,
      fields.title, fields.description, fields.assignee, fields.priority, labels, now(), id);

    const summary = columnChange
      ? `➡️ "${t.title}" moved to ${columnChange}`
      : `✏️ "${fields.title}" updated`;
    emit(logActivity({ actor, type: columnChange ? 'task.moved' : 'task.updated',
      entity: 'task', entity_id: id, summary, data: moveData || undefined }));
    return Tasks.get(id);
  },

  comment(id, { author, body }) {
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) throw new Error('task not found');
    const cid = uid('cmt_');
    run(`INSERT INTO comments (id,task_id,author,body,created_at) VALUES (?,?,?,?,?)`,
      cid, id, author, body, now());
    emit(logActivity({ actor: author, type: 'task.comment', entity: 'task', entity_id: id,
      summary: `💬 comment on "${t.title}"` }));
    return Tasks.get(id);
  },

  addDep(id, depends_on) {
    if (!depends_on) throw new Error('depends_on required');
    if (id === depends_on) throw new Error('a task cannot depend on itself');
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) throw new Error('task not found');
    const dep = get(`SELECT * FROM tasks WHERE id=?`, depends_on);
    if (!dep) throw new Error('dependency task not found');
    // Walk the existing graph from depends_on; if id is already reachable, the new
    // edge would close a cycle (direct A↔B or transitive A→B→C→A) — reject it.
    const seen = new Set();
    const stack = [depends_on];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === id) throw new Error('that would create a circular dependency');
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of all(`SELECT depends_on FROM task_deps WHERE task_id=?`, cur)) stack.push(r.depends_on);
    }
    run(`INSERT OR IGNORE INTO task_deps (task_id,depends_on) VALUES (?,?)`, id, depends_on);
    emit(logActivity({ type: 'task.dep_added', entity: 'task', entity_id: id,
      summary: `🔗 "${t.title}" now depends on "${dep.title}"` }));
    return Tasks.get(id);
  },

  rmDep(id, depends_on) {
    const r = run(`DELETE FROM task_deps WHERE task_id=? AND depends_on=?`, id, depends_on);
    if (r.changes) {
      const t = get(`SELECT * FROM tasks WHERE id=?`, id);
      emit(logActivity({ type: 'task.dep_removed', entity: 'task', entity_id: id,
        summary: `🔓 dependency removed from "${t?.title ?? id}"` }));
    }
    return Tasks.get(id);
  },

  // Atomically claim a task. Succeeds only if it is free, the lease has expired,
  // or it is already held by this agent (refreshes the lease). Prevents two
  // agents from grabbing the same work.
  claim(id, agent, lease_ms = 600_000) {
    if (!agent) throw new Error('agent required to claim');
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) throw new Error('task not found');
    const ts = now();
    // Coerce lease_ms before it reaches Date arithmetic — a bad value must fall back to the default,
    // never throw "Invalid time value". The 30s floor below still protects legit small leases.
    const lease = posInt(lease_ms, 600_000, MAX_LEASE_MS);
    const until = new Date(Date.now() + Math.max(30_000, lease)).toISOString();
    const r = run(
      `UPDATE tasks SET assignee=?, claimed_at=?, lease_until=?, updated_at=?
       WHERE id=? AND (assignee IS NULL OR assignee='' OR assignee=? OR lease_until IS NULL OR lease_until < ?)`,
      agent, ts, until, ts, id, agent, ts);
    if (r.changes === 0) {
      return { ok: false, reason: 'already claimed', held_by: t.assignee, lease_until: t.lease_until };
    }
    emit(logActivity({ actor: agent, type: 'task.claimed', entity: 'task', entity_id: id,
      summary: `🔒 claimed "${t.title}"` }));
    return { ok: true, task: Tasks.get(id) };
  },

  release(id, agent) {
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) throw new Error('task not found');
    const r = run(`UPDATE tasks SET assignee=NULL, claimed_at=NULL, lease_until=NULL, updated_at=?
                   WHERE id=? AND (assignee=? OR ?='')`, now(), id, agent, agent || '');
    if (r.changes) emit(logActivity({ actor: agent, type: 'task.released', entity: 'task', entity_id: id,
      summary: `🔓 released "${t.title}"` }));
    return { ok: r.changes > 0 };
  },

  // Pull the highest-priority unclaimed task (not in a Done column) and claim it.
  next(agent, { board_id, lease_ms } = {}) {
    if (!agent) throw new Error('agent required');
    const ts = now();
    let sql = `SELECT t.* FROM tasks t JOIN columns c ON c.id=t.column_id
               WHERE lower(c.name) != 'done'
                 AND (t.assignee IS NULL OR t.assignee='' OR t.lease_until < ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM task_deps d
                   JOIN tasks dt   ON dt.id = d.depends_on
                   JOIN columns dc ON dc.id = dt.column_id
                   WHERE d.task_id = t.id AND lower(dc.name) != 'done'
                 )`;
    const args = [ts];
    if (board_id) { sql += ` AND t.board_id=?`; args.push(board_id); }
    sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
             WHEN 'medium' THEN 2 ELSE 3 END, t.created_at LIMIT 1`;
    const cand = get(sql, ...args);
    if (!cand) return { ok: false, reason: 'no available tasks' };
    return Tasks.claim(cand.id, agent, lease_ms);
  },

  remove(id, actor = null) {
    const t = get(`SELECT * FROM tasks WHERE id=?`, id);
    if (!t) return { ok: false };
    run(`DELETE FROM tasks WHERE id=?`, id);
    emit(logActivity({ actor, type: 'task.deleted', entity: 'task', entity_id: id,
      summary: `🗑️ deleted "${t.title}"` }));
    return { ok: true };
  },
};

// ── Memory ─────────────────────────────────────────────────────────────────
export const Memory = {
  write({ agent_id = null, namespace = 'default', title, content, tags = [], importance = 3 }) {
    const id = uid('mem_');
    run(`INSERT INTO memories (id,agent_id,namespace,title,content,tags,importance,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, agent_id, namespace, title, content, JSON.stringify(tags), importance, now(), now());
    emit(logActivity({ actor: agent_id, type: 'memory.write', entity: 'memory', entity_id: id,
      summary: `🧠 remembered: "${title}"` }));
    return parse(get(`SELECT * FROM memories WHERE id=?`, id), 'tags');
  },

  update(id, patch) {
    const m = get(`SELECT * FROM memories WHERE id=?`, id);
    if (!m) throw new Error('memory not found');
    const title = patch.title ?? m.title;
    const content = patch.content ?? m.content;
    const tags = patch.tags ? JSON.stringify(patch.tags) : m.tags;
    const importance = patch.importance ?? m.importance;
    const namespace = patch.namespace ?? m.namespace;
    run(`UPDATE memories SET title=?, content=?, tags=?, importance=?, namespace=?, updated_at=? WHERE id=?`,
      title, content, tags, importance, namespace, now(), id);
    emit(null);
    return parse(get(`SELECT * FROM memories WHERE id=?`, id), 'tags');
  },

  search({ q = '', agent_id, namespace, tag, limit = 25, max_tokens = MEM_MAX_TOKENS } = {}) {
    // Same shape as the kanban filters: a namespace that does not exist returned [], and
    // an agent reads that as "the company remembers nothing about this". Namespaces are a
    // finite, knowable set — so a name that is not in it is a typo, not an answer.
    if (namespace) {
      const known = all(`SELECT DISTINCT namespace FROM memories WHERE namespace IS NOT NULL ORDER BY namespace`)
        .map((r) => r.namespace);
      if (!known.includes(namespace)) {
        throw new Error(`no memories are in a namespace called "${namespace}" — this is NOT "nothing is remembered". `
          + `The namespaces are: ${known.join(', ') || 'none yet'}`);
      }
    }
    let sql = `SELECT * FROM memories WHERE 1=1`;
    const args = [];
    if (q) { const p = `%${likeEsc(q)}%`; sql += ` AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`; args.push(p, p); }
    if (agent_id) { sql += ` AND (agent_id=? OR agent_id IS NULL)`; args.push(agent_id); }
    if (namespace) { sql += ` AND namespace=?`; args.push(namespace); }
    if (tag) { sql += ` AND tags LIKE ? ESCAPE '\\'`; args.push(tagLike(tag)); }
    sql += ` ORDER BY importance DESC, updated_at DESC LIMIT ?`; args.push(posInt(limit, 25, 200));
    const rows = all(sql, ...args).map((m) => parse(m, 'tags'));

    // 🔑 `SELECT *` HANDED BACK THE FULL CONTENT OF EVERY MATCH, UNBOUNDED. One 4MB memory made
    // memory_search return 4.23MB — ~1,110,000 TOKENS — in 9ms. It never hangs and it never errors:
    // it just quietly empties a million tokens into the model's context. Every sibling search in this
    // kit returns a bounded excerpt (cortex/scout snippet, lens truncates, recall budgets); this one
    // returned everything, and the limit it did have counted ROWS, not SIZE. A LIMIT ON HOW MANY IS
    // NOT A LIMIT ON HOW MUCH.
    //
    // It has to be a BUDGET, not a cap: Memory has no get(), so search is the only way to read a
    // memory's content, and a hard truncation would make a long memory permanently unreadable.
    // Raise max_tokens and the whole thing comes back.
    // The same helper every other reader uses. A memory has ONE body, so its flags stay unprefixed
    // (`truncated` / `full_tokens`) — the names already published on this tool.
    spendBudget(rows, 'content', posInt(max_tokens, MEM_MAX_TOKENS, 1_000_000),
      { flag: 'truncated', size: 'full_tokens' });
    return rows;
  },

  list: (limit = 100) => all(`SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?`, posInt(limit, 100, 500)).map((m) => parse(m, 'tags')),

  remove(id) {
    run(`DELETE FROM memories WHERE id=?`, id);
    emit(null);
    return { ok: true };
  },
};

// ── Messages (agent-to-agent inbox) ──────────────────────────────────────────
export const Messages = {
  send({ from_agent = null, to_agent = null, task_id = null, body }) {
    if (!body) throw new Error('body required');
    // Resolve the recipient to a canonical agent id. to_agent may arrive as an id OR a name — Agents.get
    // accepts both, and the activity summary below ALREADY resolves it for DISPLAY. But the row stored the
    // raw value while inbox() matches m.to_agent against the reader's ID, so a message addressed by NAME
    // was written, shown in the feed as "→ bob" (delivered!), and never reached bob's inbox — silently
    // lost, in the one tool whose job is agents coordinating. And a recipient that resolves to nobody is a
    // typo, not a message to send into the void. null stays null: that is a broadcast to everyone.
    if (to_agent != null) {
      const rcpt = Agents.get(to_agent);
      if (!rcpt) throw new Error(`no such agent: "${to_agent}" — message not sent. `
        + `Pass a registered agent id or name, or omit to_agent to broadcast to everyone.`);
      to_agent = rcpt.id;
    }
    const id = uid('msg_');
    run(`INSERT INTO messages (id,from_agent,to_agent,task_id,body,read,created_at)
         VALUES (?,?,?,?,?,0,?)`, id, from_agent, to_agent, task_id, body, now());
    const fromName = from_agent ? (Agents.get(from_agent)?.name || from_agent) : 'someone';
    const toName = to_agent ? (Agents.get(to_agent)?.name || to_agent) : 'everyone';
    emit(logActivity({ actor: from_agent, type: 'message.sent', entity: 'message', entity_id: id,
      summary: `✉️ ${fromName} → ${toName}: ${body.slice(0, 60)}` }));
    return get(`SELECT * FROM messages WHERE id=?`, id);
  },

  // Inbox = direct messages to me + broadcasts (not authored by me). Read state
  // is per-agent (message_reads), so broadcasts are unread until each agent reads.
  inbox({ agent, unread_only = false, limit = 50, mark_read = false, max_tokens = INBOX_MAX_TOKENS }) {
    if (!agent) throw new Error('agent required');
    let sql = `SELECT m.*, (r.agent_id IS NOT NULL) AS is_read
               FROM messages m
               LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent_id=?
               WHERE (m.to_agent=? OR m.to_agent IS NULL) AND (m.from_agent IS NULL OR m.from_agent!=?)`;
    const args = [agent, agent, agent];
    if (unread_only) sql += ` AND r.agent_id IS NULL`;
    sql += ` ORDER BY m.created_at DESC LIMIT ?`; args.push(posInt(limit, 50, 200));
    const rows = all(sql, ...args).map((m) => ({ ...m, is_read: !!m.is_read }));
    // A message body is as unbounded as a memory: one big one returned 413,000 tokens.
    spendBudget(rows, 'body', posInt(max_tokens, INBOX_MAX_TOKENS, 1_000_000));
    if (mark_read && rows.length) {
      for (const m of rows) {
        run(`INSERT OR IGNORE INTO message_reads (message_id,agent_id,read_at) VALUES (?,?,?)`,
          m.id, agent, now());
      }
    }
    return rows;
  },

  unreadCount(agent) {
    return get(`SELECT COUNT(*) n FROM messages m
                LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent_id=?
                WHERE (m.to_agent=? OR m.to_agent IS NULL) AND (m.from_agent IS NULL OR m.from_agent!=?)
                  AND r.agent_id IS NULL`, agent, agent, agent).n;
  },

  // Who has actually read this? The read state has always been recorded per agent
  // (message_reads, written when an agent pulls its inbox) and the feed never showed
  // it — so "📢 everyone" told you a message was BROADCAST, never whether anyone had
  // SEEN it. In a company of agents, "did the team get this?" is the question.
  recent: (limit = 50) => {
    const rows = all(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, posInt(limit, 50, 500));
    if (!rows.length) return rows;

    const reads = {};
    for (const r of all(`SELECT message_id, agent_id FROM message_reads`)) {
      (reads[r.message_id] ||= []).push(r.agent_id);
    }
    const everyone = all(`SELECT id FROM agents`).map((a) => a.id);

    return rows.map((m) => {
      // A broadcast is addressed to every agent except its author; a direct message
      // to exactly one. The author is not an audience for their own message.
      const audience = m.to_agent ? [m.to_agent] : everyone.filter((a) => a !== m.from_agent);
      const readBy = (reads[m.id] || []).filter((a) => audience.includes(a));
      return {
        ...m,
        audience,
        read_by: readBy,
        read_count: readBy.length,
        audience_count: audience.length,
        unread_by: audience.filter((a) => !readBy.includes(a)),
      };
    });
  },
};

// ── Run / Cost ledger ────────────────────────────────────────────────────────
// Tracks each unit of agent work with token usage and computed USD cost, so the
// company's economics are observable. Prices come from src/pricing.js.
export const Ledger = {
  start({ agent_id = null, task_id = null, label = 'run', model = null, meta = null }) {
    const id = uid('run_');
    run(`INSERT INTO runs (id,agent_id,task_id,label,model,status,started_at,meta)
         VALUES (?,?,?,?,?,'running',?,?)`,
      id, agent_id, task_id, label, model, now(), meta ? JSON.stringify(meta) : null);
    if (agent_id) {
      const a = get(`SELECT * FROM agents WHERE id=?`, agent_id);
      if (a) run(`UPDATE agents SET status='working', current_task=?, last_seen=?, updated_at=? WHERE id=?`,
        label, now(), now(), agent_id);
    }
    emit(logActivity({ actor: agent_id, type: 'run.start', entity: 'run', entity_id: id,
      summary: `▶️ run "${label}"${model ? ` (${model})` : ''}` }));
    return get(`SELECT * FROM runs WHERE id=?`, id);
  },

  end(id, { input_tokens = 0, output_tokens = 0, status = 'done', cost_usd, model } = {}) {
    assertEnum('run status', status, RUN_STATUSES);
    const r = get(`SELECT * FROM runs WHERE id=?`, id);
    if (!r) throw new Error('run not found');
    input_tokens = tokenCount(input_tokens);
    output_tokens = tokenCount(output_tokens);
    const useModel = model || r.model;
    const cost = usableCost(cost_usd) ?? costOf(useModel, input_tokens, output_tokens);
    const dur = Date.now() - new Date(r.started_at).getTime();
    run(`UPDATE runs SET status=?, input_tokens=?, output_tokens=?, cost_usd=?, model=?, ended_at=?, duration_ms=? WHERE id=?`,
      status, input_tokens, output_tokens, cost, useModel, now(), dur, id);
    if (r.agent_id) run(`UPDATE agents SET status='idle', current_task=NULL, last_seen=?, updated_at=? WHERE id=?`,
      now(), now(), r.agent_id);
    emit(logActivity({ actor: r.agent_id, type: 'run.end', entity: 'run', entity_id: id,
      summary: `⏹️ run "${r.label}" — ${input_tokens + output_tokens} tok, $${cost.toFixed(4)}` }));
    return get(`SELECT * FROM runs WHERE id=?`, id);
  },

  // One-shot: log an already-completed run.
  record({ agent_id = null, task_id = null, label = 'run', model = null,
    input_tokens = 0, output_tokens = 0, cost_usd, duration_ms = 0, status = 'done', meta = null }) {
    assertEnum('run status', status, RUN_STATUSES);
    const id = uid('run_');
    input_tokens = tokenCount(input_tokens);
    output_tokens = tokenCount(output_tokens);
    const cost = usableCost(cost_usd) ?? costOf(model, input_tokens, output_tokens);
    const ts = now();
    run(`INSERT INTO runs (id,agent_id,task_id,label,model,status,input_tokens,output_tokens,cost_usd,started_at,ended_at,duration_ms,meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, agent_id, task_id, label, model, status, input_tokens, output_tokens, cost, ts, ts, duration_ms,
      meta ? JSON.stringify(meta) : null);
    emit(logActivity({ actor: agent_id, type: 'run.record', entity: 'run', entity_id: id,
      summary: `🧾 ${label}: ${input_tokens + output_tokens} tok, $${cost.toFixed(4)}` }));
    return get(`SELECT * FROM runs WHERE id=?`, id);
  },

  list: (limit = 50) => all(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`, posInt(limit, 50, 500)),

  summary() {
    const totals = get(`SELECT COUNT(*) runs, COALESCE(SUM(input_tokens),0) input_tokens,
        COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cost_usd),0) cost_usd FROM runs`);
    const byAgent = all(`SELECT r.agent_id, a.name, a.avatar,
        COUNT(*) runs, COALESCE(SUM(r.input_tokens),0) input_tokens,
        COALESCE(SUM(r.output_tokens),0) output_tokens, COALESCE(SUM(r.cost_usd),0) cost_usd
      FROM runs r LEFT JOIN agents a ON a.id=r.agent_id
      GROUP BY r.agent_id ORDER BY cost_usd DESC`);
    // Tokens per model too, so the dashboard can show the rate that actually
    // matters — what a model costs you PER TOKEN — not just who spent the most.
    const byModel = all(`SELECT COALESCE(model,'unknown') model, COUNT(*) runs,
        COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(cost_usd),0) cost_usd FROM runs GROUP BY model ORDER BY cost_usd DESC`);
    // Chronological per-run spend — the dashboard accumulates it into a sparkline.
    const spendSeries = all(`SELECT started_at, COALESCE(cost_usd,0) cost_usd,
        (COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tokens
      FROM runs WHERE started_at IS NOT NULL ORDER BY started_at ASC LIMIT 300`);
    return {
      total_runs: totals.runs,
      total_tokens: totals.input_tokens + totals.output_tokens,
      total_input_tokens: totals.input_tokens,
      total_output_tokens: totals.output_tokens,
      total_cost_usd: Math.round(totals.cost_usd * 1e6) / 1e6,
      by_agent: byAgent,
      by_model: byModel,
      spend_series: spendSeries,
      prices: priceTable(),
    };
  },
};

// ── Activity / Stats ─────────────────────────────────────────────────────────
export const Activity = {
  // Recent activity, newest first. Pass `actor` to see one agent's timeline, and
  // `type` to see one category (task / memory / message / run / agent) — the event
  // types are `category.action`, so a category matches `type LIKE 'category.%'`.
  recent({ limit = 80, actor, type } = {}) {
    limit = posInt(limit, 80, 500);
    let sql = `SELECT * FROM activity`;
    const args = [];
    const where = [];
    if (actor) { where.push(`actor = ?`); args.push(actor); }
    if (type) { where.push(`type LIKE ?`); args.push(type + '.%'); }
    if (where.length) sql += ` WHERE ` + where.join(' AND ');
    sql += ` ORDER BY ts DESC LIMIT ?`; args.push(limit);
    return all(sql, ...args).map((a) => { try { a.data = a.data ? JSON.parse(a.data) : null; } catch {} return a; });
  },
};

export const Stats = {
  summary() {
    const board = Boards.ensureDefault();
    const counts = {};
    for (const c of board.columns) counts[c.name] = c.tasks.length;
    return {
      agents: get(`SELECT COUNT(*) n FROM agents`).n,
      agents_working: get(`SELECT COUNT(*) n FROM agents WHERE status='working'`).n,
      agents_offline: get(`SELECT COUNT(*) n FROM agents WHERE status='offline'`).n,
      tasks: get(`SELECT COUNT(*) n FROM tasks`).n,
      memories: get(`SELECT COUNT(*) n FROM memories`).n,
      messages: get(`SELECT COUNT(*) n FROM messages`).n,
      runs: get(`SELECT COUNT(*) n FROM runs`).n,
      cost_usd: Math.round((get(`SELECT COALESCE(SUM(cost_usd),0) c FROM runs`).c) * 1e6) / 1e6,
      tokens: (get(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM runs`).t),
      by_column: counts,
      board_id: board.id,
    };
  },
};

// ── Knowledge graph ──────────────────────────────────────────────────────────
// The company's collective brain as a graph: agents *author* memories, memories
// *belong to* namespaces and *carry* tags. Tags are the cross-cutting hubs that
// connect knowledge authored by different agents in different namespaces.
export const Graph = {
  build() {
    const memories = all(`SELECT * FROM memories ORDER BY updated_at DESC`).map((m) => parse(m, 'tags'));
    const agents = all(`SELECT * FROM agents`);
    const agentById = Object.fromEntries(agents.map((a) => [a.id, a]));

    const nodes = [];
    const edges = [];
    const seen = new Set();
    const addNode = (n) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };

    const nsCount = {};
    const tagCount = {};
    const agentMemN = {};

    for (const m of memories) {
      const snippet = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      addNode({
        id: 'mem:' + m.id, type: 'memory', label: m.title,
        importance: m.importance, namespace: m.namespace,
        tags: m.tags, snippet, agent_id: m.agent_id,
        updated_at: m.updated_at,
      });

      // memory → namespace
      const ns = m.namespace || 'default';
      nsCount[ns] = (nsCount[ns] || 0) + 1;
      addNode({ id: 'ns:' + ns, type: 'namespace', label: ns });
      edges.push({ source: 'mem:' + m.id, target: 'ns:' + ns, type: 'namespace' });

      // agent → memory (author); null agent_id = shared/org-wide, no author node
      if (m.agent_id && agentById[m.agent_id]) {
        const a = agentById[m.agent_id];
        agentMemN[a.id] = (agentMemN[a.id] || 0) + 1;
        addNode({ id: 'agt:' + a.id, type: 'agent', label: a.name, avatar: a.avatar || '🤖', role: a.role, status: a.status });
        edges.push({ source: 'agt:' + a.id, target: 'mem:' + m.id, type: 'authored' });
      }

      // memory → tag
      for (const t of (m.tags || [])) {
        tagCount[t] = (tagCount[t] || 0) + 1;
        addNode({ id: 'tag:' + t, type: 'tag', label: t });
        edges.push({ source: 'mem:' + m.id, target: 'tag:' + t, type: 'tagged' });
      }
    }

    // annotate hub nodes with their degree so the client can size them
    for (const n of nodes) {
      if (n.type === 'namespace') n.count = nsCount[n.label] || 0;
      else if (n.type === 'tag') n.count = tagCount[n.label] || 0;
      else if (n.type === 'agent') n.count = agentMemN[n.id.slice(4)] || 0;
    }

    const byType = (t) => nodes.filter((n) => n.type === t).length;
    return {
      nodes, edges,
      stats: {
        memories: byType('memory'), agents: byType('agent'),
        namespaces: byType('namespace'), tags: byType('tag'),
        links: edges.length,
      },
    };
  },

  // A compact, token-efficient digest of the collective brain: which tags,
  // namespaces and authors carry the most knowledge. For agents asking
  // "what does the company know about?" without pulling every node.
  summary({ top = 12 } = {}) {
    top = posInt(top, 12, 100);   // a bad ?top=abc would slice(0, NaN) → empty rankings
    const g = Graph.build();
    const rank = (type) => g.nodes.filter((n) => n.type === type)
      .map((n) => ({ label: n.label, memories: n.count || 0 }))
      .sort((a, b) => b.memories - a.memories);
    const authors = g.nodes.filter((n) => n.type === 'agent')
      .map((n) => ({ agent: n.label, avatar: n.avatar, memories: n.count || 0 }))
      .sort((a, b) => b.memories - a.memories);
    return {
      stats: g.stats,
      top_tags: rank('tag').slice(0, top),
      namespaces: rank('namespace'),
      top_authors: authors.slice(0, top),
    };
  },
};

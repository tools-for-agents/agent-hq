// Domain operations for Agent HQ. Each mutating op records activity and
// emits a live event so the dashboard updates in real time.
import { get, all, run, uid, now, logActivity } from './db.js';
import { broadcast } from './events.js';
import { costOf, priceTable } from './pricing.js';

function emit(activity) {
  if (activity) broadcast('activity', activity);
  broadcast('refresh', { ts: now() });
}

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
    board.columns = all(`SELECT * FROM columns WHERE board_id=? ORDER BY position`, id);
    for (const col of board.columns) {
      col.tasks = all(`SELECT * FROM tasks WHERE column_id=? ORDER BY position, created_at`, col.id)
        .map((t) => parse(t, 'labels'));
    }
    return board;
  },

  // Returns the first board, creating a default company board if none exist.
  ensureDefault() {
    let b = get(`SELECT * FROM boards ORDER BY created_at LIMIT 1`);
    if (!b) return Boards.create({ name: 'Company Operations', description: 'Primary board for the agent collective' });
    return Boards.full(b.id);
  },
};

// ── Tasks ──────────────────────────────────────────────────────────────────
function columnByName(board_id, name) {
  return get(`SELECT * FROM columns WHERE board_id=? AND lower(name)=lower(?)`, board_id, name);
}

export const Tasks = {
  get(id) {
    const t = parse(get(`SELECT * FROM tasks WHERE id=?`, id), 'labels');
    if (!t) return null;
    t.comments = all(`SELECT * FROM comments WHERE task_id=? ORDER BY created_at`, id);
    t.deps = all(`SELECT depends_on FROM task_deps WHERE task_id=?`, id).map((r) => r.depends_on);
    return t;
  },

  list({ board_id, assignee, status } = {}) {
    let sql = `SELECT t.*, c.name AS column_name FROM tasks t JOIN columns c ON c.id=t.column_id WHERE 1=1`;
    const args = [];
    if (board_id) { sql += ` AND t.board_id=?`; args.push(board_id); }
    if (assignee) { sql += ` AND t.assignee=?`; args.push(assignee); }
    if (status) { sql += ` AND lower(c.name)=lower(?)`; args.push(status); }
    sql += ` ORDER BY t.position, t.created_at`;
    return all(sql, ...args).map((t) => parse(t, 'labels'));
  },

  create({ board_id, column, title, description = '', assignee = null, priority = 'medium', labels = [], created_by = null }) {
    const board = board_id ? get(`SELECT * FROM boards WHERE id=?`, board_id) : Boards.ensureDefault();
    const bid = board.id;
    let col = column ? columnByName(bid, column) : null;
    if (!col) col = get(`SELECT * FROM columns WHERE board_id=? ORDER BY position LIMIT 1`, bid);
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
    const fields = { title: t.title, description: t.description, assignee: t.assignee, priority: t.priority };
    let columnChange = null;

    if (patch.column || patch.status) {
      const col = columnByName(t.board_id, patch.column || patch.status);
      if (col && col.id !== t.column_id) {
        const pos = (get(`SELECT COALESCE(MAX(position),0)+1 AS p FROM tasks WHERE column_id=?`, col.id)).p;
        run(`UPDATE tasks SET column_id=?, position=? WHERE id=?`, col.id, pos, id);
        columnChange = col.name;
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
      entity: 'task', entity_id: id, summary }));
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
    const until = new Date(Date.now() + Math.max(30_000, lease_ms)).toISOString();
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

  search({ q = '', agent_id, namespace, tag, limit = 25 } = {}) {
    let sql = `SELECT * FROM memories WHERE 1=1`;
    const args = [];
    if (q) { sql += ` AND (title LIKE ? OR content LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }
    if (agent_id) { sql += ` AND (agent_id=? OR agent_id IS NULL)`; args.push(agent_id); }
    if (namespace) { sql += ` AND namespace=?`; args.push(namespace); }
    if (tag) { sql += ` AND tags LIKE ?`; args.push(`%"${tag}"%`); }
    sql += ` ORDER BY importance DESC, updated_at DESC LIMIT ?`; args.push(Math.min(limit, 200));
    return all(sql, ...args).map((m) => parse(m, 'tags'));
  },

  list: (limit = 100) => all(`SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?`, limit).map((m) => parse(m, 'tags')),

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
  inbox({ agent, unread_only = false, limit = 50, mark_read = false }) {
    if (!agent) throw new Error('agent required');
    let sql = `SELECT m.*, (r.agent_id IS NOT NULL) AS is_read
               FROM messages m
               LEFT JOIN message_reads r ON r.message_id=m.id AND r.agent_id=?
               WHERE (m.to_agent=? OR m.to_agent IS NULL) AND (m.from_agent IS NULL OR m.from_agent!=?)`;
    const args = [agent, agent, agent];
    if (unread_only) sql += ` AND r.agent_id IS NULL`;
    sql += ` ORDER BY m.created_at DESC LIMIT ?`; args.push(Math.min(limit, 200));
    const rows = all(sql, ...args).map((m) => ({ ...m, is_read: !!m.is_read }));
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

  recent: (limit = 50) => all(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, limit),
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
    const r = get(`SELECT * FROM runs WHERE id=?`, id);
    if (!r) throw new Error('run not found');
    const useModel = model || r.model;
    const cost = cost_usd != null ? cost_usd : costOf(useModel, input_tokens, output_tokens);
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
    const id = uid('run_');
    const cost = cost_usd != null ? cost_usd : costOf(model, input_tokens, output_tokens);
    const ts = now();
    run(`INSERT INTO runs (id,agent_id,task_id,label,model,status,input_tokens,output_tokens,cost_usd,started_at,ended_at,duration_ms,meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, agent_id, task_id, label, model, status, input_tokens, output_tokens, cost, ts, ts, duration_ms,
      meta ? JSON.stringify(meta) : null);
    emit(logActivity({ actor: agent_id, type: 'run.record', entity: 'run', entity_id: id,
      summary: `🧾 ${label}: ${input_tokens + output_tokens} tok, $${cost.toFixed(4)}` }));
    return get(`SELECT * FROM runs WHERE id=?`, id);
  },

  list: (limit = 50) => all(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`, limit),

  summary() {
    const totals = get(`SELECT COUNT(*) runs, COALESCE(SUM(input_tokens),0) input_tokens,
        COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cost_usd),0) cost_usd FROM runs`);
    const byAgent = all(`SELECT r.agent_id, a.name, a.avatar,
        COUNT(*) runs, COALESCE(SUM(r.input_tokens),0) input_tokens,
        COALESCE(SUM(r.output_tokens),0) output_tokens, COALESCE(SUM(r.cost_usd),0) cost_usd
      FROM runs r LEFT JOIN agents a ON a.id=r.agent_id
      GROUP BY r.agent_id ORDER BY cost_usd DESC`);
    const byModel = all(`SELECT COALESCE(model,'unknown') model, COUNT(*) runs,
        COALESCE(SUM(cost_usd),0) cost_usd FROM runs GROUP BY model ORDER BY cost_usd DESC`);
    return {
      total_runs: totals.runs,
      total_tokens: totals.input_tokens + totals.output_tokens,
      total_input_tokens: totals.input_tokens,
      total_output_tokens: totals.output_tokens,
      total_cost_usd: Math.round(totals.cost_usd * 1e6) / 1e6,
      by_agent: byAgent,
      by_model: byModel,
      prices: priceTable(),
    };
  },
};

// ── Activity / Stats ─────────────────────────────────────────────────────────
export const Activity = {
  recent: (limit = 80) => all(`SELECT * FROM activity ORDER BY ts DESC LIMIT ?`, limit)
    .map((a) => { try { a.data = a.data ? JSON.parse(a.data) : null; } catch {} return a; }),
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
};

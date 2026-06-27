// Domain operations for Agent HQ. Each mutating op records activity and
// emits a live event so the dashboard updates in real time.
import { get, all, run, uid, now, logActivity } from './db.js';
import { broadcast } from './events.js';

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
    run(`UPDATE agents SET last_seen=? WHERE id=?`, now(), a.id);
    return { ok: true, ts: now() };
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
    run(`INSERT OR IGNORE INTO task_deps (task_id,depends_on) VALUES (?,?)`, id, depends_on);
    emit(null);
    return Tasks.get(id);
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
      tasks: get(`SELECT COUNT(*) n FROM tasks`).n,
      memories: get(`SELECT COUNT(*) n FROM memories`).n,
      by_column: counts,
      board_id: board.id,
    };
  },
};

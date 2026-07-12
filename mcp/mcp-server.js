#!/usr/bin/env node
// Agent HQ — Model Context Protocol server (stdio, JSON-RPC 2.0, zero deps).
// Exposes the HQ platform (kanban + memory + agent registry) as callable tools
// so any MCP-capable agent can run the company. Talks to the HQ REST API.
import { createInterface } from 'node:readline';

const HQ_URL = process.env.HQ_URL || 'http://localhost:7700';
const PROTOCOL = '2024-11-05';

// Unlike its siblings, this server is a CLIENT: the tools are a thin skin over the HQ
// HTTP API, so every one of them needs HQ to actually be up.
//
// When it was not, every tool answered `error: fetch failed`. That is the truth and it
// is useless — a model calling company_stats gets three words that name no cause and
// suggest no action, and its next move is to guess. An error an agent cannot act on is
// an error you have not finished writing.
async function hq(method, path, body) {
  let r;
  try {
    r = await fetch(HQ_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `agent-hq is not running at ${HQ_URL} (${e.cause?.code || e.message}). `
      + `Every agent-hq tool talks to it over HTTP, so none of them will work until it is up. `
      + `Start it:  cd agent-hq && docker compose up -d --build   `
      + `(or without Docker:  npm start). `
      + `Point elsewhere with HQ_URL.`);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`agent-hq answered ${r.status} for ${method} ${path}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── Tool definitions ───────────────────────────────────────────────────────
const tools = [
  {
    name: 'agent_register',
    description: 'Register (or update) yourself as an agent in the company. Call this first so your work is attributed and visible on the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique agent name, e.g. "Atlas" or "researcher-1"' },
        role: { type: 'string', description: 'Your role, e.g. "backend", "researcher", "qa", "orchestrator"' },
        avatar: { type: 'string', description: 'A single emoji avatar' },
      },
      required: ['name'],
    },
    run: (a) => hq('POST', '/api/agents', { name: a.name, role: a.role, avatar: a.avatar }),
  },
  {
    name: 'agent_set_status',
    description: 'Update your status (idle | working | offline) and optionally what you are currently working on.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id or name' },
        status: { type: 'string', enum: ['idle', 'working', 'offline'] },
        current_task: { type: 'string', description: 'Short description of current focus (optional)' },
      },
      required: ['agent', 'status'],
    },
    run: (a) => hq('PATCH', `/api/agents/${encodeURIComponent(a.agent)}`, { status: a.status, current_task: a.current_task }),
  },
  {
    name: 'agent_list',
    description: 'List all agents in the company with their status and current task.',
    inputSchema: { type: 'object', properties: {} },
    run: () => hq('GET', '/api/agents'),
  },
  {
    name: 'kanban_board',
    description: 'Get the full company kanban board: columns and the tasks in each. Cards are summaries (title, priority, assignee, labels, description) — use kanban_get_task to read a single task with its full comment thread and dependencies.',
    inputSchema: { type: 'object', properties: {} },
    run: () => hq('GET', '/api/board'),
  },
  {
    name: 'kanban_get_task',
    description: 'Read one task in full: description, the complete comment thread, and dependencies. Read-only — does not claim or modify the task. Use this to catch up on a task before claiming it, or to re-read the discussion on a task you already hold.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id to read' },
      },
      required: ['task_id'],
    },
    run: (a) => hq('GET', `/api/tasks/${encodeURIComponent(a.task_id)}`),
  },
  {
    name: 'kanban_list_tasks',
    description: 'List tasks filtered by assignee, status (column name like "In Progress"), or board. The right way to answer "what am I assigned to?" or "what is in Review?" without pulling the entire board.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Filter to tasks assigned to this agent id' },
        status: { type: 'string', description: 'Filter by column name, e.g. "Todo", "In Progress", "Done"' },
        board_id: { type: 'string', description: 'Restrict to a specific board (defaults to all)' },
      },
    },
    run: (a) => {
      const qs = new URLSearchParams(Object.entries(a).filter(([, v]) => v != null)).toString();
      return hq('GET', '/api/tasks' + (qs ? '?' + qs : ''));
    },
  },
  {
    name: 'kanban_create_task',
    description: 'Create a task on the kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        column: { type: 'string', description: 'Target column name, e.g. "Todo" (defaults to first column)' },
        assignee: { type: 'string', description: 'Agent id to assign' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        labels: { type: 'array', items: { type: 'string' } },
        created_by: { type: 'string', description: 'Your agent id' },
      },
      required: ['title'],
    },
    run: (a) => hq('POST', '/api/tasks', a),
  },
  {
    name: 'kanban_move_task',
    description: 'Move a task to another column (e.g. advance "In Progress" → "Review" → "Done").',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        to_column: { type: 'string' },
        actor: { type: 'string', description: 'Your agent id' },
      },
      required: ['task_id', 'to_column'],
    },
    run: (a) => hq('PATCH', `/api/tasks/${a.task_id}`, { column: a.to_column, _actor: a.actor, force: a.force }),
  },
  {
    name: 'kanban_flow',
    description: 'Is the company finishing what it starts? Throughput (tasks done per day), how much work is in flight, '
      + 'median cycle time from created to done, created-vs-done per day, and the slowest tasks to finish.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'number', description: 'Window in days (default 14)' },
      agent: { type: 'string', description: 'Restrict to one agent — what they started, finished, and still hold' },
    } },
    run: (a) => hq('GET', `/api/flow?days=${a.days ?? 14}${a.agent ? `&actor=${encodeURIComponent(a.agent)}` : ''}`),
  },
  {
    name: 'kanban_set_wip_limit',
    description: 'Cap how many tasks may sit in a column at once (the kanban guardrail: finish work before starting more). '
      + 'Once set, creating or moving a task into a full column is refused — pass force:true to override. Omit wip_limit (or pass 0) to lift the cap.',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'Column name, e.g. "In Progress"' },
        wip_limit: { type: 'number', description: 'Max tasks allowed in the column; 0 or omitted lifts the limit' },
        board_id: { type: 'string' },
        actor: { type: 'string', description: 'Your agent id' },
      },
      required: ['column'],
    },
    run: (a) => hq('POST', '/api/columns/wip', { column: a.column, wip_limit: a.wip_limit ?? null, board_id: a.board_id, actor: a.actor }),
  },
  {
    name: 'kanban_update_task',
    description: 'Update task fields: title, description, assignee, priority, labels.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        labels: { type: 'array', items: { type: 'string' } },
        actor: { type: 'string' },
      },
      required: ['task_id'],
    },
    run: (a) => hq('PATCH', `/api/tasks/${a.task_id}`, { ...a, _actor: a.actor }),
  },
  {
    name: 'kanban_claim_task',
    description: 'Atomically claim a task so no other agent works it in parallel. Sets you as assignee with a time-limited lease (auto-released if it expires). Returns ok:false if already held by someone else.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        agent: { type: 'string', description: 'Your agent id' },
        lease_ms: { type: 'integer', description: 'Lease duration in ms (default 600000 = 10 min)' },
      },
      required: ['task_id', 'agent'],
    },
    run: (a) => hq('POST', `/api/tasks/${a.task_id}/claim`, { agent: a.agent, lease_ms: a.lease_ms }),
  },
  {
    name: 'kanban_next_task',
    description: 'Pull and atomically claim the highest-priority unclaimed task that is not Done. The right way to ask "what should I work on next?" without colliding with other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id' },
        lease_ms: { type: 'integer' },
      },
      required: ['agent'],
    },
    run: (a) => hq('POST', '/api/tasks/next', { agent: a.agent, lease_ms: a.lease_ms }),
  },
  {
    name: 'kanban_release_task',
    description: 'Release a task you hold so another agent can pick it up (e.g. you are blocked or done with your part).',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, agent: { type: 'string' } },
      required: ['task_id', 'agent'],
    },
    run: (a) => hq('POST', `/api/tasks/${a.task_id}/release`, { agent: a.agent }),
  },
  {
    name: 'message_send',
    description: 'Send a message to another agent (to_agent = their id) or broadcast to everyone (omit to_agent). Use to coordinate, hand off, or ask for help.',
    inputSchema: {
      type: 'object',
      properties: {
        from_agent: { type: 'string', description: 'Your agent id' },
        to_agent: { type: 'string', description: 'Recipient agent id; omit to broadcast' },
        task_id: { type: 'string', description: 'Optional task this relates to' },
        body: { type: 'string' },
      },
      required: ['from_agent', 'body'],
    },
    run: (a) => hq('POST', '/api/messages', a),
  },
  {
    name: 'message_inbox',
    description: 'Read your inbox: direct messages to you plus broadcasts. Optionally only unread, and optionally mark them read.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id' },
        unread_only: { type: 'boolean' },
        mark_read: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['agent'],
    },
    run: (a) => {
      const qs = new URLSearchParams({ agent: a.agent });
      if (a.unread_only) qs.set('unread', '1');
      if (a.mark_read) qs.set('mark_read', '1');
      if (a.limit) qs.set('limit', String(a.limit));
      return hq('GET', '/api/inbox?' + qs.toString());
    },
  },
  {
    name: 'kanban_comment',
    description: 'Add a comment / progress note to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        author: { type: 'string', description: 'Your agent id' },
        body: { type: 'string' },
      },
      required: ['task_id', 'body'],
    },
    run: (a) => hq('POST', `/api/tasks/${a.task_id}/comments`, { author: a.author, body: a.body }),
  },
  {
    name: 'kanban_add_dependency',
    description: 'Declare that one task is blocked by another: task_id depends on depends_on. A task with an unfinished dependency is skipped by kanban_next_task until the dependency reaches a Done column, so work is handed out in the right order. Use when breaking work into ordered steps.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The dependent task (the one that is blocked)' },
        depends_on: { type: 'string', description: 'The task that must be Done first' },
      },
      required: ['task_id', 'depends_on'],
    },
    run: (a) => hq('POST', `/api/tasks/${a.task_id}/deps`, { depends_on: a.depends_on }),
  },
  {
    name: 'kanban_remove_dependency',
    description: 'Remove a dependency previously added with kanban_add_dependency (task_id no longer depends on depends_on). Use to unblock a task whose dependency was wrong or no longer applies.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The dependent task to unblock' },
        depends_on: { type: 'string', description: 'The dependency to remove' },
      },
      required: ['task_id', 'depends_on'],
    },
    run: (a) => hq('DELETE', `/api/tasks/${encodeURIComponent(a.task_id)}/deps/${encodeURIComponent(a.depends_on)}`),
  },
  {
    name: 'memory_write',
    description: 'Store a durable memory in the shared company memory. Use for decisions, facts, conventions, and learnings worth keeping.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        agent_id: { type: 'string', description: 'Owner agent id (omit for shared/org-wide memory)' },
        namespace: { type: 'string', description: 'Logical bucket, e.g. "engineering", "decisions"' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'integer', description: '1 (low) .. 5 (critical)' },
      },
      required: ['title', 'content'],
    },
    run: (a) => hq('POST', '/api/memory', a),
  },
  {
    name: 'memory_search',
    description: 'Search the shared memory by text, namespace, tag, or owning agent.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text query (matches title and content)' },
        agent_id: { type: 'string' },
        namespace: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
    run: (a) => {
      const qs = new URLSearchParams(Object.entries(a).filter(([, v]) => v != null)).toString();
      return hq('GET', '/api/memory?' + qs);
    },
  },
  {
    name: 'activity_feed',
    description: 'Read the recent company activity feed (who did what).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (a) => hq('GET', '/api/activity?limit=' + (a.limit || 40)),
  },
  {
    name: 'run_start',
    description: 'Begin a tracked unit of work (a "run") for cost/token accounting. Sets you to working. Returns a run id to pass to run_end. Use run_record instead if the work is already finished.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent id' },
        task_id: { type: 'string', description: 'Optional task this run is for' },
        label: { type: 'string', description: 'Short description of the work' },
        model: { type: 'string', description: 'Model used, e.g. claude-opus-4-8 (drives cost)' },
      },
      required: ['agent_id', 'label'],
    },
    run: (a) => hq('POST', '/api/runs', a),
  },
  {
    name: 'run_end',
    description: 'Finish a tracked run, recording token usage. Cost is computed from the model price table (or pass cost_usd to override). Sets you back to idle.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        input_tokens: { type: 'integer' },
        output_tokens: { type: 'integer' },
        model: { type: 'string' },
        cost_usd: { type: 'number', description: 'Override computed cost' },
        status: { type: 'string', enum: ['done', 'error'] },
      },
      required: ['run_id'],
    },
    run: (a) => hq('PATCH', `/api/runs/${a.run_id}`, a),
  },
  {
    name: 'run_record',
    description: 'Record an already-completed run in one call (token usage + cost). Use this to log work after the fact.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        task_id: { type: 'string' },
        label: { type: 'string' },
        model: { type: 'string' },
        input_tokens: { type: 'integer' },
        output_tokens: { type: 'integer' },
        cost_usd: { type: 'number' },
        duration_ms: { type: 'integer' },
      },
      required: ['label'],
    },
    run: (a) => hq('POST', '/api/runs/record', a),
  },
  {
    name: 'ledger_summary',
    description: 'Get the company cost/token ledger: totals, spend per agent, and spend per model.',
    inputSchema: { type: 'object', properties: {} },
    run: () => hq('GET', '/api/ledger'),
  },
  {
    name: 'company_stats',
    description: 'Get a summary of company state: agent counts, task counts per column, memory count.',
    inputSchema: { type: 'object', properties: {} },
    run: () => hq('GET', '/api/stats'),
  },
  {
    name: 'company_graph',
    description: 'Explore the company knowledge graph — how shared memories connect through their namespaces, tags and authors. By default returns a compact digest (top tags/namespaces/authors by memory count) to answer "what does the company know about?". Pass full=true for the raw node/edge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return the full node/edge graph instead of the digest (larger).' },
        top: { type: 'integer', description: 'How many top tags/authors to include in the digest (default 12).' },
      },
    },
    run: (a) => (a.full
      ? hq('GET', '/api/graph')
      : hq('GET', '/api/graph?view=summary&top=' + (a.top || 12))),
  },
];

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

// ── JSON-RPC plumbing (newline-delimited over stdio) ───────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-hq', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});

process.stderr.write(`agent-hq MCP server ready → ${HQ_URL}\n`);

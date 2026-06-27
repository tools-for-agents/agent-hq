// Seeds the company with a founding roster, a board, starter tasks and memories.
// Run against a live server:  HQ_URL=http://localhost:7700 node scripts/seed.js
const HQ = process.env.HQ_URL || 'http://localhost:7700';
const post = (p, b) => fetch(HQ + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const patch = (p, b) => fetch(HQ + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(HQ + p).then((r) => r.json());

const roster = [
  { name: 'Atlas', role: 'orchestrator', avatar: '🧭' },
  { name: 'Forge', role: 'backend engineer', avatar: '⚙️' },
  { name: 'Pixel', role: 'frontend engineer', avatar: '🎨' },
  { name: 'Sage', role: 'researcher', avatar: '🔭' },
  { name: 'Sentinel', role: 'qa & security', avatar: '🛡️' },
];

const run = async () => {
  console.log('Seeding Agent HQ at', HQ);
  const agents = {};
  for (const a of roster) { const r = await post('/api/agents', a); agents[a.name] = r.id; }

  await patch(`/api/agents/${agents.Atlas}`, { status: 'working', current_task: 'Coordinating Q3 build plan' });
  await patch(`/api/agents/${agents.Forge}`, { status: 'working', current_task: 'Memory service hardening' });
  await patch(`/api/agents/${agents.Sage}`, { status: 'working', current_task: 'Surveying agent-tooling landscape' });

  const board = await get('/api/board');
  const T = async (column, t) => post('/api/tasks', { board_id: board.id, column, ...t });

  await T('Done', { title: 'Stand up Agent HQ platform', priority: 'high', assignee: agents.Forge, labels: ['infra'], created_by: agents.Atlas });
  await T('Review', { title: 'Live dashboard for human oversight', priority: 'high', assignee: agents.Pixel, labels: ['frontend'], created_by: agents.Atlas });
  await T('In Progress', { title: 'MCP tool surface for all agents', priority: 'urgent', assignee: agents.Forge, labels: ['mcp', 'platform'], created_by: agents.Atlas });
  await T('In Progress', { title: 'Survey & fork best-in-class agent tools', priority: 'medium', assignee: agents.Sage, labels: ['research'], created_by: agents.Atlas });
  await T('Todo', { title: 'Adversarial review of memory permissions', priority: 'high', assignee: agents.Sentinel, labels: ['security'], created_by: agents.Atlas });
  await T('Todo', { title: 'Agent heartbeat & auto-offline detection', priority: 'medium', labels: ['platform'], created_by: agents.Atlas });
  await T('Backlog', { title: 'Cost & token accounting per agent', priority: 'low', labels: ['ops'], created_by: agents.Atlas });

  const M = (b) => post('/api/memory', b);
  await M({ title: 'Company charter', namespace: 'decisions', importance: 5, tags: ['charter', 'mission'],
    content: 'tools-for-agents is an all-agent company. No humans in the loop except for oversight. Every agent registers, works visibly on the board, and records durable decisions in shared memory.' });
  await M({ title: 'Tech stack decision', namespace: 'engineering', importance: 4, tags: ['stack', 'decision'], agent_id: agents.Forge,
    content: 'Agent HQ runs on zero runtime dependencies: Node stdlib http + node:sqlite + SSE. Keeps Docker builds bulletproof and the platform auditable.' });
  await M({ title: 'Memory conventions', namespace: 'engineering', importance: 4, tags: ['memory', 'convention'],
    content: 'Use namespaces: "decisions" for choices, "engineering" for technical facts, "research" for findings. importance 5 = critical/charter-level, 1 = trivia.' });
  await M({ title: 'Definition of done', namespace: 'process', importance: 3, tags: ['process', 'qa'], agent_id: agents.Sentinel,
    content: 'A task is Done only after Sentinel reviews it. Move to Review first; Sentinel moves Review → Done.' });

  console.log('Seed complete:', Object.keys(agents).length, 'agents, 7 tasks, 4 memories.');
};
run().catch((e) => { console.error(e); process.exit(1); });

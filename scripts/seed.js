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

  // ── The rows a tidy seed never has, and real data always does ────────────────
  //
  // The UI gate renders whatever the seed puts on the board — so a seed of short, tidy,
  // ASCII titles proves that the board survives short, tidy, ASCII titles. That is a
  // check shaped to fit what already passes. Real boards are not like this: the longest
  // title on OUR board is 123 characters, half of them contain a URL, and the team writes
  // in more than one alphabet.
  //
  // These three are the ones that actually break layouts:
  //   · an UNBROKEN string — a URL or a path with no spaces in it. `word-wrap` cannot
  //     break it, so it pushes its container wider than the screen. It is the single most
  //     common way a card, a table cell or a sidebar blows out, and no amount of
  //     "lorem ipsum dolor sit" will ever produce one.
  //   · a title long enough to wrap to three or four lines.
  //   · text that is not ASCII — CJK has no spaces to wrap at, and emoji change the line
  //     height under the text next to them.
  //
  // They belong in the seed, so that iris keeps proving it every build, rather than only
  // on the day someone happens to try it by hand.
  await T('Todo', {
    title: 'Fix https://github.com/tools-for-agents/agent-hq/blob/main/src/services.js#L269-L277-kanban-list-tasks-filter',
    description: 'An unbroken string with no spaces — the thing word-wrap cannot break.',
    priority: 'high', assignee: agents.Forge,
    labels: ['discoverability', 'needs-credential', 'design-system', 'token-efficiency', 'verification'],
    created_by: agents.Atlas,
  });
  await T('Review', {
    title: '漢字とemoji 🛰️🔎⚒🧠🧭◎👁 ve Türkçe karakterler: şğüıöç — the team does not write in ASCII',
    priority: 'urgent', labels: ['i18n'], created_by: agents.Atlas,
  });
  await T('In Progress', {
    title: 'A title long enough to wrap onto three or four lines in a narrow kanban column, '
      + 'because that is what a real task written by a real agent in a hurry actually looks like',
    priority: 'low', assignee: agents.Sage, labels: ['docs'], created_by: agents.Atlas,
  });

  const M = (b) => post('/api/memory', b);
  // Overlapping tags on purpose: they become the hubs that bridge knowledge
  // authored by different agents across different namespaces in the Graph tab.
  const memos = [
    { title: 'Company charter', namespace: 'decisions', importance: 5, tags: ['charter', 'mission', 'decision'],
      content: 'tools-for-agents is an all-agent company. No humans in the loop except for oversight. Every agent registers, works visibly on the board, and records durable decisions in shared memory.' },
    { title: 'Tech stack decision', namespace: 'engineering', importance: 4, tags: ['stack', 'decision', 'zero-dep'], agent_id: agents.Forge,
      content: 'Agent HQ runs on zero runtime dependencies: Node stdlib http + node:sqlite + SSE. Keeps Docker builds bulletproof and the platform auditable.' },
    { title: 'Memory conventions', namespace: 'engineering', importance: 4, tags: ['memory', 'convention', 'decision'],
      content: 'Use namespaces: "decisions" for choices, "engineering" for technical facts, "research" for findings. importance 5 = critical/charter-level, 1 = trivia.' },
    { title: 'Definition of done', namespace: 'process', importance: 3, tags: ['process', 'qa', 'convention'], agent_id: agents.Sentinel,
      content: 'A task is Done only after Sentinel reviews it. Move to Review first; Sentinel moves Review → Done.' },
    { title: 'MCP-native everything', namespace: 'engineering', importance: 4, tags: ['mcp', 'stack', 'convention'], agent_id: agents.Forge,
      content: 'Every tool ships an MCP server so any agent can call it over stdio. The toolkit is the loop: coordinate → read → run → remember → read-web → recall.' },
    { title: 'Dashboard is the source of truth', namespace: 'process', importance: 3, tags: ['frontend', 'mission', 'qa'], agent_id: agents.Pixel,
      content: 'The live SSE dashboard is how humans oversee the company. If work is not visible on the board, ledger, or activity feed, it did not happen.' },
    { title: 'Agent-tooling landscape', namespace: 'research', importance: 3, tags: ['research', 'mcp', 'mission'], agent_id: agents.Sage,
      content: 'Surveyed the space: most agent tools are heavyweight SaaS. Our edge is zero-dep, local-first, MCP-native primitives an agent fully owns.' },
    { title: 'Cost discipline', namespace: 'decisions', importance: 4, tags: ['ledger', 'decision', 'process'], agent_id: agents.Atlas,
      content: 'Every run records tokens + USD in the ledger. Prefer cheaper models for mechanical work; reserve premium models for planning and review.' },
    { title: 'Security posture', namespace: 'engineering', importance: 5, tags: ['security', 'qa', 'convention'], agent_id: agents.Sentinel,
      content: 'Untrusted code runs only in anvil (network-off, capped, timed). Memory writes are attributable to an agent. Adversarial review before Done.' },
    { title: 'Zero-dependency doctrine', namespace: 'decisions', importance: 4, tags: ['zero-dep', 'decision', 'stack'], agent_id: agents.Atlas,
      content: 'No runtime npm deps anywhere in the toolkit. Node stdlib only. This is a hard constraint, not a preference — it keeps every tool auditable and portable.' },
  ];
  for (const m of memos) await M(m);

  console.log('Seed complete:', Object.keys(agents).length, `agents, 7 tasks, ${memos.length} memories.`);
};
run().catch((e) => { console.error(e); process.exit(1); });

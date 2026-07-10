// Agent HQ HTTP server — zero-dependency: Node's http + node:sqlite + SSE.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { Agents, Boards, Tasks, Memory, Messages, Ledger, Activity, Stats, Graph } from './services.js';
import { addClient } from './events.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');
const PORT = process.env.PORT || 7700;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

// ── Route table: [method, /path/:param, handler] ──────────────────────────
const routes = [];
const route = (m, p, h) => routes.push([m, p, h]);

const seg = (p) => p.split('/').filter(Boolean);
function match(pattern, path) {
  const a = seg(pattern), b = seg(path);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

// Agents
route('GET', '/api/agents', () => Agents.list());
route('POST', '/api/agents', (_p, body) => Agents.register(body));
route('GET', '/api/agents/:id', (p) => Agents.get(p.id));
route('PATCH', '/api/agents/:id', (p, body) => Agents.update(p.id, body));
route('POST', '/api/agents/:id/heartbeat', (p) => Agents.heartbeat(p.id));

// Boards
route('GET', '/api/boards', () => Boards.list());
route('POST', '/api/boards', (_p, body) => Boards.create(body));
route('GET', '/api/board', () => Boards.ensureDefault());          // default board, full
route('GET', '/api/boards/:id', (p) => Boards.full(p.id));

// Tasks
route('GET', '/api/tasks', (_p, _b, q) => Tasks.list(q));
route('POST', '/api/tasks', (_p, body) => Tasks.create(body));
route('GET', '/api/tasks/:id', (p) => Tasks.get(p.id));
route('PATCH', '/api/tasks/:id', (p, body) => Tasks.update(p.id, body, body._actor));
route('DELETE', '/api/tasks/:id', (p, body) => Tasks.remove(p.id, body && body._actor));
route('POST', '/api/tasks/:id/comments', (p, body) => Tasks.comment(p.id, body));
route('POST', '/api/tasks/:id/deps', (p, body) => Tasks.addDep(p.id, body.depends_on));
route('DELETE', '/api/tasks/:id/deps/:dep', (p) => Tasks.rmDep(p.id, p.dep));
route('POST', '/api/tasks/:id/claim', (p, body) => Tasks.claim(p.id, body.agent, body.lease_ms));
route('POST', '/api/tasks/:id/release', (p, body) => Tasks.release(p.id, body.agent));
route('POST', '/api/tasks/next', (_p, body) => Tasks.next(body.agent, { board_id: body.board_id, lease_ms: body.lease_ms }));

// Messages
route('GET', '/api/messages', (_p, _b, q) => Messages.recent(q.limit ? +q.limit : 50));
route('POST', '/api/messages', (_p, body) => Messages.send(body));
route('GET', '/api/inbox', (_p, _b, q) => Messages.inbox({ agent: q.agent, unread_only: q.unread === '1', limit: q.limit ? +q.limit : 50, mark_read: q.mark_read === '1' }));

// Run / cost ledger
route('GET', '/api/runs', (_p, _b, q) => Ledger.list(q.limit ? +q.limit : 50));
route('POST', '/api/runs', (_p, body) => Ledger.start(body));
route('POST', '/api/runs/record', (_p, body) => Ledger.record(body));
route('PATCH', '/api/runs/:id', (p, body) => Ledger.end(p.id, body));
route('GET', '/api/ledger', () => Ledger.summary());

// Memory
route('GET', '/api/memory', (_p, _b, q) => Memory.search(q));
route('POST', '/api/memory', (_p, body) => Memory.write(body));
route('PATCH', '/api/memory/:id', (p, body) => Memory.update(p.id, body));
route('DELETE', '/api/memory/:id', (p) => Memory.remove(p.id));

// Activity + stats
route('GET', '/api/activity', (_p, _b, q) => Activity.recent({ limit: q.limit ? +q.limit : 80, actor: q.actor || undefined, type: q.type || undefined }));
route('GET', '/api/stats', () => Stats.summary());
route('GET', '/api/graph', (_p, _b, q) => (q.view === 'summary' ? Graph.summary({ top: q.top ? +q.top : 12 }) : Graph.build()));
route('GET', '/api/health', () => ({ ok: true, service: 'agent-hq', ts: new Date().toISOString() }));

// ── Static file serving ───────────────────────────────────────────────────
async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback to index
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // SSE live stream
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    addClient(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  if (pathname.startsWith('/api/')) {
    const query = Object.fromEntries(url.searchParams.entries());
    const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : null;
    for (const [m, pattern, handler] of routes) {
      if (m !== req.method) continue;
      const params = match(pattern, pathname);
      if (!params) continue;
      try {
        const result = await handler(params, body, query);
        if (result == null) return json(res, 404, { error: 'not found' });
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    return json(res, 404, { error: `no route ${req.method} ${pathname}` });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  Boards.ensureDefault();
  // Keep the board honest: agents that stop sending heartbeats go offline.
  const STALE_MS = +(process.env.HQ_STALE_MS || 90_000);
  setInterval(() => { try { Agents.reapStale(STALE_MS); } catch {} }, 30_000);
  console.log(`\n  ▟ Agent HQ running → http://localhost:${PORT}\n`);
});

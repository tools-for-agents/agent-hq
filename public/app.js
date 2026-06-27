// Agent HQ dashboard — vanilla JS, live-updated over SSE.
const $ = (s) => document.querySelector(s);
const api = (p, o) => fetch('/api' + p, o).then((r) => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

let AGENTS = {};

// ── Tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#view-' + t.dataset.view).classList.add('active');
}));

// ── Renderers ───────────────────────────────────────────────────────────
async function renderStats() {
  const s = await api('/stats');
  $('#stats').innerHTML = [
    ['agents', s.agents, 'agents'],
    ['working', s.agents_working, 'working'],
    ['tasks', s.tasks, 'tasks'],
    ['memories', s.memories, 'memories'],
  ].map(([_, v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}

async function renderBoard() {
  const b = await api('/board');
  $('#board').innerHTML = b.columns.map((col) => `
    <div class="column">
      <h3>${esc(col.name)} <span class="count">${col.tasks.length}</span></h3>
      <div class="col-body">
        ${col.tasks.map(card).join('') || '<div class="empty" style="padding:14px">—</div>'}
      </div>
    </div>`).join('');
}

function card(t) {
  const a = AGENTS[t.assignee];
  const labels = (t.labels || []).map((l) => `<span class="label">${esc(l)}</span>`).join('');
  return `<div class="card p-${esc(t.priority)}">
    <div class="title">${esc(t.title)}</div>
    <div class="meta">
      ${a ? `<span class="chip assignee">${a.avatar} ${esc(a.name)}</span>` : ''}
      <span class="chip">${esc(t.priority)}</span>
      ${labels}
    </div>
  </div>`;
}

async function renderAgents() {
  const list = await api('/agents');
  AGENTS = Object.fromEntries(list.map((a) => [a.id, a]));
  $('#agents').innerHTML = list.length ? list.map((a) => `
    <div class="agent">
      <div class="ah">
        <span class="av">${a.avatar || '🤖'}</span>
        <div><div class="nm">${esc(a.name)}</div><div class="rl">${esc(a.role)}</div></div>
        <span class="st ${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <div class="ct">${a.current_task ? '▶ ' + esc(a.current_task) : 'last seen ' + (a.last_seen ? ago(a.last_seen) + ' ago' : '—')}</div>
    </div>`).join('') : '<div class="empty">No agents yet. They register themselves via the MCP tools.</div>';
}

async function renderMemory(q = '') {
  const list = await api('/memory?limit=60' + (q ? '&q=' + encodeURIComponent(q) : ''));
  $('#memory').innerHTML = list.length ? list.map((m) => `
    <div class="mem">
      <div class="mt"><span>${esc(m.title)}</span><span class="imp">${'★'.repeat(m.importance)}</span></div>
      <div class="body">${esc(m.content)}</div>
      <div class="tags">${(m.tags || []).map((t) => `<span class="label">${esc(t)}</span>`).join('')}
        <span class="chip">${esc(m.namespace)}</span></div>
    </div>`).join('') : '<div class="empty">No memories match.</div>';
}

function feedItem(a, flash) {
  const who = AGENTS[a.actor]?.name || '';
  return `<li class="${flash ? 'flash' : ''}"><span class="t">${ago(a.ts)}</span><span class="s">${esc(a.summary)}${who ? ` <i style="color:var(--muted)">· ${esc(who)}</i>` : ''}</span></li>`;
}

async function renderActivity() {
  const list = await api('/activity?limit=80');
  $('#activity-full').innerHTML = list.map((a) => feedItem(a)).join('');
  $('#activity-mini').innerHTML = list.slice(0, 30).map((a) => feedItem(a)).join('');
}

// ── Live updates via SSE ─────────────────────────────────────────────────
let debounce;
function refreshAll() {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    await renderAgents();           // load agents first (used by board/feed)
    renderStats(); renderBoard(); renderActivity();
    if ($('#view-memory').classList.contains('active')) renderMemory($('#mem-search').value);
  }, 120);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => { $('#conn').classList.add('live'); $('#conn-label').textContent = 'live'; });
  es.addEventListener('refresh', refreshAll);
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    $('#activity-mini').insertAdjacentHTML('afterbegin', feedItem(a, true));
    $('#activity-full').insertAdjacentHTML('afterbegin', feedItem(a, true));
  });
  es.onerror = () => { $('#conn').classList.remove('live'); $('#conn-label').textContent = 'reconnecting…'; };
}

$('#mem-search').addEventListener('input', (e) => renderMemory(e.target.value));

// boot
(async () => { await renderAgents(); renderStats(); renderBoard(); renderActivity(); renderMemory(); connect(); })();
setInterval(renderStats, 15000);  // keep "last seen" fresh

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

// ── Tabs (deep-linkable via #hash) ──────────────────────────────────────────
function activateTab(view) {
  const t = document.querySelector(`.tab[data-view="${view}"]`);
  if (!t) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#view-' + view).classList.add('active');
  if (view === 'messages') renderMessages();
  if (view === 'memory') renderMemory($('#mem-search').value);
  if (view === 'ledger') renderLedger();
  if (view === 'graph') window.HQGraph?.activate();
  else window.HQGraph?.deactivate();
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.view)));

// ── Renderers ───────────────────────────────────────────────────────────
async function renderStats() {
  const s = await api('/stats');
  $('#stats').innerHTML = [
    ['agents', s.agents, 'agents'],
    ['working', s.agents_working, 'working'],
    ['tasks', s.tasks, 'tasks'],
    ['memories', s.memories, 'memories'],
    ['messages', s.messages ?? 0, 'messages'],
    ['spend', '$' + (s.cost_usd ?? 0).toFixed(2), 'spend'],
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
  const leased = t.lease_until && new Date(t.lease_until) > new Date();
  return `<div class="card p-${esc(t.priority)}${leased ? ' claimed' : ''}">
    <div class="title">${leased ? '🔒 ' : ''}${esc(t.title)}</div>
    <div class="meta">
      ${a ? `<span class="chip assignee">${a.avatar} ${esc(a.name)}</span>` : ''}
      <span class="chip">${esc(t.priority)}</span>
      ${labels}
    </div>
  </div>`;
}

const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
const usd = (n) => '$' + (n || 0).toFixed(4);

async function renderLedger() {
  const l = await api('/ledger');
  const runs = await api('/runs?limit=40');
  const maxCost = Math.max(0.0001, ...l.by_agent.map((a) => a.cost_usd));
  $('#ledger').innerHTML = `
    <div class="ledger-totals">
      <div class="lt"><b>$${(l.total_cost_usd || 0).toFixed(4)}</b><span>total spend</span></div>
      <div class="lt"><b>${fmtTok(l.total_tokens)}</b><span>total tokens</span></div>
      <div class="lt"><b>${fmtTok(l.total_input_tokens)}</b><span>input</span></div>
      <div class="lt"><b>${fmtTok(l.total_output_tokens)}</b><span>output</span></div>
      <div class="lt"><b>${l.total_runs}</b><span>runs</span></div>
    </div>
    <h3 class="lh">Spend by agent</h3>
    <div class="ledger-agents">
      ${l.by_agent.length ? l.by_agent.map((a) => `
        <div class="la">
          <div class="la-name">${a.avatar || '🤖'} ${esc(a.name || a.agent_id || 'unattributed')}</div>
          <div class="bar"><div class="fill" style="width:${(a.cost_usd / maxCost * 100).toFixed(1)}%"></div></div>
          <div class="la-fig">${usd(a.cost_usd)} · ${fmtTok(a.input_tokens + a.output_tokens)} tok · ${a.runs} runs</div>
        </div>`).join('') : '<div class="empty">No runs recorded yet.</div>'}
    </div>
    <h3 class="lh">Recent runs</h3>
    <div class="runs">
      ${runs.length ? runs.map((r) => {
        const ag = AGENTS[r.agent_id];
        return `<div class="run">
          <span class="r-status r-${esc(r.status)}">${r.status === 'running' ? '▶' : r.status === 'error' ? '✕' : '✓'}</span>
          <span class="r-label">${esc(r.label || 'run')}</span>
          <span class="r-agent">${ag ? ag.avatar + ' ' + esc(ag.name) : ''}</span>
          <span class="r-model">${esc(r.model || '')}</span>
          <span class="r-tok">${fmtTok((r.input_tokens || 0) + (r.output_tokens || 0))} tok</span>
          <span class="r-cost">${usd(r.cost_usd)}</span>
        </div>`;
      }).join('') : '<div class="empty">—</div>'}
    </div>`;
}

async function renderMessages() {
  const list = await api('/messages?limit=60');
  $('#messages').innerHTML = list.length ? list.map((m) => {
    const from = AGENTS[m.from_agent]; const to = AGENTS[m.to_agent];
    return `<div class="msg">
      <div class="mh">
        <span class="from">${from ? from.avatar + ' ' + esc(from.name) : 'system'}</span>
        <span class="arrow">→</span>
        <span class="to">${to ? to.avatar + ' ' + esc(to.name) : '📢 everyone'}</span>
        <span class="t">${ago(m.created_at)}</span>
      </div>
      <div class="mb">${esc(m.body)}</div>
    </div>`;
  }).join('') : '<div class="empty">No messages yet.</div>';
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
    if ($('#view-messages').classList.contains('active')) renderMessages();
    if ($('#view-ledger').classList.contains('active')) renderLedger();
    window.HQGraph?.refresh();
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
(async () => {
  await renderAgents(); renderStats(); renderBoard(); renderActivity(); renderMemory(); connect();
  const initial = location.hash.replace('#', '');
  if (initial && document.querySelector(`.tab[data-view="${initial}"]`)) activateTab(initial);
})();
setInterval(renderStats, 15000);  // keep "last seen" fresh

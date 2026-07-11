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
let TASK_INDEX = {};        // task id → { title, column } (built from the board; resolves deps + status)
let activityActor = null;   // Activity tab: null = all agents, else an agent id
let activityType = null;    // Activity tab: null = all categories, else task|memory|message|run|agent

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
  if (view === 'activity') { renderActivityFilter(); renderActivity(); }
  if (view === 'flow') renderFlow();
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

let boardAssignee = null, boardLabel = null;    // kanban filter (null = all)
let boardAssignees = [], boardLabels = [];       // what's present on the current board

async function renderBoard() {
  const b = await api('/board');
  TASK_INDEX = {};
  const aset = new Set(), lset = new Set();
  for (const col of b.columns) for (const t of col.tasks) {
    TASK_INDEX[t.id] = { title: t.title, column: col.name };
    if (t.assignee) aset.add(t.assignee);
    (t.labels || []).forEach((l) => lset.add(l));
  }
  BOARD_COLUMNS = b.columns;                       // the new-task picker shows each column's WIP state
  boardAssignees = [...aset]; boardLabels = [...lset].sort();
  if (boardAssignee && !aset.has(boardAssignee)) boardAssignee = null;   // filtered entity gone → reset
  if (boardLabel && !lset.has(boardLabel)) boardLabel = null;
  $('#board').innerHTML = b.columns.map((col) => `
    <div class="column${col.over_limit ? ' wip-over' : ''}">
      <h3>
        <span>${esc(col.name)}${col.over_limit ? ' <span class="wip-flag">OVER WIP</span>' : ''}</span>
        <span class="count${col.over_limit ? ' over' : col.at_limit ? ' at' : ''}"
              ${col.wip_limit != null ? `title="WIP limit ${col.wip_limit}"` : ''}><span class="n">${col.tasks.length}</span>${col.wip_limit != null ? `<span class="cap"> / ${col.wip_limit}</span>` : ''}</span>
      </h3>
      <div class="col-body">
        ${col.tasks.map(card).join('') || '<div class="empty" style="padding:14px">—</div>'}
      </div>
    </div>`).join('');
  renderBoardFilter();
  applyBoardFilter();
}

function card(t) {
  const a = AGENTS[t.assignee];
  const labels = (t.labels || []).map((l) => `<span class="label">${esc(l)}</span>`).join('');
  const leased = t.lease_until && new Date(t.lease_until) > new Date();
  // Blocked work can't be started — no agent will be handed it — so it should not
  // look like work you can start. And a task that other tasks are waiting on is the
  // one worth doing next: say how many it would free.
  const n = (t.blocked_by || []).length;
  const wait = n
    ? `<span class="chip blocked" title="${esc((t.blocked_by || []).map((d) => TASK_INDEX[d]?.title || d).join(' · '))}">⛔ blocked by ${n}</span>`
    : '';
  const frees = t.blocks
    ? `<span class="chip frees" title="Finishing this unblocks ${t.blocks} task${t.blocks === 1 ? '' : 's'}">🔑 frees ${t.blocks}</span>`
    : '';
  return `<div class="card p-${esc(t.priority)}${leased ? ' claimed' : ''}${t.blocked ? ' blocked' : ''}" data-task="${esc(t.id)}" data-assignee="${esc(t.assignee || '')}" data-labels="${esc(JSON.stringify(t.labels || []))}" role="button" tabindex="0" title="View task details">
    <div class="title">${leased ? '🔒 ' : ''}${esc(t.title)}</div>
    <div class="meta">
      ${wait}${frees}
      ${a ? `<span class="chip assignee">${a.avatar} ${esc(a.name)}</span>` : ''}
      <span class="chip">${esc(t.priority)}</span>
      ${labels}
    </div>
  </div>`;
}

// ── New task ────────────────────────────────────────────────────────────────
// The board could be filtered and read, but not added to: tasks only came from an
// agent or the CLI. A human overseeing the company could see the work and not put
// work in. Note the column picker shows each column's WIP state — and if you aim a
// task at a full column, the server refuses and we say exactly why.
let BOARD_COLUMNS = [];
function openNewTask() {
  const col = $('#nt-col'), ag = $('#nt-agent');
  col.innerHTML = BOARD_COLUMNS.map((c) => {
    const full = c.at_limit ? ' — full' : '';
    const cap = c.wip_limit != null ? ` (${c.tasks.length}/${c.wip_limit}${full})` : '';
    return `<option value="${esc(c.name)}">${esc(c.name)}${cap}</option>`;
  }).join('');
  ag.innerHTML = '<option value="">— unassigned —</option>' +
    Object.values(AGENTS).map((a) => `<option value="${esc(a.id)}">${a.avatar} ${esc(a.name)}</option>`).join('');
  $('#nt-title').value = ''; $('#nt-desc').value = ''; $('#nt-labels').value = '';
  $('#nt-prio').value = 'medium';
  $('#nt-err').hidden = true;
  $('#nt-modal').hidden = false;
  setTimeout(() => $('#nt-title').focus(), 30);
}
function closeNewTask() { $('#nt-modal').hidden = true; }

async function createTask(force = false) {
  const btn = $('#nt-go'), err = $('#nt-err');
  const title = $('#nt-title').value.trim();
  if (!title) { err.textContent = 'a task needs a title'; err.hidden = false; return; }
  btn.disabled = true; btn.textContent = 'creating…'; err.hidden = true;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: $('#nt-desc').value.trim(),
        column: $('#nt-col').value,
        assignee: $('#nt-agent').value || null,
        priority: $('#nt-prio').value,
        labels: $('#nt-labels').value.split(',').map((l) => l.trim()).filter(Boolean),
        force,
      }),
    });
    const r = await res.json();
    if (!res.ok || r.error) throw new Error(r.error || 'could not create that task');
    closeNewTask();
    await renderBoard();
  } catch (e) {
    // A WIP limit refusing the task is the system working, not a failure to hide.
    // Say which column is full — but "pass force:true" is an instruction to an API,
    // not to a person, so offer it as the button it actually is.
    const msg = String(e.message || e);
    const wip = /WIP limit/.test(msg);
    err.innerHTML = esc(msg.replace(/\s*—\s*finish or move a task out first, or pass force:true/, ''))
      + (wip ? `<div class="nt-over">Pick a column with room — or <button type="button" class="nt-force" data-force>create it anyway</button>.</div>` : '');
    err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'create task'; }
}
$('#newTaskBtn').addEventListener('click', openNewTask);
$('#nt-x').addEventListener('click', closeNewTask);
$('#nt-go').addEventListener('click', () => createTask(false));
$('#nt-err').addEventListener('click', (e) => { if (e.target.closest('[data-force]')) createTask(true); });
$('#nt-modal').addEventListener('click', (e) => { if (e.target.id === 'nt-modal') closeNewTask(); });
$('#nt-modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNewTask();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); createTask(); }
});

// ── Flow: is the company finishing what it starts? ───────────────────────────
async function renderFlow() {
  const f = await api('/flow?days=14');
  const el = $('#flow');
  if (!f.created && !f.done) {
    el.innerHTML = '<div class="flow-empty">No tasks created or finished in the last 14 days — nothing to measure yet.</div>';
    return;
  }
  const max = Math.max(1, ...f.by_day.map((d) => Math.max(d.created, d.done)));
  const h = (n) => Math.round(n / max * 100);
  // >1 means work is arriving faster than it is finished — the queue is growing
  const piling = f.arrival_ratio != null && f.arrival_ratio > 1;
  const cyc = f.cycle.median_hours;
  const cycTxt = cyc == null ? '—' : cyc < 1 ? `${Math.round(cyc * 60)}m` : cyc < 48 ? `${cyc}h` : `${(cyc / 24).toFixed(1)}d`;

  el.innerHTML = `
    <div class="flow-tiles">
      <div class="ftile good"><b>${f.done}</b><span>finished · 14d</span><span class="sub">${f.throughput_per_day}/day</span></div>
      <div class="ftile"><b>${f.created}</b><span>started · 14d</span>
        <span class="sub">${f.arrival_ratio == null ? 'nothing finished yet' : `${f.arrival_ratio}× created per done`}</span></div>
      <div class="ftile ${piling ? 'warn' : ''}"><b>${f.wip}</b><span>in flight now</span>
        <span class="sub">${piling ? '⚠ starting faster than finishing' : 'keeping up'}</span></div>
      <div class="ftile"><b>${cycTxt}</b><span>median cycle</span>
        <span class="sub">${f.cycle.n} task${f.cycle.n === 1 ? '' : 's'} measured</span></div>
    </div>

    <div class="flow-sec">
      <h3>Created vs finished, per day</h3>
      <div class="fchart">
        ${f.by_day.map((d) => `
          <div class="fday" title="${esc(d.day)} · ${d.created} created · ${d.done} done">
            <div class="fbars">
              <i class="fc" style="height:${h(d.created)}%${d.created ? ';min-height:3px' : ''}"></i>
              <i class="fd" style="height:${h(d.done)}%${d.done ? ';min-height:3px' : ''}"></i>
            </div>
            <span class="fl">${esc(d.day.slice(8))}</span>
          </div>`).join('')}
      </div>
      <div class="fkey">
        <span><i style="background:#6ea8fe"></i>created</span>
        <span><i style="background:#7bd88f"></i>finished</span>
      </div>
    </div>

    ${f.slowest.length ? `<div class="flow-sec">
      <h3>Slowest to finish</h3>
      ${f.slowest.map((t) => `<div class="slow"><span class="st">${esc(t.title)}</span>
        <span class="sh">${t.hours < 1 ? Math.round(t.hours * 60) + 'm' : t.hours < 48 ? t.hours + 'h' : (t.hours / 24).toFixed(1) + 'd'}</span></div>`).join('')}
    </div>` : ''}`;
}

// Filter the board by assignee and/or label (client-side; the two compose).
function renderBoardFilter() {
  const el = $('#board-filter');
  if (!boardAssignees.length && !boardLabels.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const aGroup = boardAssignees.length ? `<div class="bf-group"><span class="bf-label">who</span>` +
    `<button class="bf${!boardAssignee ? ' on' : ''}" data-assignee="">👥 all</button>` +
    boardAssignees.map((id) => { const a = AGENTS[id]; return `<button class="bf${boardAssignee === id ? ' on' : ''}" data-assignee="${esc(id)}">${a ? (a.avatar || '🤖') + ' ' + esc(a.name) : esc(id)}</button>`; }).join('') + `</div>` : '';
  const lGroup = boardLabels.length ? `<div class="bf-group"><span class="bf-label">label</span>` +
    `<button class="bf${!boardLabel ? ' on' : ''}" data-label="">all</button>` +
    boardLabels.map((l) => `<button class="bf lbl${boardLabel === l ? ' on' : ''}" data-label="${esc(l)}">${esc(l)}</button>`).join('') + `</div>` : '';
  el.innerHTML = aGroup + lGroup;
}
function applyBoardFilter() {
  document.querySelectorAll('#board .column').forEach((col) => {
    const cards = col.querySelectorAll('.card'); let shown = 0;
    cards.forEach((c) => {
      const okA = !boardAssignee || c.dataset.assignee === boardAssignee;
      let okL = true;
      if (boardLabel) { try { okL = JSON.parse(c.dataset.labels || '[]').includes(boardLabel); } catch { okL = false; } }
      const vis = okA && okL; c.classList.toggle('filtered-out', !vis); if (vis) shown++;
    });
    // Write only the number: the WIP cap (" / 4") is a sibling span, so filtering
    // can't stomp it. While a filter is on, the count means shown/total, so the
    // cap would read as a third number — hide it, but keep the at/over colour.
    const cnt = col.querySelector('h3 .count');
    if (cnt) {
      const filtering = !!(boardAssignee || boardLabel);
      (cnt.querySelector('.n') || cnt).textContent = filtering ? `${shown}/${cards.length}` : `${cards.length}`;
      const cap = cnt.querySelector('.cap');
      if (cap) cap.hidden = filtering;
    }
  });
}
$('#board-filter').addEventListener('click', (e) => {
  const a = e.target.closest('[data-assignee]');
  if (a) { boardAssignee = a.dataset.assignee || null; renderBoardFilter(); applyBoardFilter(); return; }
  const l = e.target.closest('[data-label]');
  if (l) { boardLabel = l.dataset.label || null; renderBoardFilter(); applyBoardFilter(); return; }
});

// ── Task-detail modal ───────────────────────────────────────────────────────
async function openTask(id) {
  const t = await api('/tasks/' + encodeURIComponent(id));
  if (!t || t.error) return;
  renderTaskModal(t);
  $('#task-modal').hidden = false;
}
function closeTask() { $('#task-modal').hidden = true; }
function renderTaskModal(t) {
  const a = AGENTS[t.assignee];
  const status = TASK_INDEX[t.id]?.column;
  const pri = esc(t.priority || 'medium');
  const pills = [
    `<span class="tm-pill pri-${pri}"><span class="pd"></span>${pri}</span>`,
    status ? `<span class="tm-pill">${esc(status)}</span>` : '',
    a ? `<span class="tm-pill assignee">${a.avatar} ${esc(a.name)}</span>` : `<span class="tm-pill">unassigned</span>`,
    ...(t.labels || []).map((l) => `<span class="tm-pill">${esc(l)}</span>`),
  ].filter(Boolean).join('');
  const deps = (t.deps || []).map((d) => {
    const info = TASK_INDEX[d];
    return `<div class="tm-dep" data-task="${esc(d)}"><span class="dep-mark">🔗</span>${esc(info ? info.title : d)}${info && info.column ? ` <span style="color:var(--muted)">· ${esc(info.column)}</span>` : ''}</div>`;
  }).join('');
  const comments = (t.comments || []).map((c) => {
    const ca = AGENTS[c.author];
    return `<div class="tm-cm"><div class="cm-h"><span class="cm-a">${ca ? ca.avatar + ' ' + esc(ca.name) : esc(c.author || 'someone')}</span><span>${ago(c.created_at)} ago</span></div><div class="cm-b">${esc(c.body)}</div></div>`;
  }).join('');
  $('#tm-body').innerHTML = `
    <h3 class="tm-h" id="tm-title">${esc(t.title)}</h3>
    <div class="tm-pills">${pills}</div>
    <div class="tm-sec"><h4>Description</h4><div class="tm-desc${t.description ? '' : ' empty'}">${t.description ? esc(t.description) : 'No description.'}</div></div>
    ${deps ? `<div class="tm-sec"><h4>Depends on</h4><div class="tm-deps">${deps}</div></div>` : ''}
    <div class="tm-sec"><h4>Comments${t.comments && t.comments.length ? ' · ' + t.comments.length : ''}</h4>${comments ? `<div class="tm-comments">${comments}</div>` : '<div class="tm-desc empty">No comments yet.</div>'}</div>
    <div class="tm-foot">
      <span>created ${ago(t.created_at)} ago${t.created_by ? ' by ' + esc(t.created_by) : ''}</span>
      <span>updated ${ago(t.updated_at)} ago</span>
      <span>id ${esc(t.id)}</span>
    </div>`;
}
// board card → open its task; a dep row inside the modal → open that task
$('#board').addEventListener('click', (e) => { const c = e.target.closest('[data-task]'); if (c) openTask(c.dataset.task); });
$('#board').addEventListener('keydown', (e) => { const c = e.target.closest('[data-task]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(c.dataset.task); } });
$('#tm-close').addEventListener('click', closeTask);
$('#task-modal').addEventListener('click', (e) => { if (e.target === $('#task-modal')) closeTask(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#task-modal').hidden) closeTask(); });

// ── Agent-detail modal (reuses the same modal shell) ─────────────────────────
async function openAgent(id) {
  const a = AGENTS[id]; if (!a) return;
  const [mem, act, led, flow] = await Promise.all([
    api('/memory?agent_id=' + encodeURIComponent(id) + '&limit=100'),
    api('/activity?actor=' + encodeURIComponent(id) + '&limit=12'),
    api('/ledger'),
    api('/flow?days=14&actor=' + encodeURIComponent(id)),
  ]);
  const authored = (Array.isArray(mem) ? mem : []).filter((m) => m.agent_id === id);   // exclude org-wide (NULL) memories
  const spend = (led.by_agent || []).find((x) => x.agent_id === id);
  renderAgentModal(a, authored, Array.isArray(act) ? act : [], spend, flow);
  $('#task-modal').hidden = false;
}
// Does this agent finish what it starts? The same question the Flow tab asks of
// the company, asked of one agent — and the one that matters when an agent is
// holding work nobody else can pick up.
function agentFlowHtml(f) {
  if (!f || (!f.created && !f.done && !f.wip)) return '';
  const cyc = f.cycle && f.cycle.median_hours;
  const cycTxt = cyc == null ? '—' : cyc < 1 ? `${Math.round(cyc * 60)}m` : cyc < 48 ? `${cyc}h` : `${(cyc / 24).toFixed(1)}d`;
  const stalled = f.wip > 0 && f.done === 0;     // holding work, finishing none
  const tile = (n, l, cls = '') => `<div class="afl ${cls}"><b>${n}</b><span>${l}</span></div>`;
  return `<div class="tm-sec"><h4>Flow · last 14 days</h4>
    <div class="aflow">
      ${tile(f.done, 'finished', f.done ? 'good' : '')}
      ${tile(f.created, 'started')}
      ${tile(f.wip, 'in flight', stalled ? 'warn' : '')}
      ${tile(cycTxt, 'median cycle')}
    </div>
    ${stalled ? '<div class="tm-desc empty">Holding work but finished nothing in this window.</div>' : ''}
    ${f.slowest && f.slowest.length ? `<div class="ag-acts">${f.slowest.slice(0, 3).map((t) =>
      `<div class="ag-act"><span class="t">${t.hours < 1 ? Math.round(t.hours * 60) + 'm' : t.hours < 48 ? t.hours + 'h' : (t.hours / 24).toFixed(1) + 'd'}</span><span class="s">${esc(t.title)}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function renderAgentModal(a, mems, acts, spend, flow) {
  const pills = [
    `<span class="tm-pill status-${esc(a.status)}"><span class="pd"></span>${esc(a.status)}</span>`,
    `<span class="tm-pill">${esc(a.role)}</span>`,
    (spend && spend.runs) ? `<span class="tm-pill">$${(spend.cost_usd || 0).toFixed(4)} · ${spend.runs} run${spend.runs === 1 ? '' : 's'} · ${fmtTok((spend.input_tokens || 0) + (spend.output_tokens || 0))} tok</span>` : '',
  ].filter(Boolean).join('');
  const memRows = mems.map((m) => `<div class="ag-row" data-mem="${esc(m.id)}" title="Open in the Memory tab"><span class="ag-ns">${esc(m.namespace)}</span><span class="ag-t">${esc(m.title)}</span><span class="ag-imp">${'★'.repeat(m.importance || 0)}</span></div>`).join('');
  const actRows = acts.map((x) => `<div class="ag-act"><span class="t">${ago(x.ts)}</span><span class="s">${esc(x.summary)}</span></div>`).join('');
  $('#tm-body').innerHTML = `
    <h3 class="tm-h" id="tm-title">${a.avatar || '🤖'} ${esc(a.name)}</h3>
    <div class="tm-pills">${pills}</div>
    ${a.current_task ? `<div class="tm-sec"><h4>Current task</h4><div class="tm-desc">▶ ${esc(a.current_task)}</div></div>` : ''}
    ${agentFlowHtml(flow)}
    <div class="tm-sec"><h4>Memories authored${mems.length ? ' · ' + mems.length : ''}</h4>${memRows ? `<div class="ag-list">${memRows}</div>` : '<div class="tm-desc empty">None authored yet.</div>'}</div>
    <div class="tm-sec"><h4>Recent activity</h4>${actRows ? `<div class="ag-acts">${actRows}</div>` : '<div class="tm-desc empty">No activity yet.</div>'}</div>
    <div class="tm-foot">
      <span>id ${esc(a.id)}</span>
      <span>last seen ${a.last_seen ? ago(a.last_seen) + ' ago' : '—'}</span>
    </div>`;
}
// agent card → open its profile; a memory row inside the modal → jump to it in the Memory tab
$('#agents').addEventListener('click', (e) => { const c = e.target.closest('[data-agent]'); if (c) openAgent(c.dataset.agent); });
$('#agents').addEventListener('keydown', (e) => { const c = e.target.closest('[data-agent]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openAgent(c.dataset.agent); } });
$('#tm-body').addEventListener('click', (e) => {
  const d = e.target.closest('.tm-dep[data-task]'); if (d) { openTask(d.dataset.task); return; }
  const m = e.target.closest('.ag-row[data-mem]'); if (m) { closeTask(); activateTab('memory'); focusMemory(m.dataset.mem); }
});

const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
const usd = (n) => '$' + (n || 0).toFixed(4);

// Cumulative-spend sparkline: accumulate the chronological per-run costs into a
// rising area chart, with an emphasized endpoint marking the current total.
function spendSparkline(series, total) {
  const pts = (series || []).filter((s) => s && s.cost_usd != null);
  if (pts.length < 2 || total <= 0) return '';        // need a couple of runs to show a trend
  let cum = 0; const cums = pts.map((s) => (cum += s.cost_usd));
  const n = cums.length, max = cums[n - 1] || 1;
  const xy = cums.map((c, i) => [(i / (n - 1)) * 100, (1 - c / max) * 100]);
  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `M0,100 L ${xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ')} L100,100 Z`;
  return `<div class="ledger-spark">
    <div class="ls-head"><span>cumulative spend</span><span class="ls-now">${usd(max)} over ${n} runs</span></div>
    <div class="ls-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path class="ls-area" d="${area}" />
        <polyline class="ls-line" points="${line}" />
      </svg>
      <span class="ls-dot" style="top:${xy[n - 1][1].toFixed(2)}%"></span>
    </div>
  </div>`;
}

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
    ${spendSparkline(l.spend_series, l.total_cost_usd || 0)}
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
  renderCompose();
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
      ${receipts(m)}
    </div>`;
  }).join('') : '<div class="empty">No messages yet.</div>';
}

// Who has actually read it. "📢 everyone" said a message was BROADCAST; it never
// said whether anyone had SEEN it — and a message nobody has read is not a message
// that was delivered, it is a message that is still waiting.
function receipts(m) {
  if (!m.audience_count) return '';                       // nobody to read it (a broadcast with no other agents)
  const seen = (m.read_by || []).map((id) => AGENTS[id]).filter(Boolean);
  const waiting = (m.unread_by || []).map((id) => AGENTS[id]).filter(Boolean);
  const all = m.read_count === m.audience_count;
  const none = m.read_count === 0;

  const faces = (list, cls) => list.map((a) =>
    `<span class="rcp ${cls}" title="${esc(a.name)}">${a.avatar}</span>`).join('');

  return `<div class="mr ${all ? 'all' : none ? 'none' : 'some'}">
    <span class="mr-n">${all ? '✓✓ read by everyone'
      : none ? `unread by ${m.audience_count === 1 ? 'them' : `all ${m.audience_count}`}`
      : `✓ read by ${m.read_count} of ${m.audience_count}`}</span>
    ${faces(seen, 'seen')}${faces(waiting, 'waiting')}
  </div>`;
}

// Compose bar: pick a sender + recipient (or 📢 everyone) and post to /api/messages.
// Populated from AGENTS (loaded at boot); selections are preserved across re-renders.
function renderCompose() {
  const agents = Object.values(AGENTS);
  const from = $('#msg-from'), to = $('#msg-to');
  if (!agents.length) {
    from.innerHTML = to.innerHTML = '<option value="">no agents yet</option>';
    from.disabled = to.disabled = true; $('#msg-send').disabled = true; return;
  }
  from.disabled = to.disabled = false;
  const opt = (a) => `<option value="${esc(a.id)}">${a.avatar || '🤖'} ${esc(a.name)}</option>`;
  const prevFrom = from.value || agents[0].id;
  from.innerHTML = agents.map(opt).join('');
  from.value = AGENTS[prevFrom] ? prevFrom : agents[0].id;
  const prevTo = to.value;
  to.innerHTML = '<option value="">📢 everyone</option>' +
    agents.filter((a) => a.id !== from.value).map(opt).join('');   // can't message yourself
  to.value = [...to.options].some((o) => o.value === prevTo) ? prevTo : '';
  syncSendState();
}

function syncSendState() {
  $('#msg-send').disabled = !$('#msg-body').value.trim() || $('#msg-from').disabled;
}

async function sendMessage() {
  const body = $('#msg-body').value.trim();
  if (!body || $('#msg-from').disabled) return;
  const btn = $('#msg-send'); btn.disabled = true;
  await api('/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from_agent: $('#msg-from').value || null, to_agent: $('#msg-to').value || null, body }),
  });
  $('#msg-body').value = '';                 // the SSE 'refresh' also repaints, but do it now for snappiness
  await renderMessages(); renderStats();
  $('#msg-body').focus();
}

$('#compose').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
$('#msg-from').addEventListener('change', renderCompose);   // keep "to" from offering the sender
$('#msg-body').addEventListener('input', syncSendState);
$('#msg-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
});

async function renderAgents() {
  const list = await api('/agents');
  AGENTS = Object.fromEntries(list.map((a) => [a.id, a]));
  $('#agents').innerHTML = list.length ? list.map((a) => `
    <div class="agent" data-agent="${esc(a.id)}" role="button" tabindex="0" title="View ${esc(a.name)}'s profile">
      <div class="ah">
        <span class="av">${a.avatar || '🤖'}</span>
        <div><div class="nm">${esc(a.name)}</div><div class="rl">${esc(a.role)}</div></div>
        <span class="st ${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <div class="ct">${a.current_task ? '▶ ' + esc(a.current_task) : 'last seen ' + (a.last_seen ? ago(a.last_seen) + ' ago' : '—')}</div>
    </div>`).join('') : '<div class="empty">No agents yet. They register themselves via the MCP tools.</div>';
}

let memoryNamespace = null;   // null = all namespaces
let MEM_CACHE = [];           // last fetched memory set (client-side namespace filtering)

function memCard(m) {
  return `<div class="mem" data-id="${esc(m.id)}">
      <div class="mt"><span>${esc(m.title)}</span><span class="imp">${'★'.repeat(m.importance)}</span></div>
      <div class="body">${esc(m.content)}</div>
      <div class="tags">${(m.tags || []).map((t) => `<span class="label">${esc(t)}</span>`).join('')}
        <span class="chip">${esc(m.namespace)}</span></div>
    </div>`;
}
// Namespace filter chips (from the fetched set, so counts reflect the current search).
function renderMemoryFilter() {
  const counts = {};
  for (const m of MEM_CACHE) counts[m.namespace] = (counts[m.namespace] || 0) + 1;
  if (memoryNamespace && !counts[memoryNamespace]) memoryNamespace = null;   // active ns fell out of the set
  const names = Object.keys(counts).sort();
  const el = $('#mem-filter');
  if (names.length < 2) { el.hidden = true; el.innerHTML = ''; return; }     // nothing to filter by
  el.hidden = false;
  el.innerHTML = `<span class="nsl">namespace</span>` +
    `<button class="nsf${!memoryNamespace ? ' on' : ''}" data-ns="">all <span class="nsn">${MEM_CACHE.length}</span></button>` +
    names.map((n) => `<button class="nsf${memoryNamespace === n ? ' on' : ''}" data-ns="${esc(n)}">${esc(n)} <span class="nsn">${counts[n]}</span></button>`).join('');
}
function applyMemoryFilter() {
  const shown = memoryNamespace ? MEM_CACHE.filter((m) => m.namespace === memoryNamespace) : MEM_CACHE;
  $('#memory').innerHTML = shown.length ? shown.map(memCard).join('')
    : `<div class="empty">${memoryNamespace ? 'No memories in “' + esc(memoryNamespace) + '”.' : 'No memories match.'}</div>`;
}
async function renderMemory(q = '') {
  MEM_CACHE = await api('/memory?limit=60' + (q ? '&q=' + encodeURIComponent(q) : ''));
  renderMemoryFilter();
  applyMemoryFilter();
}
$('#mem-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ns]'); if (!b) return;
  memoryNamespace = b.dataset.ns || null;
  renderMemoryFilter(); applyMemoryFilter();
});

// Deep-link: open the Memory tab and highlight a specific memory (used by recall's
// cross-tool "open in agent-hq" links). Clears any search filter so it's findable.
async function focusMemory(id) {
  const search = $('#mem-search'); if (search) search.value = '';
  memoryNamespace = null;                 // clear any namespace filter so the target is visible
  await renderMemory('');
  const card = document.querySelector(`.mem[data-id="${CSS.escape(id)}"]`);
  if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('focus'); setTimeout(() => card.classList.remove('focus'), 2600); }
}

function feedItem(a, flash) {
  const who = AGENTS[a.actor]?.name || '';
  return `<li class="${flash ? 'flash' : ''}"><span class="t">${ago(a.ts)}</span><span class="s">${esc(a.summary)}${who ? ` <i style="color:var(--muted)">· ${esc(who)}</i>` : ''}</span></li>`;
}

// Per-agent timeline filter for the Activity tab.
function renderActivityFilter() {
  const agents = Object.values(AGENTS).sort((a, b) => a.name.localeCompare(b.name));
  $('#act-filter').innerHTML =
    `<button class="actf${!activityActor ? ' on' : ''}" data-actor="">📡 all</button>` +
    agents.map((a) => `<button class="actf${activityActor === a.id ? ' on' : ''}" data-actor="${esc(a.id)}">${a.avatar || '🤖'} ${esc(a.name)}</button>`).join('');
  renderActivityTypeFilter();
}
// Activity categories — the event types are `category.action`, so a category is
// the part before the dot (task.created → task).
const ACT_CATS = [['task', '📋 tasks'], ['memory', '🧠 memory'], ['message', '✉️ messages'], ['run', '🧾 runs'], ['agent', '🤖 agents']];
const catOf = (t) => String(t || '').split('.')[0];
function renderActivityTypeFilter() {
  $('#act-type-filter').innerHTML =
    `<button class="actf${!activityType ? ' on' : ''} type-chip" data-type="">🗂️ all</button>` +
    ACT_CATS.map(([k, label]) => `<button class="actf${activityType === k ? ' on' : ''} type-chip" data-type="${k}">${label}</button>`).join('');
}
document.addEventListener('click', (e) => {
  const at = e.target.closest('#act-type-filter [data-type]');
  if (at) { activityType = at.dataset.type || null; renderActivityTypeFilter(); renderActivity(); return; }
  const b = e.target.closest('#act-filter [data-actor]'); if (!b) return;
  activityActor = b.dataset.actor || null;
  renderActivityFilter(); renderActivity();
});

async function renderActivity() {
  const full = await api('/activity?limit=80' +
    (activityActor ? '&actor=' + encodeURIComponent(activityActor) : '') +
    (activityType ? '&type=' + encodeURIComponent(activityType) : ''));
  const who = activityActor ? AGENTS[activityActor] : null;
  const head = (activityType || who)
    ? `<li class="act-head">${full.length} ${activityType ? esc(activityType) + ' ' : ''}event${full.length === 1 ? '' : 's'}${who ? ` by ${who.avatar || '🤖'} ${esc(who.name)}` : ''}</li>`
    : '';
  $('#activity-full').innerHTML = head +
    (full.length ? full.map((a) => feedItem(a)).join('') : '<li class="act-empty">Nothing here yet.</li>');
  // the sidebar ticker always shows the whole company's live feed (unfiltered)
  const mini = (activityActor || activityType) ? await api('/activity?limit=30') : full;
  $('#activity-mini').innerHTML = mini.slice(0, 30).map((a) => feedItem(a)).join('');
}

// ── Live updates via SSE ─────────────────────────────────────────────────
let debounce;
function refreshAll() {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    await renderAgents();           // load agents first (used by board/feed)
    renderStats(); renderBoard(); renderActivityFilter(); renderActivity();
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
    if ((!activityActor || a.actor === activityActor) && (!activityType || catOf(a.type) === activityType))
      $('#activity-full').insertAdjacentHTML('afterbegin', feedItem(a, true));
  });
  es.onerror = () => { $('#conn').classList.remove('live'); $('#conn-label').textContent = 'reconnecting…'; };
}

$('#mem-search').addEventListener('input', (e) => renderMemory(e.target.value));

// Route the URL hash: "#memory=<id>" deep-links a specific memory; "#<view>"
// opens a tab. Lets other tools (recall) link straight into the dashboard.
async function routeHash() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('memory=')) { activateTab('memory'); await focusMemory(decodeURIComponent(h.slice(7))); }
  else if (h && document.querySelector(`.tab[data-view="${h}"]`)) activateTab(h);
}
addEventListener('hashchange', routeHash);

// boot
(async () => {
  await renderAgents(); renderStats(); renderBoard(); renderActivityFilter(); renderActivity(); renderMemory(); connect();
  await routeHash();
})();
setInterval(renderStats, 15000);  // keep "last seen" fresh

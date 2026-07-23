// Agent HQ — Knowledge Graph tab.
// A premium, zero-dependency canvas force-graph of the company's collective brain:
// agents *author* memories; memories *belong to* namespaces and *carry* tags.
// Tags & namespaces are the cross-cutting hubs. Live-refreshes over SSE while
// preserving node positions. Vanilla JS + Canvas 2D — no libraries.
(() => {
  const cvs = document.getElementById('graph-canvas');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  const wrap = document.getElementById('graph-wrap');
  const tip = document.getElementById('graph-tooltip');
  const panel = document.getElementById('graph-panel');
  const panelBody = document.getElementById('gp-body');
  const legendEl = document.getElementById('graph-legend');
  const emptyEl = document.getElementById('graph-empty');
  const searchEl = document.getElementById('graph-search');
  const searchDrop = document.getElementById('graph-search-drop');
  const filterPill = document.getElementById('graph-filterpill');

  // ── Theme colors (pulled live from the dashboard's CSS variables) ──────────
  // Re-read on theme toggle via HQGraph.recolor(): the neutrals (txt/muted/line/
  // bg) must follow light ↔ dark, or near-white node labels would sit invisibly
  // on a light graph. The four type accents read the same in both themes.
  const readCOL = () => {
    const css = getComputedStyle(document.documentElement);
    const c = (v, fb) => (css.getPropertyValue(v).trim() || fb);
    return {
      memory: c('--accent', '#6ea8fe'),
      agent: c('--accent-2', '#a78bfa'),
      namespace: c('--green', '#4ade80'),
      tag: c('--amber', '#fbbf24'),
      line: c('--line', '#232b3d'),
      txt: c('--txt', '#e6ebf5'),
      muted: c('--muted', '#8a96ad'),
      bg: c('--bg', '#0b0e14'),
    };
  };
  let COL = readCOL();
  const TYPES = [
    { key: 'memory', label: 'memories', icon: '🧠' },
    { key: 'agent', label: 'agents', icon: '🤖' },
    { key: 'namespace', label: 'namespaces', icon: '📁' },
    { key: 'tag', label: 'tags', icon: '#' },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let nodes = [], links = [];
  const byId = new Map();
  const adj = new Map();               // id -> Set(neighborId)
  const view = { k: 1, x: 0, y: 0 };   // pan/zoom transform
  let alpha = 0;                       // simulation temperature
  let running = false, rafId = 0, active = false, everLaidOut = false;
  let hover = null, selected = null, dragging = null, dragMoved = false;
  let panning = null;
  let hideTypes = new Set();           // legend filters (by node type)
  let dash = 0;                        // animated energy-flow offset
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A node is hidden if its type is filtered off in the legend, or it's outside
  // the currently isolated hub neighborhood (n._hidden).
  const isHiddenNode = (nd) => hideTypes.has(nd.type) || nd._hidden;

  const radiusOf = (n) => {
    if (n.type === 'memory') return 6 + (n.importance || 3) * 1.7;
    if (n.type === 'agent') return 15;
    if (n.type === 'namespace') return 11 + Math.min(8, (n.count || 0));
    if (n.type === 'tag') return 5 + Math.min(11, (n.count || 0) * 1.6);
    return 8;
  };

  // ── Data load / merge (preserve positions across live refresh) ─────────────
  function applyGraph(g, keepPositions) {
    const prev = new Map(nodes.map((n) => [n.id, n]));
    const W = cvs.clientWidth || 800, H = cvs.clientHeight || 600;
    nodes = g.nodes.map((raw) => {
      const old = keepPositions && prev.get(raw.id);
      const n = Object.assign({}, raw);
      n.r = radiusOf(n);
      if (old) { n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy; n.pinned = old.pinned; }
      else {
        // seed near center with a little spread; hubs start central
        const spread = n.type === 'tag' || n.type === 'namespace' ? 60 : 220;
        n.x = W / 2 + (hash(n.id) % spread) - spread / 2;
        n.y = H / 2 + (hash(n.id + 'y') % spread) - spread / 2;
        n.vx = 0; n.vy = 0; n.pinned = false;
      }
      return n;
    });
    byId.clear();
    for (const n of nodes) byId.set(n.id, n);
    links = g.links = g.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
    adj.clear();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of links) { adj.get(e.source).add(e.target); adj.get(e.target).add(e.source); }
    // resolve endpoints to node refs for fast physics
    for (const e of links) { e.s = byId.get(e.source); e.t = byId.get(e.target); }
    if (selected && !byId.has(selected)) { selected = null; hidePanel(); }
    emptyEl.hidden = nodes.length > 0;
    renderLegend();
    reheat(keepPositions ? 0.5 : 1);
  }

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h); }

  async function load(keepPositions) {
    try {
      const g = await fetch('/api/graph').then((r) => r.json());
      applyGraph(g, keepPositions);
    } catch { /* offline — leave existing graph */ }
  }

  // ── Force simulation ───────────────────────────────────────────────────────
  const mass = (n) => (n.type === 'tag' || n.type === 'namespace' ? 2.4 : n.type === 'agent' ? 1.8 : 1);
  const idealLen = (e) => (e.type === 'authored' ? 90 : e.type === 'namespace' ? 70 : 62);

  function tick() {
    const W = cvs.clientWidth, H = cvs.clientHeight;
    const cx = W / 2, cy = H / 2;
    const n = nodes.length;
    // repulsion (O(n^2) — graph is small)
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (hash(a.id) % 10) - 5 || 1; dy = (hash(b.id) % 10) - 5 || 1; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const force = (2600 * mass(a) * mass(b)) / d2;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    // link springs
    for (const e of links) {
      const a = e.s, b = e.t;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = (d - idealLen(e)) / d * 0.045;
      const fx = dx * diff, fy = dy * diff;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    // gravity to center + integrate
    for (const a of nodes) {
      a.vx += (cx - a.x) * 0.0016;
      a.vy += (cy - a.y) * 0.0016;
      if (a === dragging || a.pinned) { a.vx = 0; a.vy = 0; continue; }
      a.vx *= 0.86; a.vy *= 0.86;
      a.x += a.vx * alpha; a.y += a.vy * alpha;
    }
    alpha *= 0.992;
    if (alpha < 0.02) { alpha = 0; }
  }

  function reheat(a = 0.9) { alpha = Math.max(alpha, a); everLaidOut = true; start(); }

  // Run the simulation headlessly for a beat so the first paint is a settled,
  // spread-out layout (not the tight initial seed cluster) before we fit to view.
  function presettle(iters = 320) {
    if (!nodes.length) return;
    for (let i = 0; i < iters; i++) { alpha = 0.9 * (1 - i / iters) + 0.04; tick(); }
    alpha = 0;  // fully settle so fit() reads final positions and nothing drifts after
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────
  const toScreen = (x, y) => [x * view.k + view.x, y * view.k + view.y];
  const toWorld = (px, py) => [(px - view.x) / view.k, (py - view.y) / view.k];

  // ── Render ─────────────────────────────────────────────────────────────────
  function draw() {
    const W = cvs.clientWidth, H = cvs.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cvs.width !== W * dpr || cvs.height !== H * dpr) { cvs.width = W * dpr; cvs.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const focus = hover || (selected && byId.get(selected));
    const near = focus ? adj.get(focus.id) : null;
    const dim = (id) => focus && id !== focus.id && !(near && near.has(id));
    const isHidden = isHiddenNode;

    // links
    for (const e of links) {
      if (isHidden(e.s) || isHidden(e.t)) continue;
      const [ax, ay] = toScreen(e.s.x, e.s.y);
      const [bx, by] = toScreen(e.t.x, e.t.y);
      const lit = focus && (e.s.id === focus.id || e.t.id === focus.id);
      const faded = focus && !lit;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = lit ? COL[e.t.type] : COL.line;
      ctx.globalAlpha = faded ? 0.06 : lit ? 0.75 : 0.28;
      ctx.lineWidth = lit ? 1.8 : 1;
      ctx.stroke();
      // animated energy flow along lit links
      if (lit && !reduceMotion) {
        ctx.save();
        ctx.setLineDash([2, 10]); ctx.lineDashOffset = -dash;
        ctx.strokeStyle = COL[e.t.type]; ctx.globalAlpha = 0.9; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const nd of nodes) {
      if (isHidden(nd)) continue;
      const [sx, sy] = toScreen(nd.x, nd.y);
      const r = nd.r * Math.max(0.7, Math.min(1.4, view.k));
      const faded = dim(nd.id);
      const col = COL[nd.type];
      ctx.globalAlpha = faded ? 0.22 : 1;

      // glow
      if (!faded && (nd === focus || nd.type === 'tag' || nd.type === 'namespace')) {
        ctx.shadowColor = col; ctx.shadowBlur = nd === focus ? 22 : 10;
      } else { ctx.shadowBlur = 0; }

      if (nd.type === 'agent') {
        // ring + avatar
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7);
        ctx.fillStyle = 'rgba(167,139,250,.14)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.font = `${r * 1.15}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(nd.avatar || '🤖', sx, sy + 1);
      } else if (nd.type === 'namespace') {
        // rounded square
        roundRect(sx - r, sy - r, r * 2, r * 2, 5);
        ctx.fillStyle = col; ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7);
        ctx.fillStyle = col; ctx.fill();
      }
      ctx.shadowBlur = 0;

      // selection ring
      if (selected === nd.id) {
        ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, 7);
        ctx.strokeStyle = COL.txt; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.stroke();
      }
      // pin marker
      if (nd.pinned) {
        ctx.beginPath(); ctx.arc(sx, sy, r + 2.5, 0, 7);
        ctx.strokeStyle = COL.muted; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.stroke();
      }

      // labels: hubs & focus neighborhood always; others when zoomed in
      const showLabel = !faded && (nd === focus || (near && near.has(nd.id)) ||
        nd.type === 'tag' || nd.type === 'namespace' || nd.type === 'agent' || view.k > 1.25);
      if (showLabel) {
        ctx.globalAlpha = faded ? 0.3 : 0.92;
        ctx.font = `${nd.type === 'tag' || nd.type === 'namespace' ? 12 : 11}px ui-sans-serif, system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const label = (nd.type === 'tag' ? '#' : '') + trunc(nd.label, 26);
        ctx.fillStyle = COL.txt;
        ctx.fillText(label, sx, sy + r + 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

  // ── Animation loop ─────────────────────────────────────────────────────────
  function frame() {
    if (!active) { running = false; return; }
    if (alpha > 0) tick();
    const focused = hover || selected;
    if (focused && !reduceMotion) dash = (dash + 0.6) % 12;
    draw();
    // keep the loop alive only while there's real motion: layout is cooling, or a
    // node is focused (its links animate). Otherwise idle to spare the CPU.
    if (alpha > 0 || (focused && !reduceMotion) || dragging || panning) rafId = requestAnimationFrame(frame);
    else running = false;
  }
  function start() { if (!running && active) { running = true; rafId = requestAnimationFrame(frame); } }

  // ── Hit testing (screen space) ─────────────────────────────────────────────
  function nodeAt(px, py) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nd = nodes[i];
      if (isHiddenNode(nd)) continue;
      const [sx, sy] = toScreen(nd.x, nd.y);
      const r = nd.r * Math.max(0.7, Math.min(1.4, view.k)) + 4;
      if ((px - sx) ** 2 + (py - sy) ** 2 <= r * r) return nd;
    }
    return null;
  }

  // ── Pointer interaction ────────────────────────────────────────────────────
  function relPos(e) { const b = cvs.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }

  cvs.addEventListener('pointerdown', (e) => {
    const [px, py] = relPos(e);
    const nd = nodeAt(px, py);
    cvs.setPointerCapture(e.pointerId);
    if (nd) { dragging = nd; nd.pinned = true; dragMoved = false; }
    else { panning = { px, py, x: view.x, y: view.y }; }
  });

  cvs.addEventListener('pointermove', (e) => {
    const [px, py] = relPos(e);
    if (dragging) {
      const [wx, wy] = toWorld(px, py);
      dragging.x = wx; dragging.y = wy; dragging.vx = 0; dragging.vy = 0;
      dragMoved = true; reheat(0.3); positionTip(px, py); return;
    }
    if (panning) {
      view.x = panning.x + (px - panning.px);
      view.y = panning.y + (py - panning.py);
      start(); return;
    }
    const nd = nodeAt(px, py);
    if (nd !== hover) { hover = nd; cvs.style.cursor = nd ? 'pointer' : 'grab'; start(); }
    if (nd) showTip(nd, px, py); else tip.hidden = true;
  });

  function endPointer(e) {
    if (dragging) {
      if (!dragMoved) { dragging.pinned = false; selectNode(dragging); }
      dragging = null;
    }
    panning = null;
    try { cvs.releasePointerCapture(e.pointerId); } catch {}
  }
  cvs.addEventListener('pointerup', endPointer);
  cvs.addEventListener('pointercancel', endPointer);
  cvs.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; start(); });

  // double-click empty → release all pins; on a node → release its pin
  cvs.addEventListener('dblclick', (e) => {
    const [px, py] = relPos(e);
    const nd = nodeAt(px, py);
    if (nd) nd.pinned = false;
    else nodes.forEach((n) => (n.pinned = false));
    reheat(0.6);
  });

  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = relPos(e);
    const [wx, wy] = toWorld(px, py);
    const k = Math.max(0.35, Math.min(3, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    view.k = k; view.x = px - wx * k; view.y = py - wy * k;
    start();
  }, { passive: false });

  // ── Tooltip ────────────────────────────────────────────────────────────────
  function showTip(nd, px, py) {
    const meta = nd.type === 'memory'
      ? `<span class="gt-type" style="color:${COL.memory}">🧠 memory · ${'★'.repeat(nd.importance || 1)}</span><div class="gt-sub">${escapeHtml(nd.namespace)}</div>`
      : nd.type === 'agent'
        ? `<span class="gt-type" style="color:${COL.agent}">${nd.avatar || '🤖'} agent · ${escapeHtml(nd.role || '')}</span><div class="gt-sub">${nd.count || 0} memories authored</div>`
        : nd.type === 'namespace'
          ? `<span class="gt-type" style="color:${COL.namespace}">📁 namespace</span><div class="gt-sub">${nd.count || 0} memories</div>`
          : `<span class="gt-type" style="color:${COL.tag}">#tag</span><div class="gt-sub">${nd.count || 0} memories</div>`;
    tip.innerHTML = `<div class="gt-title">${escapeHtml(nd.label)}</div>${meta}`;
    tip.hidden = false;
    positionTip(px, py);
  }
  function positionTip(px, py) {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    tip.style.left = Math.min(px + 14, w - tip.offsetWidth - 12) + 'px';
    tip.style.top = Math.min(py + 14, h - tip.offsetHeight - 12) + 'px';
  }

  // ── Detail panel ───────────────────────────────────────────────────────────
  function selectNode(nd) {
    selected = nd.id; showPanel(nd); start();
  }
  function neighborsOf(nd, type) {
    return [...adj.get(nd.id)].map((id) => byId.get(id)).filter((x) => x && (!type || x.type === type));
  }
  function chip(nd) {
    return `<button class="gp-chip gp-${nd.type}" data-goto="${escapeAttr(nd.id)}">${nd.type === 'tag' ? '#' : nd.type === 'agent' ? (nd.avatar || '🤖') + ' ' : ''}${escapeHtml(nd.label)}</button>`;
  }
  function showPanel(nd) {
    let html = '';
    if (nd.type === 'memory') {
      const author = neighborsOf(nd, 'agent')[0];
      const tags = neighborsOf(nd, 'tag');
      html = `
        <div class="gp-kind" style="color:${COL.memory}">🧠 MEMORY</div>
        <h2>${escapeHtml(nd.label)}</h2>
        <div class="gp-row"><span class="imp">${'★'.repeat(nd.importance || 1)}${'☆'.repeat(5 - (nd.importance || 1))}</span>
          <span class="gp-ns">📁 ${escapeHtml(nd.namespace)}</span></div>
        <p class="gp-content">${escapeHtml(nd.snippet || '')}</p>
        ${author ? `<div class="gp-sect">author</div><div class="gp-chips">${chip(author)}</div>` : '<div class="gp-sect">author</div><div class="gp-muted">shared / org-wide</div>'}
        ${tags.length ? `<div class="gp-sect">tags</div><div class="gp-chips">${tags.map(chip).join('')}</div>` : ''}`;
    } else if (nd.type === 'agent') {
      const mems = neighborsOf(nd, 'memory');
      html = `
        <div class="gp-kind" style="color:${COL.agent}">${nd.avatar || '🤖'} AGENT</div>
        <h2>${escapeHtml(nd.label)}</h2>
        <div class="gp-row"><span class="gp-ns">${escapeHtml(nd.role || '')}</span><span class="gp-badge st-${escapeAttr(nd.status)}">${escapeHtml(nd.status || '')}</span></div>
        <div class="gp-sect">authored ${mems.length} ${mems.length === 1 ? 'memory' : 'memories'}</div>
        <div class="gp-chips col">${mems.map(chip).join('') || '<span class="gp-muted">none yet</span>'}</div>`;
    } else { // namespace or tag
      const mems = neighborsOf(nd, 'memory').sort((a, b) => (b.importance || 0) - (a.importance || 0));
      const kind = nd.type === 'tag' ? 'TAG' : 'NAMESPACE';
      const icon = nd.type === 'tag' ? '#' : '📁';
      html = `
        <div class="gp-kind" style="color:${COL[nd.type]}">${icon} ${kind}</div>
        <h2>${nd.type === 'tag' ? '#' : ''}${escapeHtml(nd.label)}</h2>
        <div class="gp-row"><span class="gp-ns">${mems.length} ${mems.length === 1 ? 'memory' : 'memories'}</span>
          <button class="gp-filterbtn" data-filter="${escapeAttr(nd.id)}">✷ isolate</button></div>
        <div class="gp-sect">memories</div>
        <div class="gp-chips col">${mems.map(chip).join('') || '<span class="gp-muted">none</span>'}</div>`;
    }
    panelBody.innerHTML = html;
    panel.hidden = false;
  }
  function hidePanel() { panel.hidden = true; selected = null; clearFilter(); start(); }

  panelBody.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { const nd = byId.get(goto.dataset.goto); if (nd) { focusNode(nd); selectNode(nd); } return; }
    const filt = e.target.closest('[data-filter]');
    if (filt) { const nd = byId.get(filt.dataset.filter); if (nd) filterToNeighborhood(nd); }
  });
  document.getElementById('gp-close').addEventListener('click', hidePanel);

  // ── Focus / center a node ──────────────────────────────────────────────────
  function focusNode(nd) {
    const W = cvs.clientWidth, H = cvs.clientHeight;
    view.k = Math.max(view.k, 1.1);
    view.x = W / 2 - nd.x * view.k;
    view.y = H / 2 - nd.y * view.k;
    nd.pinned = false; reheat(0.2); start();
  }

  // ── Legend + type filters ──────────────────────────────────────────────────
  function renderLegend() {
    const counts = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
    legendEl.innerHTML = TYPES.map((t) => `
      <button class="gl-item ${hideTypes.has(t.key) ? 'off' : ''}" data-type="${t.key}">
        <span class="gl-dot" style="background:${COL[t.key]}"></span>
        <span class="gl-label">${t.label}</span>
        <span class="gl-count">${counts[t.key] || 0}</span>
      </button>`).join('');
  }
  legendEl.addEventListener('click', (e) => {
    const it = e.target.closest('[data-type]'); if (!it) return;
    const t = it.dataset.type;
    if (hideTypes.has(t)) hideTypes.delete(t); else hideTypes.add(t);
    renderLegend(); reheat(0.15);
  });

  // isolate the neighborhood of a hub (tag/namespace): hide everything not connected
  function filterToNeighborhood(nd) {
    const keep = new Set([nd.id, ...adj.get(nd.id)]);
    // also keep the tags/agents of the kept memories, for surrounding context
    for (const id of [...keep]) if (byId.get(id)?.type === 'memory') for (const nb of adj.get(id)) keep.add(nb);
    for (const n of nodes) n._hidden = !keep.has(n.id);
    filterPill.hidden = false;
    filterPill.innerHTML = `${nd.type === 'tag' ? '#' : '📁 '}${escapeHtml(nd.label)} · ${adj.get(nd.id).size} memories <span class="fp-x">✕</span>`;
    reheat(0.2);
  }
  function clearFilter() {
    filterPill.hidden = true;
    for (const n of nodes) n._hidden = false;
  }
  filterPill.addEventListener('click', () => { clearFilter(); reheat(0.15); });

  // ── Search ─────────────────────────────────────────────────────────────────
  let searchIdx = -1, searchHits = [];
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    if (!q) { closeSearchDrop(); searchHits = []; return; }
    searchHits = nodes.filter((n) => n.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.length - b.label.length).slice(0, 8);
    searchIdx = -1;
    // role=option, driven by the combobox above: focus stays in the input, ↑/↓ move
    // aria-activedescendant, Enter goes to the node. That is WHY these are not tabbable —
    // an option you can Tab to is the bug. (cortex's search is the same shape; iris's
    // unreachable-control asked both of them for tabindex="0" + role="button", the opposite
    // of the pattern, and was fixed to exempt a declared composite.)
    searchDrop.innerHTML = searchHits.map((n, i) => `
      <div class="gsd-item" id="gsd-opt-${i}" role="option" aria-selected="false" data-i="${i}">
        <span class="gsd-dot" style="background:${COL[n.type]}"></span>
        <span class="gsd-label">${n.type === 'tag' ? '#' : ''}${escapeHtml(n.label)}</span>
        <span class="gsd-type">${n.type}</span>
      </div>`).join('') || '<div class="gsd-empty" role="presentation">no matches</div>';
    searchDrop.hidden = false;
    searchEl.setAttribute('aria-expanded', 'true');
    searchEl.removeAttribute('aria-activedescendant');
  });
  searchEl.addEventListener('keydown', (e) => {
    if (searchDrop.hidden) return;
    if (e.key === 'ArrowDown') { searchIdx = Math.min(searchHits.length - 1, searchIdx + 1); markSearch(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { searchIdx = Math.max(0, searchIdx - 1); markSearch(); e.preventDefault(); }
    else if (e.key === 'Enter') { const n = searchHits[searchIdx] || searchHits[0]; if (n) gotoSearch(n); }
    else if (e.key === 'Escape') { closeSearchDrop(); searchEl.blur(); }
  });
  // The highlight and the announcement are ONE fact — write them in one place, or a screen
  // reader hears nothing while the arrow keys move a selection in front of everyone else.
  function markSearch() {
    [...searchDrop.children].forEach((el, i) => {
      const on = i === searchIdx;
      el.classList.toggle('sel', on);
      if (el.getAttribute('role') === 'option') el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && el.id) searchEl.setAttribute('aria-activedescendant', el.id);
    });
    if (searchIdx < 0) searchEl.removeAttribute('aria-activedescendant');
  }
  function closeSearchDrop() { searchDrop.hidden = true; searchEl.setAttribute('aria-expanded', 'false'); searchEl.removeAttribute('aria-activedescendant'); }
  function gotoSearch(n) { closeSearchDrop(); searchEl.value = ''; focusNode(n); selectNode(n); }
  searchDrop.addEventListener('click', (e) => {
    const it = e.target.closest('[data-i]'); if (!it) return;
    gotoSearch(searchHits[+it.dataset.i]);
  });

  // ── Fit / recenter ─────────────────────────────────────────────────────────
  function fit() {
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { if (n._hidden) continue; minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    if (!isFinite(minX)) return;
    const W = cvs.clientWidth, H = cvs.clientHeight, pad = 70;
    const gw = maxX - minX || 1, gh = maxY - minY || 1;
    view.k = Math.max(0.35, Math.min(2, Math.min((W - pad) / gw, (H - pad) / gh)));
    view.x = W / 2 - (minX + maxX) / 2 * view.k;
    view.y = H / 2 - (minY + maxY) / 2 * view.k;
    start();
  }
  document.getElementById('gc-recenter').addEventListener('click', fit);
  document.getElementById('gc-reheat').addEventListener('click', () => { nodes.forEach((n) => (n.pinned = false)); reheat(1); });
  document.getElementById('gc-png').addEventListener('click', exportPNG);

  function exportPNG() {
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement('canvas');
    off.width = cvs.width; off.height = cvs.height;
    const o = off.getContext('2d');
    o.fillStyle = COL.bg; o.fillRect(0, 0, off.width, off.height);
    o.drawImage(cvs, 0, 0);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.fillStyle = COL.muted; o.font = '12px ui-sans-serif, system-ui'; o.textAlign = 'right';
    o.fillText('Agent HQ · company knowledge graph', cvs.clientWidth - 14, cvs.clientHeight - 12);
    off.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = url; a.download = 'agent-hq-graph.png'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // ── Escape helpers ─────────────────────────────────────────────────────────
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  // ── Public lifecycle (called by app.js) ────────────────────────────────────
  const resize = () => { if (active) start(); };
  window.addEventListener('resize', resize);

  window.HQGraph = {
    async activate() {
      active = true;
      // canvas had 0 size while the tab was hidden — wait a frame so it has
      // real dimensions, then load, pre-settle the layout, and fit to view.
      await new Promise((r) => requestAnimationFrame(r));
      if (!everLaidOut) { await load(false); presettle(); }
      if (nodes.length && !selected) fit();
      start();
    },
    deactivate() { active = false; running = false; cancelAnimationFrame(rafId); tip.hidden = true; },
    // theme toggled: re-read the CSS-var palette and repaint so the graph's
    // neutrals track light ↔ dark (the legend/panel are DOM and track on their own).
    recolor() { COL = readCOL(); if (active) draw(); },
    // live SSE refresh — keep positions so the graph morphs instead of jumping
    refresh() { if (active) load(true); else everLaidOut = false; },
    // read-only introspection: page-space node centers (used by tests/automation)
    debug() {
      const b = cvs.getBoundingClientRect();
      return nodes.map((n) => { const [sx, sy] = toScreen(n.x, n.y); return { id: n.id, type: n.type, label: n.label, px: b.left + sx, py: b.top + sy }; });
    },
  };
})();

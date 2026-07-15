// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on
// Linux. lens's file walk swallowed .env files, and twenty green tests never saw it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test guarding that line has stopped guarding it, and you find out today rather than the
// morning after it mattered.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that
// silently stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'a task priority outside the enum ("CRITICAL") is WRONG DATA written confidently — the MCP schema guards its own path, but the HTTP API and direct callers write it verbatim, and the priority sort buries it below "low"',
    file: 'src/services.js',
    find: '  if (p != null && !PRIORITIES.includes(p)) {',
    into: '  if (false) {',
  },
  {
    why: 'task labels must be an ARRAY — accept a bare string and JSON.stringify stores it, then a consumer spreads one label "urgent" into six letters u,r,g,e,n,t',
    file: 'src/services.js',
    find: '  if (l != null && !Array.isArray(l)) {',
    into: '  if (false) {',
  },
  {
    why: 'the remaining declared enums (agent status idle/working/offline, run status done/error) are enforced in the CORE — the MCP schema only guards the MCP path, so the HTTP API could store a status the reaper and ledger do not understand',
    file: 'src/services.js',
    find: '  if (val != null && !set.includes(val)) {',
    into: '  if (false) {',
  },
  {
    why: 'the reaper must not sweep the LIVING — a plus here offlines an agent that just heartbeated',
    file: 'src/services.js',
    find: '    const cutoff = new Date(Date.now() - threshold_ms).toISOString();',
    into: '    const cutoff = new Date(Date.now() + threshold_ms).toISOString();',
  },
  {
    why: 'the WIP limit is the one rule a kanban enforces — a full column refuses the next task',
    file: 'src/services.js',
    find: '  if (n >= col.wip_limit) {',
    into: '  if (n >= col.wip_limit + 99) {',
  },
  {
    why: '"In Progres" is a MISTAKE, not a query with no results — an agent told nothing is in progress starts work someone else is already doing',
    file: 'src/services.js',
    find: '      if (!known.some((n) => n.toLowerCase() === String(status).toLowerCase())) {',
    into: '      if (false) {',
  },
  {
    why: 'READING an inbox must not CONSUME it — mark_read defaults to false on purpose',
    file: 'src/services.js',
    find: '  inbox({ agent, unread_only = false, limit = 50, mark_read = false, max_tokens = INBOX_MAX_TOKENS }) {',
    into: '  inbox({ agent, unread_only = false, limit = 50, mark_read = true, max_tokens = INBOX_MAX_TOKENS }) {',
  },
  {
    why: '...and the same, by the other route: `&&` here becomes "mark everything read, always"',
    file: 'src/services.js',
    find: '    if (mark_read && rows.length) {',
    into: '    if (mark_read || rows.length) {',
  },
  {
    why: 'memory_search must FILTER — without the q clause it hands back the whole team memory and calls it a search',
    file: 'src/services.js',
    find: "    if (q) { const p = `%${likeEsc(q)}%`; sql += ` AND (title LIKE ? ESCAPE '\\\\' OR content LIKE ? ESCAPE '\\\\')`; args.push(p, p); }",
    into: "    if (false) { const p = `%${likeEsc(q)}%`; sql += ` AND (title LIKE ? ESCAPE '\\\\' OR content LIKE ? ESCAPE '\\\\')`; args.push(p, p); }",
  },
  {
    why: 'the median cycle time must ADD the middle pair, not subtract it — a wrong number dressed as a measurement',
    file: 'src/services.js',
    find: '        : Math.round((sorted[sorted.length / 2 - 1].hours + sorted[sorted.length / 2].hours) / 2 * 10) / 10)',
    into: '        : Math.round((sorted[sorted.length / 2 - 1].hours - sorted[sorted.length / 2].hours) / 2 * 10) / 10)',
  },
  {
    why: '"slowest" must be the slowest — reverse the sort and an agent is shown the fastest work as the worst',
    file: 'src/services.js',
    find: '      slowest: [...cycles].sort((a, b) => b.hours - a.hours).slice(0, 5),',
    into: '      slowest: [...cycles].sort((a, b) => a.hours - b.hours).slice(0, 5),',
  },
  {
    why: 'an expired lease must LET GO — otherwise one dead agent removes a task from the board forever',
    file: 'src/services.js',
    find: "       WHERE id=? AND (assignee IS NULL OR assignee='' OR assignee=? OR lease_until IS NULL OR lease_until < ?)`,",
    into: "       WHERE id=? AND (assignee IS NULL OR assignee='' OR assignee=?)`,",
  },
  {
    why: 'the ledger is how a company knows what it spent — a total that SUBTRACTS is a negative number dressed as a bill',
    file: 'src/services.js',
    find: '      total_tokens: totals.input_tokens + totals.output_tokens,',
    into: '      total_tokens: totals.input_tokens - totals.output_tokens,',
  },
  {
    why: 'a run with tokens but no cost must be PRICED, not zeroed — every auto-priced run else charges $0',
    file: 'src/services.js',
    find: '    const cost = usableCost(cost_usd) ?? costOf(model, input_tokens, output_tokens);',
    into: '    const cost = usableCost(cost_usd) ?? 0;',
  },
  {
    why: 'cost = input×inRate PLUS output×outRate — a minus there silently under-bills every run',
    file: 'src/pricing.js',
    find: '  const cost = (inputTokens / 1e6) * pi + (outputTokens / 1e6) * po;',
    into: '  const cost = (inputTokens / 1e6) * pi - (outputTokens / 1e6) * po;',
  },
  {
    why: 'a HQ_PRICE_ override the user set must actually take — dropping it silently bills at the wrong rate',
    file: 'src/pricing.js',
    find: '    if (Number.isFinite(i) && Number.isFinite(o)) out[model] = [i, o];',
    into: '    if (false) out[model] = [i, o];',
  },
  {
    why: 'memory_search bounds HOW MUCH, not just how many — unbounded, ONE 4MB memory returned 1,110,000 tokens',
    file: 'src/services.js',
    find: 'const MEM_MAX_TOKENS = 4000;',
    into: 'const MEM_MAX_TOKENS = Infinity;',
  },
  {
    why: 'a LIST is not a RECORD — the board shipped the FULL description of every task (300,000 tokens) and nothing rendered it',
    file: 'src/services.js',
    find: 'const CARD_DESC_CHARS = 400;',
    into: 'const CARD_DESC_CHARS = Infinity;',
  },
  {
    why: 'kanban_get_task is bounded — a 1.2MB description handed a model 300,000 tokens in one call',
    file: 'src/services.js',
    find: 'const TASK_MAX_TOKENS = 20_000;',
    into: 'const TASK_MAX_TOKENS = Infinity;',
  },
  {
    why: 'A RECORD HAS MORE THAN ONE BODY — the shared budget bounds every reader; without it a comment or a message returns 413,000 tokens',
    file: 'src/services.js',
    find: '    if (full > room) {',
    into: '    if (false) {',
  },
  {
    why: 'the budget is spent ACROSS rows — without the accumulator, EVERY row gets the full budget and N big rows return N x it',
    file: 'src/services.js',
    find: '    spent += estTokens(r[field]);',
    into: '    spent += 0;',
  },
  {
    why: 'lease_ms must be COERCED before Date arithmetic — the MCP schema types it, but the HTTP API/direct callers pass a NaN/Infinity/astronomical value straight in, and Date.now()+it overflows the valid Date range → claim()/next() throw a raw "Invalid time value", an agent\'s most-used calls',
    file: 'src/services.js',
    find: '    const lease = posInt(lease_ms, 600_000, MAX_LEASE_MS);',
    into: '    const lease = lease_ms;',
  },
  {
    why: 'ledger token counts must be non-negative ints — the ledger SUMs them, so a NEGATIVE count stores a negative cost (silent under-bill of the company) and a NaN/string hits a raw "NOT NULL constraint failed: runs.cost_usd"; the HTTP route passes them past the MCP schema',
    file: 'src/services.js',
    find: 'const tokenCount = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);',
    into: 'const tokenCount = (v) => +v;',
  },
  {
    why: 'an explicit cost_usd must be a usable non-negative number or we price from tokens — raw, a negative poisons the company total and a string crashes on `cost.toFixed`',
    file: 'src/services.js',
    find: 'const usableCost = (v) => (v != null && Number.isFinite(+v) && +v >= 0 ? +v : null);',
    into: 'const usableCost = (v) => (v != null ? v : null);',
  },
  {
    why: 'a message recipient must be RESOLVED to a canonical agent id — inbox matches m.to_agent against the reader\'s id, so a message addressed by NAME (which the feed shows as delivered) was stored raw and never reached the inbox, silently lost in the one tool whose job is agents coordinating',
    file: 'src/services.js',
    find: '      to_agent = rcpt.id;',
    into: '      void rcpt;',
  },
  {
    why: 'BOTH sides of a message must canonicalize the agent the same way — send() resolves the recipient to an id, so if the readers (inbox/unreadCount) and the sender do not, a message stored under an id is invisible to a name (and a broadcast author sees their own message). The helper is that single point.',
    file: 'src/services.js',
    find: 'const agentId = (v) => (v == null ? v : (Agents.get(v)?.id ?? v));',
    into: 'const agentId = (v) => v;',
  },
  {
    why: 'moving a task to a MISSPELLED column must be REFUSED, not silently ignored — create() rejects a bad column, but the move dropped it on the floor: the task stayed put, no error, the agent told "Done" while it never moved. This guard is where a typo and a real move diverge.',
    file: 'src/services.js',
    find: '      // not exist is a mistake, and the two must not look the same.\n      if (!col) {',
    into: '      // not exist is a mistake, and the two must not look the same.\n      if (false) {',
  },
  {
    why: 'company_graph counters are prototype-less (Object.create(null)) — keyed by USER-CHOSEN namespace/tag names, a plain {} let a namespace/tag named "constructor"/"toString" read the inherited FUNCTION as its count, so the node came back sized by a garbage string instead of a number',
    file: 'src/services.js',
    find: '    const nsCount = Object.create(null);',
    into: '    const nsCount = {};',
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  // A SKIPPED test cannot kill a canary — it did not run. So the skip count is not trivia here:
  // it is the difference between "nothing guards this line" and "the guard never got to look".
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// do not merely confuse each other — they can make a planted bug PERMANENT:
//
//     run B plants a mutation in core.js
//     run A reads core.js as its "original"      ← the original now CONTAINS B's bug
//     run B restores its own copy
//     run A restores ITS "original"              ← re-plants B's bug, and A believes it cleaned up
//
// The sabotage is now in your tree, no process is left to undo it, and the tool that put it there
// reports success. It is not theoretical: two overlapping runs turned this repo's suite red, and the
// only message was "THE SUITE IS ALREADY RED" — which names neither the file nor the line.
// An exclusive lock, taken BEFORE the baseline (a concurrent run poisons the baseline too).
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });   // wx = fail if it already exists
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT — see the note above. Wait for it, or kill it.');
    process.exit(1);
  }
  // The holder is gone (killed before it could clean up). Its restore-on-exit ran, so the tree is
  // sound; the lock is just litter. Take it.
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
// 🔑 A canary cannot be killed by a test that DID NOT RUN. If the baseline skipped tests, then any
// canary those tests guard will "survive" — and it will look exactly like a coverage hole, sending
// you to write a test that already exists instead of to the one-line fix (start Docker / install
// Chrome). Two different facts, two different fixes; they must not print the same sentence.
// This is anvil's cycle-13 lesson one layer up: in CI a skipped test is a FAILED test, so CI never
// sees this — it is the LOCAL run that lies, and the local run is where you do the work.
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary, because they `
    + 'do not run. A survivor below is far more likely to be a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this
// process dies in between — Ctrl-C, SIGTERM, a cancelled CI job, an OOM kill — the planted bug is
// LEFT IN YOUR TREE: a deliberately subtle one-character sabotage, sitting exactly where your real
// fix was, ready for the next `git add -A`. It is not hypothetical — a killed run left
// `raw && !isHtml` in scout's core.js, silently reverting a real fix, and the next mutants run said
// only "THE SUITE IS ALREADY RED", which names neither the file nor the line.
//
// A TOOL THAT PLANTS BUGS ON PURPOSE MUST BE THE ONE THING THAT ALWAYS CLEANS UP AFTER ITSELF.
// writeFileSync is synchronous, so it is safe in an exit handler.
let planted = null;                       // { file, orig } while a mutation is on disk
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  restore();

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n    ${c.file}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED. A test that did not run cannot kill a canary, so this\n`
        + '  is most likely a MISSING DEPENDENCY (docker down? no chrome?), not a missing test.\n'
        + '  Provide it and re-run — do not go writing a test that may already exist.'
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);

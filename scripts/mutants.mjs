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

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
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
    find: '  inbox({ agent, unread_only = false, limit = 50, mark_read = false }) {',
    into: '  inbox({ agent, unread_only = false, limit = 50, mark_read = true }) {',
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
    find: '    if (q) { sql += ` AND (title LIKE ? OR content LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }',
    into: '    if (false) { sql += ` AND (title LIKE ? OR content LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }',
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
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);

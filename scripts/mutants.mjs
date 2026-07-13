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
];

const run = () => spawnSync('npm', ['test'], { encoding: 'utf8', timeout: 300_000 }).status;

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
if (run() !== 0) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
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
  const status = run();
  writeFileSync(c.file, orig);

  if (status === 0) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);

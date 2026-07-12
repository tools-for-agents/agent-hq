#!/usr/bin/env node
// Is the thing you fixed the thing that is running?
//
//   npm run deployed
//
// The container serving this company's dashboard was built on 2026-06-27 and nobody
// noticed for two weeks. The whole design-system pass, every iris fix, every UI
// change — all of it green in CI, none of it running. Because `docker compose up -d`
// REUSES AN EXISTING IMAGE, and only `--build` rebuilds it, and the difference is
// completely silent: the dashboard comes up, it looks fine, and it is two weeks old.
//
// A green build on code that is not deployed tells you nothing at all. This compares
// the fingerprint of the working tree against the one the running server reports, and
// says which it is.
import { fingerprint } from '../src/build.js';

const URL_ = process.env.HQ_URL || 'http://localhost:7700';
const local = fingerprint();

let health;
try {
  const res = await fetch(`${URL_}/api/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  health = await res.json();
} catch (e) {
  console.error(`✗ nothing is answering at ${URL_} — ${e.message}`);
  console.error(`  start it:  docker compose up -d --build`);
  process.exitCode = 1;
  process.exit();
}

if (!health.build) {
  // An old image predates this endpoint, which is itself the answer.
  console.error(`✗ STALE — the server at ${URL_} does not report a build at all,`);
  console.error(`  which means it predates this check. Rebuild it:`);
  console.error(`\n      docker compose up -d --build\n`);
  process.exitCode = 1;
} else if (health.build !== local) {
  console.error(`✗ STALE — ${URL_} is running code that is not in your working tree.`);
  console.error(`    running:      ${health.build}`);
  console.error(`    working tree: ${local}`);
  console.error(`\n  \`docker compose up -d\` reuses the existing image. Rebuild it:`);
  console.error(`\n      docker compose up -d --build\n`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${URL_} is running exactly this code (${local})`);
}

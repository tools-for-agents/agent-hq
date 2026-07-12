// What code is this process ACTUALLY running?
//
// The container serving the company dashboard was built on 2026-06-27 and nobody
// noticed for two weeks. Every UI fix, the whole design-system pass, every iris
// finding — all of it green in CI, none of it running. `docker compose up -d`
// reuses an existing image; only `--build` rebuilds it, and the difference is
// silent. The dashboard looked fine. It was just two weeks old.
//
// A green build on code that is not deployed tells you nothing. So the server
// fingerprints the files it booted from and says so out loud, and `npm run deployed`
// compares that to the working tree. Staleness stops being invisible.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The files that decide what the app IS. Data and node_modules are not code. */
function sources(root = ROOT) {
  const out = [];
  for (const dir of ['src', 'public', 'mcp']) {
    let names;
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of names.sort()) {
      if (/\.(js|html|css|json)$/.test(n)) out.push(join(dir, n));
    }
  }
  out.push('package.json');
  return out;
}

/** A stable fingerprint of the running code — same files, same bytes, same hash. */
export function fingerprint(root = ROOT) {
  const h = createHash('sha1');
  for (const rel of sources(root)) {
    try { h.update(rel).update(readFileSync(join(root, rel))); } catch { /* absent is part of the identity */ }
  }
  return h.digest('hex').slice(0, 12);
}

// Packaging invariants — run with `node --test`.
//
// A `bin` entry in package.json plus a `#!/usr/bin/env node` first line is a promise that the
// file can be RUN: `git clone … && ./src/cli.js`, `npx github:tools-for-agents/<tool>`, a PATH
// shim someone made by hand. That promise is only kept if the executable bit is recorded IN GIT
// — a clone reproduces the index mode and nothing else.
//
// It drifts silently because the way we all actually use these tools repairs it: `npm i -g` and
// `npm link` create their own shim and chmod it, so the tool works perfectly on the machine of
// everyone who would notice. Measured across this fleet on 2026-08-05: three repos recorded the
// bin target as 100755 and five as 100644, every suite green, the difference invisible in any
// diff you skim (a mode change shows as `0 insertions, 0 deletions`).
//
// This file is the net under that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bins = Object.entries(pkg.bin ?? {});

// Without this, a package.json that lost its `bin` block would make every check below pass by
// having nothing to iterate — the loop would be green and empty. A count is the only thing that
// can tell those two states apart.
test('package.json still declares a bin — otherwise the checks below are vacuous', () => {
  assert.ok(bins.length > 0,
    'no bin entries found in package.json: the executable-bit checks in this file would pass by '
    + 'checking nothing at all');
});

const inGitWorkTree = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch { return false; }
})();

for (const [name, rel] of bins) {
  const abs = join(root, rel);

  test(`bin ${name} → ${rel}: has a shebang and is executable on disk`, () => {
    assert.equal(readFileSync(abs, 'utf8').slice(0, 2), '#!',
      `${rel} is declared as a bin but does not start with a shebang — running it directly would `
      + 'hand the file to the shell, not to node');
    const mode = statSync(abs).mode & 0o777;
    assert.ok(mode & 0o111,
      `${rel} is a bin target with mode ${mode.toString(8)} — \`chmod +x ${rel}\` and commit the mode`);
  });

  test(`bin ${name} → ${rel}: recorded as 100755 in git, not just on this machine`, (t) => {
    // A local `chmod +x` satisfies the test above and ships nothing: what a clone gets is the
    // index mode. This is the assertion that actually protects the person cloning.
    //
    // The skip below can only fire outside a git checkout (a published tarball, say). It cannot
    // fire in CI, where the workflow both checks out with git AND fails the build on any skipped
    // test — so a surprise here surfaces as red rather than as a quiet "skipped 1".
    if (!inGitWorkTree) return t.skip('not a git checkout — no index mode to read');
    const line = execFileSync('git', ['ls-files', '-s', '--', rel], { cwd: root, encoding: 'utf8' });
    assert.ok(line.trim().length > 0, `${rel} is declared as a bin but is not tracked by git`);
    const mode = line.trim().split(/\s+/)[0];
    assert.equal(mode, '100755',
      `git has ${rel} recorded as ${mode}; a clone of this repo cannot run it directly. Fix with `
      + `\`git update-index --chmod=+x ${rel}\` and commit.`);
  });
}

// A sibling directory the shipped code reaches for at runtime — `join(__dir, '..', 'public')` —
// has to be in `files`, or the PUBLISHED package is missing it while the repo checkout looks
// perfect. Nothing else can see that gap: every test, every local run and every CI job works
// from the checkout, and only `npm pack` builds the thing users actually install.
//
// prism shipped exactly this: src/server.js served `../public`, `files` listed
// ["src","mcp","README.md","LICENSE"], and the published package was a web server with no web UI.
// The other seven repos listed "public" — the drift was invisible because a `files` array is
// prose about the repo that nothing reads back.
//
// The wanted set is parsed out of the code itself, so a new asset directory is covered the day
// it is referenced rather than the day someone remembers this test exists.
const sourceFiles = [];
for (const dir of ['src', 'mcp', 'scripts']) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const e of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && /\.(js|mjs)$/.test(e.name)) sourceFiles.push(join(e.parentPath ?? abs, e.name));
  }
}

test('the runtime-asset scan actually read this package\'s source', () => {
  assert.ok(sourceFiles.length > 0,
    'found no source files under src/, mcp/ or scripts/ — the check below would pass by scanning nothing');
});

test('every sibling directory the code loads at runtime is in package.json files', () => {
  if (!pkg.files) return; // no `files` array means the whole repo ships; nothing to omit.
  const wanted = new Set();
  for (const f of sourceFiles) {
    for (const m of readFileSync(f, 'utf8').matchAll(/join\(\s*__dir(?:name)?\s*,\s*'\.\.'\s*,\s*'([^']+)'/g)) {
      if (existsSync(join(root, m[1]))) wanted.add(m[1]);
    }
  }
  const missing = [...wanted].filter((d) => !pkg.files.includes(d));
  assert.deepEqual(missing, [],
    `the published package would not contain ${missing.join(', ')}, but this package's own code `
    + `loads ${missing.length === 1 ? 'it' : 'them'} at runtime — add to "files" in package.json`);
});

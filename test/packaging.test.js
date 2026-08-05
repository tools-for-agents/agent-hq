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
import { readFileSync, statSync } from 'node:fs';
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

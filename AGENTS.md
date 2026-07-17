# AGENTS.md — agent-hq

🛰️ **The operating platform for an all-agent company.** Shared memory, a kanban agents claim work from
(atomic claim/lease so parallel agents don't collide), an agent registry, messaging, a run/cost ledger, a
live dashboard with a knowledge-graph tab, and an MCP server exposing all of it (28 tools).
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                                   # 22+ required. Nothing to install.
npm test                                         # = node --test (~12s)
HQ_DB_PATH=/tmp/hq/hq.db PORT=9310 node src/server.js &
HQ_URL=http://localhost:9310 npm run seed        # 70 tasks, 20 agents, a real graph
npm run mcp                                      # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever. Node 22+
gives you `node:sqlite` and a test runner.

| Env | For |
|---|---|
| `HQ_DB_PATH` | the SQLite file (default `./data/agenthq.db`) — **always redirect this in tests** |
| `PORT` | server port (default 7700) |
| `HQ_STALE_MS` | how long before an agent's heartbeat is considered stale |

⚠️ **:7700 is usually a live instance someone is actually using.** Use 9310+ for anything you are testing,
with your own `HQ_DB_PATH`. Never point a test at a running deployment.

⚠️ **`pkill`ing the server leaves data in an uncheckpointed `-wal`** — the next server on the same path reads
zero rows and looks like a corruption bug. Just re-seed.

## The rules this repo is built on

**1. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot*. This dashboard's gate audited a **blank board for months** and went green
every time — the seed script existed; nobody ran it. Seed, assert the data is on the page, then look.

**2. Open the doors.** Half this app's hover surface lives behind buttons no gate presses: modals, the task
detail, the graph panel. Everything found behind one so far was a bug. The graph panel opens by clicking a
node **on a canvas** — `window.HQGraph.debug()` returns page-space node centres for exactly this.

**3. Answer `prefers-reduced-motion`.** Every animation here must have a rule saying what it means when a
reader asks the machine to hold still — it is a real setting for a real audience, and iris emulates it so the
picture is the same picture twice. A page that ignores it gets audited mid-fade and reports colours that
exist for 180ms (the same text came back 4.49, 4.09 and 4.17:1 on identical runs).
**Put the `@media` block LAST** — above the rules it must beat, same specificity, it loses and does nothing.

**4. A `<button>` carries a UA stylesheet.** Font does not inherit, text centres, and Chrome hands any button
that stays quiet `1px 6px` of padding — which is how three close buttons here landed 6px off the 4px grid.
Say all of it out loud.

**5. Semantics, not reflexes.** The graph search rows are a **combobox** (`role="option"`, driven by
↑/↓ + `aria-activedescendant`, focus stays in the input). They must not become tabbable buttons.

## Tests

`npm test` — `node --test`, **no test may be skipped**. The kanban's claim/lease logic is concurrency-
sensitive: if you touch it, write the test that fails against the original.

## CI

`test` · `mutants` · `look` · `first-run` · `look-views` · `look-modal` · `look-graph` · `states` ·
`dead-api` · `slow-api` · `refused-write`

- **`look-views`** sweeps all 8 tabs at phone, tablet and desktop — auditing one width audits one third of
  the product.
- **`look-modal` / `look-graph`** open the doors nothing else opens.
- **`mutants`** — every canary must die. Push and read CI.

## Commits

Lowercase, `area: what changed and why it mattered` — `ui:`, `ci:`, `core:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.

# scripts/roadmap

Tooling for the GitHub Projects roadmap described in
`docs/PROJECT_OPERATING_PLAYBOOK.md`. Plain ES modules, no dependencies.

## The gate (issue #4)

Every repo-owned reader and writer reaches GitHub through `gate.mjs`. It refuses
to call GitHub when the budget, a throttle or a lock says it should not, and it
returns `{ ok: false, code, ... }` instead of throwing for expected refusals. The
codes are listed at the top of `gate.mjs`.

| File | Job |
| --- | --- |
| `rate-limit.mjs` | Pure budget accounting (GraphQL, REST, secondary throttle, reservations). |
| `lock.mjs` | Host-local lock. Live owners are never evicted for age. |
| `gate.mjs` | The only entry point: preflight, pacing, paging bounds, truncation checks, sanitized log. |
| `github-transport.mjs` | The one file allowed to start `gh`. |
| `bypass-check.mjs` | Used by `test/roadmap-bypass.test.js` to catch code that skips the gate. |
| `probe.mjs` | Prints what the gate believes the budget is. Costs a few quota points. |
| `tools/codex-batch.mjs` | Read-only `--dry-run` planner for issues #13–44. It uses lifecycle `inspect` and `ready --dry-run`; it has no claim, worker, provider-balance, publication or completion path. |

```js
import { createGate } from "./gate.mjs";
import { createGhTransport } from "./github-transport.mjs";
const gate = createGate({ transport: createGhTransport() });
const result = await gate.read({ query: "query Who { viewer { login } }" });
if (!result.ok) console.error(result.code, result.message, result.retryAt);
```

Use `gate.session(async (ops) => { ... })` to hold the lock across several
operations (a claim must re-check and then write under one lock). Inside a
session use the `ops` passed in; calling `gate.read` from inside would wait on
itself.

## The lock

- Path: `ROADMAP_LOCK_PATH`, or `brainstorm-roadmap-gate.lock` in your OS temp
  directory (outside the repo, so every worktree on this host shares it).
- Inspect it: it is a small JSON file with the owner's `pid`, `host`, `label`
  and `acquiredAt`. Print it with `node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" <path>`
  or just open it. Find the path with
  `node -e "import('./scripts/roadmap/lock.mjs').then(m=>console.log(m.defaultLockPath()))"`.
- A lock whose owner process is dead (same host) is recovered automatically. A
  lock from another host, or one whose record cannot be read, is refused and left
  for you to inspect. Do not delete a lock you have not looked at.

## Honest limits

- The lock covers cooperating processes on **one host**. Several people or
  hosts need one dispatcher (see the playbook, section 4).
- The gate cannot account for `gh` commands typed by hand or scripts that bypass
  it (see `docs/roadmap/transport-inventory.md`); they share the same quota.
- Process IDs can be reused, and two processes recovering the same dead lock at
  the same instant have a narrow race. Both are acceptable for one person on one
  machine and are noted in `lock.mjs`.

## The lifecycle wrapper, part 1 (issue #3)

`node scripts/roadmap/lifecycle.mjs <inspect|ready|claim|block> <issue> [--json]`
(run with `help` for flags). `lifecycle-core.mjs` is the pure logic (contract,
routing, dependency and claim parsing); `lifecycle.mjs` does the reads and writes,
always inside `gate.session()` so one lock covers the re-check and the writes.

- `inspect` never writes. `ready --dry-run` verifies and reports without writing.
- `claim` needs `--execution-id`, which must equal the runner's own identity: the
  Codex runner's `CODEX_THREAD_ID` (its `CODEX_SESSION_ID` only counts when it
  equals the thread id), or the legacy `CLAUDE_CODE_SESSION_ID` when no Codex id
  is set. A conflicting or ambiguous environment is refused. `--effort` is the
  logical label; `--effective-effort` records the configured runner effort (for
  example, `low` maps to `medium`, `medium` to `high`, and `high` to `max`).
- Only the repository owner's `complete:v1`/`release:v1` comments end a claim or
  count as a prerequisite's acceptance record; anyone's `claim:v1` counts as live.
- `block` records a routing change as a proposal; the owner edits the labels.

## The lifecycle wrapper, part 2 (issue #45)

`lifecycle-finish.mjs` adds `review`, `verify`, `complete`, `stale` and `release`.

- `review` is recorded by the execution holding the live claim; an External issue also needs `--external-evidence`.
- `complete` is the only code that closes an issue (a test enforces it). Producer needs the owner's acceptance naming the tested commit after the review; Automated needs a `verify` record from a different execution (or the owner's acceptance); External needs recorded evidence. The commit must be reachable from `main` (GitHub compare API), or from a special branch named in the issue's Starting baseline.
- Comment, Done and close are written, then re-read; a half-finished completion is reconciled by marker, never replayed.
- `stale` is read-only. `release` returns a stale claim to Ready only with `--stopped-execution`, `--confirmed-by` and `--evidence`; age alone is never proof.
- Limit: the owner's acceptance is a comment from the owner account, so anything that can post as that account can type it.

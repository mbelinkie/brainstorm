# GitHub transport inventory

Playbook section 5 requires every repo-owned reader and writer to use one
audited transport. This file lists every way this repository's code can reach
GitHub. `test/roadmap-bypass.test.js` keeps it honest: it fails if a file under
`scripts/` starts `gh`, names GitHub's API host, or imports `child_process`
outside the one transport below, and it fails if this list and the code
disagree.

## Transports in the repo

- `scripts/roadmap/github-transport.mjs`
- `scripts/backup/run-command.mjs`

The GitHub transport is the only file allowed to start the `gh` CLI. Everything
else reaches GitHub through `scripts/roadmap/gate.mjs`, which adds the lock, the
budget accounting, throttle handling, paging bounds and the sanitized log.

`scripts/backup/run-command.mjs` is a Supabase-only process boundary. It may
import `child_process` solely to execute the hardcoded `supabase` executable,
with a fixed allowlist of dump/copy arguments. It is not a GitHub transport:
GitHub API/host rules, GraphQL endpoint rules, and `gh` execution rules still
apply to it, and the bypass check enforces them.

## Callers (all through the gate)

- `scripts/roadmap/probe.mjs`: read-only budget diagnostic.
- `scripts/roadmap/lifecycle.mjs` (+ `lifecycle-core.mjs`, pure): inspect, ready, claim, block (#3). Uses `gate.session()` only.
- `scripts/roadmap/lifecycle-finish.mjs`: review, verify, complete, stale, release (#45). Uses `gate.session()` and `ops.rest` only.
- `tools/codex-batch.mjs` (+ `tools/batch-core.mjs`, pure): read-only dry-run planner for issues #13–44. It reads through the gate and calls lifecycle `inspect` plus `ready(..., { dryRun: true })`; it cannot claim, spawn workers, access provider balances, publish, merge or complete. The delegation harness (`tools/delegate/`, planned; see `docs/delegation/HARNESS_SPEC.md`) will reuse its core and must use the gate for every GitHub read and write.
- `scripts/roadmap/progress.mjs` (+ `progress-core.mjs`, pure): read-only progress view (#5). Uses `gate.readAll` and `gate.read` only; it has no write path.

## Not covered, and why

These exist but are outside what an in-repo test can see. They share the same
GitHub quota, so the gate cannot account for them:

- `tools/worktree-setup.mjs` (issue #6) starts `git` and `npm ci` for worktree bootstrap. It is not a GitHub API transport and lives outside `scripts/` so the bypass check there stays strict.
- `gh` commands typed by a person or run by an agent in a terminal.
- Throwaway scripts kept outside the repository (for example in a session
  scratchpad). They do not run through the gate.
- The GitHub web UI and the Projects UI.
- `git fetch` / `git push` over HTTPS. This is the git transport, not the API,
  and does not spend REST or GraphQL points.
- Other hosts or people using the same account. The host-local lock does not
  reach them.

Adding a new transport means adding it here, in the same change.

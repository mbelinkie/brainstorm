# GitHub transport inventory

Playbook section 5 requires every repo-owned reader and writer to use one
audited transport. This file lists every way this repository's code can reach
GitHub. `test/roadmap-bypass.test.js` keeps it honest: it fails if a file under
`scripts/` starts `gh`, names GitHub's API host, or imports `child_process`
outside the one transport below, and it fails if this list and the code
disagree.

## Transports in the repo

- `scripts/roadmap/github-transport.mjs`

That is the only file allowed to start the `gh` CLI. Everything else reaches
GitHub through `scripts/roadmap/gate.mjs`, which adds the lock, the budget
accounting, throttle handling, paging bounds and the sanitized log.

## Callers (all through the gate)

- `scripts/roadmap/probe.mjs`: read-only budget diagnostic.
- `scripts/roadmap/lifecycle.mjs` (+ `lifecycle-core.mjs`, pure): inspect, ready, claim, block (#3). Uses `gate.session()` only.
- `scripts/roadmap/lifecycle-finish.mjs`: review, verify, complete, stale, release (#45). Uses `gate.session()` and `ops.rest` only.
- `scripts/roadmap/progress.mjs` (+ `progress-core.mjs`, pure): read-only progress view (#5). Uses `gate.readAll` and `gate.read` only; it has no write path.

## Not covered, and why

These exist but are outside what an in-repo test can see. They share the same
GitHub quota, so the gate cannot account for them:

- `gh` commands typed by a person or run by a Claude session in a terminal.
- Throwaway scripts kept outside the repository (for example in a session
  scratchpad). They do not run through the gate.
- The GitHub web UI and the Projects UI.
- `git fetch` / `git push` over HTTPS. This is the git transport, not the API,
  and does not spend REST or GraphQL points.
- Other hosts or people using the same account. The host-local lock does not
  reach them.

Adding a new transport means adding it here, in the same change.

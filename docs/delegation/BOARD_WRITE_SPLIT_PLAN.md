# Plan: the harness moves the board, sessions only comment

Status: plan for Matthew to read (2026-10-03). Not implemented.

## Why

Codex sessions run in a sandbox where `gh` cannot use Matthew's keychain login. They now get a fine-grained token (`delegate-harness`, only mbelinkie/brainstorm: Issues and Pull requests read/write, Contents read). GitHub refuses that token on the board, because Project 4 belongs to a personal account ("Resource not accessible by personal access token"). A classic token would work, but it reaches every repo, so Matthew ruled it out.

Every lifecycle step that runs inside a session reads the board, and two of them write it:

| Step (who runs it) | Reads the board | Writes the board |
|---|---|---|
| `claim` (Luna or Sol) | Status must be Ready; Acceptance field | Status → In progress |
| `review` (Luna) | Status must be In progress | Status → In review |
| `verify` (Verifier) | Status must be In review | nothing |

The fine-grained token fails even the read, because the issue query includes the board item.

## The design

Sessions do the GitHub issue part; the harness does the board part, outside the sandbox, with Matthew's normal `gh` login.

1. **Before the session:** the harness reads the issue with the full query (normal login) and starts the session only if the board says what the step needs (Ready for claim, In progress for review, In review for verify), and the Ready gates pass.
2. **In the session:** the pre-filled command gains `--board-free`. Lifecycle then reads the issue without the board item, runs every check that does not need the board, and posts only the comment (`claim:v1`, `review:v1`, `verify:v1`). It reports `statusPending: "In progress"` (or `"In review"`) instead of setting it.
3. **After the session:** the harness calls a new lifecycle function, `settle`. Under the gate's lock it re-reads the issue with the full query and:
   - refuses unless the live claim belongs to that session's thread ID (for review, also that the `review:v1` comment is that execution's, for the published commit);
   - does nothing if the Status is already the target;
   - moves the Status only from the expected previous state (Ready → In progress, In progress → In review);
   - refuses, and writes nothing, if the Status is anything else. Someone changed the board while the session ran, so a human decides.

## If the board move fails after the comment is posted

- **The comment is the lock, not the board.** `claim` already checks for a live claim comment before anything else and refuses with `CLAIM_HELD` when another execution holds one. So while the board still says Ready, no second runner can claim the ticket.
- **`settle` is safe to repeat.** It re-reads every time and never posts a comment. The harness retries it up to 3 times. The gate already handles rate limits and secondary throttles.
- **If it still fails,** the harness records the ticket as `claim-status-pending` (or `review-status-pending`). It stops the batch with a new stop code, `BOARD_WRITE_FAILED`, and starts no further session, so no coding happens on a half-claimed ticket. It does not try `block` either, because that is also a board write.
- **Recovery:** rerun `node tools/delegate/run.mjs ticket <n>`. It resumes at `settle`, and never starts a new session or posts a second comment (a new session would have a new thread ID and would only get `CLAIM_HELD`). Matthew can also run `node scripts/roadmap/lifecycle.mjs settle <n> --execution-id <thread>` by hand.
- **Visible in the stale check:** `lifecycle.mjs stale` gains `CLAIM_WITHOUT_STATUS`, meaning a live claim while the Status is still Ready. That mirrors the existing `STATUS_WITHOUT_CLAIM`.
- **A race with a human:** if Matthew moves the card between the harness's check and the comment, `settle` sees an unexpected Status and refuses instead of overwriting it. The claim stays live, and `release` (which already exists) clears it.

## What touches `scripts/roadmap` (protected; Sol reviews before merge)

1. `scripts/roadmap/lifecycle.mjs`
   - a board-free variant of the issue query (the same fields minus `projectItems`);
   - a `boardFree` option on `evaluate` and `claim` that skips `NOT_ON_BOARD`, the Status checks, the Acceptance-field comparison and the Status write, and keeps every other check (closed issue, claim history, `CLAIM_HELD`, Ready gates, routing);
   - the `--board-free` CLI flag;
   - the new `settle` operation (exported function plus CLI op).
2. `scripts/roadmap/lifecycle-finish.mjs`: `boardFree` for `review` and `verify`, and `settle` support for the review step.
3. `scripts/roadmap/lifecycle-core.mjs`: the `CLAIM_WITHOUT_STATUS` stale finding.
4. `test/roadmap-lifecycle.test.js`, `test/roadmap-lifecycle-finish.test.js`: tests for each of the above, each red first.
5. `scripts/roadmap/README.md`: document `--board-free` and `settle`.

Not touched: `gate.mjs`, `github-transport.mjs`, `rate-limit.mjs`, `lock.mjs`. The comment-then-status ordering and `PARTIAL_WRITE` stay as they are for runs outside the harness.

## What touches the harness (`tools/delegate`)

- `pipeline.mjs`:
  - `--board-free` on the pre-filled claim, review and verify commands;
  - the pre-session board check;
  - `settle` with retries after claim and review;
  - the two `*-status-pending` phases and resuming from them.
- `run.mjs`:
  - the `BOARD_WRITE_FAILED` stop code;
  - removing `GH_TOKEN` and `GITHUB_TOKEN` from the environment of the harness's own `gh` calls (a spawn wrapper passed to `createGhTransport`). A token exported by mistake then cannot downgrade the harness to the fine-grained token, which cannot see the board.
- `test/harness/delegate-e2e.test.js`, end-to-end cases for:
  - board-free claim then settle;
  - settle failing 3 times stops the batch with no second session;
  - a Status changed during the session is refused, not overwritten;
  - resume from `claim-status-pending`;
  - the harness's `gh` ignores a `GH_TOKEN` in its environment.
- Cards: no change needed. The commands are pre-filled and the cards already say to run them as written.

## Notes

- The gate's lock file is under `TMPDIR` (`brainstorm-roadmap-gate.lock`). The session environment allowlist keeps `TMPDIR`, so the harness and sessions share the lock.
- When the harness moves to its own repository, the board part belongs to the harness's per-project configuration. This plan keeps repository and board identifiers where they already live (`docs/roadmap/config.json`) and adds none to code or prompts.
- Size: about half a day plus Sol's review of the `scripts/roadmap` diff.

# Delegation harness: build specification

This is what to build so the [process](../DELEGATION.md) runs. The harness is the dispatcher: a deterministic program that launches model calls and Codex sessions, waits on them for free, and does every mechanical step itself. It is Protected-lane code. DeepSeek implements it in Standard-lane slices from this spec, and Sol reviews it once before the first batch.

## 1. Shape

- **Language:** Node 24 ES modules, with no new dependencies. That matches this repository and its `node:test` suite.
- **Location:** `tools/delegate/`. Pure logic goes in `*-core.mjs` files, with tests in `test/delegate-*.test.js`.
- **GitHub:** all GitHub reads and writes go through `scripts/roadmap/gate.mjs` (`createGate`, `createGhTransport`), and all lifecycle state through `scripts/roadmap/lifecycle.mjs`. Never call `gh` or the API directly; `test/roadmap-bypass.test.js` enforces this.
- **Private state:** all private state lives outside the repository in `$DELEGATE_HOME`. The default is `~/.local/share/brainstorm-delegate/`, holding `batches/<start-time>/`.
  - The DeepSeek key file is read by the request module only and never printed.
  - Public artifacts (PR bodies, lifecycle comments, the per-ticket evidence file) never contain absolute paths, keys or private responses.
- **Config:** `tools/delegate/config.json` is committed. It holds the test command, the JUnit reporter flags, lane limits, protected-path globs, fit-gate labels, budgets, ladder settings, the plan-headroom threshold and the owner's credit cap. Secrets never go in it.

## 2. Commands

`node tools/delegate/run.mjs <command>`. Setup and the first-run smoke test are in [`tools/delegate/README.md`](../../tools/delegate/README.md).

| Command | Does |
| --- | --- |
| `start [--deadline-hours 8] [--usd 10]` | Starts a batch on the owner's instruction only. Checks DeepSeek `/models` for every configured model, records the `/user/balance` baseline, the deadline and the spend cap. Refuses while another runner is live |
| `run` | Loops until there's no eligible work, the deadline passes, a budget or plan limit stops it, or a STOP file appears. Resumes unfinished tickets first, then asks the read-only planner for the next Ready ticket |
| `ticket <n>` | Advances one ticket (it must be the planner's selected Ready ticket, or already in progress in the harness) |
| `status` | One-page batch status: deadline, spend, plan reading, and each ticket's phase. A resumed session reads this, not history |
| `stop` | Writes the STOP file; the running batch stops after its current step |
| `check-sha <sha> [--ticket <n>]` | Clean detached checkout under the OS temp dir, `npm ci`, the full suite and the acceptance tests, then a summary of 30 lines or fewer. The only command the Verifier runs |

Inside `run`, each ticket moves through these phases, one step each (`tools/delegate/pipeline.mjs`):

`intake` (planner selection, Gate 0 labels, worktree) → `recon` (Scout, quote check, contract drift and fit) → `triage-and-claim` (one Luna session decides fit, lane, cases and scope, then claims) → `tests` (test author, red-on-base, commit, lock) → `implement` (ladder with guards) → `gate` (Luna decides; REPAIR once; ESCALATE to Sol) → `publish` (commit, evidence file, push) → open PR → `review` (claimant records it) → `verify` (separate Luna session runs `check-sha`) → `finish` (merge at the verified SHA, test integrated main, lifecycle `complete`; Producer tickets stop for owner sign-off).

Every step is **safe to re-run**. Ticket state is checkpointed after each step; lifecycle writes re-read before writing; opening a PR and merging re-read GitHub first, so a crash or rerun never duplicates a claim, comment, PR or merge.

## 3. Launching Codex sessions

Use `codex exec` with an explicit model and effort per role, a working directory, and JSON event output. Confirm the flags with `codex exec --help`. The prompt is: the role card path + the harness-written input file + the exact lifecycle commands to run, pre-filled except for the execution ID.

- **Identity.** The session runs lifecycle commands itself, so its genuine `CODEX_THREAD_ID` is recorded. Apply the documented `env -u CODEX_SESSION_ID` rule for spawned children. The harness never sets or invents an execution ID.
- **Claimant.** One Controller thread per Express or Standard ticket. Its steps: triage-and-claim → (harness work) → gate decision → lifecycle review. Each later step is an `exec resume` of the same thread with a new small input. The harness confirms the live claim's execution ID equals the session's thread ID before any work.
- **No file edits.** The harness fingerprints the ticket worktree before and after every role session in it; any change blocks the ticket.
- **Verifier.** A new thread, never the claimant's.
- **Triage and escalation.** One-shot threads. Their output is a decision file the harness parses. Invalid output gets one retry, then a block.
- **Never waits in a model.** The harness waits on processes and files. No Codex session waits, polls or supervises another.
- **Usage.** Parse token usage (input, cached input, output) from each session's JSON events. Missing usage counts as over budget (process §6).
- **Output contract.** Each session's last message is one fenced JSON object. For example, the gate returns `{"decision":"ACCEPT|REPAIR|ESCALATE|RECLAIM","note":"..."}`.

## 4. DeepSeek requests

Port the private `run-slice.py` checks into a `deepseek.mjs` module. It keeps:

- the deadline;
- the `/models` check;
- a reliable balance reading and the spend stop;
- returned-model verification;
- the complete-response check (`finish_reason` `stop`);
- no tool calls;
- JSON parsing.

It adds:

- the stable-prefix ordering, with prefix versioning;
- recording every response in full, failures included;
- the length-retry rule;
- cache-hit logging.

**Artifact applier.** Validates the schema, the path allowlist (the write scope minus locked files), the base SHA, exact-once `old` matches and no duplicates. Stages everything in memory and applies it atomically.

**Context assembly for recon** (no tools):

- a repository map: tracked paths plus exported symbols, from a simple parser or `grep`;
- candidate files: those matched by ticket keywords and paths, plus their importers.

The total is capped at about 200k tokens. Exclude `.env*`, `.dev.vars`, `node_modules`, private evidence and anything in `.gitignore`.

## 5. Guards

They run after every attempt, before any test. Each prints exactly one `PASS` or `FAIL <reason>` line.

1. **Locked tests:** acceptance file hashes are unchanged.
2. **Write scope:** every changed path is inside the slice's globs.
3. **Protected paths:** none touched (unless the ticket is Protected).
4. **No test weakening:**
   - collected test count is at least the base count;
   - no added `skip`, `todo`, `.only`, `{ skip: … }` or `test.skip`;
   - no added `eslint-disable` or `@ts-ignore`, unless the packet allows it.
5. **Configuration untouched:** `package.json` scripts, the lockfile, CI, wrangler and test configuration are unchanged, unless allowed.
6. **No new dependencies.**
7. **Syntax:** `node --check` on changed `.js` and `.mjs` files; `git diff --check`.
8. **Acceptance:** every acceptance test ID in the JUnit output (`node --test --test-reporter=junit`) is *passed*. Missing or skipped counts as a FAIL.
9. **Regression:** the full `npm test` passes. It takes about 12 seconds, so run it every attempt.
10. **Lane limits:** changed lines and files are within limits; otherwise promote.
11. **Public safety:** no absolute local paths, key-shaped strings or `.env` contents in the diff.

The worker's report is never an input to any guard.

## 6. Review bundle

`bundle.md` is about 300 lines or fewer, and is the only ticket content a Controller reads:

```markdown
# #<n> <title>  lane: standard  base: <sha12>  attempts: 2 (flash, flash)
DeepSeek: $0.03, cache hit 81%, models deepseek-flash (fp …)
## Approved cases            A1 … | A2 … | A3 …
## Case map                  A1 → <test>: asserts …
## Evidence
guards 11/11 PASS | acceptance A1 PASS A2 PASS A3 PASS | regression 680/680
mutants 3/3 killed | recon quotes 9/9 verified | pre-review NONE
## Worker notes (≤10 lines)
## Diff (stat, then hunks; never whole files)
```

- Successful logs are never included; a failure shows an excerpt of 40 lines or fewer.
- A diff over 400 lines is not bundled. The ticket is split or escalated instead.

## 7. Budgets and account limits

- **Before** launching or resuming any Codex session, check:
  - the deadline;
  - the ticket's session and token budget;
  - the account's 5-hour usage against the headroom threshold (process §6 and §7).
- **Reading usage.** Read the account's 5-hour and weekly usage from the
  rate-limit fields Codex reports in its JSON events or session logs; confirm
  the field names first. Update a small usage table after every session.
  Missing or stale usage counts as exhausted.
- **At the 5-hour limit:** if the owner's credit cap allows it, continue and
  count credits spent at rate-card prices. Otherwise sleep until the reported
  reset, if that's within the deadline, and resume. Claimant threads resume on
  the same account.
- **At the weekly limit:** stop the batch and write the status.
- **Never** switch accounts, buy credits, or change plan settings. Those are
  the owner's actions.

## 8. Outputs

Per ticket, private:

- `recon.json`, `decisions.json`, `packet.md`, `acceptance.lock`;
- for each attempt: the request, response, diff, guard results and JUnit XML;
- `bundle.md`, the session usage records, and the checkpoint.

Public:

- a per-ticket evidence file `docs/delegation/evidence/<n>.md` of 40 lines or fewer, written by the harness: SHAs, models, request IDs, checks with results, decisions, exclusions;
- the PR body;
- lifecycle comments.

The harness writes the ledger to `$DELEGATE_HOME/ledger.csv` (process §10). It does not append to `docs/CLAUDE_WORKLOG.md`.

## 9. Build order

Each step is a Standard-lane slice with its own tests. Pure cores come first.

1. **Config loader, artifact validator and applier, guards 1–7 and 10–11.** All pure, with fixture tests.
2. **`deepseek.mjs`** (ported checks plus recording), against a fake HTTP server in the tests.
3. **JUnit parsing, guards 8–9, the red-on-base check and the lock.**
4. **The ladder loop and bundle writer** (with a fake DeepSeek).
5. **Codex session launcher and usage parsing** (with a fake `codex` binary in the tests); budgets.
6. **Lifecycle and gate integration:** claim and review via the session, publish, `check-sha`, finish. Reuse the planner core.
7. **Recon assembly and quote verification; the mutant check and pre-review.**
8. **Plan usage reading, headroom checks, credit cap and reset sleep.**
9. **The `run` loop, `status`, `resume`, the stop file and the dispatcher lock.**

**Minimum useful version: steps 1–6.** It removes the dispatcher conversation and Codex's mechanical work, which is most of the saving. Steps 7–9 add the remaining Codex savings and safety.

**Acceptance for the harness itself:**

- every guard has a test that fails when the guard is removed;
- `npm test` and `npm run test:harness` both pass;
- one end-to-end dry run on a throwaway ticket with fake DeepSeek and fake Codex binaries;
- one real Express ticket with Sol watching the bundle and evidence.

## 10. Implementation status (October 2, 2026)

Every feature in this spec and in the [process](../DELEGATION.md) is built.

**Tests:** unit tests in `test/delegate-*.test.js` (part of `npm test`), a bypass check in `test/roadmap-bypass.test.js`, and thirteen end-to-end runs in `test/harness/` (`npm run test:harness`, about 50 seconds). The end-to-end runs are kept out of `npm test` because product tickets run the suite on every ladder attempt; run them after any harness change, and as part of Sol's harness review. They use a throwaway repository with real git and `node --test`, and fake DeepSeek, Codex, lifecycle and gate. Together they cover:

- the full path, with mutants, pre-review and the audit sample;
- a mutant that survives, strengthened tests and their re-proof;
- pre-review with one extra attempt, and keeping the green version when that attempt regresses;
- ladder climbing and the guards;
- a capped ladder escalating;
- one REPAIR;
- two slices;
- the Protected lane with Sol;
- a category raised to Protected by the owner;
- batched triage across two tickets;
- Gate 0 flagging;
- a role session editing the worktree;
- crash recovery of scratch edits, and fresh names on a retry.

**Covered:**

- **Build steps 1–6:** config, artifacts, guards, JUnit, red-on-base, the lock, the DeepSeek client, the ladder, the bundle, the Codex launcher, budgets, plan headroom, lifecycle and gate integration, `check-sha`, publish, PR, merge, finish.
- **Step 7:**
  - recon (context without tools, quote verification, drift and fit);
  - the mutant check (in place, behind a crash-safe backup), with one strengthening round re-proven green on the implementation, red on base and fatal to the survivors, then re-locked and committed;
  - pre-review, with one extra attempt that keeps the previous green version if it regresses.
- **Step 8:** single-account plan headroom, the credit cap, sleeping until the reset, and stopping at the weekly limit.
- **Step 9:** `run`, `ticket`, `status`, `stop`, the runner lock, resuming from checkpoints, restoring scratch edits after a crash.
- **Beyond the steps:**
  - slices;
  - the Protected lane (Sol design-and-claim, gate, real-process check, review);
  - routing to Sol for escalations and for owner category overrides;
  - batched triage (`batch.triageBatchSize`);
  - the Sol audit sample (`audit`);
  - `reopens` and `report`, with tuning recommendations;
  - workstream categories with `categoryOverrides` (`minLane`, `ladderStart`).

**Unconfirmed until the first real run** (see the README smoke test):

- Codex's JSON event and session-log field names. They were read from the codex-cli 0.160.0 binary, not from a live run.
- Network access for lifecycle commands inside the Codex sandbox (`sandbox_workspace_write.network_access=true`).
- Whether DeepSeek accepts `response_format` with thinking enabled. `deepseek.jsonMode` is off by default.
- How well DeepSeek follows the scout, mutant, pre-review and test-author prompts on real tickets.

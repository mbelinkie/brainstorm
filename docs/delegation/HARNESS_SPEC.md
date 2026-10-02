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

`node tools/delegate/run.mjs <command>`:

| Command | Does |
| --- | --- |
| `start --deadline 8h --usd 10` | Starts a batch on the owner's instruction only. Records a fresh deadline, the DeepSeek `/user/balance` baseline, a `/models` check, and the dispatcher lock. Refuses if another batch lock is live |
| `next` | Runs the planner (`tools/codex-batch.mjs` core) and Gate 0 labels, then intake for the next eligible ticket |
| `recon <n>` | Runs the Scout, verifies quotes, runs the reproduction command, and blocks on contract drift |
| `triage` | Writes the trimmed triage view for pending tickets and launches one Controller triage session |
| `tests <n>` | Runs the test author, the red-on-base check and the lock |
| `implement <n>` | Runs the ladder with guards after each attempt, then the mutant check and pre-review |
| `bundle <n>` | Writes `bundle.md` |
| `gate <n>` | Resumes the claimant for its decision and routes it |
| `publish <n>` | Pushes the branch, opens the PR, and records the full SHA |
| `verify <n>` | Launches the Verifier session, which runs `check-sha` |
| `check-sha <sha>` | Clean detached checkout, `npm ci`, full suite plus acceptance tests, then prints a summary of 30 lines or fewer. The only command the Verifier runs |
| `finish <n>` | Merges preserving the SHA, tests integrated main, runs lifecycle `complete`, writes the ledger and evidence file. For an owner sign-off ticket, writes the sign-off summary instead |
| `claim <n>` | After triage returns `fit=ok`, launches the claimant session (Luna, or Sol for Protected) to run the claim command. Nothing in the worktree changes before this succeeds |
| `run` | Loops until there's no eligible work, the deadline passes, a budget stops it, or a stop file appears. Each pass: `next` and `recon` for up to 10 eligible tickets, one `triage`, then `claim` through `finish` for each ticket in turn |
| `status` | Prints the one-page batch status. A resumed session reads this, not history |
| `resume` | Re-reads live GitHub, Git and claim state and reconciles with the private checkpoint before any write |

Every command is **idempotent**. It re-reads live state and compares stable markers before any write, so a crash or rerun never duplicates a claim, comment, PR or merge.

## 3. Launching Codex sessions

Use `codex exec` with an explicit model and effort per role, a working directory, and JSON event output. Confirm the flags with `codex exec --help`. The prompt is: the role card path + the harness-written input file + the exact lifecycle commands to run, pre-filled except for the execution ID.

- **Identity.** The session runs lifecycle commands itself, so its genuine `CODEX_THREAD_ID` is recorded. Apply the documented `env -u CODEX_SESSION_ID` rule for spawned children. The harness never sets or invents an execution ID.
- **Claimant.** One Controller thread per Express or Standard ticket (Sol for Protected). Its steps: claim → (harness work) → gate decision → lifecycle review. Each step is an `exec resume` of the same thread with a new small input. Record the thread ID at launch.
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
- one end-to-end dry run on a throwaway ticket with fake DeepSeek and fake Codex binaries;
- one real Express ticket with Sol watching the bundle and evidence.

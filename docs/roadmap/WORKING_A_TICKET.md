# Working a ticket: instructions for a new machine

For anyone (a person, or a Codex session) picking up work on the Brainstorm
quiz platform from a machine that has access to `mbelinkie/brainstorm`. It covers
finding a ticket you may work, claiming it, doing the work, reporting it, and
stopping at the right place.

The rules behind it live in `docs/PROJECT_OPERATING_PLAYBOOK.md`. This file is the
practical version for the tooling that exists **today**: the lifecycle wrapper
`scripts/roadmap/lifecycle.mjs` (issues #3 and #45) on top of the GitHub API gate
(issue #4). The wrapper writes the claim, review, block and completion comments
and the board status for you. **Do not hand-write those comments or edit board
statuses by hand**; the tool checks the gates first and keeps the records in a
format it can read back.

## 0. Ground rules (read these first)

1. **The GitHub issue and the Project board are the truth.** Not a chat, not a
   summary, not memory. The wrapper re-reads live state before every change.
2. **One issue, one claim, one branch, one worktree.** Never work two tickets in
   one checkout, and never work in a checkout another session is using.
3. **One dispatcher.** Matthew decides what becomes **Ready** and who works it.
   The wrapper makes claims safe on one machine (a lock plus a re-read), but that
   is **not atomic across machines or people**. Two people can still claim the
   same ticket at the same moment. Do not start a ticket unless it is Ready *and*
   Matthew has told you it is yours.
4. **You stop at In review.** Acceptance, merging, and completion belong to the
   owner or the dispatcher, never to the agent that did the work.
5. **Deploys and migration numbers stay with Matthew.** Do not run
   `wrangler deploy`, `npm run deploy` or `supabase db push`. Do not choose a
   migration number; it is written into the issue when it is promoted.
6. **Public repo.** No tokens, passwords, `.env.local` contents, private
   recordings, personal data or absolute local paths in issues, comments, commits
   or logs.
7. **DeepSeek implements bounded slices.** `model:economy` uses
   `deepseek-flash`; `model:standard` uses `deepseek-v4-pro`. Before planning,
   dispatching or repairing, read [the coding guide](../DEEPSEEK_CODING_GUIDE.md).
   A native Sol coordinator holds the claim with its real identity and an
   explicit coordination mismatch; a separate Sol execution reviews the exact
   published commit. Product implementation and fixes remain with DeepSeek.
8. **The wrapper does not replace judgment.** If it refuses, read the reason. Do
   not work around a refusal; fix its cause or ask.

## 1. One-time setup on a machine

You need **git**, **Node 24**, the **GitHub CLI (`gh`)** and a **bash** shell
(Git Bash on Windows). The commands below assume bash.

```bash
git clone https://github.com/mbelinkie/brainstorm.git
cd brainstorm
gh auth login                               # the account needs access to the repo
gh auth refresh -h github.com -s project    # Projects need the "project" scope
gh auth status                              # scopes should include repo, read:org, project
npm ci                                      # frozen-lockfile install
npm test                                    # must be green before you touch anything
node scripts/roadmap/lifecycle.mjs help     # the wrapper has no dependencies
```

The Project is **private and user-owned** (`mbelinkie`, Project #4,
https://github.com/users/mbelinkie/projects/4). Ask Matthew to add your account
to the repo and the Project if `gh project list --owner mbelinkie` fails.

Files that are *not* in git and are not yours to copy around: `.env.local`
(deploy secrets; never read or print it) and `.dev.vars` (Worker dev secrets).
Ask Matthew if you need local Worker secrets.

Read, in this order: `CLAUDE.md`, `docs/PROJECT_OPERATING_PLAYBOOK.md`,
`docs/roadmap/config.json`, `docs/roadmap/routing.md`,
`scripts/roadmap/README.md`, and the goal issue
[#10](https://github.com/mbelinkie/brainstorm/issues/10) (the Prompt Battle MVP
map). Read `PRODUCT_SPEC.md` and `mistakes.md` before changing behaviour.

## 2. Find and plan an eligible ticket

The read-only planner scans the fixed Prompt Battle issue range (#13–44),
checks Project priority and status, dependencies and claims, and reports at most
one already-Ready ticket:

```bash
node tools/codex-batch.mjs --dry-run
```

The planner uses the shared gate, lifecycle `inspect`, and
`ready(..., { dryRun: true })`. It never changes a Project field, claims an
issue, launches a worker, accesses a model-provider balance, publishes, merges
or completes work. Only `--dry-run` and `--help` are supported;
`--sole-dispatcher`, `--resume` and issue-scope overrides are refused before
GitHub access.

Issues are ordered P0 through P3, then by number. Missing issues, incomplete
Project pagination or incomplete claim comments stop the scan. Unknown Scope
or authorization on one issue skips that ticket while allowing unrelated
work to proceed. A candidate needs `Owner decisions: None`.
A migration is eligible only with one concrete number using one of the complete
field values `Assigned by Matthew: migration #NNNN`, `Matthew assigned
migration NNNN`, or `Migration NNNN assigned by Matthew`; anything else,
including `0037+`, multiple numbers, negative text or provisional wording, is
not an assignment. External issues are always excluded. Producer work may be
selected, but it cannot merge until Matthew accepts the reviewed commit.

The planner selects only work already marked Ready. Its `promotionCandidates`
list reports eligible Backlog or Blocked work even when a Ready ticket is also
selected. Those candidates still need Matthew to promote them with the
lifecycle wrapper; a null `selected` with nonempty promotions does not mean
there is no eligible work. The planner never promotes automatically. Before
starting, re-read the selected issue and its gates:

```bash
node scripts/roadmap/lifecycle.mjs inspect N
node scripts/roadmap/lifecycle.mjs ready N --dry-run
```

Both commands are read-only. A passing Ready check looks like:

```text
OK {"ok":true,"op":"ready","dryRun":true,"wouldSet":"Ready","changed":false,"status":"Ready"}
```

A failing run names each reason and exits 1:

```text
REFUSED NOT_READY: #19 is not ready: PREREQ_NOT_CLOSED, PREREQ_NOT_DONE, PREREQ_NO_ACCEPTANCE
  - PREREQ_NOT_DONE: ...#13 is open but is not Done on Project mbelinkie/4 (status: Backlog)
```

Matthew decides what becomes Ready and who works it. Do not start a ticket
unless it is Ready and Matthew has assigned it to you. Do not run
`ready N` without `--dry-run` unless Matthew explicitly asks you to promote
that ticket.

## 3. Prepare your branch and worktree (no work yet)

Always branch from a verified `origin/main` commit, never from another feature
branch, and never commit to `main`. Do this *before* claiming, because the claim
records the branch, the starting commit and the worktree.

```bash
git fetch origin
git worktree list                        # confirm you are not about to use someone's checkout
git worktree add ../quiz-<short-name> -b codex/<short-name> origin/main
cd ../quiz-<short-name>
npm ci                                   # every worktree gets its own install
git status --short --branch              # report this; it should be clean
git stash list                           # should be empty
```

- Use `codex/<short-name>` for Codex sessions; people may use their own prefix.
- Start from `main` unless the issue's **Starting baseline** says otherwise.
- Never share `node_modules` between worktrees. Never start in a checkout that
  another session is using.

## 4. Claim it

Run this from inside your worktree. One command: under one lock it re-checks that
the ticket is still Ready, refuses if someone else holds a live claim, posts the
`claim:v1` comment, and sets the board status to In progress.

Launch one native `gpt-6.1-sol` coordinator at actual high effort. The issue
keeps its DeepSeek coding label; the `coordinator` config profile allows the
real claim holder’s model without relabeling it as an implementer. This written
coordination mismatch is already authorized by Matthew’s routing instruction:

```bash
node scripts/roadmap/lifecycle.mjs claim N \
  --execution-id "$CODEX_THREAD_ID" \
  --branch codex/<short-name> \
  --start-commit "$(git rev-parse origin/main)" \
  --model gpt-6.1-sol \
  --effort medium \
  --effective-effort high \
  --allow-mismatch "Sol coordinates; DeepSeek implements all slices" \
  --worktree ../quiz-<short-name>
```

- The ID must be this native coordinator’s own `CODEX_THREAD_ID`. Keep the
  wrapper’s identity checks. A conflicting inherited `CODEX_SESSION_ID` may be
  removed only while retaining the genuine child thread ID, as in the verified
  rehearsal below. A plain terminal has no native claim identity; start the
  coordinator through Codex’s native controls. Never fabricate or manually set
  a worker ID. DeepSeek API request IDs are recorded as provider evidence only.
- This claim records Sol’s actual effort, not the issue’s DeepSeek effort.
  DeepSeek logical `low`/`medium`/`high` maps to effective `low`/`high`/`high`;
  record both values in slice evidence. `model:coordinator` is an execution-role
  allowlist, never a product-issue label. Sol may design, test, document and
  orchestrate, but never substitute product implementation or review fixes.
- Worktree names are public relative names, never absolute private paths.
- Repeating a claim with the same ID reconciles a partial write. `CLAIM_HELD`
  means preserve both checkouts and stand down; never remove an ambiguous or
  occupied worktree. Report the holder and await reconciliation.

### DeepSeek batch limits and handoff

A batch starts only on Matthew’s explicit start instruction. This policy change
is preparation, not a start instruction. At restart record a fresh start time,
an eight-hour deadline, the sole dispatcher and the actual USD balance from
DeepSeek’s `/user/balance`. Do not reuse an expired prior deadline. One DeepSeek
session at a time; remote workers receive explicit ticket assignments from the
same dispatcher. A model request runs only after its slice contract is ready.

Use the official artifact-only API harness described in the coding guide.
Load the saved key privately in the parent request wrapper; do not print it,
place it in a prompt or expose it to tools. Verify `/models`, the requested and
returned model, thinking mode and mapped effort. Preserve Sol’s Codex settings.
The prior CLI profile is not evidence that tool permissions or recovery work.

Check actual USD balance before and after every session, including failed
responses and repairs. Stop launching at $10 observed spend since the fresh
batch baseline; the last session may exceed it. Billing can lag and has cent
precision: report observed balances and retain usage metadata, never call a
zero observed change free. Missing, inconsistent or unreliable spending data
pauses dispatch. Codex coordination and review consume separate allowance.
Keep private provider responses and checkpoints outside the public repository.

The authorized batch permits ordinary scoped edits, checks, explicit-path
commits, pushes, PR creation, lifecycle records and accepted Automated merges
without per-operation approval. Publish each completed ticket’s branch and PR
before the next ticket. Git operations preserve unrelated work; deployments,
real provider/production-room actions and migration application remain with
Matthew. Producer tickets still wait for his exact-artifact acceptance;
External tickets require authorized real-environment evidence.

Prepare ordered behavior slices from actual source/callers, with exact write
scope, input/output contracts, pseudocode where useful, and Sol-owned acceptance
checks. Use a fresh packet per slice and preserve accepted code plus short
handoff. Prefer pure logic, transformations and explicitly requested skeletons;
a skeleton alone does not complete a behavior ticket. Only allowlisted artifacts
are applied. Run acceptance and relevant regressions after each slice, then
verify the combined ticket. DeepSeek’s own tests do not replace Sol’s assertions.

Allow one localized repair with observed failure and unchanged contract. If it
fails, behavior/design expands or a critical invariant breaks, stop and reduce
or block the slice. After two evidence-based attempts without progress, record
the blocker and continue only with unrelated eligible work. Preserve and publish
safe partial commits clearly marked incomplete, with no issue-closing keywords.
Sol does not code the fix and there is no Luna/OpenAI fallback. A Flash-to-Pro
change needs a recorded routing decision, not a silent replacement. Packet or
output-limit failures require a smaller packet and retained failed-call cost.

If interrupted, re-read live issue/claim/review, Git status, published branch and
PR heads before any write. Preserve older live Luna claims. A new coordinator
must not impersonate the old holder: only lifecycle release with confirmed
stopped-execution evidence permits a replacement claim. Age and a local
checkpoint alone are insufficient. Re-read after uncertain mutations before
replaying; compare stable markers to avoid duplicate claims/completions.

Publish and verify the full 40-character commit SHA. A fresh independent Sol
execution uses a clean detached checkout, runs `npm ci` and `npm test`, exercises
the slice/ticket acceptance checks and records verification with its own native
ID. Any revised head needs renewed verification. Send localized findings back
to DeepSeek within the repair budget. The claimant records lifecycle review,
distinguishing implementation evidence from checks it actually ran.

For Automated acceptance the dispatcher merges with a merge commit or
fast-forward preserving the verified SHA (no squash or rebase), tests integrated
`main`, then calls lifecycle complete. Producer acceptance remains with Matthew;
External work remains excluded by the read-only planner. Keep one dispatcher,
no recurring schedule or distributed scheduler. Matthew keeps the Mac awake.

### Verified rehearsal lessons (2026-10-01)

The native route completed [#51](https://github.com/mbelinkie/brainstorm/issues/51)
through [PR #52](https://github.com/mbelinkie/brainstorm/pull/52). Sol verified
`5941527a57299c746ff65af9806b4aac321a9d01`; merge commit
`bc1d37421bc37769f05aec2ee59788b8761fe397` preserved it. All 554 tests passed
in Sol's clean checkout and on integrated main. Repeating `complete` returned
`alreadyCompleted`; `stale` confirmed Closed/Done, no live claim or discrepancy.

- **Native identity:** a child can have its own `CODEX_THREAD_ID` while inheriting
  the parent's different `CODEX_SESSION_ID`. For lifecycle calls in that child,
  use `env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs ...`, retaining
  its actual thread ID. An ambiguous identity must stop consequential actions.
  Sol found a self-release bypass missed by the suite; Luna reproduced it with
  a failing regression and fixed it before renewed verification.
- **Live decisions:** Ready status does not resolve an explicitly pending choice.
  Conversely, an affirmative owner decision can be complete but use wording the
  strict planner rejects. Preserve the original evidence while normalizing the
  boundary field, for example `Migrations: Assigned by Matthew: 0037` or
  `Owner decisions: None.` with a separate `Resolved owner decision:` line.
  Here `None` means no outstanding choice. Normalization never assigns a number
  or decides a value. Re-read newly promoted tickets; the planner scans #13–44.
- **Recovery notes:** privately retain the deadline, dispatcher-lock owner,
  issue/agent identity, branch, published SHA, verifier SHA and lifecycle phase.
  Compare them with fresh GitHub/git evidence before the next write. Resume the
  claim holder to record its own review; the dispatcher cannot impersonate it.
- **Waiting:** native agents use `collaboration.wait_agent`. `functions.wait`
  accepts only a running exec cell ID, never an agent name or an invented ID.
- **Handoffs:** confirm native spawn/resume/wait controls remain available after
  a model or tool handoff. A completed child turn can still have an app-owned
  thread writer: a CLI resume of #42 was refused with `already has an active
  writer`. Preserve the claim and published work; resume through the owning
  native controls rather than replacing its identity or removing writer locks.
- **Evidence limits:** the Cloudflare Workers Builds check failed on both the
  starting baseline and integrated main. Passing repository tests established
  setup correctness; deployment success remained unproven and outside scope.

## 5. Do the work

- **Read the contract again** and keep to its Scope and Exclusions. Anything
  outside it is a new issue, not a bonus.
- **Test first.** Add or extend a test in `test/` that fails before and passes
  after. Tests are `node:test`, run by `npm test`. Never call live services
  (Supabase production, Sentry, Gemini, GitHub) in a test; use fixtures and fakes.
- **Run `npm test`** and keep the real output. Never write "should pass".
- **Match the file's style.** No repo-wide formatting, no renames, no drive-by
  refactors. Put new logic in the extracted modules, not deeper into `app.js` or
  `author.js`.
- **Stage explicit paths only.** Never `git add -A` or `git add .`. Check
  `git show --stat HEAD` after every commit.
- **Commits:** small and single-purpose with a `feat:` / `fix:` / `chore:` /
  `docs:` prefix. Identify the model that did the work (for example
  `Model: DeepSeek Flash (deepseek-flash)`); never attribute work to Claude you did not
  run through Claude.
- **Work log:** append an entry to `docs/CLAUDE_WORKLOG.md` for every session:
  date, branch, files touched, the slice, the commands you really ran, and what
  remains unproven. Add a `CHANGELOG.md` line only for completed, user-visible,
  verified work.
- **Talking to GitHub from code:** only through `scripts/roadmap/gate.mjs`. Do
  not call `gh` or the GitHub API directly from scripts or ad hoc commands;
  `test/roadmap-bypass.test.js` checks repository-owned scripts. Use `createGate`
  and `createGhTransport` for PR/issue reads and writes too.
  `node scripts/roadmap/probe.mjs` shows the budget; use it sparingly.
- **Migrations:** one new, ordered file in `supabase/migrations/` with the number
  Matthew assigned. Never edit or renumber an applied migration. Do not apply it
  yourself.
- **Stuck?** After **two** evidence-based attempts without progress, stop. Write
  down the confirmed facts and a focused reproduction. Record the blocker via
  lifecycle, preserve safe partial work, and continue only unrelated eligible
  tickets within the batch limits; DeepSeek owns any further approved fixes.

### Product rules that must not regress

Scoring is decided on the server, never in the browser. Players never receive
future state (upcoming questions, answers, other players' images). Presentation
is a strict projection of state. Cross-client commands carry exact IDs. Client
success is never implied before the server confirms. Score events are
append-only. Old quizzes still load. Details: `CLAUDE.md`.

## 6. Report as you go

### Blocked

```bash
node scripts/roadmap/lifecycle.mjs block N \
  --cause "what is stopping you" --needs "the decision or evidence needed, and from whom"
```

This posts a `block:v1` comment and sets Blocked. Scope and priority stay
untouched. To propose a routing change (for example moving to a cheaper model)
add
`--routing-change <label> --attempted-checks ... --failure ... --remaining-risk ...
--next-scope ...` (all required).
The wrapper only records the proposal; **the owner changes the labels.**

Found a new problem? File a new issue (search open **and closed** issues for
duplicates first) rather than widening this one.

### Ready for review

Commit, run `npm test`, push your branch (a person pushes as normal; a Codex
session pushes only when asked), then:

```bash
node scripts/roadmap/lifecycle.mjs review N \
  --execution-id "$CODEX_THREAD_ID" \
  --commit "$(git rev-parse HEAD)" \
  --commands "npm test: <N> pass, 0 fail; <other commands you ran>" \
  --exclusions "what you deliberately did not do" \
  --outstanding "the acceptance steps still waiting on someone" \
  --branch codex/<short-name>
```

Only the execution holding the live claim can record a review. An **External**
issue also needs `--external-evidence "<the real-environment evidence>"`. This
posts the `review:v1` comment and sets In review. Then **stop**. Do not close the
issue, do not mark it Done, and do not merge.

### Independent check (Automated issues)

An Automated issue is not accepted on the implementer's own report. A **different**
execution (its own `CODEX_THREAD_ID`) re-runs the checks on the tested
commit and records it:

```bash
node scripts/roadmap/lifecycle.mjs verify N \
  --execution-id "$CODEX_THREAD_ID" --commit <tested-sha> \
  --checks "what you ran and what you saw"
```

Alternatively the owner accepts in writing (below).

### Who accepts what

| Class | What permits completion |
| --- | --- |
| **Automated** | A `verify` record from an execution other than the implementer for the reviewed commit, or the owner's acceptance. |
| **External** | Excluded by the planner. Dispatch requires Matthew's authorization and real evidence from the actual application, service or environment, recorded with the review. A simulation is not enough. |
| **Producer** | The owner's explicit acceptance, posted after the review, naming the full tested commit SHA. |

## 7. Completion and recovery (owner or dispatcher only)

When the right person has accepted:

1. **Merge through a PR** (or fast-forward) so the tested commit is on `main`.
   Do **not** write `Closes #N`: the wrapper's `complete` is the only code that
   closes roadmap issues.
2. Run `npm test` on `main` itself.
3. Complete it:

   ```bash
   node scripts/roadmap/lifecycle.mjs complete N
   ```

   (If the work was accepted onto a special branch, name it in the issue's
   **Starting baseline** first and pass `--special-branch <name>`, so dependents
   cannot start from a baseline that is missing it.) `complete` checks the class's
   acceptance, checks via GitHub that the commit is reachable from `main`, then
   writes the `complete:v1` comment, sets Done and closes the issue together, and
   re-reads to confirm. A half-finished completion is reconciled on re-run, never
   replayed.

Dependents become Ready-able only when the prerequisite is closed, Done on the
board, and carries that owner `complete:v1` record.

**A stuck or abandoned claim.** `stale N` is read-only: it compares the issue, the
board and the claim records and reports discrepancies. Age alone is never proof
that a run stopped. `release N` returns a claim to Ready only with recorded
evidence:

```bash
node scripts/roadmap/lifecycle.mjs release N \
  --stopped-execution <id> --confirmed-by <name> --evidence "how you know it stopped"
```

Merge one branch at a time. `CHANGELOG.md` and `docs/CLAUDE_WORKLOG.md` are
append-only shared files: resolve conflicts as a union, in date order, never by
dropping the other side's entries. Delete merged branches with `git branch -d`
(never `-D`).

## 8. Things that will bite you

- **Shared checkout.** Two sessions in one folder switch each other's branches.
  Use a worktree per ticket and check `git worktree list` first.
- **Closed is not Done.** A dependency counts only when it is closed, Done on the
  board, and has the owner's completion record.
- **The owner's acceptance is a comment from the owner's account.** Anything that
  can post as that account can type it, which is why a bare self-report is never
  accepted as verification.
- **Stale baseline.** Deploys ship the working directory, not a git ref. Another
  reason deploys stay with Matthew.
- **Hidden work.** `git status` alone does not prove a tree is clean. Also check
  `git stash list` and untracked files.
- **Same GitHub account on two machines** shares one API quota. Do not run loops
  or bulk edits. The wrapper's lock covers one host only.
- **Local dev uses the production Supabase project.** A real-room test writes real
  rows. Ask Matthew before running one.
- **Exit codes:** `0` done, `1` refused (the code and reason are printed), `2` bad
  usage. Add `--json` for machine-readable output.

## 9. Starter prompt for a Codex dispatcher

Launch from the repository or worktree root so `CLAUDE.md` loads. Resolve live
claims and pending decisions before new dispatch; the planner only proposes
already-Ready work. Use this after Matthew explicitly starts the batch:

```text
Run the authorized Brainstorm batch under docs/roadmap/WORKING_A_TICKET.md,
docs/roadmap/routing.md and docs/DEEPSEEK_CODING_GUIDE.md. Reconcile live
GitHub/Project/Git records first, including paused claims and published PRs.
Record a fresh eight-hour deadline, sole dispatcher and DeepSeek USD baseline.
Select Ready tickets by priority/dependencies, preserving acceptance and owner
migration numbers. Use Flash for model:economy and Pro for model:standard;
verify actual provider/model, enable thinking, and map low/medium/high to
low/high/high. One DeepSeek session at a time, using fresh bounded packets
and the artifact-only API; enforce allowlisted writes and private credentials.
A genuine native high-effort Sol coordinator holds each lifecycle claim with
an explicit coordination mismatch; DeepSeek implements all product code and
fixes. Publish each completed ticket branch and PR. Independent Sol verifies
the exact published SHA in a clean checkout. Merge passing Automated tickets
preserving that SHA, test integrated main and lifecycle-complete. Producer and
External gates remain intact. Allow one localized repair; block stalled work
and preserve safe partial commits. Stop new sessions at the $10 observed USD
spend threshold or deadline, or when spending/dispatch authority is unknown.
No implementation fallback, deployments, migration application or real-room
writes. Do not start from this prompt without Matthew’s start instruction.
```

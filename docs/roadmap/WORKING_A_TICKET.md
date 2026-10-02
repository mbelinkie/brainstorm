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
7. **DeepSeek implements; a harness dispatches; Codex decides.** DeepSeek
   implements every product slice and fix through the delegation harness.
   A Luna Controller (or Sol, for Protected tickets) holds the claim. A
   separate Luna execution verifies the final published commit. Each session
   reads only its [role card](../delegation/cards/). The process is
   [the delegation process](../DELEGATION.md); models are in [routing](routing.md).
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

The claim is made by the role session the harness launches, never by the
harness itself and never by a plain terminal. One command, under one lock,
re-checks that the ticket is still Ready, refuses if someone else holds a live
claim, posts the `claim:v1` comment, and sets the board status to In progress.
The exact commands are pre-filled in the role cards:

- **Express and Standard lanes:** the Luna Controller claims
  ([controller card](../delegation/cards/controller.md)).
- **Protected lane:** Sol claims ([Sol card](../delegation/cards/sol.md)).

Both use a written `--allow-mismatch` reason, because the issue keeps its
DeepSeek coding label while a Codex model holds the claim. Matthew's routing
instruction authorizes that coordination mismatch ([routing](routing.md)).

- **Use your own ID.** It must be this native session's own `CODEX_THREAD_ID`.
  Keep the wrapper's identity checks. A spawned child may inherit its parent's
  different `CODEX_SESSION_ID`; run lifecycle commands with
  `env -u CODEX_SESSION_ID` while retaining the genuine thread ID. Never
  fabricate or manually set an ID. DeepSeek API request IDs are provider
  evidence only.
- **Record the effort the session actually ran at.** The claim records the
  holder's real effort, not the issue's DeepSeek effort. Record both values in
  slice evidence. `model:controller` and `model:coordinator` are execution-role
  allowlists, never product-issue labels.
- **Worktree names** are public relative names, never absolute private paths.
- **Repeating a claim** with the same ID reconciles a partial write.
- **`CLAIM_HELD`** means preserve both checkouts and stand down. Never remove an
  ambiguous or occupied worktree. Report the holder and wait for
  reconciliation.

### Batches

**How a batch runs.** Batches run through the delegation harness
(`node tools/delegate/run.mjs`, [spec](../delegation/HARNESS_SPEC.md)) and
start only on Matthew's explicit instruction. The harness is the dispatcher.
No Codex conversation orchestrates, waits on or polls other sessions. The
pipeline, lanes, the fit gate (design and research tickets are flagged, not
worked), budgets, multi-account rules and evidence are defined in
[the delegation process](../DELEGATION.md).

**Before the harness exists.** Until its minimum version (spec §9, steps 1–6)
is built and reviewed by Sol, no new product batch starts.

**Tickets claimed before October 2, 2026** finish under the October 1 batch
rules, preserved in [the October 1 version of this file](https://github.com/mbelinkie/brainstorm/blob/2198c09/docs/roadmap/WORKING_A_TICKET.md#deepseek-batch-limits-and-handoff).
That includes the paused batch's open PRs.

**Recovery.** If interrupted, re-read live issue, claim and review state, Git
status, and published branch and PR heads before any write. Then run
`node tools/delegate/run.mjs resume`. A new session must not impersonate an old
claim holder: only lifecycle `release`, with confirmed stopped-execution
evidence, permits a replacement claim. Native-session lessons from the
October 1 rehearsal are in [LESSONS.md](LESSONS.md).

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
- **Stuck?** The harness's repair ladder and one Controller REPAIR are the
  whole retry budget. After that, the ticket is escalated or reclaimed: record
  the blocker via lifecycle, preserve safe partial work, and continue only
  with unrelated eligible tickets within the batch limits. DeepSeek owns any
  further approved fixes.

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

## 9. Starting a batch

Batches are started by Matthew running the harness, not by prompting a
dispatcher conversation:

```bash
node tools/delegate/run.mjs start --deadline 8h --usd 10
node tools/delegate/run.mjs run          # loops until done, deadline, budget or stop file
node tools/delegate/run.mjs status       # one-page state; what a resumed session reads
```

The harness launches each role session with its card and a small input file.
No session should be given this guide, the playbook or the worklog to read
during a batch.

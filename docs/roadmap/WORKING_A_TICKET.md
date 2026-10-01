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
7. **Routing uses native Luna subagents.** Both `model:standard` and
   `model:economy` mean `gpt-6-luna`. Logical `low`/`medium`/`high` effort maps
   to effective `medium`/`high`/`max`. The independent reviewer uses
   `gpt-6.1-sol` and checks the change without taking over coding. Historical
   Claude and DeepSeek claims remain readable; unsupported models are refused
   for new claims, including with `--allow-mismatch` (`docs/roadmap/routing.md`).
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

## 2. Find an eligible ticket

List what is Ready, lowest priority number first (P0, then P1):

```bash
gh project item-list 4 --owner mbelinkie --limit 200 --format json \
  -q '.items[]|select(.status=="Ready")|"#\(.content.number)\t\(.priority)\t\(.size)\t\(.title)"'
```

Use `--limit 200`; the default is too small. If nothing is Ready, stop and ask
Matthew. Do not pick from Backlog.

Then ask the wrapper, for ticket `N`. Both commands are read-only:

```bash
node scripts/roadmap/lifecycle.mjs inspect N
node scripts/roadmap/lifecycle.mjs ready N --dry-run
```

`inspect` prints the routing labels, declared and native dependencies, claims on
record (and whether one is live), the baseline commit, and any blockers.
`ready --dry-run` runs every Ready gate without writing. A passing run looks like:

```text
OK {"ok":true,"op":"ready","dryRun":true,"wouldSet":"Ready","changed":true,"status":"Backlog"}
```

A failing run names each reason and exits 1:

```text
REFUSED NOT_READY: #19 is not ready: PREREQ_NOT_CLOSED, PREREQ_NOT_DONE, PREREQ_NO_ACCEPTANCE
  - PREREQ_NOT_DONE: ...#13 is open but is not Done on Project mbelinkie/4 (status: Backlog)
```

The gates, and what the codes mean:

| Gate | Passes when |
| --- | --- |
| Contract | all 9 sections present (Outcome, Scope, Exclusions, Dependencies, Acceptance, Verification, Boundaries and authorization, Starting baseline, Routing and size rationale), no placeholders |
| Routing | exactly one `model:` and exactly one `effort:` label, and a supported pairing |
| Acceptance | one class (Automated, External or Producer) and the board's Acceptance field agrees with the issue |
| Dependencies | the `Blocked by` lines in the body and GitHub's native links name the same set (`DEPENDENCY_MISMATCH` otherwise) |
| Prerequisites | each one is **closed**, **Done on the board**, and has a recorded owner acceptance (`PREREQ_NOT_CLOSED`, `PREREQ_NOT_DONE`, `PREREQ_NO_ACCEPTANCE`). Closed alone is not enough. |
| Data | nothing truncated or stale; missing data fails closed (`STALE_READ`, `CLAIM_HISTORY_INCOMPLETE`) |

Also check by eye: if the ticket adds a migration, its number is written in the
issue (assigned by Matthew); and any existing live claim is Matthew's to clear
(section 7).

Promoting a ticket to Ready is the dispatcher's step:
`node scripts/roadmap/lifecycle.mjs ready N` (without `--dry-run`). Do not run it
on tickets you were not given.

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

```bash
node scripts/roadmap/lifecycle.mjs claim N \
  --execution-id "$CODEX_THREAD_ID" \
  --branch codex/<short-name> \
  --start-commit "$(git rev-parse --short origin/main)" \
  --model gpt-6-luna \
  --effort high \
  --effective-effort max \
  --worktree ../quiz-<short-name>
```

- **The execution ID must be this run's own.** It has to equal the runner's
  `CODEX_THREAD_ID` (a UUID; its `CODEX_SESSION_ID` only counts when it equals the
  thread id), or the legacy `CLAUDE_CODE_SESSION_ID` when no Codex id is set. It
  must not equal a parent-session ID. A conflicting or ambiguous environment is
  refused. It is never guessed, and the orchestrator never forges it for a worker.
- **A person at a plain terminal has no such variable**, and the claim is refused:
  `REFUSED EXECUTION_ID_MISSING: no CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID is
  set`. The supported route is to do the work through a Codex session that
  launches the native Luna subagent. Ask Matthew before setting the variable by
  hand: it would satisfy the check, but it is self-asserted.
- **The run must match the labels.** `--model` must be the ID of the issue's
  `model:` profile (`model:standard` and `model:economy` both use `gpt-6-luna`)
  and `--effort` its `effort:` level, or you get `ROUTING_MISMATCH`.
  `--effective-effort` states the runner's real effort (`low` maps to `medium`,
  `medium` to `high`, `high` to `max`); it is validated and recorded separately.
  `--allow-mismatch "<reason>"` records a deliberate difference; ask first.
- `--worktree` takes a name like `../quiz-x`, **never an absolute path** (the
  repo is public).
- Claiming again with the same ID is safe: it reconciles a half-finished claim
  instead of posting a second comment.

If the claim is refused with `CLAIM_HELD`, someone else holds it. **Stand down**:
remove your worktree (`git worktree remove ../quiz-<short-name>`), delete your
unused branch, and tell Matthew. Do not try to override it.

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
  `Model: GPT-6 Luna (gpt-6-luna)`); never attribute work to Claude you did not
  run through Claude.
- **Work log:** append an entry to `docs/CLAUDE_WORKLOG.md` for every session:
  date, branch, files touched, the slice, the commands you really ran, and what
  remains unproven. Add a `CHANGELOG.md` line only for completed, user-visible,
  verified work.
- **Talking to GitHub from code:** only through `scripts/roadmap/gate.mjs`. Do
  not call `gh` or the GitHub API from a script; `test/roadmap-bypass.test.js`
  will fail. Typing `gh` yourself is fine, but it shares the same quota (about
  5,000 GraphQL points an hour per account), so avoid loops.
  `node scripts/roadmap/probe.mjs` shows the budget; use it sparingly.
- **Migrations:** one new, ordered file in `supabase/migrations/` with the number
  Matthew assigned. Never edit or renumber an applied migration. Do not apply it
  yourself.
- **Stuck?** After **two** evidence-based attempts without progress, stop. Write
  down the confirmed facts and a focused reproduction and ask. If a Luna
  subagent cannot get a required check green, record the failing checks and the
  smallest next scope and ask Matthew; there is no Opus escalation in the
  current workflow.

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
| **External** | Real evidence from the actual application, service or environment, recorded with the review. A simulation is not enough. |
| **Producer** | The owner's explicit acceptance, posted after the review, naming the tested commit. |

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

## 9. Starter prompt for a Codex session

Launch it from the repository (or worktree) root so `CLAUDE.md` loads.

```text
You are working on the Brainstorm quiz platform. Work GitHub issue #<N> in
mbelinkie/brainstorm exactly as docs/roadmap/WORKING_A_TICKET.md describes: read
CLAUDE.md, the playbook and that file first; run `node scripts/roadmap/lifecycle.mjs
inspect <N>` and `ready <N> --dry-run` and report the result; create your own
worktree and branch from origin/main; claim with `lifecycle.mjs claim` (your own
CODEX_THREAD_ID; model and effort must match the labels); work test-first
inside the issue's scope; log your work; record `lifecycle.mjs review` with real
evidence; and STOP at In review. Never merge, close, run `complete`, deploy, push
to main, or choose a migration number. Routing is native Luna subagents (see
routing.md). After two evidence-based failed attempts, stop and ask. Do not
hand-write claim/review/block comments or edit board statuses; use the wrapper.
```

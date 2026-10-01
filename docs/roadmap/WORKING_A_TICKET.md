# Working a ticket: instructions for a new machine

For anyone (a person, or a Claude Code session) picking up work on the Brainstorm
quiz platform from a machine that has access to `mbelinkie/brainstorm`. It covers
finding a ticket you may work, claiming it, doing the work, reporting it, and
stopping at the right place.

The rules behind it live in `docs/PROJECT_OPERATING_PLAYBOOK.md`. This file is the
practical, copy-and-run version, written for what exists **today**. The lifecycle
wrapper that will automate the gates (#3, #45) is not built yet, so several steps
below are manual on purpose. When that wrapper lands, this file should be
shortened to point at it.

## 0. Ground rules (read these first)

1. **The GitHub issue and the Project board are the truth.** Not a chat, not a
   summary, not memory. Re-read the live issue before every transition.
2. **One issue, one claim, one branch, one worktree.** Never work two tickets in
   one checkout, and never work in a checkout another session is using.
3. **One dispatcher for now.** Matthew decides what becomes **Ready** and who
   works it. Claims are a comment plus a re-read, which is *not* atomic, and the
   host-local lock does not span machines. If two people take the same ticket,
   the earliest claim comment wins (section 3).
4. **You may only start a ticket that is Ready** (or that Matthew has told you to
   start). Do not promote tickets yourself unless you are the dispatcher.
5. **You stop at In review.** Acceptance, merging, closing and Done belong to the
   owner or the dispatcher, never to the agent that did the work.
6. **Deploys and migration numbers stay with Matthew.** Do not run
   `wrangler deploy`, `npm run deploy` or `supabase db push`. Do not choose a
   migration number; it is assigned when the ticket is promoted.
7. **Public repo.** No tokens, passwords, `.env.local` contents, private
   recordings or personal data in issues, comments, commits or logs.
8. **Sonnet 5.5 is the model ceiling.** `model:standard` means Sonnet 5.5,
   `model:economy` means Haiku 4.5. Opus is used only on one issue, only after
   Sonnet has failed, only with the `escalation:opus` label and Matthew's
   go-ahead (`docs/roadmap/routing.md`).

## 1. One-time setup on a machine

You need **git**, **Node 24**, the **GitHub CLI (`gh`)** and a **bash** shell
(Git Bash on Windows). The commands below assume bash.

```bash
git clone https://github.com/mbelinkie/brainstorm.git
cd brainstorm
gh auth login                        # account must have access to the repo
gh auth refresh -h github.com -s project   # Projects need the "project" scope
gh auth status                       # confirm scopes include repo, read:org, project
npm ci                               # frozen-lockfile install
npm test                             # should be all green before you touch anything
```

The Project is **private and user-owned** (`mbelinkie`, Project #4). Ask Matthew
to add your account to the repo and the Project if `gh project list --owner
mbelinkie` fails.

Files that are *not* in git and are not yours to copy around: `.env.local`
(deploy secrets; never read or print it) and `.dev.vars` (Worker dev secrets).
Ask Matthew if you need local Worker secrets.

Read, in this order: `CLAUDE.md`, `docs/PROJECT_OPERATING_PLAYBOOK.md`,
`docs/roadmap/config.json`, `docs/roadmap/routing.md`,
`scripts/roadmap/README.md`, and the goal issue
[#10](https://github.com/mbelinkie/brainstorm/issues/10) (the Prompt Battle MVP map).
Also read `PRODUCT_SPEC.md` and `mistakes.md` before changing behaviour.

## 2. Find an eligible ticket

The board: https://github.com/users/mbelinkie/projects/4

List what is Ready, with priority and size:

```bash
gh project item-list 4 --owner mbelinkie --limit 200 --format json \
  -q '.items[]|select(.status=="Ready")|"#\(.content.number)\t\(.priority)\t\(.size)\t\(.title)"'
```

(Use `--limit 200`; the default is too small.) Lower `P` numbers come first
(P0, then P1). If nothing is Ready, stop and ask Matthew; do not pick from
Backlog.

### Eligibility checklist (check live, every time)

Run these for ticket `N`. **All must pass.**

```bash
N=12   # the ticket number

# 1. Open, correctly labelled, and what the contract says
gh issue view $N --repo mbelinkie/brainstorm --json state,title,labels,assignees \
  -q '{state,title,labels:[.labels[].name],assignees:[.assignees[].login]}'

# 2. Board status and fields
gh project item-list 4 --owner mbelinkie --limit 200 --format json \
  -q ".items[]|select(.content.number==$N)|{status,priority,size,acceptance,workstream}"

# 3. Blockers: every one must be CLOSED/COMPLETED *and* Done on the board
gh api graphql -F n=$N -f query='query($n:Int!){repository(owner:"mbelinkie",name:"brainstorm"){issue(number:$n){blockedBy(first:20){totalCount nodes{number state stateReason}}}}}' \
  -q '.data.repository.issue.blockedBy'

# 4. Is it already claimed? (look for claim comments, oldest first)
gh issue view $N --repo mbelinkie/brainstorm --json comments \
  -q '.comments[]|select(.body|contains("claim:v1"))|{at:.createdAt,by:.author.login}'
```

| Check | Must be |
| --- | --- |
| State | `OPEN` |
| Board Status | `Ready` |
| Labels | **exactly one** `model:` and **exactly one** `effort:` label |
| Contract | all 9 sections present (Outcome, Scope, Exclusions, Dependencies, Acceptance, Verification, Boundaries and authorization, Starting baseline, Routing and size rationale) with no `?`/`TODO` placeholders |
| Dependencies | the `Blocked by #N` lines in the body match the blockers GitHub reports; every blocker is closed **and** Done on the board |
| Acceptance | one class: Automated, External or Producer |
| Claim | no existing `claim:v1` comment, or one that Matthew says is stale |
| Migration | if the ticket adds one, its number is written in the issue (assigned by Matthew) |

If anything fails, **do not start.** Post a short comment saying what is missing
(or tell Matthew) and move on. A dependency that is closed but not Done on the
board is *not* satisfied.

## 3. Claim it

Order matters: re-check, claim, then re-check that you are the earliest claimant.

**a. Set the board status.** Paste this helper into your shell (it reads the
IDs from `docs/roadmap/config.json`, so nothing is hard-coded):

```bash
set_status() {   # usage: set_status 12 "In progress"
  local cfg=docs/roadmap/config.json item
  item=$(gh project item-list 4 --owner mbelinkie --limit 200 --format json \
    -q ".items[]|select(.content.number==$1)|.id")
  [ -n "$item" ] || { echo "issue $1 is not on the board"; return 1; }
  gh project item-edit --id "$item" \
    --project-id "$(node -e "console.log(require('./$cfg').project.nodeId)")" \
    --field-id "$(node -e "console.log(require('./$cfg').fields.Status.id)")" \
    --single-select-option-id "$(node -e "console.log(require('./$cfg').fields.Status.options[process.argv[1]])" "$2")" \
    >/dev/null && sleep 1.5 && echo "#$1 -> $2"
}
```

Wait at least a second between writes to GitHub; do not loop on mutations.

**b. Post the claim comment.** Save it to a file and post it. Keep the marker on
the first line exactly; tooling will parse it.

```markdown
<!-- claim:v1 issue=N -->
**Claim** (manual; the lifecycle wrapper does not exist yet)

- Repository / issue: mbelinkie/brainstorm #N
- Execution ID: <this session's real ID, or "manual: <your name>, <machine>">
- Owner: <who is driving>
- Model / effort: <exact model ID used>; label says `model:..` / `effort:..`
- Starting commit: `origin/main` = `<short sha>`
- Working branch: `claude/<short-name>`; worktree: `../quiz-<short-name>`
- Ready gates checked live: <contract complete; labels ok; blockers 0 or all Done; acceptance class; unclaimed>

Plan: <one or two sentences>. I will not merge, push to main, or deploy.
```

```bash
gh issue comment $N --repo mbelinkie/brainstorm --body-file claim.md
set_status $N "In progress"
```

**c. Confirm you won.** Re-run the claim-comment query from section 2. If another
`claim:v1` comment was posted **before yours**, you lost: stand down, post a
one-line note on the issue, and set nothing else. If yours is earliest, proceed.

Do not set the status to In progress if the board already shows it from
someone else.

Everyone on this project may be posting as the same GitHub account, so the
comment's author does not say who claimed. The **Execution ID** line in the
claim comment is what tells two claimants apart: make it specific (session ID, or
your name plus machine), and compare it, not the author, when deciding who won.

## 4. Check it out (branch and worktree)

Always branch from a verified `origin/main` commit, never from another feature
branch, and never commit to `main`.

```bash
git fetch origin
git worktree add ../quiz-<short-name> -b claude/<short-name> origin/main
cd ../quiz-<short-name>
npm ci
git status --short --branch      # report this; it should be clean
git stash list                   # should be empty
```

- Use `claude/<short-name>` for Claude sessions; people may use their own prefix.
  The branch name should say what the ticket does.
- Start from `main` unless the issue's **Starting baseline** says otherwise.
- Give every worktree its own `npm ci`. Do not share `node_modules` between
  worktrees. Never start a session inside a checkout that another session is
  using: check `git worktree list` and `git status` first.

State, in one or two sentences, the smallest behaviour you will add and how you
will prove it.

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
  `docs:` prefix. For Claude sessions, end the body with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (use the model you
  actually ran).
- **Work log:** append an entry to `docs/CLAUDE_WORKLOG.md` for every session:
  date, branch, files touched, the slice, the commands you really ran, and what
  remains unproven. Add a `CHANGELOG.md` line only for completed, user-visible,
  verified work.
- **Talking to GitHub from code:** only through `scripts/roadmap/gate.mjs`. Do
  not call `gh` or the GitHub API from a script; `test/roadmap-bypass.test.js`
  will fail. Typing `gh` yourself in a terminal is fine, but it shares the same
  quota (about 5,000 GraphQL points an hour per account), so avoid loops.
  Check the budget with `node scripts/roadmap/probe.mjs` sparingly.
- **Migrations:** one new, ordered file in `supabase/migrations/` with the number
  Matthew assigned. Never edit or renumber an applied migration. Do not apply it
  yourself.
- **Stuck?** After **two** evidence-based attempts without progress, stop. Write
  down the confirmed facts and a focused reproduction, and ask. If Sonnet cannot
  get a required check green, record the failing checks and the smallest next
  scope and ask Matthew about a bounded Opus escalation.

### Product rules that must not regress

Scoring is decided on the server, never in the browser. Players never receive
future state (upcoming questions, answers, other players' images). Presentation
is a strict projection of state. Cross-client commands carry exact IDs. Client
success is never implied before the server confirms. Score events are
append-only. Old quizzes still load. Details: `CLAUDE.md`.

## 6. Update the ticket as you go

**Blocked** (you cannot continue):

```markdown
<!-- block:v1 issue=N -->
**Blocked.** Cause: <what>. Needed: <decision or evidence and from whom>.
Attempted: <checks run and results>. Smallest next scope: <one line>.
```

then `set_status N "Blocked"`. Do not change the ticket's scope, priority or
routing labels. A routing change needs written justification (attempted checks,
failure, remaining risk, smallest next scope) and Matthew's agreement.

**Found a new problem?** File a new issue (search open **and closed** issues for
duplicates first) rather than widening this one.

**Ready for review.** Push your branch (this is normal and expected for a
person; a Claude session pushes only when asked), then post:

```markdown
<!-- review:v1 issue=N -->
**Ready for <acceptance class> acceptance.**

- Tested commit: `<sha>` on `claude/<short-name>` (from `origin/main` `<sha>`)
- `npm test`: <N tests, N pass, 0 fail>  (paste the real tail of the output)
- Files changed and why: <list>
- Acceptance criteria, each ticked with its evidence: <list>
- Invariants preserved / judgment calls: <list>
- Migrations: <none, or file name and compatibility>
- Manual verification done: <what>; **not** done: <what>
- Not proven / limits: <honest list>
```

then `set_status N "In review"` and **stop**. Do not close the issue, do not mark
it Done, and do not merge.

### Who accepts what

| Class | What permits completion |
| --- | --- |
| **Automated** | An authorized reviewer re-runs the retained checks. Your own report is evidence, not acceptance. |
| **External** | Real evidence from the actual application, service or environment. A simulation is not enough. |
| **Producer** | Matthew's explicit acceptance of the exact artifact or version. |

## 7. Completion (owner or dispatcher only)

When the right person accepts:

1. Merge through a PR (or fast-forward), and **do not** write `Closes #N` in the
   PR body. Only this acceptance step closes roadmap issues.
2. Confirm the tested commit is reachable from `origin/main`, then run
   `npm test` on `main` itself:

   ```bash
   git fetch origin && git merge-base --is-ancestor <tested-sha> origin/main && echo reachable
   ```
3. Post a `<!-- complete:v1 issue=N -->` comment: who accepted and how, the PR,
   the commit, and the `main` test result.
4. `gh issue close N --repo mbelinkie/brainstorm --reason completed`, then
   `set_status N "Done"`. A blocked-by dependent only becomes startable once the
   issue is both closed **and** Done on the board.

Merge one branch at a time. `CHANGELOG.md` and `docs/CLAUDE_WORKLOG.md` are
append-only shared files: resolve conflicts as a union, in date order, never by
dropping the other side's entries. Delete merged branches with `git branch -d`
(never `-D`).

## 8. Things that will bite you

- **Shared checkout.** Two sessions in one folder will switch each other's
  branches. Use a worktree per ticket.
- **Stale baseline.** Deploys ship the working directory, not a git ref. Another
  reason deploys stay with Matthew.
- **Hidden work.** `git status` alone does not prove a tree is clean. Also check
  `git stash list` and untracked files.
- **Same GitHub account on two machines** shares one API quota. Do not run
  loops or bulk edits.
- **Local dev uses the production Supabase project.** A real-room test writes
  real rows. Ask Matthew before running one.
- **Closed is not Done.** A dependency counts only when it is both.

## 9. Starter prompt for a Claude Code session

Launch it from the repository (or worktree) root so `CLAUDE.md` loads.

```text
You are working on the Brainstorm quiz platform. Work GitHub issue #<N> in
mbelinkie/brainstorm exactly as docs/roadmap/WORKING_A_TICKET.md describes:
read CLAUDE.md, the playbook, and that file first; check the eligibility list
against the live issue; claim it with a claim:v1 comment; branch from origin/main
in your own worktree; test first; keep to the issue's scope; log your work; post a
review:v1 comment with real evidence; set In review; and STOP. Never merge, close,
mark Done, deploy, or choose a migration number. Never push to main. Sonnet 5.5
is the model ceiling. After two evidence-based failed attempts, stop and ask.
```

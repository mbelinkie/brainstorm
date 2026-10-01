# Claude Code operating guide — Quiz Control / Brainstorm

This repository is a **deployed, live-audience** quiz platform. Most work here is
bug fixing and small, bounded improvements on top of an existing codebase that
was largely written by another agent (ChatGPT / Codex) and by the user.

Two rules outrank everything else in this file:

1. **Preserve work you did not create.** Assume every existing file, every
   uncommitted modification, and every untracked file belongs to the user or to
   another agent's in-flight slice.
2. **Make your own work identifiable.** A reviewer must be able to tell, later
   and without asking, exactly which lines Claude changed and why. See
   [Attribution](#attribution-distinguishing-claudes-work).

## Start every session here

Before editing anything:

1. Run `git status --short --branch` and report the result in your reply. This
   tree normally carries uncommitted work in `app.js`, `author.js`, `styles.css`,
   the question bank, and the tests. That is the user's own working state, it is
   current, and it is safe to build on. **Do not stage, revert, reformat, or
   "clean up" any of it,** and do not commit it as a side effect of your own
   commit — stage only the files your task actually changed.
2. If a dirty file looks like another agent's in-flight slice rather than the
   user's own edits, ask before editing it.
3. Read `PRODUCT_SPEC.md` before changing behavior, data model, question
   formats, scoring, or media handling. It is the authoritative product
   description.
4. Read `mistakes.md`. It is the engineering memory of this project and it
   already documents the failure modes most likely to bite you again.
5. Read `RUNBOOK.md` before running anything locally, and `DEPLOYMENT.md` before
   touching migrations or deploy scripts.
6. Read `HANDOFF.md` for what is in flight, then `CHANGELOG.md`'s most recent
   entries for current status. Prefer live
   files, Git history, and the user's latest instruction over any summary.
7. Inspect the actual implementation, the relevant migration(s), and the
   relevant tests before proposing a change.

Then state, in one or two sentences, the smallest user-visible behavior your
change will fix or add, and how you will prove it.

## Roadmap work (GitHub Project)

Before creating, promoting, claiming, reviewing, or completing roadmap work,
read `docs/PROJECT_OPERATING_PLAYBOOK.md`, `docs/roadmap/config.json` and
`docs/roadmap/routing.md`. The live board is the "Brainstorm Roadmap" Project
(user project #4). Preserve explicit dependencies, bounded scope, exact routing
(Sonnet 5.5 is the model ceiling; Opus only via a recorded `escalation:opus`),
acceptance class, and private-data boundaries. The lifecycle wrapper and API
budget gate are not built yet (issues #3 and #4), so apply those gates by hand
and report missing capabilities or conflicting evidence instead of bypassing
them.

## Attribution: distinguishing Claude's work

This is the reason this file exists. Follow all of it.

- **Branch.** Do work on `claude/<short-kebab-name>` created from a verified
  commit on `main`. Never commit directly to `main` and never push, merge,
  rebase, force-push, open a PR, or deploy unless the user explicitly asks.
- **Commits.** Keep them small and single-purpose. Use the existing
  `feat:` / `fix:` / `chore:` prefixes, and end every commit body with:

  ```text
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

- **Work log.** Append an entry to `docs/CLAUDE_WORKLOG.md` (create it if it
  does not exist) for every session: date, branch, files touched, the bug or
  slice, the commands you actually ran, and what remains unproven. This is the
  durable record of Claude's contribution, separate from `CHANGELOG.md`.
- **CHANGELOG.md.** Add a user-facing line only for completed, verified work,
  in the existing voice and date grouping. Do not restructure or reword prior
  entries — they are someone else's record.
- **Do not reformat.** No repo-wide prettier runs, no import reordering, no
  renaming, no "while I was in here" refactors of adjacent code. Formatting
  noise destroys the diff's evidentiary value. Match the surrounding style of
  the file you are editing, whatever it is.
- **One owner per slice.** Do not edit this worktree while Codex or another
  agent is working in it. If you are unsure, ask.

Never use destructive Git or filesystem commands on user work: no
`git reset --hard`, no `git clean`, no broad `checkout`/`restore`, no automatic
stashing, no recursive deletion outside a scratch directory you created. Never
rewrite shared history.

## Operational lessons

Each of these cost real time at least once. They were kept as agent memory on
Matthew's Mac until 2026-09-23 and now live here so they follow the repo.

- **Launch sessions from the repo root.** This file only loads as project
  context when the session's working directory is this repo. Sessions started
  from elsewhere silently ran without these rules.
- **Hidden work: check more than `git status`.** In-flight work has hidden in
  untracked files and in a `git stash`. Before calling the tree clean, also run
  `git stash list` and `git rev-list --count origin/main..main`. `test/*.test.js`
  is a glob, so an untracked test still runs and inflates the count. Stage
  explicit paths only — never `git add -A` / `git add .`, especially while
  resolving a merge — and check `git show --stat HEAD` after any merge commit.
- **Deploys ship the working directory, not a git ref.** `prepare-deploy.mjs`
  copies from `process.cwd()`, so a stale checkout deploys old code with no
  error. `/__version` reports deploy time and `commit: null`, so it cannot
  catch this. Before deploying, confirm HEAD matches the intended branch; to
  prove a feature shipped, grep the live asset:
  `curl -s https://brainstorm.matthewbelinkie.com/app.js | grep -c '<marker>'`.
- **Supabase grants are non-default.** `anon`, `authenticated` and
  `service_role` have **no SELECT** on public tables; only `postgres` does.
  `security definer` RPCs are unaffected, but any Worker route that reads a
  table directly through PostgREST needs an explicit `grant select` in a
  migration (`BYPASSRLS` bypasses policies, not grants — mistakes.md #9). After
  adding such a route, list unreadable tables:

  ```sql
  select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
    and not has_table_privilege('service_role', oid, 'select') order by relname;
  ```

- **`/media/*` is edge-cached — keep it that way.** `/media/:assetId` and
  `/author-media/:assetId` once re-fetched the object from Supabase Storage on
  every request, which blew the org's Cached Egress quota (9.3 GB of 5 GB,
  Aug 2026). `a6513bf` added a `caches.default` layer keyed by `storage_path`
  (15 min TTL) after the authorization check. Do not reintroduce an uncached
  Storage fetch. Trade-off: an in-place audio re-trim can serve stale bytes for
  up to 15 minutes. If quota trouble recurs, read the Supabase usage dashboard
  by metric first; the next lever is moving media to R2, not a longer TTL.
- **Diagnostics exports are device-local.** `quiz-control-diagnostics.json`
  holds only the exporting device's errors (host/presenter; Matthew hosts from
  Windows/Chrome), cumulative, last 30 entries. Player-phone errors
  (`submit-answer`, `door-choice`, `auto-submit-answer`) are only in Sentry
  (org `ead-ot`, project `javascript`): group by the `scope` tag plus
  `os.name`/`browser.name`. An unchanged export does not mean diagnostics broke.
- **Parallel-session workflow.** Matthew fans work out to one session per git
  worktree (`../quiz-<name>` on `claude/<name>`); workers commit and stop. A
  single integrator session merges one branch at a time, smallest first, runs
  `npm test` after each, union-resolves `CHANGELOG.md` and
  `docs/CLAUDE_WORKLOG.md`, and deletes with `git branch -d` (never `-D`).
  Deploys (`wrangler deploy`, `supabase db push`) and **migration numbers stay
  with Matthew** — parallel sessions collide on numbers and git cannot see it.
  Review-only sessions leave untracked `docs/reviews/*.md`, so check
  `git status` before removing any worktree.

## Repository shape

Plain ES modules served statically — there is no bundler for the app itself.

- `index.html` + `config.js` + `app.js` — the runtime for host, player, and
  presentation surfaces, selected by `?view=`. `config.js` holds **publishable**
  values only.
- `author.html` / `author.js` / `author.css` — the question-bank editor.
- `quiz-core.js`, `quiz-validation.js`, `subtitle-core.js`, `image-crop.js`,
  `video-utils.js`, `room-api.js` — extracted logic that tests import directly.
  **Prefer putting new logic here** rather than deeper into `app.js` (162 KB) or
  `author.js` (153 KB); testability is the point.
- `cloudflare-worker.js` — the deployed Worker: private media proxy and API
  routes. It is the only place the service-role key may be used.
- `server.mjs` — local dev server (`npm run dev`, port 4173).
- `supabase/migrations/NNNN_*.sql` — ordered, append-only. Server-authoritative
  scoring lives here, not in the browser.
- `test/*.test.js` — `node:test`, run with `npm test`. Several are contract
  tests that assert against migration SQL text.
- `video-processor.worker.js` → `video-processor.worker.bundle.js` is generated
  by `npm run build:video`; the bundle and `.deploy-assets/` are ignored build
  output. Do not hand-edit them.

## Working a bug fix

1. **Reproduce first.** Identify the surface (host / player / presentation /
   author), the question format, and the phase (lobby, question open, locked,
   revealed, between rounds, final). State the reproduction before you patch.
2. **Fix at the right boundary.** Scoring and authorization belong in migrations
   and the Worker. Presentation is a *projection* of authoritative state — never
   let it compute a result the server owns.
3. **Add or extend a test** in `test/` that fails before the fix and passes
   after. Turn every production bug into a regression test.
4. Run `npm test` and paste the real output. Never say tests "should pass."
5. Manually verify anything visual or media-related per `RUNBOOK.md`, or say
   plainly that you could not.
6. Update `CHANGELOG.md` and `docs/CLAUDE_WORKLOG.md`. Add a numbered entry to
   `mistakes.md` only if the bug revealed a genuine structural lesson, and
   follow that file's existing "What to do next time" format.

After two evidence-based debugging attempts without progress, stop patching.
Write down the confirmed facts and a focused reproduction, and ask the user how
to proceed.

## Product invariants that must not regress

These are distilled from `PRODUCT_SPEC.md` and `mistakes.md`. Breaking one is a
release-blocking defect, not a style issue.

- **Scoring is server-authoritative.** Correct answers, accepted spellings,
  partial credit, multipliers, and tie handling are resolved in Supabase RPCs
  from the stored quiz key. The browser never decides points.
- **Players never receive future state.** No upcoming questions, correct
  answers, reveal media, or usable media URLs reach a player payload before the
  host reveals. The single exception is deliberate: a player may hold the active
  question's option artwork ID (`options[].imageAssetId`), which `0029` allows
  and `can_access_live_media` gates. Every other asset reference — question
  audio, matching clip audio, reveal art — is host- and Presentation-only. Note
  that `toPlayerQuestion` forwards `items` and `categories` through unfiltered,
  so artwork attached there would reach a phone and then be refused; do not
  author it until the payload allowlist and the media policy agree again.
  Private media is served only through the Worker proxy with the host's room
  secret or the player's session token.
- **Presentation is a strict projection** of authoritative state, and carries
  no host controls or production notes.
- **Cross-client commands are self-identifying.** Audio and media cues carry the
  exact question ID, clip ID, and revision. Stale-cue playback is a known
  historical bug class here.
- **Client success is never implied before server confirmation.** Pending,
  confirmed, rejected, and retryable are four distinct visible states.
- **Score-affecting events are immutable and auditable.** Manual adjustments,
  door bonuses, and late-join catch-up all append audit events that the CSV
  exports can explain.
- **Loading, failure, absence, and invalidity are distinct states** in the
  authoring UI. A slow authenticated media query must not render as "missing."
- **Migration history equals production state.** Every persistent schema change
  gets a new ordered migration. Never edit an applied migration, never renumber,
  never replay history against the live schema.
- **Raw source media stays local** (`music quiz originals/` is git-ignored), and
  filenames or public asset paths must never reveal track titles or answers.
- **Old quizzes still load.** `quiz.sample.json` and
  `music-trivia.question-bank.json` are compatibility fixtures; validate against
  them via `quiz-validation.js` before shipping a schema change.

## Security and permission boundaries

- Work only inside this repository unless the user explicitly authorizes another
  path. Do not inspect home-directory credentials, shell history, browser data,
  SSH material, keychains, or unrelated projects.
- **Never read, print, or copy `.env.local`.** `.env.example` is safe
  documentation. `config.js` is publishable by design; keep it that way — a
  `SUPABASE_SECRET_KEY` or service-role key in any browser-served file is a
  critical defect.
- The service-role key exists only as a Worker secret
  (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY`). Never echo it, never add it
  to `wrangler.jsonc`, never log it.
- Do not run `wrangler deploy`, `npm run deploy`, `supabase db push`, or any
  command that mutates the production project or its data without explicit
  per-instance approval from the user. `supabase migration repair` requires an
  explicit conversation, never a reflex.
- Do not install or upgrade dependencies, alter `package-lock.json`, or add
  build tooling without approval and a reason tied to the current task.
- Do not call live external services (Supabase production, Sentry, Gemini,
  YouTube) in tests. Use fixtures and deterministic fakes.
- Keep dev servers on loopback (`127.0.0.1:4173`). Do not broaden CORS or the
  Worker's public routes for convenience.
- Keep normal permission prompts enabled. Do not add MCP servers, hooks, or
  extra working directories without approval.

Ask before any destructive migration, data rewrite, deletion beyond scratch
files you created, dependency change, live-provider call, or operation whose
scope you are unsure of.

## Review priorities

Correctness before style. Report in this order:

1. data loss, credential exposure, authorization, or player-privacy leaks;
2. violations of the product invariants above;
3. missing or out-of-order migrations and incompatible persisted quiz data;
4. broken idempotency, reconnect/refresh recovery, stale-cue handling, or
   lock/reveal atomicity;
5. scoring and audit-trail inaccuracies;
6. untested failure states and misleading completion claims;
7. maintainability and style.

## Required handoff

End every task with a short, evidence-backed handoff:

- what a user can now do (or what stopped being broken);
- branch, files changed, and the reason for each;
- invariants you had to preserve and any judgment calls you made;
- migrations added and their data-compatibility impact;
- exact commands run and their **actual** output;
- manual verification performed, or explicitly not performed;
- anything you could not prove, plus the smallest sensible next step;
- commit ID, if the user asked for a commit.

Do not mark anything complete for scaffolding, mocked-only wiring, or an
untested claim. When uncertain, leave it open and say precisely what has and has
not been proven.

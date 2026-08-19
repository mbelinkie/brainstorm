# Quiz Control — cleanup, merge, and release guide

Written 2026-08-17 against the actual repo state at that moment. Part 1 is a
one-time cleanup of today's mess. Parts 2 and 3 are the repeatable process.

---

## The state you're actually in

Your mental model is "several dirty branches that need combining." That is not
what happened. The real state:

- **All five `claude/*` branches point at the same commit, `6532ffc`.** They have
  zero divergence from each other. There is nothing to merge between them. Four
  of the five are empty labels.
- **All five sessions ran in the same working tree** (`git worktree list` shows
  one worktree). So every session's work landed in one shared pile of
  uncommitted changes, layered on top of your own edits.
- **`main` is one commit behind `6532ffc`, linearly.** It fast-forwards. No
  merge commit, no conflicts, no rebase.
- **The uncommitted pile is real work:** 16 modified files, +339/−42, plus one
  new untracked test.
- **`npm test` is currently RED: 124 pass, 1 fail.** A session was still working
  when I looked (`video-utils.js` modified 3 minutes before I ran this).

So the job is not "merge branches." It's "finish one in-flight slice, commit one
pile, fast-forward, push, deploy."

### Who wrote what in the uncommitted pile

| Files | Owner |
|---|---|
| `room-api.js`, `test/answer-submission-recovery.test.js` (new) | auto-submit race fix — **done** |
| `quiz-core.js`, `test/quiz-core.test.js` | host volume fix — **done** |
| `video-utils.js`, `test/video-clips.test.js` | manual audio-volume override — **UNFINISHED** |
| `styles.css`, `quiz-validation.js`, `music-trivia.question-bank.json`, `quiz.sample.json`, `test/presentation-layout.test.js`, `test/quiz-validation.test.js` | yours |
| `app.js` | **shared:** yours + auto-submit fix + volume fix |
| `author.js` | **shared:** yours + audio-volume override |
| `test/reliability-contract.test.js` | **shared:** volume fix + audio-volume override |
| `CHANGELOG.md`, `docs/CLAUDE_WORKLOG.md` | session records |

Three files carry hunks from more than one author. **Do not try to split them.**
`git add -p` surgery across `app.js` (70 changed lines in a 162 KB file) to
reconstruct per-bug commits costs an hour and risks committing a broken
intermediate state. The per-bug detail already lives in `docs/CLAUDE_WORKLOG.md`,
which is the durable record. Ship one honest release commit instead.

---

## Part 0 — Two blockers before anything else

### Blocker 1: the failing test is an unfinished feature, not a broken one

`test/reliability-contract.test.js:65` asserts `author.html` contains:

```text
id="audio-volume-override-enabled" type="checkbox"
id="audio-volume-override-percent" type="range"
```

Neither exists. The `claude/audio-volume-override` session wrote the logic
(`video-utils.js` helpers, `author.js` wiring, the tests) but had not yet added
the two controls to `author.html` when it stopped. `author.html` is not even in
`git status`.

That work is entangled with `author.js` and `test/reliability-contract.test.js`,
so you cannot cleanly park it by stashing whole files. **Finish it.** Resume that
session, or start a new one with:

```text
Read CLAUDE.md, then docs/CLAUDE_WORKLOG.md's last entry. A previous session
left the manual audio-volume override half-finished: video-utils.js, author.js,
and the tests are written, but the two controls were never added to author.html,
so test/reliability-contract.test.js:65 fails. Add only those controls, get
`npm test` fully green, and add a worklog entry. Don't touch anything else —
the rest of the working tree is a release I'm about to commit.
```

### Blocker 2: production is missing two files it imports (pre-existing bug)

`prepare-deploy.mjs` copies a hardcoded list of files into `.deploy-assets/`.
`video-utils.js` and `image-crop.js` are not on that list — but `author.js`
imports both. Verified against your live deployment:

```text
video-utils.js     HTTP 404
image-crop.js      HTTP 404
author.js          HTTP 200  text/javascript
```

A static ES module import that 404s fails the whole module graph, so **the
deployed authoring editor at `/author.html` currently loads no JavaScript at
all.** This predates every session this week (the committed `author.js` at `HEAD`
already had both imports, and so does the copy live in production right now).
Local authoring works because the dev server serves the whole folder — which is
why this was invisible.

The in-flight override work adds a *second* import from `video-utils.js` into
`author.js`, so this must be fixed before that ships regardless.

Fix, in `prepare-deploy.mjs`'s `publicFiles` array:

```js
  "quiz-validation.js",
  "video-utils.js",
  "image-crop.js",
  "diagnostics.js",
```

Then guard it so this can't recur — a test that parses every `import ... from
"./x.js"` in the deployed entry points and asserts each target is in
`publicFiles`. Worth doing; it's the same class of bug as the migration-drift
lesson in `mistakes.md`.

I did not make either change myself: a session was live in this worktree minutes
before I looked, and editing under it would violate the one-owner rule.

---

## Part 1 — One-time cleanup

Run from the repo root. Stop at the first thing that doesn't match.

**1. Confirm no agent session is running.** Check that nothing is still writing:

```bash
ls -lT app.js author.js author.html video-utils.js | awk '{print $6,$7,$8,$9}'
```

Run it twice, ~30 seconds apart. If timestamps move, a session is active — wait.

**2. Land Blocker 1 and Blocker 2, then get green.** Non-negotiable gate:

```bash
npm test
```

Do not proceed until it reports `fail 0`.

**3. See exactly what you're about to commit.**

```bash
git status --short && git diff --stat
```

**4. Decide the untracked files.** Four promo PNGs, `gemini_api_integration_guide.md`,
`CLAUDE.md`, and the new test are untracked. The test and `CLAUDE.md` should be
committed. The PNGs and the Gemini guide are your call — if the promo images are
source material rather than shipped assets, leave them out.

**5. Commit the release.** One commit, honest message:

```bash
git add -A
git commit
```

Message body:

```text
fix: player logo overlap, auto-submit race, host audio volume

Combined release of three bug fixes plus in-flight authoring work that
shared files and could not be cleanly separated. Per-fix root causes,
reproductions, and verification are in docs/CLAUDE_WORKLOG.md.

- Auto-submit no longer reports expected stale-revision races to Sentry;
  it refetches room state and retries once.
- Host audio volume slider now renders on every playable audio panel and
  its level carries to every cue, not just the title screen.
- Manual per-clip audio volume override in the authoring editor.
- prepare-deploy.mjs now ships video-utils.js and image-crop.js, which
  author.js imports and which 404'd in production.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**6. Fast-forward `main` and collapse the branch clutter.**

```bash
git checkout main
git merge --ff-only claude/audio-volume-override
```

`--ff-only` is deliberate: if it refuses, the history isn't what this guide
assumed — stop and look rather than forcing a merge.

Then delete the now-redundant branches. `-d` (not `-D`) refuses to delete
anything not fully merged, which is the safety you want:

```bash
git branch -d claude/audio-volume-override claude/auto-submit-race-fix \
  claude/fix-android-logo-picker-overlap \
  claude/fix-submitted-count-and-part-results claude/host-volume-persist
```

**7. Push to GitHub.**

```bash
git push origin main
```

---

## Part 2 — Deploy to production for testing

**1. Migration preflight.** This batch adds no migrations, but confirm local and
remote agree before every deploy (per `DEPLOYMENT.md`):

```bash
npx supabase migration list --linked
```

Every local migration must pair with the same remote version. `0032_video_media_assets.sql`
must be applied before publishing any quiz with video. If the histories diverge,
**stop** — do not run `supabase migration repair` reflexively; audit the live
schema first.

**2. Deploy.** This rebuilds the video worker bundle, restages `.deploy-assets/`,
and ships:

```bash
npm run deploy
```

**3. Confirm the build that's actually live.**

```bash
curl -s https://wild-haze-73b3.matthew-belinkie-3af.workers.dev/__version
```

Note that `commit` reads `null` today — the Worker exposes a version endpoint
but nothing stamps the Git SHA into it. That's also why your Sentry events carry
no release tag, which cost a previous session real time trying to date a bug.
Wiring the SHA in is a small, high-value follow-up.

**4. Verify the two things this release actually touched.** Both are unverifiable
locally, which is why they're deploy-gated:

- `/author.html` on the deployed site: confirm the editor renders and the browser
  console shows no module 404s. This is the Blocker 2 fix.
- A real phone joining a real room: submit an answer, have the host advance the
  question mid-submission, and confirm the player sees a quiet status rather than
  an error — and that no new `auto-submit-answer` events land in Sentry.

**5. Then the standing pre-game rehearsal** from `DEPLOYMENT.md`: create a room,
join from a phone on cellular (not office Wi-Fi), submit, lock, reveal, confirm
the leaderboard moves.

---

## Part 3 — Stop this from recurring

The root cause of today's mess is one line: **five agent sessions shared one
working tree.** Branches don't isolate anything if every session edits the same
files in the same directory — you get one pile with five labels on it, and the
last session to touch a file silently owns it.

Two ways to fix it, in order of preference:

**A. One worktree per session.** Real isolation — separate directory, separate
checkout, no interleaving. This is cheap in this repo, because every test
imports only `node:` builtins and `server.mjs` depends only on builtins too:
**a worktree needs no `npm install` to run `npm test` or `npm run dev`.**

```bash
cd "/Users/matthewbelinkie/Desktop/ONGOING/Quiz Platform"
git worktree add ../quiz-<name> -b claude/<name> main
cp .env.local ../quiz-<name>/.env.local
```

`.env.local` is git-ignored, so it does not travel with the checkout and must be
copied. Give each session its own port, since `server.mjs` defaults to 4173:

```bash
cd ../quiz-<name> && PORT=4174 npm run dev
```

When the session is green and committed, merge from the main checkout and remove
the worktree:

```bash
cd "/Users/matthewbelinkie/Desktop/ONGOING/Quiz Platform"
git merge --no-ff claude/<name>
git worktree remove ../quiz-<name>
git branch -d claude/<name>
```

Two things worktrees do **not** solve:

- **Migration numbering.** Two sessions each adding "the next" migration both
  pick `0033` and collide at merge. Only one session at a time may add a
  migration, or assign the number yourself before starting each one.
- **Merge conflicts in the big files.** Any two features touching `app.js` or
  `author.js` will conflict on merge. That is strictly better than today's
  silent interleaving — a conflict is visible and resolvable, an interleave is
  not — but it is not free. Keep concurrent sessions on different surfaces
  (player vs. author vs. presentation) where you can, and merge often so
  branches stay short-lived.

**B. Serialize.** One session at a time in this directory. Each must end with
either a commit or an explicit "not committed, here's the diff" note before you
start the next.

Either way, three rules:

- **A session that can't commit must say so loudly.** Today's volume-fix session
  correctly refused to commit `app.js` because your edits were interleaved — and
  said so in the worklog. That's the right behavior; it's why the work was
  recoverable.
- **Never start a session on a red test suite.** The next agent can't tell your
  breakage from its own.
- **Deploy the smallest thing you can verify.** Today's release bundles four
  changes because they got entangled. That's a recovery, not a template.

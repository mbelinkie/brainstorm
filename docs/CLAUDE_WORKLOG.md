# Claude Work Log

Durable record of Claude's contributions to this repo, separate from `CHANGELOG.md`. One entry per session.

## 2026-10-07 — Late record: presentation sizing (#33)
- Added four CSS declarations and a layout regression check for the Prompt Battle presentation at smaller viewport sizes. Commit `bdbd276` was independently reviewed and merged as PR #99; integrated verification passed on `09d05f3`.
- Evidence recorded by the independent review: 953 full-suite tests, 32 focused tests, and 10 synthetic browser checks; the integrated suite passed 953 tests. Verification was synthetic only; no production room or service was used.

## 2026-10-07 — Prompt Battle editor recovery and navigation (#42)
- On `codex/editor-42-autonomous`, fixed malformed saved `engine.permittedModels` values crashing the editor. The renderer now leaves the saved value untouched, shows the shared validation error, and allows an explicit correction. Type filters now omit ordinary question rounds with no matching questions while keeping Prompt Battle rounds discoverable by title or prompt.
- Added focused regressions and a private synthetic Playwright recovery check. Focused tests passed 14/14; the browser check verified malformed-value restoration, adjacent edits and reload, explicit correction and reload, zero page errors, and no auth/RPC/media access. `npm test` passed 912/912 on the worktree.
- No production room, provider, migration, or deploy was used. PR #53 remains pending independent Sol review; this work is not accepted until that review is complete.

## 2026-10-07 — Current-main integration for #42
- **Branch:** `codex/editor-42-autonomous`. Fetched `origin/main` at `c065ea1b3a404449727521e0476ad74cf8b7158b` and merged it into `63e4b8350b8a846ae21880e404cea811d75f8a55` with merge commit `79d47194eb2cc2688e13c7d3e4c19ee75261acc1`. Kept both sides of the `CHANGELOG.md` conflict; `docs/CLAUDE_WORKLOG.md` merged without conflict.
- **Checks on the merge commit:** `npm test` passed 973/973; the focused editor and reliability tests passed 49/49; `quiz.sample.json`, `music-trivia.question-bank.json`, and `quiz.battle.sample.json` all passed `validateQuiz`; `git diff --check origin/main...HEAD` passed. The synthetic Chrome recovery check passed restoration without draft mutation, adjacent edit/reload, explicit correction/reload, and no page errors or RPC/auth/storage/media calls (3 external requests blocked, 33 local requests).
- **Commands:** `ctx-wire run git fetch origin main:refs/remotes/origin/main`; `ctx-wire run git merge --no-ff origin/main`; `ctx-wire run npm test`; `ctx-wire run node --test test/author-battle-input.test.js test/author-battle-round-guard.test.js test/author-prompt-battle-editor.test.js test/reliability-contract.test.js`; offline `validateQuiz` check for the three fixtures; synthetic browser recovery check.
- No production room, provider, migration, or deploy was used. PR #53 remains pending independent Sol review; no PR acceptance, merge, or issue completion was recorded.

## 2026-08-18 — Investigated: "I don't see brainstorm.matthewbelinkie.com on the title screen"
- **Branch:** `claude/investigate-title-url-deploy`. Investigation only; no product code changed.
- **Report:** User said the join URL added by `bf7df3f` ("feat: show join URL on the presentation title screen only") isn't visible on the live title screen, even though that commit is merged to `main`.
- **Verdict: stale production deploy, not a code/CSS/wrong-screen bug.** The live site at `brainstorm.matthewbelinkie.com` is serving an `app.js` build that predates `bf7df3f` and three other same-day merges. Confirmed by diffing the live-served files against this worktree's source:
  - `https://brainstorm.matthewbelinkie.com/app.js` has no `presentation-title-domain` span in `presentationTitlePage()` at all (diffed byte-for-byte against local `app.js`).
  - Also missing from the live `app.js`/`author.js`: `isPlayerSessionExpired`/`PLAYER_SESSION_ACTIVITY_KEY` (from `claude/device-session-memory`, merged `5cb380d`), the `audioSourceFileError` source-file-limit fix (from `claude/media-upload-limit`, merged `2be5338`), and the entire image-suggestion-assistant removal (from `claude/remove-image-suggest`, merged `ab60324`) — live `author.js` still has `openImageFinder`, `imageFinderTarget`, and the "Find image" menu item that removal deleted.
  - So the live deploy is stale relative to **all four** of yesterday's same-day merges (`24f6f63`, `2be5338`, `5cb380d`, `ab60324`), not just the title-URL one.
  - `GET https://brainstorm.matthewbelinkie.com/__version` reports `deployedAt: 2026-08-18T03:30:21Z`, which is numerically *after* all four merge-commit timestamps (03:14:02–03:21:46 UTC that same morning) — so the deploy timestamp alone doesn't reveal the gap. `prepare-deploy.mjs` copies whatever is currently on disk in the deploying machine's working directory into `.deploy-assets/` (it doesn't build from a specific git ref), so the most likely explanation is that `npm run deploy` was run from a checkout that hadn't yet pulled/merged these four branches at the time, even though the deploy itself ran later in wall-clock time.
  - Ruled out the "wrong screen" hypothesis: the code is correctly scoped to `presentationTitlePage()` only (`state.presentationScreen === "title"`); `presentationCornerJoinQr()` deliberately has no URL text, per the original commit, and that's still true in source.
  - Ruled out clipping/legibility: built a real room locally (`node server.mjs`, `?view=presenter&room=<code>`) and visually confirmed the title screen renders `brainstorm.matthewbelinkie.com` in bold white text between "Scan the code with your phone" and the gold room code, fully legible, not clipped or wrapped, at both 800×450 and 1280×900 viewports.
- **Fix needed:** none in this repo. **Redeploy from current `main`** to ship the four pending merges:
  ```sh
  npm run deploy
  ```
  (this runs `prepare:deploy` — which rebuilds the video bundle and regenerates `.deploy-assets/` fresh from the working tree — then `wrangler deploy`). Run it from a checkout that has pulled `main` including `24f6f63`/`2be5338`/`5cb380d`/`ab60324`/`b58adb7`. Not run here — deploys are the user's per `CLAUDE.md`.
- **Commands run and actual output:**
  ```
  $ npm test
  ℹ tests 149
  ℹ pass 148
  ℹ fail 1
  ```
  The one failure (`test/deploy-manifest.test.js`, missing gitignored `video-processor.worker.bundle.js`) is the same pre-existing, unrelated gap noted in prior worklog entries for a fresh worktree without `node_modules`/the video build.
- **Could not verify:** which specific machine/checkout ran the live `npm run deploy` and why it wasn't up to date with `main` at that moment — that's outside this repo's introspection; flagging it to the user as the open question rather than guessing further.
## 2026-08-18 — Move the presentation timer to a top-center badge, off the corner QR
- **Branch:** `claude/presentation-timer-top-center` (renamed from the worktree's default `worktree-agent-afd2240cc8386ed25` branch name to follow the `claude/<short-kebab-name>` convention before committing; this branch was not checked out in any other worktree, so the rename was safe).
- **Bug (user-reported):** "The timer appears in the corner UNDER the QR code. Make the time at the top CENTER to prevent this." — on the Presentation (shared big-screen) view, the countdown could render partly hidden behind the corner join-QR badge.
- **Root cause:** `timerDisplay()`'s `<span data-timer-readout>` was rendered *inside* the `.presentation-round` heading section (`app.js`, `renderPresenter()`). In fullscreen kiosk mode, `.is-presentation .presentation-round .question-timer` positioned that span `position:absolute; right:clamp(22px,3vw,48px); top:50%` — i.e., pinned to the right edge of the round-heading row. `presentationCornerJoinQr()` is a separate, sibling element styled `.presenter-join-qr--corner{position:fixed; top:14px; right:clamp(18px,3vw,48px)}`, and because the round heading occupies only the top ~22% of the fullscreen grid, that timer's `top:50%` (of the 22% row) landed in almost exactly the same screen region as the QR's fixed top-right position — the two overlapped, with the QR painted on top.
- **Fix:**
  - `app.js` — removed `${state.phase === "open" ? timerDisplay() : ""}` from the `.presentation-round` heading template in `renderPresenter()`. Added a new `presentationTimerBadge()` function (guards on `state.phase === "open"` and a non-empty `timerDisplay()` readout) that renders `<div class="presentation-timer-badge" data-presentation-timer-badge>${timerDisplay()}</div>` as its own element. Wired it in as a sibling of `cornerJoinQr` and `fullscreenControl` in the `shell(...)` call (`${cornerJoinQr}${presentationTimerBadge()}${fullscreenControl}`), so it is not nested inside `.presentation-round` or the corner QR container. The inner `<span data-timer-readout>` from `timerDisplay()` is unchanged, so `updateTimer()`'s `document.querySelectorAll("[data-timer-readout]")` 250ms tick and the `is-expired` class toggle keep working without a full re-render. `timerControls()` (the Host view's control panel) still calls `timerDisplay()` directly and was not touched.
  - `styles.css` — removed the old `.presentation-round .question-timer` (non-fullscreen) and `.is-presentation .presentation-round .question-timer` (fullscreen) rules. Added `.presentation-timer-badge{position:fixed;z-index:9;top:35px;left:50%;transform:translate(-50%,-50%);pointer-events:none}` plus a nested `.question-timer` rule for sizing/background, an `.is-expired` variant, a `max-width:700px` top-offset tweak, and an `.is-presentation .presentation-timer-badge{top:calc(clamp(66px,9vh,82px)/2)}` override that vertically centers the badge on the topbar's own height in fullscreen kiosk mode, carrying forward the same large `min-width:clamp(112px,13vw,190px)` / `font-size:clamp(30px,5.6vh,68px)` prominence sizing the timer already had, just recentered and no longer right-anchored.
  - The topbar itself (`brandTopbar(false, false, ...)`, called with `presenter=false`) renders an empty right slot on every non-title presentation screen (its `showRoom` room-badge is only shown on the title screen, and the corner QR floats as a separate fixed element instead) — so the topbar's horizontal center, where the badge is now vertically centered, was already visually empty in both the brand-mark's flex row and the round heading below it.
- **Test:** extended `test/presentation-layout.test.js`. Updated the existing "presenter timer is a prominent shared-screen control" test to match the new `.is-presentation .presentation-timer-badge .question-timer` selector (it was asserting against the now-removed `.presentation-round .question-timer` selector and would otherwise have false-passed against dead CSS). Added a new test, "presenter timer sits in its own fixed top-center badge, clear of the corner join QR," asserting: the `heading` template no longer calls `timerDisplay()`; `presentationCornerJoinQr()` contains neither `timerDisplay()` nor `data-timer-readout`; `presentationTimerBadge()` exists and renders the `data-timer-readout`-bearing markup as its own `.presentation-timer-badge` div; it is wired in as a sibling (`${cornerJoinQr}${presentationTimerBadge()}`) rather than nested; and the CSS positions the badge as `position:fixed` with horizontal centering (`left:50%;transform:translate(-50%,-50%)`), independent of the corner QR's separate `top:14px;right:...` fixed position.
- **Commands run and actual output:**
$ node --test test/presentation-layout.test.js
...
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
...
ℹ tests 150
ℹ suites 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
  The one failure, `test/deploy-manifest.test.js` ("every local file referenced by a shipped file is itself shipped" — `author.js references "./video-processor.worker.bundle.js", which does not exist"), is pre-existing and unrelated to this change: `video-processor.worker.bundle.js` is a gitignored, locally built artifact this worktree doesn't have. Confirmed by `git stash`-ing all three of my changed files and re-running `npm test` in this same worktree — identical single failure, same assertion, before any of my edits existed; then `git stash pop` to restore the fix.
- **Could not verify:**
  - **No real projector or actual browser render.** Per `mistakes.md`'s note that diagnostics are device-local, and per this task's own instruction not to deploy: I did not open the Presentation view in an actual browser (fullscreen or windowed), take a screenshot, or view it on a real second-screen/projector setup to visually confirm the badge clears the QR and the round heading at a real aspect ratio. The fix is verified structurally (the timer markup is no longer inside `.presentation-round` or the QR container; the CSS positions are non-overlapping by their fixed coordinates as computed above) and by the full-suite regression tests, but not by a rendered screenshot.
  - **Extreme/unusual aspect ratios.** I reasoned through the geometry at common projector widths (≈1024px, ≈1920px, and the existing 700px mobile-preview breakpoint) and confirmed the badge's centered position stays clear of the QR's fixed right-edge offset with comfortable margin at each, but did not exhaustively test every possible viewport size (e.g., very narrow portrait-oriented displays, which this product's presentation surface isn't designed for regardless).
  - Did not touch `supabase/migrations/` or any server-side code — this is a purely client-side layout/CSS fix with no data-model or scoring implication, so none was needed.
## 2026-08-18 — Author editor: one validator, and three draft-persistence bugs
- **Branch:** `claude/author-editor` (from `b58adb7`). Parallel-worker slice E of `docs/reviews/2026-08-17-consolidated-plan.md`: findings C19, C20, C21, C22. C23 was explicitly out of scope (collides with the in-flight `image-engine.js` slice) and no new validation rules were added (C18's "reject empty rounds" belongs to the fixture worker).
  - `quiz-validation.js` — now the single authoritative validator. Gained the rules that previously lived only in `author.js`'s private copy: the 11-type allowlist, question `audio.mediaAssetId` UUIDs, `fill_in_the_blank` blanks, the `arrange_in_order` and `categorize` answer keys, `matching` pair referential integrity plus labeled clips/options, and `finale.audio` asset IDs.
  - `author.js` — deleted its own `validateQuiz` (~93 lines) and imported the shared one; removed the now-unused `validNumericLiteral` helper; reordered the boot block so the saved draft is restored before the bundled-bank fetch; guarded two `JSON.stringify(bank)` dereferences; added `markChanged()` to the `#import-file` handler; added the `between:` branch to the `[data-remove-audio]` handler and made `markChanged()` conditional on a branch having matched.
  - `test/quiz-validation.test.js` — six new behavioral tests for the promoted rules.
  - `test/reliability-contract.test.js` — retargeted the `restoredDraft` slice anchor (it used `function validateQuiz`, which no longer exists in `author.js`), plus four new author-editor contract tests.
  - `CHANGELOG.md`, `docs/CLAUDE_WORKLOG.md`.
- **No migration.** No schema, scoring, or Worker change. `app.js`, `quiz-core.js`, `cloudflare-worker.js`, and `quiz.sample.json` were not touched.
### Reproductions confirmed before patching
- **C19** — `author.js` imported `diagnostics.js`, `image-crop.js`, `subtitle-core.js`, `video-utils.js`, and *not* `quiz-validation.js`; `grep` confirmed `quiz-validation.js` was imported only by three test files and shipped by `prepare-deploy.mjs` to a browser that never loaded it.
- **C20** — the boot block's first statement was `await fetch(BANK_URL, …)`; `restorePublishedSnapshot()`, `restoredDraft()`, and `render()` were all sequenced behind it inside the same `try`.
- **C21** — `#apply-raw` called `markChanged()`; `#import-file` did not.
- **C22** — `privateAudioPreview(...)` emits `data-remove-audio="between:<key>"` for between-round sounds (`author.js`, the between-round sound card), while the `[data-remove-audio]` handler recognized only `"question"`, `"finale:"`, and `"clip:"` and called `markChanged()` unconditionally outside every branch.
### Validator disagreements and how they were resolved
Both copies already rejected empty rounds ("Round N needs at least one question"), contrary to the plan's drift table — so merging added no empty-round rule and did not disturb the `quiz.sample.json` fixture work. Every other divergence was one-sided (a rule present in exactly one copy), so the union was taken with no rule dropped and none invented. Net user-visible change to the editor: it now also validates `betweenRoundBonus.audio` asset IDs, which only the untested module checked before.
### Commands actually run
$ npm run build:video      # failed: esbuild is not installed in this worktree
Copied the git-ignored `video-processor.worker.bundle.js` from the main checkout instead so `test/deploy-manifest.test.js` could pass. Nothing in the main checkout was modified.
$ npm test                 # on b58adb7, after the bundle copy
ℹ tests 149
ℹ pass 149
(The slice brief quoted a baseline of 158 tests; the measured baseline on `b58adb7` was 149.)
Each fix was written test-first and each new test was observed failing before its fix and passing after.
$ npm test                 # final
ℹ tests 159
ℹ pass 159
### What remains unproven
- **No browser verification was possible here.** C20, C21, and C22 are all `localStorage` draft-persistence behaviors in a module that cannot be imported under `node:test` (top-level `await fetch`, DOM access at load).
- C22 *is* proven behaviorally: the test slices the real `[data-remove-audio]` handler body out of `author.js`, compiles it with `new Function`, and runs it against fakes — it asserts the between-round clip is actually deleted and that an unrecognized target never calls `markChanged()`.
- C19's promoted rules are proven behaviorally against `quiz-validation.js`. That the *editor* now uses that module is proven only structurally (the import exists, no local `function validateQuiz` remains).
- **C20 and C21 are proven only structurally** — ordering and presence assertions on the source text. Per `RUNBOOK.md`, Matthew should confirm by hand: (a) edit a quiz, break the bundled bank URL (or go offline) and reload — the draft should still open and the status line should say the bundled bank did not load; (b) import a quiz JSON, reload without touching a field — the imported quiz should still be there; (c) attach a between-round bonus sound, press the preview's "Remove audio", and confirm the clip is gone from the JSON and no longer plays.
- Not addressed, deliberately: C23 (author image preview states), C18's empty-round rule and its `quiz.sample.json` fixture, and the `author.js` `originalBank` variable, which `grep` shows is assigned twice and never read — flagged, not changed.
## 2026-08-18 — Stop the Host screen rebuilding itself on every player action

- **Branch:** `claude/host-render-gate`
- **Bug (user-reported):** "The host screen appears to be refreshing a lot, perhaps every time the players do anything."
- **Files touched:**
  - `quiz-core.js` — new `HOST_LIVE_STATE_FIELDS`, `hostRenderKey()`, `hostLiveCounts()`. Put here rather than in `app.js` so the remount boundary is directly testable, per CLAUDE.md.
  - `app.js` — new `patchHostLiveRegions()`; `receive()` now gates the Host remount on `hostRenderKey`; `acceptSubmission()`, `acceptPlayerPresence()` and `acceptDoorChoice()` patch instead of calling `render()`; `leaderboard()` split into `leaderboardRows()` + `data-leaderboard`; `manualScoreControls()` split into `manualScoreNote()` / `manualScorePlayerOptions()`; patch hooks added to the Host and Host-doors markup.
  - `test/host-render-gate.test.js` — new.

### Root cause actually confirmed (not the one first suspected)

The initial hypothesis was `receive()`'s ungated Host branch at the `!["player","presenter"].includes(view)` clause. That clause is a real gap and is now closed, **but it was not the driver of the reported symptom.** The Host does not receive its own `state` broadcasts: `BroadcastChannel` does not deliver to the posting context, the Supabase channel is created with `broadcast: { self: false }`, and `emit()` returns early for every view except `host`. So that clause only fires for a second Host tab or the landing view.

The actual cause was three *unconditional* `render()` calls on player-originated messages:

- `acceptSubmission()` — every `submission` broadcast.
- `acceptPlayerPresence()` — every player join.
- `acceptDoorChoice()` — every door pick.

Players broadcast a submission on every answer tap, every categorize tap, every matching-dropdown change, every drag-drop, and — through `queueAutoSubmission({ allowEmpty: true, delay: 40 })` on `[data-multi-blank]` — roughly **once per keystroke** on multi-fill-in-the-blank questions. Each one ran `render()` → `renderHost()` → `app.innerHTML = shell(...)`, discarding and rebuilding the entire Host layout.

What that rebuild was costing on every phone tap, all of which the host perceives as "refreshing":

1. Keyboard focus and half-typed text in `[data-score-points]`, `[data-score-reason]`, and the `[data-jump-question]` selection — destroyed mid-keystroke. An unapplied question-jump choice silently snapped back to the current question.
2. Every `[data-private-image]` was re-fetched through the Worker media proxy: `render()` revokes `imageMediaObjectUrls` and `attachEvents()` re-runs `loadPrivateImage()`, which has no cache. A room of players answering produced a continuous stream of proxy requests and visible image flicker.
3. `startTimerTicker()` cleared and restarted the 250 ms `setInterval` every time.
4. All ~40 per-node listeners in `attachEvents()` were torn down and re-bound (they are per-node `addEventListener`, not delegated — confirmed before changing render frequency).

### Approach, and the alternative rejected

Chose **(a) a `hostRenderKey()` remount gate plus in-place patching of the live regions**, over (b) leaving the full render in place and special-casing the three message types.

- (a) is this codebase's own established pattern — `playerRenderKey()` / `presenterRenderKey()` plus targeted updaters like `updatePresenterActiveClipState()` — so it reads as consistent rather than novel.
- `mistakes.md` #14 already prescribes exactly this and warns against putting transport-only fields in a remount boundary. The Host was simply never given the boundary that Presentation got.
- (b) is not actually narrower in risk: it needs the same enumeration of patch targets, but leaves `receive()` able to remount the Host and gives no protection to any future inbound path.
- (a) alone is not sufficient either — a submission genuinely does change host-visible content — which is why the gate is paired with `patchHostLiveRegions()`.

`hostRenderKey()` is a **denylist**, not an allowlist (unlike `playerRenderKey()`): a newly added state field defaults to remounting the Host. For a live-audience tool a stale host screen is worse than a flickery one, so the gate fails toward re-rendering.

### Kept working (each checked against the code, not assumed)

- **Host typing/focus:** `patchHostLiveRegions()` never touches `.host-utilities`, the question-jump control, or any focused node — it skips the manual-score picker when `document.activeElement` is that picker, preserves its chosen value, and will not toggle `disabled` on a focused control.
- **Timer:** the patch never calls `attachEvents()`, so `startTimerTicker()` is not re-entered and the interval survives. `[data-timer-readout]` is patched by `updateTimer()` on its own 250 ms tick, independent of render.
- **Listeners:** per-node, bound in `attachEvents()` after each full render. Everything the patch replaces (`data-host-submitted-count`, `data-host-answer-results`, `[data-leaderboard]` rows, the Host's compact doors board) is listener-free markup; `[data-play-intro]` buttons are updated by `classList.toggle` only, never rebuilt. The doors patch hook is applied only to the host's read-only `compact` board, never the player's interactive door buttons.
- **Media:** `videoPanel()`, `audioPanel()` and `matchingClipControls()` are no longer re-emitted on player activity at all, so the volume slider and the `<audio>`/`<video>` elements stop being recreated under the host. This is strictly better than before.

### Coordination note

Another agent is adding a "presented by" override text input to `hostUtilityControls()`. It needs no change here: the patch never writes into `.host-utilities`, and inbound player messages no longer remount the Host, so that input is safe mid-typing. If its state field must remount the Host when it changes *remotely*, that happens automatically — `hostRenderKey()`'s denylist means new fields are structural by default. Add it to `HOST_LIVE_STATE_FIELDS` only if something patches it in place.

### Tests

```
$ node --test test/host-render-gate.test.js
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

Confirmed red before the fix: the first run failed on the missing `hostLiveCounts` export, and after adding the pure helpers the wiring tests still failed (`expected app.js to define function patchHostLiveRegions(`) until `app.js` was rewired.

```
$ npm test
ℹ tests 163
ℹ pass 162
ℹ fail 1
```

The one failure is `test/deploy-manifest.test.js` — "author.js references ./video-processor.worker.bundle.js, which does not exist in the repository". Pre-existing and environmental: that bundle is gitignored build output absent from any fresh worktree. Verified by checking out untouched `b58adb7` into a scratch worktree and reproducing the identical failure there. Did not run the video build or touch that file.

### Not verified

- No live browser run. This repo's app-layer tests are all source-text assertions and there is no jsdom or headless browser available (adding a dependency needs approval), so the DOM patch itself is covered by pure-function tests plus wiring/contract assertions, **not** by executing `patchHostLiveRegions()` against a real DOM. The behaviour worth eyeballing live is listed in the handoff.
- No Supabase or Worker round-trip exercised.


## 2026-08-17 — Show the join URL on the presentation title screen only

- **Branch:** `claude/title-screen-url`
- **Feature (user-requested):** On the Presentation title screen (the opening screen shown before the host starts round 1), show the public join URL `brainstorm.matthewbelinkie.com` alongside the QR code and room code, so a room without a scannable phone camera can still join by typing the address. Confirmed the URL should not appear anywhere once the quiz begins — it already didn't (see below).
- **Files touched:**
  - `app.js` — `presentationTitlePage()` (the sole renderer of the title screen's join card): added `<span class="presentation-title-domain">brainstorm.matthewbelinkie.com</span>` between the "Scan the code with your phone" line and the room code.
  - `styles.css` — added `.presentation-title-join .presentation-title-domain{color:#fff;font-weight:800}` next to the existing `.presentation-title-join` rules, so the domain reads as bold white text at a distance (it already inherited the join card's base `span` size/color).
  - `test/presentation-layout.test.js` — added a regression test asserting (a) `presentationTitlePage()` contains the domain span, (b) the CSS rule exists, and (c) `presentationCornerJoinQr()` — the small corner badge used everywhere *after* the title screen — does not contain the domain text.

### What was confirmed before writing code

- The title screen is rendered exclusively by `presentationTitlePage()` (`app.js`), used only when `state.presentationScreen === "title"`.
- Once the quiz begins (`presentationScreen` moves off `"title"`), join info during play is shown only via `presentationCornerJoinQr()`, a small corner badge with a QR code and the room code — it never included URL text, before or after this change. So "don't show the URL once the quiz begins" was already true; this change only needed to add the URL to the title screen, not remove anything.
- The player's own device never displays the room URL or code (players have already joined by the time they see their own screen), so no player-view change was needed.
- The QR code itself already encodes the real `location.origin` dynamically (not a hardcoded domain) — the new text is static, human-readable branding for manual entry, per the user's explicit request for that literal string.

### Test

```
$ node --test test/presentation-layout.test.js
```
Confirmed the new test fails on the pre-fix code: temporarily `git stash`-ed `app.js`/`styles.css` (keeping the new test), reran, got the expected `AssertionError` on the missing `presentation-title-domain` span, then `git stash pop`-ed the fix back before proceeding.

```
$ npm test
...
ℹ tests 141
ℹ pass 140
ℹ fail 1
```
The one failure (`test/deploy-manifest.test.js`: "every local file referenced by a shipped file is itself shipped") is pre-existing and unrelated: `video-processor.worker.bundle.js` is a `.gitignore`d generated build artifact (`npm run build:video`) that simply isn't present in this fresh worktree yet — it exists in the main checkout but not here. Did not run the video build or touch that file, per CLAUDE.md's "do not hand-edit generated bundles."

### Could not verify

- Visual appearance on an actual projector/presentation display — this was verified by reading the rendered markup/CSS and the existing test-suite conventions (this repo's presentation-layer tests are all source-text assertions, no headless browser rendering available here), not by looking at the live screen.
- No live room / Supabase round-trip exercised — this is a static-copy change to an existing, already-tested render path; no state or data-flow logic changed.

## 2026-08-17 — Audio-clip upload source-file limit and wording

- **Branch:** `claude/media-upload-limit`
- **Ask:** The audio "Trim and upload clip" buttons alerted `"Choose an audio file up to 25 MB."` on the raw local source file, before any trimming happened. 25 MB is the right limit for the final *uploaded* clip, but far too small for a source file an author picks locally to trim from.
- **Scope decision (confirmed with the user before coding):** There's already a separate, working video-upload pipeline (`uploadPrivateVideo` / "Presentation video cue" section, shipped 2026-08-15 per `CHANGELOG.md`) with its own messaging and no source-size cap — that pipeline isn't affected by this change and didn't need touching. The user confirmed the fix should stay scoped to the audio-only gate: raise the local source-file limit, keep the wording as "audio file" (accurate, since this gate stays audio-only). A follow-up session will build a dedicated combined/video-aware ingest interface later if needed.
- **Files touched:**
  - `video-utils.js` — added `MAX_AUDIO_SOURCE_BYTES` (500 MB) and a pure `audioSourceFileError(file)` helper, following the existing pattern of `MAX_VIDEO_BYTES` / `validateVideoEdit` in the same file.
  - `author.js` — `uploadPrivateAudio()`'s source-file gate now calls `audioSourceFileError()` instead of inlining the old `file.type.startsWith("audio/") || file.size > 26214400` check and hardcoded message.
  - `test/video-clips.test.js` — added a regression test for `audioSourceFileError`: accepts audio up to the new 500 MB limit (including sizes that would have failed the old 25 MB cap), rejects non-audio and oversized files with the expected message.
- **Not touched:** the *rendered*-clip upload cap (still 25 MB, `author.js` line ~658, `clipped.blob.size > 26214400`) and the video pipeline's own 25 MB rendered-MP4 cap (`MAX_VIDEO_BYTES`) — both are checks on the actual uploaded artifact and were already correctly scoped.

### Verification

Confirmed the new test fails before the fix (stashed `author.js`/`video-utils.js`, kept the test) — `video-clips.test.js` failed with `SyntaxError: The requested module '../video-utils.js' does not provide an export named 'MAX_AUDIO_SOURCE_BYTES'`. Restored the fix and reran:

```
$ npm test
...
✔ audio source file gate accepts a large local audio file and rejects non-audio or oversized files (0.260851ms)
...
ℹ tests 141
ℹ pass 140
ℹ fail 1
```

The one failure (`deploy-manifest.test.js`, "every local file referenced by a shipped file is itself shipped") is pre-existing and unrelated: it fails identically on a clean checkout of this worktree's base commit with none of my changes applied, because `video-processor.worker.bundle.js` (generated by `npm run build:video`, ignored build output) isn't present in this fresh worktree.

### Not verified

No live/manual verification — this is a pure client-side validation-message and constant change with no visual, audio, or video rendering involved, and no server/migration change. Did not run the author UI in a browser or pick an actual oversized local file.

## 2026-08-17 — Android join-screen logo picker overlap

- **Branch:** `claude/fix-android-logo-picker-overlap`
- **Bug:** On the player join screen ("Choose your player logo"), the logo choice cards rendered as an overlapping, fanned stack on Android Chrome at phone widths. Reported as fine on iPhone.
- **Files touched:**
  - `kaplan-brand-layer.css` — removed `min-height: 0;` from the mobile (`max-width: 520px`) `.player-logo-choice` rule.
  - `test/player-logo.test.js` — added a regression test asserting the mobile `.player-logo-choice` rule doesn't declare `min-height: 0`.

### Root cause (confirmed, not guessed)

`.player-logo-picker>div` (the scrollable list of choices) is `display: grid` with implicit `auto` row tracks. Each `.player-logo-choice` is a grid item and, at the mobile breakpoint, a flex container whose only real content is a large aspect-ratio-square avatar (`width: min(62vw,260px)`, `aspect-ratio: 1`) — roughly 230px tall on a typical phone.

The mobile rule also set `.player-logo-choice { min-height: 0; ... }`. On Chromium's grid track-sizing algorithm (used by both Android Chrome and this session's Chromium-based browser-preview tool), that explicit `min-height: 0` suppresses the grid item's automatic minimum size, and the implicit `auto` row track collapsed to ~28px (just the label chrome) instead of expanding to the ~230px avatar. The avatar itself still painted at full size, visually overflowing into the following rows — producing the fanned, mashed-together stack in the screenshot. WebKit (Safari/iOS) sizes the row to the item's content regardless of `min-height: 0`, which is why the same CSS looked correct on iPhone. This is a genuine cross-engine CSS Grid intrinsic-sizing divergence, not a data or JS bug, and not something specific to the user's device — it reproduced identically in the local dev server under an emulated Android-Chrome/mobile viewport.

`min-height: 0` did not appear to serve any purpose in this specific rule (the picker's own scroll clipping already happens via `overflow-y: auto` / `overflow: hidden` on ancestor elements), so removing it was the minimal fix.

### Reproduction

1. `npm run dev` (already running locally on `127.0.0.1:4173`).
2. Open `http://127.0.0.1:4173/?view=player&room=<any-code>` with `localStorage` cleared, at a viewport ≤520px wide (e.g. 375×812).
3. Before the fix: the "Choose your player logo" list rendered as a stack of overlapping ~28px-tall pink cards with a ~230px avatar bleeding out of each into the next.
4. After the fix: each choice renders as a full, non-overlapping card and the list scrolls normally.

Verified with actual computed styles in the browser (`getBoundingClientRect()` on `.player-logo-choice` showed `height: 28px` before the fix, `height: 260.5px` after), not just visual inspection.

### Commands run and actual output

```
$ npm test
...
ℹ tests 116
ℹ pass 116
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Also confirmed the new test fails against the pre-fix CSS (temporarily restored `min-height: 0` in a scratch copy, re-ran `node --test test/player-logo.test.js`, saw the expected `AssertionError`, then restored the fix) before finalizing.

### Verified manually

- Mobile width (375px, emulated Android/Chromium): choice cards no longer overlap; full scroll through all 19 avatars checked, none overlapping.
- Desktop width (1280px): the wider icon+name row layout (not the mobile single-column layout) still renders correctly with no regression.

### Could not verify

- Real Android hardware/Chrome — only reproduced under an emulated Chromium mobile viewport in this session's browser-preview tool (which the tool itself describes as emulating Android Chrome UA at widths <768px). The computed-style evidence (grid row collapsing under `min-height:0`) is a browser-engine-level explanation, not something specific to one physical device, so this should generalize to real Android Chrome, but a real-device check by the user is the safest final confirmation.
- Real iPhone/Safari — did not have one to confirm the "looks fine" baseline; took the user's report as ground truth for the before-state.
- No live-room / real Supabase join flow was exercised — this was purely a client-side rendering fix on the join form, before any name is submitted or `data-join-room` is clicked.

### Unrelated observation (not touched)

`room-api.js` appeared as a modified file partway through this session that was not part of the initial `git status` and that I did not edit. Left untouched per the "one owner per slice" rule; flagged to the user rather than investigated or included in this change.

## 2026-08-17 — Auto-submit-answer race reported to Sentry (JAVASCRIPT-A)

- **Branch:** `claude/auto-submit-race-fix` (created off `claude/fix-android-logo-picker-overlap`'s tip, `6532ffc` — another session was actively committing to this worktree while this one ran; branched from wherever `HEAD` was rather than disturbing it, per the user's direction).
- **Bug:** Sentry `JAVASCRIPT-A` — `Error: This question has changed; refresh and try again`, scope `auto-submit-answer`, culprit `call(room-api)`, 3 handled production events, no release metadata.
- **Files touched:**
  - `room-api.js` — `call()` now preserves `error.code/details/hint` on the thrown `Error`. Added `classifySubmitAnswerError()`, `planStaleRevisionRecovery()`, and `submitLiveAnswerWithRecovery()`.
  - `app.js` — `queueAutoSubmission()` now calls `submitLiveAnswerWithRecovery()` instead of `roomApi.submitAnswer()` directly and branches on its `status`.
  - `test/answer-submission-recovery.test.js` — new, real (not string-matching) behavioral tests for the three new `room-api.js` exports.

### Root cause (confirmed via Sentry MCP, not guessed)

Queried `JAVASCRIPT-A` read-only. Observed: the reported stack is exactly `app.js:2115` (`await roomApi.submitAnswer(...)` inside `queueAutoSubmission`) → `room-api.js:21` (`if (error) throw new Error(error.message)`); all 3 events fired within a 2-minute window today in one room (`F7M6VD`, question `piano-final`); no `release` tag on any event.

`submit_live_answer()` in `supabase/migrations/0002_live_room_rpc.sql` checks `phase`, then `revision`, then `question_id`, in that order, and raises the *same* "This question has changed; refresh and try again" message whether the revision alone is stale on the same open question, or the question itself changed underneath the check. `queueAutoSubmission()`'s existing local guard (recheck of question ID/revision immediately before calling `submitAnswer`, `submissionSequence` serialization) already narrows the race, but a gap remains between that local recheck and the RPC actually being processed — exactly the scenario in `advanceQuestion()` (`app.js:274`, unchanged, pre-existing, intentional), which moves directly from one open question to the next within a round without a lock/reveal step in between and bumps the session revision on every `persistHostState()` call regardless of phase. That local guard has been unchanged since the repo's initial commit (`9ab6e1f`, 2026-08-14), 3 days before these events — I could not obtain deploy/release confirmation (Sentry carried no release tag on any of the 3 events), but the guard's age relative to the events makes it very likely it was already live, i.e. these events are the guard's known residual gap, not a regression it introduced. Regardless of deploy timing, the code as read today unconditionally reported *every* `submitAnswer` rejection — including this expected concurrency outcome — via `recordDiagnostic()`, which is the actual, deploy-independent bug this fix addresses.

Did not touch `supabase/migrations/` — the SQL check ordering itself is not the defect; the client-side classification of an ambiguous-but-server-correct rejection is.

### Reproduction / model

Could not reproduce live (no live room available in this session). Modeled from the exact code path and confirmed against the Sentry stack trace: (1) player debounces an answer, local guard passes; (2) host calls `advanceQuestion()` mid-flight, bumping `revision` and `questionId` while `phase` stays `question_open`; (3) `submit_live_answer` raises the stale-revision message because its `phase`/`revision` checks run before the `question_id` check; (4) pre-fix, this always reported to Sentry with no recovery attempt.

### Commands run and actual output

```
$ npm test
...
ℹ tests 122
ℹ pass 122
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Verified red→green for real: `room-api.js` had zero prior uncommitted changes, so I `git stash push -- room-api.js` to revert it to `HEAD`, reran `node --test test/answer-submission-recovery.test.js` and confirmed it failed (`TypeError: submitLiveAnswerWithRecovery is not a function`), then `git stash pop` to restore the fix and reran the full suite green.

### Could not verify

- No live room / real Supabase session — the retry-once-and-reconcile flow is unit-tested against injected fakes (`test/answer-submission-recovery.test.js`), not exercised against a live `submit_live_answer` RPC or real network latency.
- `queueAutoSubmission()`'s UI branch (status text rendering) has no DOM/browser test harness in this repo (no jsdom), same limitation as the rest of `app.js`.
- Sentry release/deploy history for the pre-fix guard — no release metadata was available on any of the 3 events, so I could not confirm exactly which deployed build produced them, only that the guard code has been stable since the initial commit.
- Did not touch the manual "Submit" button path (`app.js:2300`, scope `submit-answer`) — out of scope for this Sentry issue, and it already alerts the user directly on failure with different UX.

### Unrelated observation (not touched)

Mid-session, `HEAD` moved from `main` to `claude/fix-android-logo-picker-overlap` and a new commit (`6532ffc`) appeared that this session did not make — confirming another agent/session was concurrently active in this same worktree. All pre-existing uncommitted changes (app.js, author.js, styles.css, the question bank, etc.) were verified intact throughout and are unmodified by this session beyond the files listed above.

## 2026-08-17 — Host audio volume slider scoped to the title screen only

- **Branch:** `claude/host-volume-persist`
- **Bug:** The host's audio volume slider only appeared on the title-screen music panel. Turning it down there had no effect on question, between-round, or finale audio, and there was no way to adjust volume once the quiz left the title screen.
- **Files touched:**
  - `quiz-core.js` — moved `normalizedAudioVolume` here (was a private helper in `app.js`) as a plain exported, testable function; no behavior change.
  - `app.js` — see root cause below for exactly what changed and why.
  - `test/quiz-core.test.js` — added a unit test for `normalizedAudioVolume`'s clamping/default behavior.
  - `test/reliability-contract.test.js` — replaced the old title-only contract test ("Host can adjust title music volume...") with one that asserts the slider is scope-agnostic and that a volume-only command can never reload/swap the active clip.

### Root cause (confirmed, not guessed)

Two independent restrictions in `app.js`, both scoped to the literal string `"title"`:

1. `audioPanel(sourceAudio, { opening, scope, label })` only emitted the `<input data-audio-volume>` slider markup when called with `opening: true` (`const volumeControl = opening ? ... : "";`). Of the three call sites, only the title-screen panel passes `opening: true`; the per-question panel (`audioPanel()`) and the finale panels (`audioPanel(..., { scope: "finale", ... })`) never did, so no slider ever rendered there.
2. Even if a slider had rendered elsewhere, `setAudioCommand(command)` computed `volume = command.audioScope === "title" ? currentTitleAudioVolume() : 1` — every non-title audio command (question, between-round, finale) was hard-coded to full volume, ignoring whatever the host had set.

I traced this by grepping every `audioScope`/`volume` reference in `app.js`, reading `audioPanel()`, `setAudioCommand()`, `applyPresentationAudioCommand()`, and `preparePresentationAudio()` end to end, and confirming `state.titleAudioVolume`/`currentTitleAudioVolume()` were referenced nowhere except those title-scoped call sites. This fully explains the reported symptom (slider present only for title music, and no cross-screen persistence) without needing to run a live room.

### Fix

- Generalized `state.titleAudioVolume`/`currentTitleAudioVolume()` to `state.audioVolume`/`currentAudioVolume()`, dropping the `audioScope === "title"` special case; `setAudioCommand` now always stamps the current persisted volume onto every command it creates, regardless of scope (this also fixes automatic between-round/finale cues silently ignoring the host's set volume, not just the manual slider).
- `audioPanel()`'s volume slider now renders whenever the panel `playable` (same gate as the Play/Restart/Pause buttons), not only when `opening`.
- The host-side volume `<input>` listener no longer sends `audioScope: "title"` on its command — a volume-only command carries no clip identity at all now.
- `applyPresentationAudioCommand()` (presentation tab) now returns immediately after applying the new gain for a `"volume"` action, **before** calling `preparePresentationAudio(command)`. This was necessary once the slider could appear on non-title screens: `preparePresentationAudio` resolves which clip to load from `command.audioScope`/`audioKey`, and a bare volume nudge no longer carries those, so it must never reach that code path (previously harmless only because the slider — and thus every volume command — was permanently scoped to `"title"`, matching whatever was already loaded).
- Kept `audioVolume` excluded from `presenterRenderKey()` (renamed from the old `titleAudioVolume` exclusion) so dragging the slider still never remounts the shared presentation screen.

### Commands run and actual output

```
$ npm test
...
ℹ tests 123
ℹ suites 0
ℹ pass 123
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 261.532332
```

Verified red→green for real: reconstructed the pre-fix `app.js`/`quiz-core.js` in a scratch copy (reversing exactly the edits listed above, nothing else) and ran the two updated test files against it. `test/quiz-core.test.js` failed with `SyntaxError: ... does not provide an export named 'normalizedAudioVolume'`; `test/reliability-contract.test.js` failed with an `AssertionError` on the new `const volumeControl = playable ? ...` assertion, confirming both are genuine regression tests for this fix. Re-ran the full suite against the real (fixed) working tree afterward and got the clean 123/123 output above.

### Could not verify

- No live room was exercised. Everything above is static source verification (contract-style tests, matching this repo's existing pattern for `app.js` since there is no DOM/jsdom test harness here) plus manual code tracing — not a running host + presentation tab.
- Did not confirm in a real browser that dragging the slider during a question's audio, or during the finale drumroll/outro, produces an audible volume change with no glitch/reload, or that the level is still applied correctly after a host page reload (the code path for that — merging `publicState.audioVolume` back into `state` on reconnect — is unchanged, pre-existing generic state-merge logic, not something this session added or altered).
- Did not verify on a real Android/iOS device or with an actual attached audio clip; no media assets were available in this session.

### Not committed

`app.js` already carried unrelated uncommitted changes from the current session's `claude/auto-submit-race-fix` work before this fix started (per `git status` at session start). Since git cannot cleanly separate my hunks from those pre-existing ones within the same file, I did not run `git add`/`git commit` — the diff above is the complete, isolated record of what this session changed. The user can stage/commit `app.js` and `quiz-core.js` together with their other in-flight `app.js` work, or ask for a surgical `git add -p`-style patch if they want this kept as a separate commit.

## 2026-08-17 — Manual audio volume override for uploaded clips

- **Branch:** `claude/audio-volume-override`
- **Feature request:** All uploaded audio is normalized to −16 dBFS by default with no way to opt out. The user wants an optional slider at upload time to hard-encode a specific clip at a chosen (typically quieter) fixed volume instead.
- **Root cause / trace (confirmed, not guessed):** `uploadPrivateAudio()` always called `chooseAudioClip(file, { normalize: !doorBackgroundMusic, outputGain: doorBackgroundMusic ? DOOR_BACKGROUND_AUDIO_GAIN : 1 })`. The only escape from automatic loudness leveling (`normalizeAudioBuffer`, target −16 dBFS) was a single hardcoded special case wired to one specific upload slot (`target.betweenRoundAudioKey === "doorChoice"`), forcing a fixed 50% gain. There was no author-facing control of any kind, and no way to apply a custom level to any other clip (question, title, finale, or a different between-round slot).
- **Mid-session instruction:** the user reported the door-specific 50% mechanism "doesn't seem to be working" and asked to delete it outright in favor of the new general override. Removed `DOOR_BACKGROUND_AUDIO_GAIN`, the `doorBackgroundMusic` branch in `uploadPrivateAudio`/`chooseAudioClip`, the `reduceDoorBackgroundAudioVolume()` function and its "Render this file at 50% volume" button, and the door-asset exclusions in the media-library batch "Level all audio" function. The `doorChoice` between-round-audio *slot* itself (upload target, label, key) is unrelated and untouched — only its special-cased gain mechanics were removed. Door background music now uses the same general override as any other clip.
- **Files touched:**
  - `video-utils.js` — added `MIN_MANUAL_AUDIO_VOLUME_PERCENT`/`MAX_MANUAL_AUDIO_VOLUME_PERCENT`/`DEFAULT_MANUAL_AUDIO_VOLUME_PERCENT`, `clampManualAudioVolumePercent()`, `manualAudioVolumeGain()`, and `resolveAudioClipProcessing()` — pure, testable functions deciding whether a clip renders with automatic leveling or an author-chosen fixed gain.
  - `author.html` — added a checkbox (`#audio-volume-override-enabled`) and a percent slider (`#audio-volume-override-percent`, 1–150%, reusing the existing `.assistant-setting`/`.cropper-zoom` CSS classes so no stylesheet changes were needed) to the audio-clip trim dialog.
  - `author.js` — wired the new controls into `chooseAudioClip()`'s existing clip-state/`sync()` pattern; both the preview and final-render paths now call `resolveAudioClipProcessing({}, clip.volumeOverride ? clip.volumePercent : null)` before rendering. Removed the door-specific gain mechanism described above (constant, branch, function, button, batch-normalize exclusions) and simplified `formatNormalization()` (its door-only branch was dead code once the door branch was removed).
  - `test/video-clips.test.js` — added a unit test for `clampManualAudioVolumePercent`/`manualAudioVolumeGain`/`resolveAudioClipProcessing` covering clamping, the default (no override) path, and a manual override taking precedence over a non-default base.
  - `test/reliability-contract.test.js` — replaced the old door-background-specific contract test with two tests: one asserting the deleted mechanism (`DOOR_BACKGROUND_AUDIO_GAIN`, `doorBackgroundMusic`, `reduceDoorBackgroundAudioVolume`, `data-reduce-door-audio-volume`) no longer appears anywhere in `author.js`/`author.html`, and one asserting the new override's UI wiring and render-path call exist in `chooseAudioClip()`.

### Commands run and actual output

Confirmed the new UI-wiring test failed before implementation (`node --test test/reliability-contract.test.js`, `AssertionError` on the `resolveAudioClipProcessing` import/usage regex — full output in session transcript, omitted here for length). After implementation:

```
$ npm test
...
ℹ tests 125
ℹ suites 0
ℹ pass 125
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 268.710509
```

Also ran `node --check author.js` and `node --check video-utils.js` to confirm both files still parse cleanly, since the reliability-contract tests only pattern-match `author.js`'s source text and never execute it (it's browser code with top-level `window`/`document` references).

### Could not verify

- No live upload: never exercised the actual `chooseAudioClip()` dialog in a browser, so the checkbox/slider's visual layout, the disabled-state styling on the range input, and the live "Fixed volume …%" preview summary text are unverified beyond static source correctness.
- Never rendered actual audio through `OfflineAudioContext`/`AudioBuffer` — `applyAudioGain`/`renderAudioClip`'s interaction with the new `outputGain` path is exercised only indirectly, through the pure `resolveAudioClipProcessing()` unit tests and the existing (unchanged) `renderAudioClip`/`applyAudioGain` functions.
- Did not verify that a clip uploaded with the manual override survives a later "Level all audio" library-wide batch re-normalization. That batch function has no way to know a given asset was manually overridden at upload time (no such flag is persisted), so running it will re-normalize *every* audio asset in the library, including previously-overridden ones — this is a pre-existing limitation of the batch function, not something this session introduced, but it's now more likely to matter since manual overrides are a first-class feature rather than one hardcoded exception. Flagging this for the user rather than silently declaring it solved.
- Did not test on a real Android/iOS device or with production media assets.

### Not committed

`author.js`, along with `app.js`, `styles.css`, the question bank, and the test files, already carried the user's own unrelated uncommitted work at session start (per `git status --short --branch`). I did not stage or commit anything — `author.html`, `author.js`, `video-utils.js`, `test/reliability-contract.test.js`, and `test/video-clips.test.js` are the only files this session touched; everything else in `git status` is pre-existing user work, untouched. The user can `git add` those five files when ready.

## 2026-08-17 — Host "answers received" double-counting + per-part reveal results

- **Branch:** `claude/fix-submitted-count-and-part-results` (created off `6532ffc`, the same tip other concurrent sessions in this worktree were also branching from). **Note:** this worktree had at least three other Claude sessions actively creating branches and switching `HEAD` in the same physical directory during this session (`claude/auto-submit-race-fix`, `claude/host-volume-persist`, `claude/audio-volume-override`, all still at `6532ffc` — no divergent commits, so no working-tree files were ever overwritten by a checkout, but `HEAD` ended this session pointing at `claude/host-volume-persist`, not this branch). Flagged to the user mid-session; they confirmed it was safe to proceed. I did not run `git commit`, `git stash`, or any other git command that could disturb a concurrent session's uncommitted work.
- **Bug 1 (fixed):** The Host screen's "answers received" count (`submittedCount / state.players.length`) would intermittently show roughly double the real connected-player count (e.g. 6/12 for 6 players).
- **Feature 2 (added):** A "Who got it right" panel on the Host screen after answer reveal, with a per-part breakdown for matching, categorize, and multi-fill-in-the-blank questions.
- **Files touched:**
  - `app.js` — `sendSubmission()` and `announcePlayerPresence()` now broadcast `doorPlayerRecordId || playerId` instead of the bare local `playerId`; added `answerResultsPanel()` and wired it into the Host reveal-phase template.
  - `quiz-core.js` — added `tallyQuestionResults(question, submissions)`.
  - `styles.css` — appended `.answer-results` rules at the end of the file (Host-only reveal panel).
  - `test/quiz-core.test.js` — added `tallyQuestionResults` unit tests (multi-part breakdowns, single-answer types, closest-number tie handling, empty submissions).
  - `test/roster-identity-contract.test.js` — new; source-contract regression test for the roster-ID fix (see below for why this pattern, not a live-room test).

### Root cause (confirmed via code tracing, not guessed)

Traced end to end, no live room needed — this is a deterministic logic bug reproducible every session, not a race:

1. Each player's browser generates and persists a local auth token (`playerId`, in `localStorage`) used as the `playerToken` credential for `join_live_room`/`submit_live_answer` RPCs.
2. `join_live_room()` (`supabase/migrations/0002_live_room_rpc.sql`) creates a `session_players` row with its own Postgres-generated `id uuid default gen_random_uuid()` (`0001_initial.sql:53`) — a value with **no relationship** to the player's local token — and returns it as `joined.playerId`.
3. `get_live_leaderboard()` (`0021_player_logos.sql:59`) — the RPC behind `roomApi.getLeaderboard()` — keys every roster row by that same `session_players.id`. `lockQuestion()` in `app.js` reassigns `state.players` from this RPC on every lock, which is the only place `state.players` is authoritatively refreshed mid-game.
4. But `sendSubmission()` and `announcePlayerPresence()` (pre-fix) broadcast `payload.playerId = playerId` — the raw **local token**, not `joined.playerId`. The host's `acceptSubmission()`/`acceptPlayerPresence()` guard against duplicates with `state.players.find/some(p => p.id === payload.playerId)`; since the token never equals any `session_players.id` already in the list, every submission/presence event after a lock refresh pushes a brand-new "ghost" entry for a player who is already on the roster under their real server ID.
5. `state.submitted` (the numerator) stays correct throughout because it is always keyed consistently by the same local token on both write and the `Object.keys(...).length` read — only the denominator (`state.players.length`, sourced from two different ID spaces) is affected. This exactly matches the reported symptom: a correct numerator (6) with a denominator that inflates toward double (12) between question opens and resets to the true count at the next lock.
6. Interestingly, the code already had the correct pattern for a different feature: `rememberDoorPlayerRecord(joined.playerId)` captures this exact server ID into `doorPlayerRecordId` (persisted per room) for door-choice result matching, but it was never reused for submissions/presence. The fix reuses that existing variable — no new persistence mechanism.

This was root-caused from two independent angles that agreed (Phase 1/Phase 2 of the debugging process): (a) forward-traced every place `state.players` is written and confirmed the two disjoint ID sources, and (b) confirmed `adjust_live_score()`'s `p_player_id uuid` parameter (`0012_manual_score_adjustments.sql`) is checked against `session_players.id`, proving that ID — not the raw token — is the one true canonical player identity server-side, which the fix now uses consistently on the broadcast side too.

### Fix

`sendSubmission()` and `announcePlayerPresence()` now broadcast `doorPlayerRecordId || playerId` (falling back to the raw token only if a player somehow submits before their join round-trip populated `doorPlayerRecordId`, an edge case that already existed for door-choice lookups). Verified both of the app's join flows (`connectHostedRoom()`'s auto-join and the join-screen button handler) call `rememberDoorPlayerRecord(joined.playerId)` before their first `announcePlayerPresence()` call, so `doorPlayerRecordId` is populated before any broadcast in the normal flow.

### Why a source-contract test, not a live/imported one

`app.js` is a browser-only script (DOM, `BroadcastChannel`, `window.location` at module scope) with no dependency injection, so it cannot be `import`ed under `node:test` — this repo's own `test/reliability-contract.test.js` already established the pattern of asserting against `app.js`'s source text for exactly this reason. `test/roster-identity-contract.test.js` follows that precedent: it asserts `sendSubmission`/`announcePlayerPresence` broadcast `doorPlayerRecordId || playerId`, and that both join flows call `rememberDoorPlayerRecord` before their first `announcePlayerPresence()`.

Verified red→green without touching the real file: copied `app.js` to a scratch directory, mechanically reverted just the two payload lines to their pre-fix text, and ran the same regex assertions against both copies —

```
PRE-FIX (should be false/false): sendSubmission uses resolved id = false, announcePlayerPresence uses resolved id = false
POST-FIX (should be true/true): sendSubmission uses resolved id = true, announcePlayerPresence uses resolved id = true
```

### Feature 2: per-part reveal results

`tallyQuestionResults(question, submissions)` in `quiz-core.js` is host-only, post-reveal, display-only analytics — it never assigns points. It reads `hostQuestion` (the host's own authoritative question, already holding the correct-answer key) and `state.submitted` (the raw answers the host already collected for the current question) and mirrors the per-type comparison rules in `supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql` (matching pairs, categorize items, multi-fill-in-the-blank clips with the same punctuation/case-insensitive normalization; single-choice/multiple-choice/short-answer/fill-in-the-blank/arrange-in-order/closest-number for single-part types, including replicating the closest-number tie-for-smallest-distance rule). It returns `{ totalSubmitted, correctCount, parts }`, where `correctCount` is "got every part right" and `parts` is `null` for single-part question types. `answerResultsPanel()` renders it on the Host screen only, only during `state.phase === "reveal"`; Presentation and players never receive this data (it isn't added to `publicRoomState()`).

This intentionally duplicates the migration's comparison logic on the client for display purposes, since there is no persisted per-part breakdown in `score_events` to read back (it only stores one aggregated `points` value per player per question) and adding one would require a new migration — out of scope without the user's explicit sign-off on a schema change. Flagging the duplication risk explicitly: if `0030_multi_fill_in_the_blank_scoring.sql`'s comparison rules ever change, `tallyQuestionResults()` needs the matching update or the Host's summary will silently disagree with actual scoring.

### Commands run and actual output

```
$ npm test
...
ℹ tests 134
ℹ suites 0
ℹ pass 134
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 260.296893
```

### Could not verify

- **No live room.** Everything above is traced from migration SQL and `app.js` source, and covered by unit/contract tests against fixed fixtures — I did not join a real hosted room with multiple real player devices to watch the "answers received" count inflate and recover, or watch the new "Who got it right" panel render against real reveal data. This is the single biggest gap: the roster-ID fix in particular only fully proves itself against a real `get_live_leaderboard()` round trip.
- **Visual/manual verification of the new Host panel.** Did not open `?view=host` in a browser to confirm `.answer-results` renders acceptably alongside the existing `.stat`/`.manual-score` blocks at host-panel widths, or that it's absent outside the reveal phase and outside the host view. CSS was written to match the existing `.manual-score`/`.stat` variables and minified style in `styles.css`, but not screenshot-checked.
- **`closest_number` "correct" definition.** `tallyQuestionResults()` treats "correct" as tied-for-closest, matching the SQL's shared-points winner logic. This is a judgment call, not something the product spec states explicitly as "correct" for that question type — flagging it in case the user wants different framing (e.g. "within X of the target" instead of "closest of those who answered").
- Did not touch `supabase/migrations/` — no schema change, no `supabase db push`, per the task boundaries.

## 2026-08-17 — Prompt Battle round type: design spec only

**Branch:** `claude/prompt-battle-spec`
**Files touched:** `docs/superpowers/specs/2026-08-17-prompt-battle-design.md` (new), this file.
**No application code, no migrations, no dependency changes.**

### Slice

Brainstormed and specified a new round type in which paired players generate AI
images from a shared comic prompt and the room votes blind on each matchup. The
user supplied `local-reference/gemini_api_integration_guide.md` (authored by
Gemini) as a starting point. Output is a design document only — nothing is
implemented, and the spec is not yet approved by the user.

### Decisions recorded in the spec

Quiplash-style pairing (all players generate); budgeted iteration with 2–4
variants per attempt; host preview-and-veto before any image reaches the room;
blind voting with creator reveal after; winner points plus voter participation
points through the existing `score_events` table; 30-day retention with auto
purge; three-way matchup for odd player counts; full winner points to all tied
entrants; Vertex AI as the target credential path with OpenRouter as the
day-one build provider behind a swappable adapter.

### Corrections made to the supplied guide

- The guide's `GEMINI_API_KEY`-in-env approach conflicts with the user's stated
  premise that players use corporate Gemini accounts. Workspace Gemini seats are
  not API credentials; the two cannot both be true. Resolved toward a Vertex AI
  service account in a Kaplan Google Cloud project.
- The guide's suggestion to deduct points from players whose prompts trip the
  safety filter is inverted — it penalises false positives, which dominate. The
  spec refunds the attempt and applies no penalty.
- The guide's SynthID claim ("guarantees images were not pre-made and uploaded
  from the web") does no work here: with server-side generation, players have no
  upload path at all. Not relied on.
- The guide's model IDs (`gemini-3.1-flash-image`, `gemini-3-pro-image`) were
  checked against live provider documentation and are correct.

### Research performed (2026-08-17, live docs)

OpenRouter shipped a dedicated Image API (`POST /api/v1/images`) in June 2026:
`n` of 1–10 returns multiple variants from a single call, `output_format` and
`resolution` are request parameters, and `usage.cost` reports actual spend per
call. This removed three open questions from the draft design (parallel calls
for variants, phone bandwidth / image resizing, and refund-on-failure policy).

Verified pricing changed the cost estimate materially: worst case is roughly
$11–16 per round on Gemini 3.1 Flash Image, not the ~$5 originally estimated.
Imagen 4 is deprecated and shut down 2026-08-17, so it is not an available path.

### Commands run

```
$ git checkout -b claude/prompt-battle-spec
Switched to a new branch 'claude/prompt-battle-spec'
$ grep -n "TBD\|TODO\|XXX\|FIXME" docs/superpowers/specs/2026-08-17-prompt-battle-design.md
no placeholders found
```

`npm test` was not run — no code changed and no test was added or modified.

### Unproven / open

- **Blocking, external:** whether Kaplan IT permits a downloadable Vertex
  service-account key, or mandates Workload Identity Federation. WIF from
  Cloudflare Workers is a substantially larger effort than the spec assumes.
- Whether `n > 1` is honoured by the specific chosen model through OpenRouter.
  The spec's host-side test button is designed to answer this empirically.
- Vertex returns no cost field, so the session spend cap there depends on a
  hand-maintained price table that will drift.
- The `media_assets.uploaded_by` nullability change touches an existing RLS
  policy and existing author flows; it is specified but not yet exercised.
- Retention purge introduces a Cloudflare Cron Trigger, which is new
  infrastructure for this repository.
- No implementation plan exists yet. Nothing here has been executed against
  Supabase, the Worker, or any provider.

## 2026-08-17 — Player identity outlived its session (auto-rejoin with a stale name/logo)

- **Branch:** `claude/device-session-memory`, worktree `../quiz-device-session-memory` off `main` at `1754625`.
- **Bug (user-reported):** A phone that had previously played a quiz auto-filled its old name and logo when scanning the QR code for an unrelated, later room — the join screen never appeared. Desired: reconnect a phone that closes its tab and immediately rescans the same room's QR, but ask for a name again for a genuinely separate, later game.
- **Files touched:**
  - `quiz-core.js` — added `isPlayerSessionExpired(lastActiveAt, now, ttlMs)` (pure) and `PLAYER_SESSION_TTL_MS` (6 hours).
  - `app.js` — added `PLAYER_SESSION_ACTIVITY_KEY`; on load, clears the saved `musicTriviaPlayerId`/`musicTriviaPlayerName`/`quizPlayerLogoKey`/activity keys (both storages) if `isPlayerSessionExpired()` says the gap is too long, before those keys are read into `playerId`/`playerName`/`playerLogoKey`. `savePlayerValue()` now also stamps the activity timestamp, so any player action (join, name/logo pick, door pick) extends the session.
  - `test/quiz-core.test.js` — new unit tests for `isPlayerSessionExpired()` (within TTL, past TTL, and no/invalid recorded activity all handled).
  - `test/player-logo.test.js` — new structural test asserting `app.js` imports `isPlayerSessionExpired`, runs the expiry check and clears storage before the identity is read, and that `savePlayerValue` stamps the activity timestamp.

### Root cause (confirmed, not guessed)

`persistedPlayerValue()`/`savePlayerValue()` in `app.js` (pre-fix) read/wrote `musicTriviaPlayerId`, `musicTriviaPlayerName`, and `quizPlayerLogoKey` to `localStorage` with no expiry at all. The player-join screen only renders when `params.has("room") && !playerName` (`app.js`, join-screen branch); since `playerName` never expired, a returning device always skipped straight to the "You're in" / auto-rejoin branch (`if (view === "player" && params.has("room") && playerName) { ...roomApi.joinRoom(...) }`), regardless of how much time had passed since it was last used. This is a direct deviation from `PRODUCT_SPEC.md`'s stated design ("Players receive short-lived anonymous identities scoped to one session") — the identity was neither short-lived nor session-scoped, it was permanent. Read the full call chain (`app.js:493` comment block through the join-screen render and the auto-rejoin branch) and `test/player-logo.test.js`'s pre-existing "survives closing the browser" test, which confirms the *reconnect* behavior is intentional and had to be preserved, just bounded in time.

### Fix

Added a last-activity timestamp (`musicTriviaPlayerSessionAt`) written every time `savePlayerValue()` runs (i.e. on join, name/logo pick, door pick). On script load, `isPlayerSessionExpired()` (in `quiz-core.js`, unit-tested directly, not string-matched) compares that timestamp against `Date.now()` with a 6-hour TTL; if expired (or never set), the four player-identity keys are wiped from both `localStorage` and `sessionStorage` *before* `playerId`/`playerName`/`playerLogoKey` are read from them. A fresh `playerId` is then generated as before. A same-session reload/reconnect (tab closed and QR rescanned minutes later) leaves the timestamp fresh, so identity and the door-pick record survive untouched; a later day's game finds the timestamp stale, clears `playerName`, and the join screen's existing `!playerName` gate naturally asks for a name again.

Did not scope the TTL by room code — the reported symptom is purely about elapsed time ("an entirely different day"), not about which room. `quiz-door-player:<roomCode>` records for other rooms are left alone (out of scope): they're inert once `playerId`/`playerName` have been cleared, since the auto-rejoin branch that would use them is gated on `playerName`.

### Commands run and actual output

```
$ npm test
...
ℹ tests 144
ℹ suites 0
ℹ pass 143
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The one failure, `test/deploy-manifest.test.js` ("every local file referenced by a shipped file is itself shipped" — `author.js references "./video-processor.worker.bundle.js", which does not exist"), is pre-existing and unrelated: `video-processor.worker.bundle.js` is a gitignored, locally built artifact (`npm run build:video`, needs `esbuild` from `node_modules`, which this fresh worktree doesn't have and which I did not install per the no-dependency-changes rule). Confirmed by `git stash`-ing my changes and re-running `npm test` in this same worktree: identical failure, same assertion, before any of my edits existed.

Verified the new tests actually test something, per TDD: temporarily `git stash`-ed `app.js`/`quiz-core.js` (keeping the new tests) and re-ran `node --test test/quiz-core.test.js test/player-logo.test.js` — `quiz-core.test.js` failed outright (`isPlayerSessionExpired` doesn't exist to import) and `player-logo.test.js`'s new assertion failed on the missing `quiz-core.js` import. Restored the fix (`git stash pop`) and reran the full suite (output above).

### Could not verify

- **No live room / real device.** Everything above is a `localStorage`/`sessionStorage` timing model verified with real `Date.now()` math in unit tests, and structural assertions that the wiring exists in the right order in `app.js`. I did not open the app in an actual mobile browser, join a room, force-close the tab, rescan a QR code, or fast-forward a device's clock 6+ hours to watch the join screen reappear.
- **The 6-hour TTL value itself.** The user's description ("same session" vs. "an entirely different day") doesn't pin an exact number; 6 hours is a judgment call sized to comfortably cover a single quiz night's intermissions/reconnects while reliably expiring by the next day. If actual quiz nights run longer than 6 hours between a player's actions, or the user wants a tighter/looser window, `PLAYER_SESSION_TTL_MS` in `quiz-core.js` is the one place to change it.
- Did not touch `supabase/migrations/` — no schema or server-side change; this is entirely client-side join-screen gating, per the task boundaries and without being asked to add a migration.

## 2026-08-17 — Removed the image suggestion assistant

- **Branch:** `claude/remove-image-suggest`. The task arrived pointed at a `quiz-<name>` worktree that didn't actually exist yet — the main checkout (`Quiz Platform/`) was on `main` with an unrelated in-progress edit to `docs/RELEASE_PROCESS.md` (not touched). Created this worktree per that same doc's documented `git worktree add ../quiz-<name> -b claude/<name> main` procedure before doing any task work.
- **Request:** remove the author-only "image suggestion assistant" feature entirely — both its entry point on the main authoring screen and its entry point on each image upload control — because the user does not want the feature at all.
- **Scope:** this was a full feature removal, not just a UI hide. Traced the feature end-to-end from the two named UI entry points through to its dedicated backend route and removed all of it, since leaving a dead `/media-assistant/search` Worker route, local dev proxy, and Wikimedia/OpenAI-calling code behind an unreachable UI would be dead weight, not a partial removal.
- **Files touched:**
  - `author.html` — removed the `<section class="media-assistant">` panel (the "Image suggestion assistant" heading, "Open image finder" button, and draft-mode checkbox) from the preview column, and removed the `<dialog id="image-finder">` element entirely.
  - `author.js` — removed the "Find image" menu item from `imageActionControls()` (shared by every image upload slot: title, reveal, question, and each option); removed `openImageFinder`, `draftImageSearch`, `findImageIdeas`, `approveSuggestedImage`, the `IMAGE_SEARCH_DRAFT_KEY` constant, the `imageFinderTarget` module variable (and its now-unnecessary default parameter on `resolveImageFinderTarget`), and all associated event-listener wiring (`#suggest-images`, `#image-draft-mode`, `#image-finder-*`, `[data-find-image]`).
  - `author.css` — removed the now-unused `.media-assistant`, `.suggested-queries`, and `.media-candidate` rules. Kept `.assistant-setting` (still used by the audio-clipper's volume-override checkbox) and `.image-finder` (still used as generic modal styling by the rename-asset and sign-in dialogs).
  - `cloudflare-worker.js` — removed the `POST /media-assistant/search` route (author auth check, OpenAI prompt, Wikimedia Commons query, and candidate assembly).
  - `server.mjs` — removed the local dev-server proxy for `/media-assistant/search`.
  - `wrangler.jsonc` — removed `/media-assistant/*` from `run_worker_first`.
  - `test/access-control.test.js` — removed the now-obsolete "media assistant requires author authentication" test and the `media-assistant` assertion in "media routes bypass the static-asset handler"; updated the slice-boundary marker in "closest-number guesses expose player identities…" from the removed route to the next real route (`/author-media/`) so the slice still isolates the intended handler.
  - `test/reliability-contract.test.js` — removed the obsolete "local authoring proxies image-assistant requests to the Worker" test and its now-unused `server` file read.
  - `test/image-suggestion-removal.test.js` — new. Asserts the panel, dialog, JS wiring, and backend route are all absent, and that the remaining paste/upload image actions are untouched.
  - `PRODUCT_SPEC.md` — removed the sentence describing the media assistant from the image-selection bullet (this file documents current behavior, unlike `CHANGELOG.md`'s historical log, which was left alone and instead given a new dated entry).
  - `CHANGELOG.md` — added one line under today's existing `## 2026-08-17` section.
- **Commands run and actual output:**

```
$ npm test
...
ℹ tests 143
ℹ suites 0
ℹ pass 143
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

  Before writing the new test file, verified it actually discriminates: `git stash push` on just the changed files (leaving the new test file in place) reproduced the pre-removal source, ran `node --test test/image-suggestion-removal.test.js` directly and saw it fail with the expected `doesNotMatch`/`/media-assistant/search` assertion error, then `git stash pop` to restore the fix.
- **One pre-existing, unrelated gap found and worked around:** a fresh `git worktree add` checkout has no `video-processor.worker.bundle.js` (git-ignored generated build output) and no `node_modules` (this repo's tests only need `node:` builtins, so `npm test` doesn't need `npm install`, but `npm run build:video` does need the `esbuild` devDependency, which isn't installed here). `test/deploy-manifest.test.js` failed on that missing bundle before I touched anything. Copied the already-built bundle from the main checkout (`Quiz Platform/video-processor.worker.bundle.js`) into this worktree to unblock a clean full-suite run; did not rebuild it, install anything, or touch `package-lock.json`. This file is git-ignored and irrelevant to my diff.
- **Could not verify:**
  - Did not open `author.html` in a browser to visually confirm the preview-column layout looks correct with the assistant panel gone, or that the per-image "⌄" menu (now containing only "Upload image") still opens/closes and looks reasonable with one item instead of two.
  - Did not deploy or exercise the live Cloudflare Worker — confirmed by source inspection and the regression test that `/media-assistant/search` is gone from `cloudflare-worker.js`, `server.mjs`, and `wrangler.jsonc`, but did not hit a running Worker to confirm the route now 404s.
  - Left the `source` parameter on `author.js`'s `uploadPrivateImage(file, optionIndex, source = null)` in place even though the only caller that ever passed a non-null `source` (`approveSuggestedImage`) is gone — it's dead but harmless (defaults to `null`, which is also what plain manual uploads already pass), and removing it would touch a function several other tests slice by name; left it rather than risk an unrelated regression for a cosmetic cleanup.

## 2026-08-18 — Host-side "presented by" override for the presentation title cards
- **Branch:** `claude/presented-by-override`
- **Feature (user-requested):** "Expose the PRESENTED BY text in the hosting screen… there should be an override in the hosting screen, so I can do a quiz for multiple audiences without creating a new version of the json." One quiz file, many audiences; the credit line changes per show, at host time, without editing or re-saving the quiz.
- **Files touched:**
  - `quiz-core.js` — new `resolvePresenterCredit(override, authoredPresenter)` and `DEFAULT_PRESENTER_CREDIT`. Per CLAUDE.md ("prefer putting new logic here… testability is the point"), the whole precedence rule lives in this importable module rather than inside `app.js`. A trimmed non-empty override wins; anything else falls back to `authoredPresenter ?? "ADO&S PRESENTS"`, which preserves the previous `??` semantics exactly (an authored empty string still hides the line).
  - `app.js` — five surgical edits: import the resolver; add `presenterOverride: ""` to `defaultState`; add `presenterOverride: state.presenterOverride || ""` to `publicRoomState()`; swap the two hardcoded `const presenter = titlePage.presenter ?? "ADO&S PRESENTS"` lines (in `presentationTitlePage()` and `finalScoreTitlePage()`) for the resolver; add `presenterOverrideControl()` rendered from `hostUtilityControls()`, plus an input/change handler next to the existing audio-volume handler.
  - `styles.css` — one `.host-presenter-override` rule block, placed beside `.question-jump` and matching its host-panel idiom (grid, `--line` top border, 12px purple label, muted 11px help text).
  - `test/presenter-credit-override.test.js` — new, 11 tests (see below).
  - `test/presentation-layout.test.js` — updated the existing "opening and closing presentation cards use the quiz-configured presenter line" test, which pinned the exact literal `const presenter = titlePage.presenter ?? "ADO&S PRESENTS"`. It now asserts both title cards call the resolver (`.match(...).length === 2`); the test's original intent, that the authored value drives the credit line, is preserved.
  - `PRODUCT_SPEC.md` — documented the override under "Host" and in the big-screen view's list. The **quiz JSON data model did not change** — `titlePage.presenter` already existed and is untouched — but the room-state payload gained a public field, so the spec now says where the override lives and that it is never written back.
  - `CHANGELOG.md` — one user-facing line under a new `## 2026-08-18` section.
### Design calls and why
- **Authoring was already done.** `author.js:406` already renders a "Presented by" input (`data-title-field="presenter"`, `maxlength="120"`), `quiz-validation.js:9` already bounds it, and `quiz.sample.json` / `music-trivia.question-bank.json` already carry `titlePage.presenter: "ADO&S PRESENTS"`. Per the task's instruction, I confirmed this and left it alone. The new host input reuses the same 120-character limit so the two fields cannot disagree.
- **Room state, not host-local state.** This was forced by the code, not a preference: `presentationTitlePage()` and `finalScoreTitlePage()` run in the **presenter** view, which fetches its *own* copy of `hostQuizDefinition` (`app.js` ~line 830, gated on the host secret). A host-local variable would never reach the big screen. `publicRoomState()` is the only payload the presenter receives, so the override rides there. It is a public credit line — the same class of data as the `quizTitle`/`quizSubtitle` already in that payload — so it leaks nothing to players.
- **Broadcast the raw override, not the resolved string.** The presenter resolves the override against its own authored copy. This keeps the fallback local, so clearing the override restores the authored line with no extra round trip, and it leaves existing no-override behavior byte-identical.
- **It survives a host reload, deliberately.** This came free and I kept it: `persistHostState()` writes `publicState: publicRoomState()` to the server, and the reload path merges `savedRoom.state` back into `state`. A host who refreshes mid-show should not silently lose the audience's name from the closing card. It is still per-session — scoped to the room, never to the quiz file.
- **Placed in `hostUtilityControls()`, which renders on all three host screens** (main, doors, finale). The closing card shows the same credit line as the opening one, so the host must be able to set or fix it at either end of a show.
- **No `render()` in the input handler.** It mirrors the existing audio-volume control exactly: `input` → update state + `emit()` (live big-screen update, no server write); `change` (blur/Enter) → also `persistHostState()`. A `render()` on keystroke would replace the host panel's `innerHTML` and destroy the input mid-typing. There is a regression test asserting the handler contains no `render()` call.
- **Presenter repaint needs no render-path change.** `presenterRenderKey()` destructures away only the non-visual fields (`activeClipId`, `audioCommand`, `revision`, `submitted`, `audioVolume`, `mediaCommand`) and stringifies the rest, so `presenterOverride` is in the key automatically and a change repaints the shared screen. I touched neither `render()` nor the gating in `receive()`, per the concurrent-agent coordination constraint. A test asserts `presenterRenderKey` does not strip the field.
## 2026-08-18 — Saved player identity was time-bounded but not room-scoped
- **Branch:** `claude/room-scoped-player-identity`, worktree `.claude/worktrees/claude-room-scoped-player-identity` off `main` at `b58adb7`.
- **Bug (user-reported):** "When a person tries to enter a NEW room with the same phone, they should get a new opportunity to pick a name and icon. Authentication shouldn't last forever. I just tested it and scanning the QR code with my phone immediately brings up my old name/icon."
- **Files touched:** `quiz-core.js`, `app.js`, `test/quiz-core.test.js`, `test/player-logo.test.js`, `CHANGELOG.md`, this file.
### Diagnosis (confirmed, not assumed)
The branch the user was unsure about *did* merge: `git merge-base --is-ancestor 22f24c3 main` exits 0, and `22f24c3` ("fix: expire saved player identity after a 6-hour session gap") is in `git log main`. It implemented the wrong axis for this symptom. It added `musicTriviaPlayerSessionAt` plus `isPlayerSessionExpired()` with a 6-hour TTL, clearing the identity only when the device had been idle that long. Nothing in it referenced the room. That commit's own worklog entry says so outright: "Did not scope the TTL by room code — the reported symptom is purely about elapsed time."
So a phone that played room `ABC123` an hour ago and then scanned the QR for the unrelated room `XYZ789` was well inside the TTL, `playerName` was still populated, and `renderPlayer()`'s `params.has("room") && !playerName` gate never fired — the join screen was skipped and the auto-rejoin branch (`app.js`, `view === "player" && params.has("room") && playerName`) joined the new room under the old name and logo. "How long ago did this phone play" and "which room did it play in" are orthogonal, and only the first had been built. Reproduced as a model rather than on hardware; see "Could not verify".
### Design decisions
**Room code as the key.** `public.room_code()` draws 6 characters from a 32-character alphabet, `sessions.room_code` carries a `unique` constraint, and `create_live_room` loops retrying on `unique_violation` (`supabase/migrations/0002_live_room_rpc.sql`). No migration deletes session rows, so a code is never recycled onto a later, unrelated game. The room code is therefore a durable identifier, not a reusable slot, and is safe to key persisted identity on.
**#3 — other rooms are RETAINED, not clobbered.** Identity is stored as a small map (`quizPlayerIdentities`) keyed by room code, each entry carrying its own `lastActiveAt`. Clobbering on each new join would be a few bytes cheaper and materially worse: a player who opens the wrong QR code (a stale poster, a neighbour's screen), picks a name, and then rescans the right one would have had their real room's token destroyed, and would rejoin as a brand-new player with a zeroed score — the exact catastrophic failure this task warned against, just triggered a different way. Same for a host running two rooms back to back who sends a phone back to the first. Retention costs a few hundred bytes; the map is pruned of expired entries and capped at `PLAYER_IDENTITY_ROOM_LIMIT` (8) most-recently-active rooms on every write, so it cannot grow without bound. Activity in one room never refreshes another room's clock — each entry expires on its own TTL.
**#4 — the legacy unkeyed identity is migrated onto the current room, but only with proof.** Phones in the wild hold the old flat `musicTriviaPlayerId` / `musicTriviaPlayerName` / `quizPlayerLogoKey` / `musicTriviaPlayerSessionAt` keys. Dropping them outright is the simplest option and was rejected: a deploy can land mid-game, and every phone in a live room would be shown the join screen, re-join under a fresh token, and be orphaned from its score — worse for a live-audience tool than the bug being fixed. Migrating blindly onto the current room is also wrong: the legacy blob carries no room information, so a phone that played a *different* room an hour ago would get the reported bug one last time.
The resolution uses evidence already on the device. `quiz-door-player:<roomCode>` is *already* room-keyed and is written by `rememberDoorPlayerRecord()` on every successful join and auto-rejoin (`join_live_room` always returns `playerId`, migration `0002`), so its presence proves this device genuinely joined *this* room. `migrateLegacyPlayerIdentity()` adopts the legacy identity onto the current room only when all of: the legacy name and token exist, `isPlayerSessionExpired()` says it is still inside the 6-hour TTL, the URL has a `room` param, and that room's door record exists. Otherwise it is discarded. Either way the legacy keys are removed from both storages, so the migration runs at most once per device. The original activity stamp is carried through rather than refreshed, so an adopted identity does not get a free TTL extension. Every failure mode of this gate falls toward *asking* for a name, never toward reusing the wrong one.
**#2 — the TTL was layered under, not replaced.** `PLAYER_SESSION_TTL_MS` and `isPlayerSessionExpired()` are unchanged and now do the per-entry expiry inside the store, plus gate the legacy migration. `savePlayerIdentity()` restamps on join, name/logo pick, and door pick — the same events `savePlayerValue()` stamped before — so the TTL remains a *session gap*, not a hard clock.
### Fix
`quiz-core.js` gained pure, directly unit-tested helpers: `readPlayerIdentityStore()`, `playerIdentityForRoom()`, `writePlayerIdentityForRoom()`, and `PLAYER_IDENTITY_ROOM_LIMIT`. All are string-in/string-out over the serialized store, so the room-and-TTL logic is testable without a DOM. `app.js` reads its identity through `playerIdentityForRoom(localStorage.getItem(PLAYER_IDENTITY_KEY), roomCode)` and writes it through `savePlayerIdentity()`; an unknown room yields no identity, so the existing `!playerName` join-screen gate fires naturally without being touched.
### Commands run and actual output
ℹ tests 160
ℹ pass 160
$ npm test        # baseline, before any edit
ℹ tests 149
ℹ pass 148
ℹ fail 1          # pre-existing: test/deploy-manifest.test.js, see below
$ npm test        # after the fix
ℹ tests 161
ℹ pass 161
## 2026-08-18 — Cheap independent tests, the sample fixture, and the product spec
- **Branch:** `claude/tests-and-spec`, worktree `quiz-tests-and-spec`, based on `b58adb7`. One of four parallel worktrees; this was batch **G** of `docs/reviews/2026-08-17-consolidated-plan.md` §4 — findings C30, C27, the fixture half of C18, and the fixture entry of C32. Deliberately the lowest-risk batch: no runtime code, no migrations. `app.js`, `author.js`, `quiz-core.js`, `quiz-validation.js`, `cloudflare-worker.js`, and `supabase/migrations/` were read but never modified.
- **Baseline correction.** The plan records `b58adb7` as 158 tests / 158 pass. In a clean worktree it is **149 tests, 148 pass, 1 fail**. The nine-test difference is `test/image-engine.test.js`, an untracked in-flight slice that exists only in the main checkout; the failure is `deploy-manifest.test.js` looking for the git-ignored `video-processor.worker.bundle.js`. The 2026-08-17 worklog entry above records copying that bundle in from the main checkout to work around it. That workaround should no longer be needed — see below.
### What landed
- `quiz.sample.json` — rounds 2, 3, and 4 had `"questions": []` and the matching finale had `"correctPairs": {}`. Filled all four. Rounds gained three questions each, chosen to widen type coverage from two types to nine (single choice, true/false, categorize, multiple choice, closest number, fill-in-the-blank, short answer, arrange-in-order, matching). Image selection and multi-blank were left out because both need real private media assets. The "Finish the Lyric" round is authored as song-title completion rather than lyric fragments; the real bundled bank already carries the actual lyric round.
- `test/quiz-fixtures.test.js` — new, 12 tests. Both fixtures through `validateQuiz`, a no-empty-round assertion, an answer-key-leak check over `toPlayerQuestion` at every nesting depth, an asset-ID sentinel check, a per-question scoring round trip against `tallyQuestionResults`, and a guard on artwork attached to `items`/`categories`.
- `test/migration-hygiene.test.js` — new, 2 tests. Migration prefixes unique, contiguous, starting at 0001. Worker table reads (including PostgREST `select=` embeds) checked against `grant select on table … to service_role` in the migrations.
- `test/deploy-manifest.test.js` — `generatedArtifacts` now also excuses the *referenced* bundle, not just the manifest entry, so a clean checkout is green without `npm run build:video`. Added `raw source media is never shipped` and `no shipped file carries a secret`.
- `test/scoring-contract.test.js`, `test/late-join-bonus.test.js`, `test/door-bonus.test.js` — ten test names relabelled `migration presence:` / `source presence:`, plus a header in each explaining they are change detectors, not behavioral proofs. No assertion changed.
- `PRODUCT_SPEC.md` — §3, §4, §5, §6, §7, §9, §11 corrected; new §7 "Score modifiers" and new §19 for shipped-but-unspecified features.
- `CLAUDE.md` — the "no asset IDs" player-privacy invariant amended to match the shipped, `0029`-endorsed design.
### Commands actually run
ℹ tests 165
ℹ pass 165
## 2026-08-18 — Presentation correctness (consolidated-plan batch D, plus C7)

- **Branch:** `claude/presentation-correctness`, from `b58adb7`. Worker session in the
  `quiz-presentation-correctness` worktree; held `app.js` exclusively for this round.
- **Slice:** findings C17, C6, C15, C9 from `docs/reviews/2026-08-17-consolidated-plan.md`
  (batch D), plus the **minimum-acceptable half of C7** added mid-session, because the quiz
  being played live today contains a `closest_number` question and C8 (no `select` grant on
  `session_players`) may already be breaking that route in production.
- **Commit order was deliberate.** C17 and C7 are each standalone commits touching regions
  no other commit in this branch touches, so either can be cherry-picked onto `main` alone
  before a show. Verified this rather than assuming it: cloned the worktree to a scratch
  directory, checked out `b58adb7`, and cherry-picked `cc18475` and `5256d44` each on their
  own — both applied cleanly, and C7's tests passed there. The scratch clone was thrown
  away; nothing was pushed, merged, or rebased, and the main checkout was never touched.

### What changed, per finding

- **C17 (`cc18475`) — `app.js`, one line.** `matchingBoard`'s empty-pool branch was a
  single-quoted string, so `${showingMatches ? …}` was never interpolated, and the
  `unassigned.length && !presenter` guard is always falsy on Presentation — the audience saw
  the raw source text for the whole question. Backticked it.
- **C6 (`58cbb47`) — `app.js`, `quiz-core.js`.** `publicRoomState()` published a revealed
  answer key for every type except `arrange_in_order`, and `toPlayerQuestion()` does not copy
  `correctOrder`, but `orderBoard` read `question.correctOrder` regardless. Presentation
  therefore fell through `orderedItems`' `999` fallback to the authored `items` order, and a
  player's phone showed that player's own submitted order — both under "Correct order", while
  Supabase had scored the real key. Added `revealedCorrectOrder`, and moved the whole
  `revealed*` block to `quiz-core.js` as `revealedAnswerKeys()`, paired with
  `revealKeyFor(question, phase, surface, revealed)`: host reads the definition, player and
  Presentation render only what was published. `REVEAL_KEY_FIELDS` covers `author.js`'s
  11-type allowlist and a test asserts that, so the next type cannot ship with one surface
  missing. A locked player now reads "Locked in — waiting for the reveal."
- **C7, minimum fix only (`5256d44`) — `app.js`.** `closestNumberResultEntries()` fell back to
  `realtimeClosestNumberGuesses` — only the submission broadcasts this tab happened to
  receive — whenever the authoritative Worker fetch had not succeeded, and
  `closestNumberResultsBoard()` re-derived the ranking, the tie set and the ★ from that
  subset. It now returns `null` when the authoritative list is not loaded, and the board
  renders an explicit state instead of a ranking. "Not loaded", "failed to load" and "nobody
  guessed" are three separate messages now rather than two.
- **C15 (`08db2cc`) — `app.js`, `quiz-core.js`.** `presenterRenderKey` moved to `quiz-core.js`
  and now excludes `screenHistory` and `scoreNotification` outright, and scopes `players` and
  `doorPicks` to the scenes that actually render them. `players` is kept for `title`,
  `round_end`, `final_podium`, `final_scores` **and phase `complete`** — the review's field
  list omits `complete`, but `renderPresenter` renders `presentationLeaderboard` there without
  going through a finale screen. `doorPicks` is kept for `door_choice`/`door_reveal`, where
  `doorChoiceCards()` reads it. Added `updatePresenterScoreCelebration()` so the toast is
  swapped in place rather than lost along with its remount.
- **C9 (`9721e12`) — `app.js`, `quiz-core.js`.** `rankPlayers()` in `quiz-core.js` is now the
  single ranking rule; the CSV export, host panel, Presentation scoreboard, player
  mini-leaderboard, final-scores pages and `playerFinale`'s own-finish position all use it.
  The host panel's "Holding the lead" caption followed position too and now follows rank.

### Tests

New: `test/presentation-boards.test.js`, `test/closest-number-board.test.js`,
`test/presentation-render-key.test.js`, `test/standings-consistency.test.js`; extended
`test/quiz-core.test.js`.

Several existing tests in this area assert against `app.js` **source text** with regexes and
would have passed regardless of these fixes — `presentation-layout.test.js`'s regexes matched
C17's uninterpolated literal happily. `app.js` cannot be imported under node (top-level DOM
side effects), so the new tests lift the functions under test out of `app.js` by name and
evaluate them against stubs for the module-level bindings. That renders real markup, which is
what these findings are about.

Three existing tests sliced `app.js` using `function presenterRenderKey` as a boundary and
broke when it moved. `test/reliability-contract.test.js` and `test/video-clips.test.js` had
their render-key assertions rewritten as behavioral ones against the imported function;
`test/door-bonus.test.js:66` and two `reliability-contract` slices were repointed at the next
marker. **`door-bonus.test.js:66` would have silently passed vacuously** once its boundary
vanished (`app.match(...)?.[0] || ""`), so I re-ran it and confirmed the regex still matches
1,291 characters rather than leaving it green and empty.

- **Commands actually run:**

```
$ npm test
ℹ tests 189
ℹ suites 0
ℹ pass 189
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2122.408605
Baseline before any edit was 149 pass / 0 fail, so the 11 new tests are the whole delta.
Verified the new tests actually discriminate rather than passing vacuously: backed `app.js` up to a scratch directory, reverted the `publicRoomState()` field and both resolver call sites to their pre-change form, and re-ran the new file — the two wiring tests failed as intended:
✖ the override travels to the presentation screen in the broadcast room state
✖ both the opening and closing title cards resolve the override against the quiz file
ℹ tests 11
ℹ pass 9
ℹ fail 2
Then restored from the backup and confirmed `md5` byte-identical to the pre-mutation file, `node --check app.js` clean, and the full suite green again.
- **No browser verification of any kind.** I did not run the dev server, open the host screen, or watch a real presentation screen update. Everything visual here — that the new control sits sensibly in the host panel, that `.host-presenter-override` looks right next to `.question-jump`, and above all that the credit line actually repaints live on the big screen when the host types — is argued from source reading and tests, not observed. This is the main thing to check live.
- **The two-tab live path is unproven.** The chain (host `input` → `emit()` → Supabase broadcast → `receive()` → `presenterRenderKey` differs → `render()`) is verified only structurally.
- **Host-reload persistence is unproven end to end.** It follows from `persistHostState()` writing `publicRoomState()` and the reload merging `savedRoom.state`, but I did not actually refresh a live host.
### Handoffs / notes for whoever is next
- **For the concurrent host-render-gate agent:** I added exactly one new host control and one state field; I did not touch `render()` or the gating in `receive()`. But be aware this is now a **text input on the host screen**, which is the known mid-typing-destruction hazard. My handler avoids self-inflicted re-renders, and because state is updated on every keystroke the input's `value` is repopulated correctly if some *other* code path re-renders — but the **caret position will jump to the end**, and an IME composition would be interrupted. If the render gate ends up re-rendering the host panel on unrelated events (a player submission, a presence ping), that will be user-visible as caret jitter while typing a credit line. The clean fix, if it becomes a problem, is to skip re-rendering while `document.activeElement` is inside the host panel — that belongs in the render-gating slice, not here, so I left it alone.
- **Pre-existing, unrelated:** a fresh worktree has no `video-processor.worker.bundle.js` (git-ignored generated output), so `test/deploy-manifest.test.js` fails until `npm run build:video` is run. Same gap the 2026-08-17 image-assistant entry hit. I ran `npm run build:video` rather than copying the bundle; installed nothing and did not touch `package-lock.json`.
- **Known limitation, left as-is:** a presentation screen opened without the host secret has `hostQuizDefinition === null`, so it already showed the default `"ADO&S PRESENTS"` rather than the authored credit, both before and after this change. The override still works there (it wins regardless of the authored value). Broadcasting the *resolved* credit instead of the raw override would incidentally fix that too, but it changes existing no-override behavior, so I judged it out of scope.
The 1 baseline failure was `test/deploy-manifest.test.js` — `author.js references "./video-processor.worker.bundle.js", which does not exist` — a git-ignored generated artifact absent from any fresh worktree, failing identically before I touched anything. As a previous session did, I copied the already-built bundle from the main checkout into this worktree to get a clean full-suite run; I did not rebuild it, run `npm install`, or touch `package-lock.json` (`node_modules` and its `esbuild` devDependency are absent here). The file is git-ignored and is not in my commit.
Verified the new tests actually fail without the fix, per TDD: restored `app.js` and `quiz-core.js` from `HEAD` into the worktree (backing my versions up to the scratchpad first, then copying them back) and re-ran the two test files — 4 structural tests in `player-logo.test.js` failed and `quiz-core.test.js` failed to load at all on the missing imports. Also confirmed the behavioural delta directly: with a store holding room `ABC123` last active one hour ago, a TTL-only lookup returns `"Belinkie"` for room `XYZ789` (the bug) while `playerIdentityForRoom()` returns `null`, and the same-room lookup still returns `"Belinkie"`.
### Not regressed
`test/player-logo.test.js`'s Android join-screen logo-layout test (commit `6532ffc`, the `min-height: 0` grid-row collapse) is untouched and passes; my change touches no CSS. The auto-submit test ("auto-submit skips a selection after its question has closed or changed") passes. Two pre-existing string-matching assertions in `player-logo.test.js` referenced storage mechanisms this change removes (`savePlayerValue("musicTriviaPlayerId", playerId)`, `savePlayerValue("quizPlayerLogoKey", playerLogoKey)`, and the `PLAYER_SESSION_ACTIVITY_KEY` wiring); I rewrote those assertions onto the new mechanism while keeping each test's original intent, and the behavioural guarantees they were proxying for are now covered by real unit tests in `quiz-core.test.js` instead of string matching.
- **No real device, no live room.** Everything is a `localStorage` model verified in unit tests plus structural assertions that `app.js` is wired in the right order. I did not open the app on a phone, scan a QR code, or watch a join screen appear. The manual steps to confirm are in the handoff.
- **The legacy migration path on a device that actually holds legacy keys.** The gate is asserted structurally and its TTL-carryover behaviour is unit-tested through `writePlayerIdentityForRoom()`, but I could not exercise a real phone whose storage predates this change. This is the highest-value thing for the user to spot-check on a handset that played before the deploy.
- **The `PLAYER_IDENTITY_ROOM_LIMIT` cap of 8.** A judgment call. Visiting a room writes an entry even before a name is chosen, so casually opening several room URLs inside one TTL window consumes slots; 8 is far above any realistic quiz night, and eviction is least-recently-active first, but the number is not derived from data.
- Did not touch `supabase/migrations/` — this is entirely client-side join-screen gating, no schema or server change.
ℹ duration_ms 388.194411
Both `validateQuiz` implementations were run over both fixtures from a scratch script (`author.js` exports nothing, so its private copy was extracted and evaluated for verification only, not committed):
=== quiz.sample.json ===        before          after
quiz-validation.js : 3 errors  →  []
author.js copy     : 4 errors  →  []
=== music-trivia.question-bank.json ===
both                : []       →  []
The fourth error in the shipped validator — `Round 5, question 1 needs complete clips, options, pair key, and positive points per pair` — is the empty `correctPairs`, and it is **not in any of the four review reports**. All four ran only `quiz-validation.js`, whose matching rule checks `!item.correctPairs` and so accepts `{}`.
### Verified the new tests discriminate
- Mutated a scratch copy of `quiz.sample.json` (emptied a round, planted artwork on an ordering card, added an option asset ID): four of the six fixture tests failed, and passed again on restore.
- Planted `sb_secret_…` in `assets/kaplan-k.svg`: `no shipped file carries a secret` failed, proving the walk reaches nested directory entries. Removed.
- The secret scan also asserts its own patterns still match a known-bad sample, so it cannot pass by matching nothing.
### What remains unproven
- **Nothing here was run in a browser or a live room.** The sample quiz is proven to validate and to score its own answer keys through the shared helpers. It was **not** loaded into a host session and played through, so the C18 host dead-end is proven closed only for the fixture, not for the `startRound` code path that produced it — that half belongs to whoever owns `app.js`.
- **The trivia answers in the new sample questions are not independently fact-checked by any test.** `quiz-fixtures.test.js` derives the correct answer from the key, so a wrong-but-coherent key passes. The test comment says so.
- **`test/quiz-fixtures.test.js` imports `quiz-validation.js`**, which is the module `prepare-deploy.mjs` ships and the existing tests use — but *not* the copy the editor runs on Publish. Both accept both fixtures today. When the two validators are merged (C19), re-point that import.
- **`migration-hygiene.test.js` pins one open defect rather than fixing it.** `session_players` is embedded by the closest-number guess board and granted to `service_role` by no migration. Closing it needs a migration number, which only Matthew assigns. The assertion is an exact match on the missing set, so it will fail when the grant lands and the exception is left behind.
- **`RUNBOOK.md` is now slightly stale.** It describes `quiz.sample.json` as containing "Placeholders for the five planned rounds." That file is outside this batch's ownership and was not edited.
ℹ duration_ms 419.449388
```

  Baseline in this worktree was 149/149, not the plan's 158 — the extra 9 are
  `test/image-engine.test.js`, another agent's untracked slice, which is not in this
  worktree. Same pre-existing `deploy-manifest.test.js` failure as the 2026-08-17 session
  (no `node_modules`, no git-ignored `video-processor.worker.bundle.js` in a fresh
  worktree); copied the already-built bundle from the main checkout to unblock a clean run,
  exactly as that session did. Nothing installed, `package-lock.json` untouched.

  Every fix was proven to fail first. For C6, C7 and C17 the new tests were written and run
  red before the patch. For C15 and C9, where the tests are new files, I re-ran them against
  the **pre-change** code in the scratch clone at `b58adb7`: C9's suite failed 5 of 6 there
  (only the CSV, already tie-aware, passed), and the four C15 remount paths were confirmed
  against a verbatim copy of the old `presenterRenderKey`.

  For C6 I also had to be sure moving `publicRoomState()`'s `revealed*` block did not change
  what it publishes: compared `revealedAnswerKeys()` against a verbatim copy of the seven old
  expressions across 780 question-shape × phase combinations — 0 differences.

### Deliberately not done

- **C7's real fix.** `/host-closest-number-guesses` should return the server's
  `winningDistance`/`isWinner`/`points` per row so Presentation only renders them. That needs
  `cloudflare-worker.js` (not mine this round) and a deploy. The minimum fix turns a
  confident wrong answer into an honest failure; it does not make the board work when the
  route is down. **C8's missing `grant select on public.session_players to service_role` is
  still unfixed and is the thing most likely to trigger this path today.**
- `realtimeClosestNumberGuesses` is still populated but no longer read. Left in place as the
  raw material for that later fix rather than removed as drive-by cleanup.
- **C9, final-scores pager.** Row ranks are tie-aware; the pager's
  `data-final-score-first-rank`/`-last-rank` attributes stay positional, because the status
  line means "Ranks 1–10 of 23" as a count of entries shown. Making those tie-aware would
  also require reworking the pager's total (the last page's last rank is no longer the player
  count when the tail is tied), in a `setTimeout`-driven DOM path I cannot exercise here.
- **The podium.** `finalPodiumCard`'s three places are a layout (2nd, 1st, 3rd blocks), not a
  ranking, so tied leaders still occupy separate plinths. Changing that is a design decision.
- Did not touch `author.js`, `quiz-validation.js`, `supabase/migrations/`,
  `cloudflare-worker.js`, `quiz.sample.json`, `PRODUCT_SPEC.md`, `CLAUDE.md`, or
  `styles.css`. No migration was added. `docs/reviews/2026-08-17-consolidated-plan.md` is
  untracked reference material and was left unstaged.

### Could not verify

- **Nothing here was checked in a browser.** No live room, no shared screen, no phone. All
  five fixes are proven by rendering functions in node and asserting on markup, not by
  looking at them. Per `RUNBOOK.md`, the things most worth a human glance are:
  - the matching clip pool actually reading "Listen for each clip" / "All items placed" (C17);
  - an `arrange_in_order` reveal on both Presentation and a phone (C6) — note that neither
    bundled fixture contains one, so this needs an authored question;
  - **the celebration toast still appearing and disappearing on Presentation after a manual
    score adjustment (C15).** This is the riskiest unverified change: the toast left the
    render key, so it now depends entirely on `updatePresenterScoreCelebration()` inserting
    and removing `.score-celebration` inside `.presentation-main`. If that is wrong, the
    toast silently stops showing on the shared screen. It builds the same DOM
    `renderPresenter` would and adds no wrapper element, so no CSS change was needed — but it
    has never been seen running;
  - the question image *not* blanking when a late player joins mid-question (C15);
  - a tied final scoreboard on the shared screen next to the exported CSV (C9).
- The closest-number "could not be loaded" state is unproven against a real failing Worker;
  it is proven only against a simulated failed fetch in the unit test.

## 2026-08-18 — Migrations 0034 (close the categorize drift) and 0035 (C4 / MIG F5)
- **Branch:** `claude/scoring-migrations`, worktree `../quiz-scoring-migrations`, based on `eba7276`. Numbers 0034 and 0035 assigned by Matthew; no other file created in `supabase/migrations/`.
- **Files:** `supabase/migrations/0034_categorize_partial_credit.sql` (new), `supabase/migrations/0035_prevent_double_scoring.sql` (new), `test/scoring-contract.test.js`, `CHANGELOG.md`, this file. Nothing else — `app.js` is held by a parallel worker gating the jump control that triggers C4, and no existing migration was edited.
- **0034 — closes the repo/production drift.** The live `lock_and_score_live_question` is not the one in `0030`: a `create or replace` was applied by hand in the SQL editor on 2026-08-18 before a live game, changing only the `categorize` branch to per-item partial credit (`docs/2026-08-18-live-fix-state.md` §1.2), and no migration was ever written. 0034 was generated mechanically from `0030` — a script asserts the exact old header and the exact old three-line categorize branch are present, then replaces them — so `diff -u 0030 0034` yields exactly two hunks: the header comment and the categorize branch. **Applying it is a no-op in production**, which already runs this body; that is stated in the file's header along with the `pg_proc` re-check query.
- **0035 — finding C4 / MIG F5, three parts.** Generated from `0034` (never from `0030`, which would have silently reverted partial credit), from `0025`'s `reveal_live_door_rewards`, and from `0002`'s `submit_live_answer`, each by a single asserted string substitution so the rest of every body is byte-identical to its source.
  1. `lock_and_score_live_question` now runs `delete from public.score_events where session_id = … and question_id = … and created_by = 'system'` immediately after locking submissions and before the scoring loop, and returns `replacedEvents` alongside `scoredResponses`. Re-locking a scored question replaces its automatic verdict instead of adding a second award. Only `system` events are cleared; `adjust_live_score` writes `host`, so manual adjustments survive.
  2. `reveal_live_door_rewards` now selects only choices `where revealed_at is null` for re-rolling. `choose_live_door` (0025) already clears `revealed_at` when a player changes door, so a new or changed choice still rolls while an already-revealed reward cannot be re-randomized by a host resetting the phase.
  3. `submit_live_answer` now raises `'Your answer to this question is already locked'` if the player's row for that question is `is_locked`. The phase check still fires first, so this only triggers after a reopen.
- **Delete over unique index, deliberately.** A partial unique index on `(session_id, player_id, question_id) where created_by = 'system'` fails to create if any existing session already carries duplicate system events from a past re-lock — the migration would be unrunnable against the live database with no way to know in advance short of a query — and it would turn a re-lock into a mid-show duplicate-key exception rather than an idempotent re-score. The delete has neither failure mode. Cost: the first scoring pass's events are not retained for audit. Mitigated, not solved, by returning `replacedEvents` so a re-score is visible rather than silent.
- **Tests.** Added five "effective definition" tests to `test/scoring-contract.test.js`. They read the whole `supabase/migrations/` chain and keep the *last* `create or replace function public.<name>` — what a full replay leaves in the database — rather than grepping one named file. That is the only shape of test that can catch the actual hazard here: a future migration rebuilt from an older copy of the function reverts partial credit or drops a guard with no conflict and no symptom. Four of the five fail with 0034/0035 removed; the fifth (`adjust_live_score` still writes `host`) is a coupling guard for the delete's `created_by` filter and correctly passes either way. Verified the silent-revert case directly by dropping a copy of `0030` in as a hypothetical `0036`: the partial-credit test fails and names `0036_hypothetical_revert.sql`.
- **Commands run and actual output:**
  ```
  $ npm test            # baseline at eba7276, before any change
  ℹ tests 255
  ℹ pass 255
  ℹ fail 0

  $ npm test            # after 0034, 0035, and the five new tests
  ℹ tests 260
  ℹ pass 260
  ℹ fail 0
  ```
  Also ran a stack-based `if`/`loop`/`case`/`begin` balance check over both new files, validated first against `0030`, `0025`, and `0002` as known-good controls: all bodies balanced.
- **Not verified, and cannot be from here.** There is no database in this environment and the repo's scoring tests only read SQL as text, so **nothing below is behaviorally proven**: that the delete makes a re-lock idempotent, that door rewards survive a phase reset, that a locked submission is refused, or that categorize partial credit still scores correctly after 0034/0035 land. Neither migration has been applied to any database. The manual steps Matthew must run in a throwaway room are in the session report.
- **Known follow-up left undone (not my file):** `submit_live_answer`'s new rejection string is not in `room-api.js`'s `SUBMIT_ANSWER_CONFLICT_REASONS`, so it classifies as `"unexpected"` and a blocked edit shows a save-failed state rather than the quiet abandoned state. It does not retry-loop and does not claim success, so it is truthful, but whoever owns `room-api.js` should add the mapping. Noted in 0035's header comment too.
- **Also still owed, unchanged by this session:** `0033_closest_number_player_names.sql` has still never been applied to the database (`docs/2026-08-18-pause-handoff.md` §1). 0034 and 0035 queue behind it.
## 2026-08-18 — Player + host recovery (consolidated-plan batch H)

- **Branch:** `claude/host-recovery`, from `eba7276`. Baseline confirmed before any edit:
  `npm test` → 255 tests, 255 pass, 0 fail.
- **Findings:** C16, C13, C11, C12, C14, C18 (host half), C4 (client half). Plus one
  mid-task request from the coordinator: map migration 0035's new `submit_live_answer`
  rejection.
- **Files touched:** `app.js`, `quiz-core.js`, `room-api.js`, `cloudflare-worker.js`,
  `test/host-recovery.test.js` (new), `test/player-submission-states.test.js` (new),
  `test/presentation-cue-freshness.test.js` (new), `test/answer-submission-recovery.test.js`,
  `test/reliability-contract.test.js`, `test/access-control.test.js`, `test/door-bonus.test.js`,
  `test/presentation-layout.test.js`. No migration, no `author.js`, no `styles.css`.

### What landed, per finding

- **C16 — `f151ee3`.** `updateTimer` set `timerExpiryLocking = true` and called an
  un-awaited `lockQuestion()`. Pressing R inside the RPC round trip started a second
  `lock_and_score_live_question()`, which lost the row lock and raised "The active question
  is not open" → `alert()` on the shared laptop, and `state.phase` never became `"locked"`,
  so `revealQuestion()` aborted. Fix: `classifyLockAndScoreError()` +
  `lockAndScoreWithRecovery()` in `room-api.js` (already-locked is benign; re-read phase,
  revision and leaderboard; refuse to claim a lock the server still reports as
  `question_open`), `autoLockDecision()` in `quiz-core.js`, and a single shared in-flight
  promise in `app.js`. The latch is now cleared after every attempt with a 2s backoff — it
  used to be cleared only by `startTimer()`, so one transient failure killed auto-lock for
  the rest of the show, silently.
- **C13 — `8c01c6b` (Worker) + `d7bfac7` (client).** `/host-submissions` mirrors
  `/host-text-answers`: verify the host secret through `get_host_live_room_state`, then read
  `sessions` and `submissions` on the service credential. **No migration needed** — `0028`
  already grants both tables. Returns `{ questionId, submissions: [{ playerId, answer }] }`.
  `restoreHostSubmissions()` merges it into `state.submitted` on reconnect via
  `mergeRecoveredSubmissions()` (recovered rows fill gaps; a broadcast that landed meanwhile
  wins) and patches the live regions rather than remounting the console.
- **C11 — `1c76c46`.** `submissionStatusView()` in `quiz-core.js` gives idle / sending /
  confirmed / failed / abandoned their own message and class. The outcome lives in module
  state plus a sessionStorage record that stores *which answer* was confirmed, so a redraw
  reconstructs the truth instead of reading a boolean that was set on the first success and
  never cleared. The manual Submit failure is inline beside the button instead of a modal.
- **C12 — `e87106d`.** Already fixed in the tree by `96e0416`; the assertion that looked like
  it covered this was inverted (below). Added a real guard for both paths.
- **C14 — `acf9548`.** `presentationCueDecision()` in `quiz-core.js` rejects a cue from
  another room/quiz, a duplicate, one not newer than the last applied, and a
  playback-starting cue of unknown or stale age on a fresh mount. `cueIdentity()` stamps
  `id`, `issuedAt`, `roomCode` and the quiz id on every audio and video cue. Arming no
  longer wipes the applied marker. `preparePresentation{Audio,Video}()` now report whether
  the commanded clip actually loaded, so an unavailable clip no longer plays the previous one.
- **C18 host half — `754df79`.** `firstPlayableRound()` and `nextPlayablePosition()` in
  `quiz-core.js`; `advanceQuestion()` and `startRound()` share them. An empty round is
  skipped; a tail of nothing but empty rounds records a diagnostic and goes to the finale.
- **C4 client half — `8f85d66`.** The jump control and `jumpToQuestion()` both require
  `?testing=1`. No migration touched — the server constraint is another worker's.
- **0035 rejection mapping — `c5fcc2a`.** "Your answer to this question is already locked"
  now classifies as `answer-locked` and abandons quietly instead of surfacing as a failure.

### Commands actually run

```
$ npm test            # on eba7276, before any edit
ℹ tests 255
ℹ pass 255
ℹ fail 0

$ npm test            # final
ℹ tests 295
ℹ pass 295
ℹ fail 0
```

Every new test was also run against baseline copies of `app.js` / `quiz-core.js` /
`room-api.js` / `cloudflare-worker.js` (extracted with `git show eba7276:<file>` into a
scratch directory) and confirmed failing there first.

### Two vacuous assertions found and repaired

- `test/reliability-contract.test.js` anchored the manual-submit ordering check on
  `await roomApi.submitAnswer`, which that handler stopped calling when the recovery wrapper
  landed. `indexOf` returned -1 and `-1 < n` passed regardless. Its slice also started at the
  *first* `[data-submit]` query — the text-input listener — sweeping in an unrelated host
  handler. Both fixed, with existence checks before every ordering assertion.
- `test/access-control.test.js`'s closest-number slice ran to `/author-media/` and would have
  silently swallowed the new route. It now ends at `/host-submissions`.

### Deliberate deviations from the plan

- **The cue does not carry a resolved `mediaAssetId`.** The plan asked for one, but the same
  command object is in `publicRoomState()` and reaches every player phone, and
  `test/video-clips.test.js` already forbids an asset id there. `cueAudioSource()` gives host
  and Presentation one shared resolution instead, which is what the asset id was for.
- **`styles.css` was not touched** (not in this session's ownership). The new
  `submission-pending` / `-confirmed` / `-failed` / `-abandoned` class names therefore have no
  rules yet; the legacy `submitted` (green) and `locked` (red) classes still carry the colour,
  so nothing renders unstyled — but a failure and a safely-locked question still *look* alike.
- **An empty tail goes to the finale** rather than raising an explicit host error. A modal on
  the shared laptop is the thing C16 exists to remove; the diagnostic records it instead.

### What remains unproven

- **Nothing here was seen in a browser.** No live room, no shared screen, no phone. See the
  report for the per-change manual checks that matter most.
- `/host-submissions` is exercised against a stubbed `fetch`, never against Supabase. It needs
  a deploy before the C13 client half does anything in production; until then
  `restoreHostSubmissions()` fails its fetch, records a diagnostic, and leaves the counter as
  it is today. **Deploying the client without the Worker is safe; the reverse is also safe.**
- The 20s cue-freshness window assumes host and Presentation share a clock (RUNBOOK has them
  as two tabs on one machine). A cue that appears to come from the future is treated as fresh
  so a skewed clock can never silence the shared screen, but a Presentation on a *second*
  machine with a >20s slow clock could reject a legitimate first cue after arming; pressing
  Play again issues a new cue and recovers.

## 2026-08-24 — Prompt Battle addendum 1: Workers AI free engine

**Branch:** `claude/prompt-battle-free-engine`
**Files touched:** `docs/superpowers/specs/2026-08-24-prompt-battle-free-engine-addendum.md` (new),
`docs/superpowers/specs/2026-08-17-prompt-battle-design.md` (2 pointers added, 9 insertions,
0 deletions), this file.
**No application code, no migrations, no dependency changes.**

### Slice

Reviewed a draft addendum (supplied by the user, authored by another AI, dated
2026-08-21) proposing free `cloudflare_ai` and `pollinations` adapters, and
wrote a corrected replacement. The draft is not adopted.

### Defects found in the draft

Verified against Cloudflare's model documentation on 2026-08-24:

- `@cf/black-forest-labs/flux-1-schnell` returns `{ image: "<base64 JPEG>" }` —
  a base64 string inside JSON. The draft wrapped that object in `new Response()`
  and read `arrayBuffer()`, which yields garbage, and labelled the output
  `image/webp` when it is JPEG. Both on the model it set as the default.
- The model has **no `width` or `height` parameters**. The draft passed both,
  and built a `resolution.split('x')` translation around them that silently
  yields NaN for the base spec's tier values ("1K", "2K") and falls back to 512.
- `executeParallel` performed fetches inside `image-engine.js`, contradicting
  base spec §7.3's purity requirement — the property that lets tests run from
  fixtures without live calls, per CLAUDE.md. It also introduced a
  `typeof adapter.executeParallel === 'function'` branch in the Worker, which is
  the failure mode recorded as mistakes.md #8.
- `Promise.all` fails fast, so one flaky variant discards every image from an
  attempt the player already spent.
- `maxSessionGenerations` was declared and cited as the free-tier safety bound
  but never implemented, leaving free sessions unbounded.
- `maxSessionSpendUsd: 0.0` was used to mean "unlimited", inverting the
  intuitive reading and turning a typo on a paid provider into a removed cap.

### Corrections made

Adapter contract changed to plural: `buildRequests()` returns a descriptor array
(`kind: "http" | "binding"`), the Worker owns all I/O through one dispatch path,
and `parseResponses({ results, expectedVariants })` folds results back. Seeds are
generated by the Worker and passed in, so the module stays deterministic and
testable. `Promise.allSettled` with explicit partial-success semantics: attempt
consumed if any image returns, refunded only at zero.

Pollinations rejected and the reasoning recorded, chiefly that its adapter
hardcoded `blocked: false` and could never report a safety block — the base
spec's moderation design depends on provider-side filtering as the first line
with host veto as the second.

Workers AI becomes the day-one slice 1 provider, replacing OpenRouter in that
role, so the entire adapter layer can be built and tested with no credential and
no spend. OpenRouter moves to slice 1b.

### Verified facts recorded in the addendum

flux-1-schnell input is `prompt` (1–2048 chars), `steps` (1–8, default 4), and
`seed`. Free allocation is 10,000 neurons/day at ~43 neurons per image, which is
roughly 230 images/day — about one full-size event per day, shared with
development testing. The draft did not state this constraint.

### Commands run

```
$ git checkout -b claude/prompt-battle-free-engine
Switched to a new branch 'claude/prompt-battle-free-engine'
$ grep -n "TBD\|TODO\|XXX\|FIXME" docs/superpowers/specs/2026-08-24-...-addendum.md
no placeholders
$ git diff --stat docs/superpowers/specs/2026-08-17-prompt-battle-design.md
 1 file changed, 9 insertions(+)
```

`npm test` was not run — no code changed and no test was added or modified.

### Self-inflicted issue, fixed

An early edit to the base spec wrote a bare 0xA7 byte, making the file invalid
UTF-8, and a byte-mode repair then stripped the trailing byte from five
legitimate `§` characters. Both were caught by an explicit UTF-8 decode check
and repaired; the final diff is 9 insertions and 0 deletions. Worth noting
because a text-only diff review would not have surfaced the encoding damage —
validate encoding explicitly after byte-level edits.

### Unproven / open

- No code exists. Every adapter in the addendum is specified, not implemented.
- `isWorkersAiSafetyRejection` is specified to return `false` until a real
  captured error fixture exists, because a misreported safety block tells a
  player to rewrite a prompt that was fine. Nobody has captured that error yet.
- The ~43 neurons/image figure is from secondary sources, not a metered
  measurement. The first real session should be checked against the account's
  neuron usage before anyone plans an event around the 230/day estimate.
- Whether flux-1-schnell's fixed output size is acceptable on the presentation
  screen has not been looked at. No image has been generated.

## 2026-08-24 — Prompt Battle slice 1: image-engine.js, the Worker test route, and the host test panel

**Branch:** `claude/prompt-battle-engine`, created from `claude/prompt-battle-free-engine`'s
tip (`28fa0e4`, main + the addendum doc), not from bare `main` — see "Judgment calls" below.
**Files touched:** `image-engine.js` (new), `test/image-engine.test.js` (new),
`test/battle-test-image-route.test.js` (new), `test/battle-test-panel.test.js` (new),
`cloudflare-worker.js`, `wrangler.jsonc`, `app.js`, `styles.css`, `CHANGELOG.md`, this file.
No migrations, no dependency changes, no player/presentation-view changes.

### Slice

Implemented exactly the scope given: the pure `image-engine.js` adapter layer
(`workers_ai` only, per the 2026-08-24 addendum's corrected plural
`buildRequests`/`parseResponses` contract), the `ai: { binding: "AI" }`
wrangler config, an authenticated `POST /battle/test-image` Worker route, and
a host-only title-screen test panel in `app.js`. openrouter, vertex, and the
Kaplan proxy remain unimplemented. No migrations, phases, pairing,
submission, voting, or scoring — as instructed.

### TDD

`test/image-engine.test.js` and `test/battle-test-image-route.test.js` were
both written first and watched to fail for the expected reason (missing
module; then a `TypeError` on `env.ASSETS.fetch` because the route did not
exist and every request fell through to the static-asset handler) before any
production code existed, then implemented to green. `test/battle-test-panel.test.js`
(the app.js source-grep regression tests) was written **after** the app.js
change, not before — disclosing this because the task's TDD instruction was
explicit and I don't want an undisclosed exception. It's a supplementary
contract test (host/title-screen gating, select-not-input, no `state.battleTest*`
leak path), not the mandated deliverable.

### Judgment calls

- **Branch base.** The task said "branch `claude/prompt-battle-engine` from
  main," but the addendum doc — marked REQUIRED reading — only exists on
  `claude/prompt-battle-free-engine`, one commit ahead of `main`. Flagged this
  to the user before branching; they chose branching from the current tip
  (main + the addendum commit) over bare `main`.
- **Deferred the OpenRouter bullet in addendum §11.** The addendum's test list
  includes "OpenRouter's adapter returns a single descriptor with `n:
  variants`..." but the task's own SCOPE section says to leave openrouter
  unimplemented this slice. Implemented every `workers_ai`-specific case in
  §11 and skipped that one bullet rather than build an adapter out of scope.
- **Fixed test-panel prompt/variant count.** The panel spec (base spec §7.5)
  lists a model menu, Test button, images, and cost — no prompt field. Used a
  fixed server-side test prompt and `variants: 2` (the addendum's schema
  default) rather than invent a free-text prompt field nothing asked for.
- **The 10-per-session cap is an in-memory `Map` keyed by room code** —
  explicitly non-durable (documented in a code comment): it does not survive
  an isolate restart/redeploy and is not shared across concurrently running
  isolates. A durable version needs the `session_battle_generations` table,
  which is a migration and out of scope this slice. This is the same
  limitation the parked `claude/prompt-battle-slice-1` WIP flagged; not
  fixed here for the same reason (no migrations this slice).
- **Found and did not touch `claude/prompt-battle-slice-1`.** A separate,
  explicitly `PARKED, UNFINISHED` branch from 2026-08-18 with the exact bugs
  the addendum's §4.1 catalogs (wrong output shape, wrong mimetype, `width`/
  `height` params the model doesn't accept). Left alone; nothing from it was
  reused.

### Commands run

```
$ git checkout -b claude/prompt-battle-engine
Switched to a new branch 'claude/prompt-battle-engine'
$ node --test test/image-engine.test.js        # RED: Cannot find module 'image-engine.js'
$ node --test test/image-engine.test.js        # GREEN: 13 pass
$ node --test test/battle-test-image-route.test.js   # RED: 8 fail (TypeError on env.ASSETS.fetch)
$ node --test test/battle-test-image-route.test.js   # GREEN: 8 pass
$ node --test test/battle-test-panel.test.js   # 5 pass (written after the app.js change)
$ npm test
ℹ tests 326
ℹ pass 326
ℹ fail 0
```
(300 pre-existing + 13 + 8 + 5 new. Full output pasted to the user in the
session transcript.)

### Unproven / open — the three things this slice was meant to check

None of the three could be checked with real data. `npx wrangler whoami`
succeeded once early in the session (reporting `Matthew.belinkie@kaplan.com's
Account`), but every subsequent attempt — including inside `wrangler dev` —
reported "You are not authenticated," and `CLOUDFLARE_API_TOKEN` is unset in
this shell (`printenv` confirms it; no `~/.wrangler/config` exists either).
Whatever supplied credentials for that one `whoami` call was not available
again, including to a backgrounded `wrangler dev`. I did not go looking for
a token to feed it — that would mean sourcing a credential from somewhere I
haven't been shown or asking the user to paste one into chat, and I don't
think either is the right move here. I built and left a throwaway probe
Worker instead (`ai-probe-scratch`, AI binding only, no Supabase dependency)
in the session scratchpad, and it's described to the user with copy-paste
commands so they (or a future session with working `wrangler` auth) can get
real numbers in under a minute:

- flux-1-schnell's real output dimensions/aspect ratio — not observed, no
  image has been generated by this session either.
- The real shape of a Workers AI safety-filter rejection — not captured.
  `isWorkersAiSafetyRejection` still returns `false` unconditionally, per the
  addendum's own instruction, pinned by a test that checks it doesn't guess
  at a shape from memory. This is now two sessions running into the same
  missing fixture.
- Real neuron cost per image — not measured. The ~43/image figure in the
  spec is still unverified against metered usage.

The host panel **was** exercised in a real browser this session (`npm run dev`
+ a browser tool, room code `zzverify` — never created, so no host secret was
stored for it and no real Supabase call fired): confirmed the panel renders
in the right spot on the host title screen with the model menu pre-selected,
confirmed it is absent from `?view=player` and `?view=presenter` for the same
room, and confirmed clicking Test with no host secret produces the inline
"Host authorization is required." state instead of a network call or a
crash. What this did **not** prove: a real generation round-trip.
`server.mjs` (`npm run dev`) is a static file server with no `/battle/test-image`
route — only `cloudflare-worker.js` has it — and `wrangler dev` needs the
Cloudflare auth this session doesn't reliably have (see above). So the
Worker route's actual behavior is proven by `test/battle-test-image-route.test.js`
(stubbed Supabase + fake AI binding) and by reading the code, not by a live
click-through.

## 2026-08-24 — Prompt Battle: multi-model Workers AI support

**Branch:** `claude/prompt-battle-engine` (continuing Sonnet's slice 1)
**Files touched:** `image-engine.js`, `cloudflare-worker.js`, `app.js`,
`test/image-engine.test.js`, this file. No migrations, no dependency changes.

### Slice

flux-1-schnell handled simple prompts but not complex compositional ones, so
the host test panel was extended to three more Workers AI models. Doing that
surfaced that these models do not share an input schema at all.

### The durable finding: Cloudflare's published schemas are wrong three times

Every item here is what the live API actually did, not what the docs say.

1. **`@cf/black-forest-labs/flux-1-schnell` rejects `seed`** with "Additional
   or unevaluated properties '/seed' at '/' not allowed", though the model
   page lists `seed` as an accepted optional parameter. (Found by the prior
   session; recorded here because it is the first instance of the pattern.)
2. **`@cf/black-forest-labs/flux-2-klein-4b` and `-9b` will not accept a JSON
   payload in any shape.** They require multipart/form-data: `env.AI.run()`
   must be called with `{ multipart: { body, contentType } }` where `body` is
   a form stream and `contentType` carries the MIME boundary. Cloudflare's own
   code example for these models shows a flat JSON payload and is simply
   incorrect. Both a flat payload and a `{ multipart: {...} }` plain object
   were rejected identically with "required properties at '/' are
   'multipart'", because no plain object can express a boundary.
3. **Step parameter names differ**: `steps` on flux-1-schnell and
   lucid-origin, `num_steps` on the FLUX.2 klein models.

These models also reject unrecognised properties outright rather than
ignoring them, which means a payload built for one model hard-fails on
another. That is why per-model profiles exist rather than one shared shape.

### Design

`WORKERS_AI_PROFILES` in `image-engine.js` owns protocol — payload shape,
parameter names, step counts, encoding. `BATTLE_MODEL_ALLOWLIST` in the
Worker is now purely deployment policy (may a host select this model). An
earlier version of this change put `steps` in the allowlist; that was wrong
once it emerged the models differ in parameter *names* too, and it was moved.

Descriptors gained an `encoding: "json" | "multipart"` marker. `image-engine.js`
still emits only inert data; the Worker's `runBattleDescriptor()` builds the
FormData and its stream, because a ReadableStream is single-use and
constructing one in the module would put I/O back into the pure layer that
the addendum's contract (section 2) exists to keep out.

### Findings that change the design

- **Variant diversity does not need `seed`.** lucid-origin returns visibly
  different variants from identical calls, so model non-determinism already
  supplies it. `seed` is never sent to any model.
- **lucid-origin is not materially better than flux-1-schnell** on complex
  compositional prompts, per the user's own testing, despite Cloudflare
  documenting it as having "exceptional prompt adherence" and exposing a
  `guidance` dial. Two of three free models have now failed the same way.
- **The free allocation cannot host an event.** 10,000 neurons/day, reset at
  00:00 UTC. lucid-origin costs ~755 neurons/image, so ~7 two-variant presses
  exhausted the day during testing. A 120-image round is ~90,600 neurons on
  lucid-origin, ~3,840 on klein. On Workers Free this is a hard stop mid-round;
  Workers Paid ($5/mo) turns the same moment into overflow billing at
  ~$0.011/1,000 neurons.

### Commands run

```
$ npm test
ℹ tests 335
ℹ pass 335
ℹ fail 0
```

Multipart wire format was verified locally (correct boundary, correct
Content-Disposition parts) rather than against the live API.

### Unproven

- **No klein image has ever been generated.** The multipart change moved the
  error from schema rejection (5006) to quota exhaustion (4006), which proves
  the request now passes validation. It does **not** prove the round trip
  works.
- **klein's output shape is unverified.** Cloudflare describes its output as a
  "multipart object containing image". `parseResponses()` reads
  `result.body?.image`, matching the other models. If klein returns a stream
  or a differently nested structure, the panel will report "no images came
  back" with no error at all. That is the next thing to check once quota
  resets, and it should not be mistaken for a regression in the fix.
- klein's output quality on a hard prompt — the only question that actually
  matters — remains completely unmeasured.
- `isWorkersAiSafetyRejection` still returns `false`; no real safety-rejection
  error has been captured from any model.
- Nothing here was verified against the deployed Worker by me; the user ran
  the live tests.

## 2026-08-25 — Prompt Battle slice 2: schema foundation and round pairing

Branch: `claude/prompt-battle-engine`

### Files touched

- `supabase/migrations/0036_prompt_battle_rounds.sql` (new) — the four battle
  phases, `session_battle_matchups`, `session_battle_entries`, and the three
  host RPCs `open_battle_round`, `set_battle_engine`, `get_host_battle_state`,
  plus the shared `host_battle_state_payload` projection helper.
- `quiz-validation.js` — `prompt_battle` round rules; a round with no `type` is
  still the ordinary question round, so both compatibility fixtures are
  unaffected.
- `room-api.js` — `openBattleRound`, `setBattleEngine`, `getHostBattleState`.
- `app.js` — host-only pairing panel (`battlePairingPanel`) and its two
  handlers; panel state is a module-level `battleRoundPanel`, never on `state`.
- `styles.css` — one line of panel styling beside the slice-1 `.battle-test-*`
  block.
- `test/battle-pairing.test.js` (new), `test/quiz-validation.test.js` — 18 + 9
  new tests.

### The migration is 0036, not 0033

The base spec numbers this migration `0033`. That number was taken by
`0033_closest_number_player_names.sql` before this slice was written, and the
chain now runs to `0035`. Migrations here are append-only and contiguous
(`test/migration-hygiene.test.js` asserts both), so renumbering or colliding
was not an option. Every spec reference to "migration 0033" for Prompt Battle
means this file.

### Judgment calls

- **The shuffle seed and the effective engine are session columns, not
  `sessions.state`.** `state` is returned verbatim to every player phone by
  `get_live_room_state()`. Dedicated columns keep both out of that payload
  without depending on a future editor of `publicRoomState()` remembering to
  filter them.
- **`open_battle_round` pairs `current_round_index` and does not go looking for
  the battle round.** Inferring the round would invent semantics slice 3 might
  have to undo. It raises `Round N is not a prompt battle round` instead. The
  consequence is in "Unproven" below.
- **`set_battle_engine` validates only the quiz's half of the allowlist
  intersection.** `BATTLE_MODEL_ALLOWLIST` lives in `cloudflare-worker.js` and
  SQL cannot see it; copying it into a migration would create the second
  divergent copy `mistakes.md` #8 is about. The Worker still checks its own
  allowlist against whatever it reads back, so the intersection holds end to
  end.
- **The model must be permitted by every `prompt_battle` round**, because there
  is one effective engine per session. For a one-battle-round quiz that is
  exactly "the round's `permittedModels`".

### Commands run

```
$ npm test
ℹ tests 362
ℹ pass 362
ℹ fail 0
```

### Applied and verified 2026-08-25 (same day)

Matthew ran the push. Verified afterwards read-only against the linked project
`jwrtxdmawjmkuvxgpmlq`, per mistakes.md #13 ("verify by querying the resulting
live function or schema, not only by trusting a zero exit code"):

- `supabase migration list --linked` — 0001..0036 all paired local/remote, no
  gap and no divergence.
- All four `battle_*` values present on `session_phase`; all three `battle_*`
  columns present on `sessions`.
- Both tables exist with `relrowsecurity = true` and **0 policies**, matching
  0025's shape.
- `service_role` has SELECT on both (the explicit grants) and **no**
  INSERT/UPDATE/DELETE. `anon` and `authenticated` have no SELECT at all, so
  the browser roles cannot read the pairing directly.
- `open_battle_round`, `set_battle_engine`, `get_host_battle_state` are all
  `prosecdef = true`; `host_battle_state_payload` is `prosecdef = false` with
  EXECUTE held only by `postgres` — the `revoke ... from public` took.
- `pg_get_functiondef` on the live definitions still contains the idempotency
  guard, the `least(player_ordinal / 2, matchup_count - 1)` three-way clamp,
  the `order by md5(shuffle_seed::text ...)` shuffle, the `phase::text`
  comparison, and set_battle_engine's permittedModels check. No drift between
  the migration file and what the database actually holds.
- The pairing arithmetic was **evaluated in the deployed Postgres** over
  `generate_series` for 2..9 players (a pure SELECT; nothing written). Result:
  every player placed, exactly one three-way on odd counts, always the last
  matchup, never a four-way. That table is now pinned in
  `test/battle-pairing.test.js` as "pairing places every player, and only the
  final matchup is ever a three-way".

The `alter type ... add value` + same-file function bodies pattern is therefore
no longer trusted on 0025's precedent alone — 0036 applied cleanly.

### Still unproven

- **No RPC has been called.** The verification above is schema and function
  *definition*, plus the pairing arithmetic in isolation. `open_battle_round`
  has never actually paired a real roster, because that needs a live room with
  at least two joined players and would write rows.
- **Idempotency is unproven as behavior.** The guard is present in the live
  definition; nobody has yet opened a round twice and confirmed the second call
  returns the first pairing.
- **The host cannot yet navigate the room into a `prompt_battle` round.** The
  phase machine for a question-less round is slice 3+; `startRound` cannot
  enter a round with no questions. So the "Open battle round" button only
  succeeds against a session whose `current_round_index` already points at the
  battle round, which today means setting it by hand. This is the smallest
  next step.
- **`set_battle_engine` has no UI.** It was specified as an RPC for this slice;
  the host engine menu is slice 3's work alongside `/battle/generate`.

## 2026-09-23 — First session on the work PC: live-state check, slice 2 review, editor draft-loss fix

Branch: `claude/battle-author-guard`, cut from `claude/prompt-battle-engine`
at `ee7b481` rather than from `main`, because the code being fixed (the
prompt_battle rules in `quiz-validation.js`) exists only on the battle branch.

### Live-state check (read-only, no deploy)

- `/__version` and `wrangler deployments list` agree: the live Worker is version
  `aa730648`, deployed 2026-08-25 15:19:52 UTC, with no deploy since. That is 70 s
  after `a6513bf` was committed.
- Live `app.js` is byte-identical (git blob hash) to the battle branch from
  `d595a7b` through `3618d9d`. Slice 2's panel (`battlePairingPanel`) and
  `openBattleRound` are **not** live.
- **The `/media` edge cache is live.** An authorized `GET /author-media/<id>`
  against the live Worker returned `200` with `cache-control: private,
  max-age=900`, which only `a6513bf`'s `toPrivateClientResponse` produces (the
  old code sent `private, no-store`). A 5.19 MB clip took 290 ms, then 190 ms on
  a repeat fetch. That fits a cache hit but does not prove one.
- Supabase org usage: the 12 Sep – 12 Oct cycle is at 0 / 5 GB for both egress
  and cached egress. The previous cycle's cached egress all fell on 13–18 Aug,
  before the fix, so the fix has not yet run under a live game.
- Author sign-in was broken ("Error sending magic link email", `POST /otp`
  → 500). Auth mail goes through Resend SMTP. The Resend domain
  `auth.matthewbelinkie.com` was **Failed** because its DNS records had gone
  from Cloudflare. Matthew re-added them; I confirmed them on 1.1.1.1 and
  8.8.8.8 and pressed Restart in Resend, after which sign-in worked. Session
  storage is per origin, so signing in on `workers.dev` does not sign in the
  custom domain.

### Slice 2 review (`3aab152`)

Two findings:

1. **Fixed here:** `validateQuiz` accepts a question-less prompt_battle round,
   but `author.js` assumes `round.questions` everywhere. Apply raw JSON / Import
   set `bank`, saved the draft (overwriting the previous one), then `renderNav`
   threw, the catch reported "Not applied", and `restoredDraft()` discarded the
   draft on refresh.
2. **Not fixed; slice 3 design input:** `open_battle_round` writes
   `sessions.phase = 'battle_prompt'`, battle fields in `state`, and a revision
   bump, but the host only stores the response in `battleRoundPanel`. The host's
   next `set_live_room_state` (0002) overwrites phase and state wholesale with
   no revision check, so the battle phase silently disappears. No surface
   renders `battle_prompt` either, so a reload in between falls through to the
   previous question's layout. Slice 3 must make the host adopt the returned
   phase/state, or move battle transitions onto `set_live_room_state`.

### Files touched

- `quiz-validation.js`: new export `editorUnsupportedRounds(candidate)`, one
  message per prompt_battle round.
- `author.js`: import it; both `#apply-raw` and `#import-file` throw its first
  message before `bank = candidate`, so neither the open bank nor the draft
  changes.
- `test/author-battle-round-guard.test.js` (new): 5 tests covering the helper
  plus a source contract that each handler checks the guard before assigning
  `bank`.
- `test/reliability-contract.test.js`: the exact-import regex now allows
  additional named imports from `quiz-validation.js`. Its intent (the shared
  validator, not a private copy) is unchanged.
- `CHANGELOG.md`: one line.

### Commands run

```
$ npm test
ℹ tests 368
ℹ pass 368
ℹ fail 0
```

The new test file failed before the change (missing export) and passes after.

Manual check, local `npm run dev` on 127.0.0.1:4173 in the in-app browser: saved
a draft, then pasted the bank plus a valid prompt_battle round into Apply raw
JSON. Status read "Not applied: Round 6 is a Prompt Battle round, which this
editor cannot edit yet…", the nav still showed 5 rounds, the saved draft was
byte-identical, and there were no uncaught errors. I removed the test draft
afterwards. The Import-file path was not exercised by hand; the source-contract
test covers it.

### Unproven / next

- Authoring a battle round in the editor is still unsupported. That is a later
  slice's UI.
- Review finding 2 above is open and blocks a working slice 3 phase machine.
- `HANDOFF.md` still says what is live is unknown and describes a local Docker
  build for the Cloud Run proxy. Docker is not installed on the work PC, so that
  route needs `roles/cloudbuild.builds.editor` from David. Not updated in this
  commit.

## 2026-09-23 — Prompt Battle slice 3a: entering and showing a battle round

Branch: `claude/prompt-battle-3a`, cut from `claude/battle-author-guard`.
Spec: `docs/superpowers/specs/2026-09-23-prompt-battle-slice-3a-design.md`.
Plan: `docs/superpowers/plans/2026-09-23-prompt-battle-slice-3a.md`.

This was built subagent-driven: one implementer per task, then a
spec-compliance review, then a code-quality review. The controller checked
each fix before moving on.

### What changed

- `quiz-core.js`:
  - `isBattleRound`.
  - `firstPlayableRound` / `nextPlayablePosition` reach a `prompt_battle`
    round, which is entered only from outside and never re-entered from
    inside.
  - `hostSavedPosition(state)`: while `battleRoundIndex` is set, a save
    records the battle round.
- `app.js`:
  - `battle_prompt` in both phase maps (save and reload).
  - Three integer-or-null fields in `publicRoomState()` and
    `playerRenderKey()`.
  - `enterBattleRound` / `openBattleRoundFromHost` / `endBattleRound` /
    `refreshBattlePairing` / `renderHostBattle`.
  - Host renders `renderHostBattle` for the whole battle round (start card
    with Open, `battle_prompt` with End).
  - N on the start card opens the round; N in `battle_prompt` does nothing.
  - P does nothing inside a battle round and never steps back onto a
    `battle_prompt` history entry.
  - Player holding screen; Presentation `presenterBattlePrompt()` and a
    "Prompt Battle" phase label.
  - `battleRoundDefinition` removed (unused).
- `styles.css`: one line for the Presentation battle card.
- Tests:
  - `test/battle-phase-3a.test.js` (new).
  - `test/battle-pairing.test.js`: the call-site count is now 1 (in
    `renderHostBattle`). The privacy regex was narrowed from
    `/state\.battleRound/` to the pairing names, then tightened with spread
    and `Object.assign` checks.

### Judgment calls and review fixes

- **The host adopts `open_battle_round`'s result** and saves it through
  `set_live_room_state` (review finding 2). The host stays the only phase
  writer. No migration.
- **`enterBattleRound` moves `state.question`'s round number and title** to
  the battle round, so the progress bar, round labels and the later round-end
  card name the right round.
- **Plan error:** the `/state\.battleRound/` narrowing belonged in Task 3, not
  Task 4. The Task 3 implementer stopped at 379/1 instead of editing outside
  its scope. The plan was corrected in `22476d1`.
- **`fc45920`:** the battle start card was drawing the previous round's last
  question (prompt, audio/video controls, "Opening the first question…").
  Also, P after End restored a broken `battle_prompt`. Both fixed.
- **`3099048`:**
  - **Stale-pairing race:** with two adjacent battle rounds and a fast second
    N, `open_battle_round` could return round A's pairing while B's save was
    in flight. Open now refuses a pairing whose `roundIndex` differs from
    `state.battleRoundIndex`, and asks the host to press Open again.
  - The battle screen keeps `hostUtilityControls()` and
    `manualScoreControls()`, per spec §5.
- **`811a1d3`:** the player battle screen was missing `shell(..., true)`, so it
  had no player styling and no score celebration. That was a plan-code bug.
  It also gained `playerIdentityBadge()`, which shows only the player's own
  name and logo.
- **No CHANGELOG line yet.** CLAUDE.md allows one only for verified work, and
  the battle path has not run in a real room. Add it after the rehearsal.

### Commands run

```
$ npm test          # after each task: 374, 377, 380, 387, 388, 390, 392, 392
ℹ tests 392
ℹ pass 392
ℹ fail 0
```

Manual check, local `npm run dev` in the in-app browser:
- The editor still refuses a battle round ("Not applied: Round 6 is a Prompt
  Battle round…").
- Host, player and Presentation all load with no console errors.
- The local demo plays start → question → reveal → finale with no errors.

The local demo has no battle round, so **this proves only that nothing
regressed**. No real room was used and nothing was deployed.

### Known limits (deliberate)

- A battle round cannot be round 1. Room setup and host reload need a question
  in round 1.
- End battle round awards no points and leaves the matchups unresolved. Slices
  4 and 5 replace it.
- There is no audio stop on the battle screens. A long round-start cue plays on
  until End cues `roundEnd`.
- The Presentation shows the round title twice, in the heading and in the card.
  This is cosmetic.
- `preparePresentationVideo()` preloads the previous question's video, if it
  had one, from the stale `questionId`. This already happens on round cards and
  was not introduced here.
- Tasks 1–3 alone would dead-end a host at a battle round. Only ship them
  together with Task 4.

### Still unproven

- **The whole battle path in a hosted room.** That covers walking into the
  round, Open, adoption, the Presentation and phones, host reload in both
  battle screens, a repeat Open (idempotency), and End. It needs a real-room
  rehearsal against production Supabase (plan Task 8), which needs Matthew's
  approval and a published quiz containing a battle round. The editor cannot
  author one yet.
- This would also be the first real call of `open_battle_round` on a real
  roster, which slice 2 left unproven.

### Final whole-branch review (same day)

Verdict: ready with notes. Fixed on this branch:

- **`6571de0`:**
  - **Save recovery:** after a failed save recovers, the battle screen
    re-renders (`renderBattleAfterSaveRecovered`), so Open is no longer stuck
    disabled.
  - **One refresh path:** Refresh pairing goes through `refreshBattlePairing`
    with the same `roundIndex` check as Open. `runBattleRoundCall` removed.
  - **Reload screen:** a reload into `battle_prompt` also sets
    `presentationScreen = "battle_prompt"`. `open_battle_round` does not write
    it, so after a lost Open response phones and Presentation stayed on the
    round-start card.
- **`1352800`:** Refresh pairing shows its busy state and a missing-secret
  error again. These were lost when `runBattleRoundCall` was removed.

`npm test`: 396 pass, 0 fail. Checked only by source-contract tests, not by
hand.

Deferred to slice 3b:

- **Doors mislabel after a battle round.** Pressing P from the doors after a
  battle round restores the round-end card with the previous question round's
  number, and the save records that round. `screenSnapshot()` does not carry
  the battle relabelling.
- **Doors multiplier with no points.** Doors before a battle round target it,
  but 3a awards no points there. Slice 5 must decide whether doors skip a
  battle round or carry over.
- **Duplicated phase maps.** The save and reload phase maps
  (`hostStatePayload` and `connectHostedRoom`) are hand-written inverses.
  Every new battle phase has to be added to both. Consider one shared map in
  `quiz-core.js`.

## 2026-09-30 — GitHub ticketing setup (PROJECT_OPERATING_PLAYBOOK)

Branch: `claude/github-ticketing` (from `main` at `765e04b`). Model: Sonnet 5.5.

**Slice:** stand up the playbook's GitHub Issues + Projects system for this repo.

**Files added:** `docs/PROJECT_OPERATING_PLAYBOOK.md` (verbatim copy),
`docs/roadmap/config.json` (live Project/field/option IDs), `docs/roadmap/routing.md`
(Haiku 4.5 / Sonnet 5.5 ceiling, Opus escalation rule), `.github/ISSUE_TEMPLATE/work-contract.md`.

**GitHub objects created (mbelinkie):** Project #4 "Brainstorm Roadmap" (linked to
`mbelinkie/brainstorm`); Status options replaced with the 7 playbook values; fields Priority, Size,
Workstream, Acceptance; labels `model:economy`, `model:standard`, `effort:low|medium|high`,
`escalation:opus`, `setup-test`. Issues #1/#2 are `[SETUP TEST]` (closed); #3-#8 are Inbox
placeholders for unbuilt playbook pieces.

**Commands run:** `gh project create/field-create/link/item-add/item-edit`, a GraphQL
`updateProjectV2Field` (Status options) and `addBlockedBy`, `gh label create`, `gh issue create/close`.
Lifecycle test: #1 Inbox→Backlog→Ready→In progress→In review→closed→Done; #2 (blocked by #1) was
moved to Ready only after a live read showed #1 CLOSED/COMPLETED. Final live read: both Done.

**Unproven / pending:**
- Gates were applied **by hand**. No lifecycle wrapper, API budget gate, or progress view exists (#3-#5).
- Built-in Project workflows were not inspected (not exposed by API). Closing #1 did not set Done
  by itself after the Status options were replaced, but the rule config itself is unverified (#8).
- Board/table views, and a Backlog/auto-add rule, were not created (no API); UI step.
- No backups claimed (#7). Worktree guards not built (#6).
- Jira was initially assumed, then corrected to GitHub before any work started.

Follow-up (same day): added the roadmap pointer section to `CLAUDE.md` at Matthew's request.
Project workflow audit (#8) and board/table views were attempted via the in-app browser, which
timed out (pane hidden); they remain pending. Branch push was requested but not performed.

Follow-up 2 (same day, Claude in Chrome): workflow audit done in the Project UI (#8 commented).
'Item closed' and 'Pull request merged' are Off (error icon after the Status options were
replaced); only 'Auto-add sub-issues' is On. Created a Board view and renamed View 1 to Table
(fields: Labels, Parent issue, Priority, Size, Workstream, Acceptance added and saved; verified
via the GraphQL view `fields`). The Board view's fields were not customised, and Board is grouped
by Status by default. Auto-add to project was not configured. Push still not performed.

## 2026-09-30 — Prompt Battle MVP ticket set

Branch: `claude/prompt-battle-tickets` (from `origin/main` at `f5be228`). Model: Sonnet 5.5.

**Slice:** break the Prompt Battle MVP (Gemini via Kaplan's Cloud Run proxy) into bounded GitHub
issues with explicit dependencies, so they can be spun up one at a time.

**Merged first:** PR #9 (ticketing setup) into `main` at Matthew's request.

**Read:** the Prompt Battle architecture spec, base design and slice 3a design (from
`claude/prompt-battle-3a`; they are not on `main` yet), and Kaplan's approval ServiceNow
RITM0207043 (read-only, in Chrome).

**Created on GitHub (mbelinkie/brainstorm):** issues #10-#44 — two goals (#10 MVP, #11 post-MVP)
and 33 work issues, all in Backlog on Project #4 with Priority, Size, Workstream, Acceptance,
`model:`/`effort:` labels, native blocked-by links and sub-issue links. #12 (merge the Prompt
Battle branch) gates almost everything because slices 1-3a exist only on an unmerged branch.

**Facts from the approval now in the issues:** project `quiz-platform-image-generation`, model
`gemini-3.1-flash-image`, Sandbox / Internal, $75/month budget (an alert, not a hard cap),
internal Kaplan activities only, no data stored in GCP. Gaps flagged in the issues: the service
account's `roles/aiplatform.user` is requested but not confirmed granted; no per-image prices;
no region stated.

**Incident:** the generator hit a GitHub 504 on `project item-add` for #36, leaving the issue
created but not on the board or in the local state file. Reconciled by hand (item added, state
repaired) before resuming, so no duplicates. The generator now retries idempotent calls and never
retries issue creation.

**Commands run:** `gh issue create/view`, `gh project item-add/item-edit`, GraphQL
`addBlockedBy` / `addSubIssue`, `gh issue edit`. Final checks: 35 issues > #8, 0 duplicate
titles, 0 `#?` placeholders, board shows Backlog 35.

**Not done / unproven:** no issue is Ready (the lifecycle wrapper, #3, is still unbuilt; gates are
manual). Migration numbers are deliberately unassigned. Per-image Vertex prices and the SA role
are unverified. The generator script lives only in the session scratchpad (not committed); the
issues themselves are the source of truth.

Follow-up (same day): spun up #12 and wrote the #3/#4 contracts.

- **#12 (merge Prompt Battle branch):** Ready gates checked by hand against live state, claimed (comment on the issue, Status In progress), merge prepared on `claude/merge-prompt-battle` as `2f30bcd` (parents `f5be228`, `df700f1`). `npm test` on the merged tree: 396/396. Only conflict was `docs/CLAUDE_WORKLOG.md`, union-resolved in date order. Status In review; Claude did NOT merge into `main` or push; Matthew accepts by merging.
- **#4 (API gate) and #3 (lifecycle wrapper):** replaced the Inbox placeholders with full contracts, `model:standard`/`effort:high`, Backlog. Split the wrapper into #3 (inspect, ready, claim, block) and new #45 (review, complete, stale-claim recovery). Order is #4, then #3, then #45, because the playbook requires all GitHub traffic to go through the gate. Native blocked-by links set. #5-#7 left in Inbox as agreed.
- **Unproven:** no wrapper or gate code exists yet; every gate is still manual. #12 is not Done until Matthew accepts.

## 2026-10-01 — Roadmap API gate (issue #4)

Branch: `claude/roadmap-api-gate` (from `origin/main` at `f5be228`). Model: Sonnet 5.5.

**Slice:** playbook section 5. One audited GitHub transport with budget protection, so the lifecycle wrapper (#3, #45) and a progress view can be built safely.

**Files added:** `scripts/roadmap/{rate-limit,lock,gate,github-transport,bypass-check,probe}.mjs`, `scripts/roadmap/README.md`, `docs/roadmap/transport-inventory.md`, `test/roadmap-{gate,transport,bypass}.test.js`. No dependency or package.json change; `scripts/` is not in the deploy allowlist so it cannot ship.

**Design points worth knowing:** refusals are returned as `{ok:false, code}`, never thrown; the gate never replays a write (an uncertain mutation must be re-read by the caller); a throttle is recognised only from status, headers and the structured RATE_LIMITED error, never from words in a body; nested truncated connections fail closed by default; `gate.session()` holds the lock across several operations for the wrapper.

**Commands run:** `node --test` on the three new files (42/42); `npm test` (342/342, was 300 on main); mutation check on a scratch copy: five deliberate breakages (missing-quota allowed, live lock evicted, null coerced to 0, no mutation spacing, body text as throttle) each failed the intended test; one allowed live probe (`gh api graphql --include` rateLimit, then `node scripts/roadmap/probe.mjs`): gate reading 4020 vs raw 4021, consistent with the one point its own call spent.

**Unproven / limits:** the lock is host-local only (two recoverers of one dead lock have a narrow race; PID reuse reads as alive, the safe direction); the real transport was exercised live only for the rate-limit read and `/rate_limit`, not for mutations (those run against #3/#45); no caller exists yet besides `probe.mjs`. About 980 of 5000 GraphQL points were already spent this hour by ad-hoc ticket creation, which the gate could not see.

## 2026-10-01 — Lifecycle wrapper part 1 (issue #3)

Branch: `claude/lifecycle-wrapper-1` (from `origin/main` at `eace950`). Model: Sonnet 5.5 (`claude-sonnet-5-5`); session `CLAUDE_EFFORT` read `medium` against the `effort:high` label (recorded on the claim).

**Slice:** `inspect`, `ready`, `claim`, `block` on top of the #4 gate. Spin-up was by hand (the wrapper did not exist): read live state, set Ready, posted the `claim:v1` comment, set In progress.

**Files:** added `scripts/roadmap/lifecycle.mjs`, `scripts/roadmap/lifecycle-core.mjs`, `test/roadmap-lifecycle.test.js`; edited `docs/roadmap/config.json` (additive `routing` block only), `scripts/roadmap/README.md`, `docs/roadmap/transport-inventory.md`. No package.json change; no CHANGELOG line (tooling).

**Judgment calls (flag for Matthew):** `model:economy` is mapped to efforts low/medium only (routing.md is silent; `ROUTING_UNSUPPORTED` fires on economy+high). Execution ID = explicit `--execution-id` that must equal `CLAUDE_CODE_SESSION_ID` and differ from any parent-session variable. Claims by anyone count as live; only owner comments end a claim or prove acceptance (public repo). A worktree must be a name, never an absolute local path. `block` records routing changes as proposals and does not edit labels.

**Commands run:** `node --test test/roadmap-lifecycle.test.js` (59/59); `npm test` (497/497, was 438); read-only live `lifecycle.mjs inspect 12` and `ready 12 --dry-run` (refused ISSUE_CLOSED, no write); mutation check on a scratch copy: removed the duplicate-claim guard, the prerequisite-Done check, the partial-write reconcile, and the dependency-mismatch check; each failed the intended tests, control 59/59.

**Unproven:** the real transport has not yet performed these mutations live (ready/claim/block writes are covered only by the fake); the execution-id check cannot tell a child from its parent if the runner exposes no parent variable; lock is host-local; stale-claim recovery, review and complete are #45.

## 2026-10-01 — Lifecycle wrapper part 2 (issue #45)

Branch: `claude/lifecycle-wrapper-2` (from local `main` at `cd15757`, which is #3 merged; `origin/main` was still `eace950`). Model: Sonnet 5.5. Spin-up used the new wrapper itself: `ready 45` then `claim 45 --allow-mismatch` (session effort `medium` vs `effort:high` label), the first live writes the wrapper has made.

**Slice:** `review`, `verify`, `complete`, `stale`, `release` in `scripts/roadmap/lifecycle-finish.mjs`; new parsers and renderers in `lifecycle-core.mjs`; `lifecycle.mjs` gained the CLI ops and passes its internals to part 2. Tests: `test/roadmap-lifecycle-finish.test.js` (30) with a shared fake in `test/helpers/roadmap-world.js`. The part 1 test file is untouched (it keeps its own copy of the fake).

**Judgment calls (flag for Matthew):** an Automated issue completes on an independent `verify:v1` record (a different execution than any claimant or reviewer) or on the owner's acceptance; External needs the evidence line in the review; Producer needs the owner's acceptance naming the tested commit after the review. Reachability uses the GitHub compare API against `main` (identical/behind = reachable). `release` is the stale-claim restart and needs an operator name plus written evidence; a run cannot release itself. The close mutation exists only in `lifecycle-finish.mjs`.

**Commands run:** `node --test` on both lifecycle files (89/89); `npm test` (527/527, was 497); mutation check on a scratch copy of six breakages (self-verification allowed, reachability skipped, Automated bare self-report accepted, no re-read check, release without evidence, recorded-completion check removed), each failing the intended tests, control 30/30.

**Unproven at this point:** the live `[SETUP TEST]` run and the Producer confirmation; `complete` against the real compare API; the commit must be pushed before #45 itself can be completed.

## 2026-10-01 — Accepting and merging #12 and #4; contributor guide

Branch: `claude/roadmap-docs` (worktree `../quiz-roadmap-docs`, from `main` at `eace950`). Model: Sonnet 5.5.

- **Accepted by Matthew in chat and merged:** #12 via PR #46, #4 via PR #47. `npm test` on `main` after both: 438/438. Both issues closed with `complete:v1` comments and set Done by hand (the lifecycle wrapper does not exist yet). PR bodies deliberately avoid `Closes #N` so only the acceptance step closes roadmap issues.
- **Added** `docs/roadmap/WORKING_A_TICKET.md`: how a person or session on another machine finds an eligible ticket, claims it, branches into a worktree, works, reports and stops. Every command in it was run against the live repo (the status helper only as an idempotent no-op on #12).
- **Backfilled** the two work-log entries from the unpushed `claude/prompt-battle-tickets` branch (ticket set; spin-up of #12 and scoping of #3/#4) in date order. That branch can now be deleted once nobody needs it.
- **Mistake to record:** I ran `git switch -c` in the main checkout while another session had `claude/lifecycle-wrapper-1` checked out there, which briefly changed its branch. Restored within seconds (tree was clean, branch had no commits). Lesson, now in the guide: check `git worktree list` and `git status` before any branch switch, and use a worktree per session.
- **Updated after #3 and #45 landed on `main`:** rewrote the guide around `scripts/roadmap/lifecycle.mjs` (inspect, ready, claim, block, review, verify, complete, stale, release); removed the hand-written comment templates and the manual status helper. Ran the read-only commands against live issues (`inspect 13`, `ready 13 --dry-run`, `ready 19 --dry-run` refused with PREREQ_* codes, `stale 12`, and a `claim` with no session id refused with EXECUTION_ID_MISSING before any write). No claim, review or completion was performed. Pushed and merged through a PR at Matthew's request.
- **Open question for Matthew:** the wrapper identifies a run by `CLAUDE_CODE_SESSION_ID`, so a person at a plain terminal cannot claim. The guide says to work through a Claude Code session or ask him; whether to allow a self-asserted ID is his call.

## 2026-10-01 — DeepSeek orchestration (issue #51)

Branch: `codex/deepseek-orchestration` (from `main` at `271a47d`). Model: DeepSeek V4 Pro (`deepseek-v4-pro`), executed through the Codex DeepSeek profile. Execution ID: `01a0f5de-3bac-7d30-a5e7-44da0c60c7a9` (this run's own `CODEX_THREAD_ID`).

**Slice:** retired the Claude model ceiling and Opus escalation for a DeepSeek routing (`model:economy` = `deepseek-flash`, `model:standard` = `deepseek-v4-pro`; logical `low`/`medium`/`high` labels mapped to runner effective `low`/`high`/`high`, recorded separately on the claim). Added Codex execution identity (`CODEX_THREAD_ID`, with `CODEX_SESSION_ID` trusted only when it equals the thread id) alongside the legacy `CLAUDE_CODE_SESSION_ID`, failing closed on conflicting/ambiguous environments. Added `tools/codex-batch.mjs` (sequential batch dispatcher) and `tools/batch-core.mjs` (pure selection/budget/head/reconciliation logic); the dispatcher reuses the shared gate for the project scan, PR lookup/creation and merge, and keeps run state/logs outside git.

**Files:** edited `docs/roadmap/config.json`, `docs/roadmap/routing.md`, `scripts/roadmap/lifecycle-core.mjs`, `scripts/roadmap/lifecycle.mjs`, `scripts/roadmap/lifecycle-finish.mjs`, `scripts/roadmap/README.md`, `docs/roadmap/transport-inventory.md`, `docs/roadmap/WORKING_A_TICKET.md`, `CLAUDE.md`, `docs/CLAUDE_WORKLOG.md`, `test/roadmap-lifecycle.test.js`, `test/roadmap-lifecycle-finish.test.js`; added `tools/codex-batch.mjs`, `tools/batch-core.mjs`, `test/batch-core.test.js`, `test/codex-batch.test.js`. No dependency change; no CHANGELOG line (internal process tooling).

**Commands run:** `node --test test/roadmap-lifecycle.test.js test/roadmap-lifecycle-finish.test.js test/roadmap-bypass.test.js test/roadmap-gate.test.js test/roadmap-transport.test.js` (136/136); `node --test test/batch-core.test.js test/codex-batch.test.js` (17/17); `npm test` (549/549).

**Unproven / outstanding:** live GitHub writes (ready/claim/review for #51) could not be performed — the `gh` token for `mbelinkie` is invalid and unauthenticated requests are rate-limited (403), which is exactly the bootstrap exception #51 records; the real CLI run, Sol review, PR, merge and completion are left to the orchestrator. The batch dispatcher and its provider balance/worker/Sol spawns are covered by offline fakes only.

## 2026-10-01 — DeepSeek orchestration repair (issue #51, PR #52)

Branch: `codex/deepseek-orchestration` (from `main` at `271a47d`). Model: DeepSeek V4 Pro (`deepseek-v4-pro`). Execution ID: `01a0f5f9-a3cc-7a12-b5c1-81cf4a9ffe6d` (this run's own `CODEX_THREAD_ID`; the earlier `01a0f5f2-ac82-7862-8f3e-710e1a59ae82` attribution was incorrect).

**Slice:** consolidated repair of the batch dispatcher after an independent Sol review failed the published SHA. The worker now launches with the exact DeepSeek profile/model, `approval_policy=never`, workspace-write sandbox, effective-effort override, writable git shared dir, and a stripped-then-parented execution identity (the worker generates its own id; the dispatcher is recorded as `CODEX_PARENT_THREAD_ID`). Sol runs on the default provider with no DeepSeek key and its own session. Publication pushes the branch, verifies the remote head through the gate, then creates/refetches a PR; merge carries the reviewed SHA in the REST body; merged `origin/main` is fetched and tested in a separate detached integration worktree, never the caller's checkout. Acceptance requires Sol exit zero plus a fresh independent `verify` for the exact reviewed SHA. State is persisted atomically (owner-only files, outside git), corrupt state fails closed, resume reuses the owned branch/worktree and never resets spend, budget is strictly cumulative (null/empty totals are invalid, not zero), and a non-dry-run needs `--sole-dispatcher` (host-local lock) with a real process-deadline kill. `lifecycle.inspect` now returns sanitized review/verification fields instead of stripping them entirely.

**Files:** edited `scripts/roadmap/lifecycle-core.mjs` (Codex parent env vars), `scripts/roadmap/lifecycle.mjs` (sanitized inspect + forbid unsupported models even with `--allow-mismatch`), `tools/batch-core.mjs` (strict budget, null-safe balance, migration allocation), `tools/codex-batch.mjs` (rewritten runner), `test/batch-core.test.js`, `test/codex-batch.test.js`, `test/roadmap-lifecycle.test.js`; added `AGENTS.md`.

**Commands run (real output):** `npm test` — 563 pass, 0 fail, 0 skipped. `node scripts/roadmap/lifecycle.mjs ready 51 --dry-run` (wouldSet Ready), `ready 51` (Backlog -> Ready), `claim 51` with this run's own id (claimed, In progress).

**Correction to the earlier diagnosis:** the previous "invalid gh token" reading was wrong. The token is supplied privately to the launcher as `GH_TOKEN`; the macOS Keychain is inaccessible in the sandbox, which is why `gh` auth-by-keychain could not resolve. `GH_TOKEN` is the supported path and is never printed or committed.

**Unproven / outstanding:** the orchestrator still must push this branch, run the final independent Sol review and the real setup rehearsal, then merge and complete #51. The batch runner's live worker/Sol spawns and provider-balance calls are covered by offline fakes only; the exact `shell_environment_policy` exclusion of `DEEPSEEK_API_KEY` from a child shell is not yet asserted offline.

## 2026-10-01 — Native Luna routing and lifecycle repair (issue #51)

Branch: `codex/deepseek-orchestration` (worktree based on `271a47d5`). Model:
GPT-6 Luna (`gpt-6-luna`) as a native Codex subagent. Execution ID:
`01a0f723-2ce8-7071-b5c2-5004b0c1e211` (this run's `CODEX_THREAD_ID`).

**Slice:** both logical model profiles now identify Luna; logical efforts map to
effective `medium`/`high`/`max`; distinct full commit IDs compare exactly while
legacy abbreviated records remain readable. Historical Claude and DeepSeek
records stay parseable, and new unsupported model claims remain refused.

**Files:** edited `docs/roadmap/config.json`, `docs/roadmap/routing.md`,
`docs/roadmap/WORKING_A_TICKET.md`, `scripts/roadmap/README.md`,
`docs/roadmap/transport-inventory.md`, `AGENTS.md`, `CLAUDE.md`,
`scripts/roadmap/lifecycle-core.mjs`, `scripts/roadmap/lifecycle.mjs` and the two
lifecycle test files.

**Commands run:** `ctx-wire run node --test test/roadmap-lifecycle.test.js test/roadmap-lifecycle-finish.test.js`
(97 pass, 0 fail); `ctx-wire run git diff --check` (clean). The first live claim
attempt refused before network access because the child environment inherited a
parent `CODEX_SESSION_ID`. Retried with only that inherited alias unset and the
authentic `CODEX_THREAD_ID` unchanged; lifecycle claimed #51 at high/max and set
In progress.

**Unproven / outstanding:** the native Luna/Sol setup rehearsal and independent
review are still pending. The temporary subprocess dispatcher remains for the
separately scoped next change.


## 2026-10-01 — Read-only Prompt Battle planner (issue #51)

Branch: `codex/deepseek-orchestration`. Model: GPT-6 Luna (`gpt-6-luna`),
executed as a native Codex subagent. Execution ID: this run's own
`CODEX_THREAD_ID`.

**Slice:** removed the subprocess batch runner, provider key/balance access,
resume state, execution flags and publication/completion behavior. Replaced it
with a read-only `--dry-run` planner for issues #13–44 using the shared GitHub
gate and lifecycle `inspect`/`ready --dry-run`. It fails closed on absent or
incomplete issue data, incomplete claim history, unknown scope/authorization,
ambiguous migration assignment and stale SHA identity; respects status,
priority, dependencies, claims and acceptance class. External work is excluded;
Producer selection states the owner-acceptance merge gate. Eligible Backlog and
Blocked promotion candidates are reported without changing Project status.

**Files:** `tools/codex-batch.mjs`, `tools/batch-core.mjs`,
`test/codex-batch.test.js`, `test/batch-core.test.js`, `AGENTS.md`, `CLAUDE.md`,
`docs/roadmap/WORKING_A_TICKET.md`, `docs/roadmap/routing.md`,
`scripts/roadmap/README.md`, and `docs/roadmap/transport-inventory.md`.

**Commands run:** `ctx-wire run node --test test/batch-core.test.js test/codex-batch.test.js`
(18 pass, 0 fail); `ctx-wire run env -u GH_TOKEN -u DEEPSEEK_API_KEY npm test`
(553 pass, 0 fail); `ctx-wire run git diff --check` (clean);
`ctx-wire run node tools/codex-batch.mjs --dry-run` (32 issues scanned, no Ready
selection, #42 reported as the sole eligible Backlog promotion candidate, and
contract/acceptance skips reported for the other actionable issues). The first
live attempt stopped at #16's missing authorization field; after changing
per-ticket unknown scope/authorization to a skip, the full scan completed.

**Unproven / outstanding:** whether Matthew promotes #42, publication,
independent Sol review of the published full-SHA head, merge, integrated-main
test and lifecycle completion remain with the owner/dispatcher. No GitHub mutation,
worker launch, model-provider request, publication or merge was performed by
this worker.

## 2026-10-01 — Reject ambiguous release-run identity (issue #51 follow-up)

Branch: `codex/deepseek-orchestration`. Model: GPT-6 Luna
(`gpt-6-luna`), native Codex subagent. Execution ID: this run's own
`CODEX_THREAD_ID` (`01a0f723-2ce8-7071-b5c2-5004b0c1e211`).

**Slice:** fixed `lifecycle.release` to reject a present but ambiguous runner
identity before GitHub access, including a thread ID paired with a conflicting
session ID. A plain terminal with no runner identity can still perform the
evidence-backed owner release. Existing release-marker parsing and historical
records are unchanged. The live #51 claim was not released or otherwise
modified.

**Files:** `scripts/roadmap/lifecycle-finish.mjs`,
`test/roadmap-lifecycle-finish.test.js`, and `docs/CLAUDE_WORKLOG.md`.

**Commands run:** initial regression reproduction,
`ctx-wire run node --test test/roadmap-lifecycle-finish.test.js` (31 pass,
1 fail: ambiguous identity incorrectly released the claim); after the fix,
`ctx-wire run node --test test/roadmap-lifecycle-finish.test.js` (32 pass,
0 fail); `ctx-wire run node --test test/roadmap-lifecycle.test.js test/roadmap-lifecycle-finish.test.js`
(98 pass, 0 fail); `ctx-wire run env -u GH_TOKEN -u DEEPSEEK_API_KEY npm test`
(554 pass, 0 fail); `ctx-wire run git diff --check` (clean).

**Unproven / outstanding:** no live release was attempted; the existing #51
claim remains live. Publication, Sol review, merge and completion remain with
the owner/dispatcher.

## 2026-10-01 — Add Prompt Battle round authoring
- **Branch:** `codex/pb-editor-luna-42`; execution `01a0f768-10ae-7691-b6d8-3d3b6ae95036` (GPT-6 Luna, logical medium / effective high).
- **Slice:** Added editor support for Prompt Battle rounds and prompts, including engine/scoring fields, validator messages beside fields, round reorder/duplicate/delete, import/raw JSON acceptance, and draft recovery. Existing question rounds and validation rules are unchanged. `prepare-deploy.mjs` now includes the new editor helper module.
- **Files:** `author.js`, `author.css`, `prompt-battle-editor.js`, `quiz-validation.js`, `prepare-deploy.mjs`, `test/author-battle-round-guard.test.js`, `test/author-prompt-battle-editor.test.js`, `test/reliability-contract.test.js`, `CHANGELOG.md`, and this work log.
- **Commands and results:** `node --test test/author-prompt-battle-editor.test.js test/author-battle-round-guard.test.js test/quiz-validation.test.js test/quiz-fixtures.test.js test/reliability-contract.test.js test/deploy-manifest.test.js` (85/85); `node --check author.js`; `node --check prompt-battle-editor.js`; `git diff --check`; `env -i PATH="$PATH" CI=1 npm test` (559/559).
- **Manual check:** Loaded the editor in a local preview with an empty `QUIZ_PLATFORM_CONFIG` and saw the new battle-round form, its prompt/engine/scoring controls, and existing validator messages. No sign-in, room, or service calls were made. The temporary preview server stopped during reload, so the final preview/round-trip was not visually rechecked after the last render adjustment.
- **Unproven:** Producer acceptance remains outstanding: author a valid round in the editor and load it into a local room to inspect the slice 3a pairing panel. Do not rehearse against the configured production Supabase without Matthew's approval. No migration or deploy was performed.

## 2026-10-01 — #42 review corrections
- **Slice:** Missing engine/scoring blocks in recoverable battle drafts now expose the validator's section-level message and can be recreated through field edits. Prompt ID/text validator errors now appear beside their individual fields.
- **Files:** `author.js`, `prompt-battle-editor.js`, `test/author-prompt-battle-editor.test.js`, and this work log.
- **Commands and results:** focused authoring, guard and reliability tests (44/44); `node --check author.js`; `node --check prompt-battle-editor.js`; `git diff --check`; `env -i PATH="$PATH" CI=1 npm test` (607/607).
- **Merge:** Integrated `origin/main` at `3c42f92b5ad29719cdf25027847648985f2253c6`; retained both work-log entries in the merge conflict.
- **Unproven:** Producer acceptance and the local-room pairing-panel check remain with Matthew; no migration or deployment was performed.

## 2026-10-01 — Read-only progress view (issue #5)

Branch: `claude/progress-view` (from `main` = `origin/main` at `3447913`, which contains the lifecycle wrapper). Model: Sonnet 5.5, effort `medium` (matches the `effort:medium` label). #5 was an Inbox placeholder; at Matthew's instruction ("yes to all") I wrote its contract, labeled it `model:standard`/`effort:medium`, set Backlog/Automated/Medium on the board, then `ready 5` and `claim 5` through the wrapper.

**Slice:** `scripts/roadmap/progress.mjs` (CLI, read-only, gate only) and `progress-core.mjs` (pure counting and Markdown/HTML rendering); `test/roadmap-progress.test.js` (15 tests); inventory and README updated.

**Judgment calls:** executable denominator excludes Inbox placeholders, `setup-test`, goals (label `goal`/`parent` or a `GOAL:` title; the live board has #10/#11 titled that way with no label) and drafts. Snapshot reuse is a temp-dir JSON file (default 60s), never for a partial fetch. Block reasons come from one batched read of the latest `block:v1` comment for up to 20 blocked issues in this repo.

**Commands run:** `node --test test/roadmap-progress.test.js` (15/15); `npm test` (542/542, was 527); mutation check on a scratch copy of four breakages (setup-test counted, partial shown as complete, partial snapshot reused, nested truncation tolerated), each failed the intended tests; one read-only live `node scripts/roadmap/progress.mjs --fresh --html <file>`: Done 4 of 40 executable, 2 Inbox placeholders, 4 setup-test excluded, exit 0.

**Unproven:** the HTML page was not opened in a browser; organization-owned Projects are untested (this one is user-owned); block-reason lookups only cover this repository.

## 2026-10-01 — Worktree bootstrap and command guard (issue #6)

Branch: `claude/worktree-guards` (from `origin/main` `271a47d`, which includes the lifecycle wrapper and the contributor guide). Model: Sonnet 5.5. #6 was an Inbox placeholder; at Matthew's instruction ("yes to all") I wrote its contract (`model:standard`/`effort:high`, External, Medium), then `ready 6` and `claim 6` through the wrapper (effort mismatch recorded: session `medium` vs label `high`). It was worked in the main checkout after #5 reached In review, not in a separate worktree (the guide asks for one per ticket; a sibling worktree needs extra directory access). #5's branch is untouched.

**Slice:** `scripts/guard/command-guard.mjs` (pure decision logic, 12 rules), `scripts/guard/pre-command-hook.mjs` (Claude Code PreToolUse adapter), `scripts/guard/worktree-checks.mjs` (pure) and `tools/worktree-setup.mjs` (runner), `docs/roadmap/guard-coverage.md`, `docs/roadmap/claude-settings.guard.json` (proposed hook, NOT installed), tests `test/command-guard.test.js` and `test/worktree-setup.test.js` (29).

**Judgment calls (flag for Matthew):** the runner is in `tools/`, not `scripts/worktree-setup.mjs` as my draft contract said, because the #4 bypass test forbids `child_process` anywhere under `scripts/` except the GitHub transport and I did not want to loosen it. `.claude/settings.json` was not created or edited: installing a hook needs the owner's approval (CLAUDE.md), so only the snippet is delivered. Plain `git push`, `merge`, `rebase` and `commit --amend` are deliberately allowed (the guard cannot know whether the user asked). `git commit -a` is refused under `add-all`. A hook-input it cannot read is refused (fail closed).

**Commands run:** `node --test` on the two new files (29/29); `npm test` (556/556, was 527 on main; #5's 15 are on a different branch); mutation check on a scratch copy of six breakages (reset --hard unchecked, substitutions unchecked, any delete target treated as scratch, unreadable hook input allowed, single-quoted text treated as a command, install runs after a failed check), each failing the intended tests, control 29/29.

**Real-runner evidence (after Matthew approved a local-only hook):** a nested `claude -p` could not authenticate ("Not logged in"), so the hook was loaded through a git-ignored `.claude/settings.local.json` in the desktop app session instead. In that live session a Bash `git reset --hard HEAD` and a PowerShell `git -C <scratch> clean -fd` were both denied by the hook with the rule named (`reset-hard`, `git-clean`), the scratch repo's uncommitted line survived, and an allowed `git status` ran. The live hook then blocked this session's own next command as "unparseable": a heredoc whose text contained an apostrophe. The guard now cuts heredoc bodies out before scanning (a body fed to a shell such as `bash <<EOF` is still checked as commands, a `<<` inside quotes is not a heredoc, an unterminated heredoc is refused); two tests added and shown to fail without the change. Earlier, Windows PowerShell's UTF-8 byte-order mark made the hook refuse valid input; it is now stripped (test added).

**Unproven:** `tools/worktree-setup.mjs` was exercised only with a fake exec, not on a real fresh worktree; the PowerShell `tool_name` is confirmed only by one live denial; the hook is active only through the git-ignored local settings file, not the tracked `.claude/settings.json` (owner decision); a heredoc piped to an interpreter other than a shell (python, node) is not parsed, as documented in guard-coverage.md.

## 2026-10-01 — Verified native workflow lessons

Branch: `codex/native-workflow-lessons`. Author: Codex orchestrator
(documentation only; product implementation remains Luna-owned).

**Slice:** updated the existing ticket guide with the completed #51/#52
rehearsal evidence, authentic native child identity handling, exact published
commit verification, safe recovery notes, strict boundary-field normalization,
and the distinction between repository checks and existing deployment failures.
Recorded only observed behavior; added no runner or scheduler.

**Files:** `docs/roadmap/WORKING_A_TICKET.md`, `docs/roadmap/routing.md`, and this worklog.
Sol flagged the stale pending-rehearsal statement in routing; it now points to
the verified rehearsal evidence in the ticket guide.
**Verification:** live lifecycle completion returned completed, then
alreadyCompleted; stale confirmed CLOSED/Done, no live claim and no discrepancy.
Sol and integrated main each passed 554 tests at the recorded rehearsal SHAs.
`git diff --check` passed for this documentation change. No product code changed.

## 2026-10-01 — DeepSeek slice trial: battle fixture and runbook (#17)

Branch: `codex/deepseek-trial-17`, accepted base `bc8a6764f809619519e86ae3163e3f6922e22cf9`. Implementation: official API `deepseek-v4-pro`, thinking enabled, high effort; returned model `deepseek-v4-pro`, fingerprint `a307abda487cd1b463329ccb945ce396`. Sol coordinated the ticket and owned acceptance; this worklog/evidence entry is orchestration-authored. The authorized issue-specific Sol coordinator claim is recorded in #17; the normal Luna routing is unchanged.

**Slices:** 17-A returned `quiz.battle.sample.json` and `test/quiz-battle-fixture.test.js`; request `9d226d39-06e5-4091-9b81-8c17364849ba`, 35.0 seconds, accepted first pass. 17-B returned an appended `RUNBOOK.md` section; request `e1806183-c1d3-40d9-9aa9-b6dc6c4a93e0`, 63.2 seconds. One localized repair (`61552c4c-cdc0-484d-9096-4b513c87764c`, 40.4 seconds) corrected the current adapter identifier and host-credential/provisioning instructions. All artifacts were applied verbatim to allowlisted paths. No model tools, shell, credential access, or product implementation fallback was used.

**Evidence:** baseline `npm ci` exited 0 and `npm test` passed 600/600. Sol-owned new-fixture check initially failed with expected ENOENT. After 17-A, the real shared validator, exact contract values and original compatibility hashes passed; focused fixture/compatibility tests passed 15/15. Full `npm test` passed 603/603, zero failures/skips. Final private fixture/docs gate and `git diff --check` passed after the documentation repair. The original compatibility JSON files, validator and existing tests are unchanged. Independent exact-published-commit review remains pending at this commit.

**Cost and limits:** official USD balance before calls $18.47; observed after workers $18.45. Per-response readings initially lagged the charge, so the observed $0.02 decrease is at the endpoint's cent precision and may not be final billing. Across the three calls, 23,775 prompt tokens and 22,177 completion tokens (17,795 reasoning tokens included). Sol and orchestration use separate Codex allowance.

**Unproven/excluded:** no real room, publishing through the app, image generation, deployment or migration application. The runbook distinguishes the unmerged editor support (#42) and pending Kaplan adapter/Worker wiring from current Workers AI host testing. This fixture/doc trial provides no evidence about autonomous recovery, permission-sensitive work, or production generation.

## 2026-10-01 — DeepSeek Flash/Pro sliced implementation routing

Branch: `codex/deepseek-sliced-routing`, base
`f1cdf3f83f207c0e8d968dac2cec19d2cc040b65`. Matthew requested new DeepSeek
instructions after #17, then explicitly requested a Flash trial. This is setup;
no product ticket/batch was launched and paused live claims remain preserved.

**Authorship:** DeepSeek Flash authored the routing config and exact test edits.
The Codex orchestrator authored operating docs and this evidence; the user’s
local guide/research were copied into this branch and extended for the adopted
workflow. The original checkout/untracked source files were preserved.

**Slices and limits:** initial `deepseek-flash` high-thinking request
`f81030ce-9e6d-465b-85b7-319777aa38bc` ended `length`: 32,461 prompt tokens,
16,384 completion (15,644 reasoning). No incomplete edits were applied. Scope
was reduced to two transformations, both thinking enabled/low: config request
`79b48fdf-ce76-4d2f-abab-6c554be2928b` (5.5s, 1,274 prompt/1,562 completion,
338 reasoning), test request `3a5bea36-ba69-4be9-a3d6-38cb532a9c5a` (32.6s,
5,802 prompt/9,522 completion, 7,497 reasoning). Returned model `deepseek-flash`,
fingerprint `aeb56401ca74e127821c4f9126dcb669`. Artifacts applied verbatim
within their allowlist; no implementation repair/fallback. No tools were given;
DeepSeek correctly marked its checks unrun.

**Behavior:** economy uses Flash, standard Pro; logical low/medium/high maps to
low/high/high. A Sol coordination profile allows honest native claim identity
with explicit mismatch evidence; provider request IDs never substitute for
Codex IDs. Independent Sol review remains separate. Batch instructions retain
one dispatcher/session, eight hours, $10 observed spend, published PR per ticket,
exact-commit merge/integrated checks, and Producer/External/production boundaries.

**Checks:** clean starting main `npm ci` exit 0, baseline `npm test` 603/603.
Focused `node --test test/roadmap-lifecycle.test.js
 test/roadmap-lifecycle-finish.test.js test/codex-batch.test.js` passed 112/112.
Non-routing config data compared unchanged; lifecycle production source unchanged.
Full `npm test` passed 605/605, zero failures/skips; `git diff --check` passed.
Publication, independent Sol and integrated main evidence follows in the PR. Shared API balance observed $18.41 then $18.39; billing lag/cent
precision prevents assigning a final invoice cost to this setup. Codex allowance
is separate. No production services, deployment or migration application.


### 2026-10-01 — issue42 DeepSeek repair checkpoint (Sol orchestration)

Preserved the historical Luna editor work on `codex/pb-editor-luna-42` and merged accepted main `c21efc60c882749fa5f487ead0a8e808f552e1ed` without conflicts. The stopped Luna claim was released with app-confirmed interrupted execution evidence; a genuine Sol coordinator now owns the ticket.

DeepSeek Pro authored stable adjacent validator message nodes and input persistence without form remounts (`e633980a-c622-461a-9f6a-cc240914ae17`, `974054ea-615f-4cc5-b9d1-472db7fdf516`). Every field saves before blur and updates the shared validator and preview in place. Under Matthew's explicit Flash-trial instruction, DeepSeek Flash authored the scoped hidden-control change (`195af9cc-7fa5-45b8-8e6f-d31d4ad4ebff`, `7e125bd6-1cba-41d8-9f1c-4672d070441a`). Sol corrected its initial shared-row assumption: question and round controls share one row, so only Add question and its template select are hidden; round actions remain usable. All artifacts applied verbatim after whole-response/schema/path/unique-match validation. No OpenAI product implementation.

Sol's isolated Chrome check used empty backend configuration, loopback serving and aborted all cross-origin requests. The baseline reproduced variants3->7 restoring3 on refresh and a lost first Add prompt click. Repaired source passes scratch-round validation, full-field save/reload, numeric persistence, first-click prompt addition, exact adjacent validator error updates while preserving focus, preview updates, question-control visibility, real round reorder/delete with neighboring drafts unchanged, and both fixture validation/import checks. No page errors. Existing editor normalization adds empty finale audio when opening question fixtures; that behavior predates this ticket and fixture file bytes remain unchanged. Focused existing editor/guard tests12/12 pass; full checks and independent published-commit review are recorded in the ticket, never inferred from this prose.

The combined repair request `366f60fb-dfdb-4561-bfd2-6a52ce036231` exhausted16384 output tokens and was rejected without edits. Pro's shipped regression generation then exhausted the same budget twice (`fd490096-28a5-43f2-ae88-256defd51947`, `1e47e56a-928b-4e46-b93c-69adeca0b654`); no partial test was accepted. The step was blocked and unrelated issue16 work resumed. All failed calls remain in spending/evaluation evidence.

Process lessons: make source transformations smaller than combined implementation/test design; preserve complete private failing evidence before dispatch; source regex tests can pass while browser input events lose drafts/clicks. Inspect the actual parent DOM before hiding a container. Retain same-element/focus checks and actual first-click/reload/reorder tests. High thinking can consume the entire output limit even on a small test packet; record a failed request and re-scope/reroute explicitly instead of applying truncated code or claiming tests passed.

Outstanding: shipped numeric-input regression, separate Sol review of the published commit, authorized actual local-room pairing-panel rehearsal and Producer acceptance. This rehearsal uses production Supabase, and no production writes, provider-image calls, migrations or deployment occurred.


### 2026-10-01 — output budget correction and issue42 regression

The private dispatcher imposed `max_tokens:16384`, including reasoning and final answer. Current official completion docs support 393216 and document 65536 as the thinking default. Sol changed only the private orchestration runner to 65536, retaining deadline/USD/model/artifact guards and recording the cap in success/failure metadata. The portable DeepSeek guide now explains this budget, truncation rejection and controlled retry. Historical failed calls remain charged and preserved.

The identical reduced regression prompt, Pro/high, completed with `stop`: request `de5edea2-9158-4892-91cd-3a8507d11455`, 905 prompt/14742 completion tokens (13791 reasoning), 97.3 seconds. It used less than the former cap, so this stochastic retry alone does not prove causation or general reliability. The returned test omitted the closing brace for its extracted function; one localized DeepSeek repair `b48c53e6-d2e8-46ef-98c4-57fa25f0afc6` completed with 292 prompt/1793 completion tokens (1733 reasoning), 14.7 seconds. Artifacts applied verbatim; Sol authored no test implementation.

`test/author-battle-input.test.js` runs the actual source binding and shared helpers. On an archived genuine `ab7c7b8` baseline it fails specifically on the missing input listener; current source passes persistence before blur, exact invalid/valid marker feedback and zero remounts. Full `npm test`:613 passed, zero failures/skips; `node --check author.js` and `git diff --check` pass. Browser product source is unchanged from the preceding successful isolated Chrome checkpoint. Observed batch USD balance18.39->18.19 ($0.20, delayed cent-precision billing); Sol allowance is separate.

The regression-generation blocker is resolved. Renewed independent Sol verification of the new published SHA, authorized real-room pairing-panel evidence and Producer acceptance remain required. No production calls, deployment, migration application, merge or completion.

### 2026-10-01 — issue16 DeepSeek storage, media access and seeded prompts

Branch `codex/pb-storage-deepseek-16`, baseline `c21efc60c882749fa5f487ead0a8e808f552e1ed`. Native Sol coordinator owns the existing live claim; the earlier genuine Sol CLI planning execution remains separate, not substituted for it. DeepSeek Pro authored owner-assigned migration0037 and all new shipped test code. Sol orchestrated exact allowlisted artifact application, authored this operating evidence and the output-budget guide update, and ran checks; it authored no SQL/test implementation.

0037 adds generation audit storage, RLS and explicit service_role SELECT, nullable author uploader/battle ownership metadata and expiry. Existing trusted-author metadata AND object-byte access are consciously preserved. Hosts can access battle assets only in their session; players require own metadata ownership AND own generation/entry/matchup/session provenance in allowed battle phases. Battle branches return before unchanged legacy quiz/options paths. Prompt order reuses the persisted shuffle seed with MD5(seed,round,promptID) and ordinal tie break; the complete old pairing function matches0036 after removing this one aggregate. No generation/voting/submission RPCs or existing migrations/tests/fixtures/source were changed.

Requests and actual usage (all retained, including initial rejected/repair output):
- `media-access`: `6168b646-ac1a-4225-97b8-e131233d918d`, Pro/high thinking, finish `stop`, 5853 prompt/13612 completion tokens.
- `media-format`: `418dbfea-95a4-45e8-b17d-38a16f96431c`, Pro/high thinking, finish `stop`, 659 prompt/4337 completion tokens.
- `prompt-order`: `d44ccd92-fc51-45e8-93ac-4cc3d6556417`, Pro/high thinking, finish `stop`, 5461 prompt/12049 completion tokens.
- `shipped-contracts-repair`: `78de2bd3-a523-40c7-9305-08ee1120ade5`, Pro/high thinking, finish `stop`, 6819 prompt/14300 completion tokens.
- `shipped-contracts`: `6399340f-d675-47b8-a3b3-8fe14eb35b29`, Pro/high thinking, finish `stop`, 13607 prompt/30094 completion tokens.
- `storage-repair`: `e9811131-6852-4107-8050-a75b50abe4dc`, Pro/high thinking, finish `stop`, 400 prompt/416 completion tokens.
- `storage`: `57ad659b-e83c-4318-9cbb-f131ef11e7a6`, Pro/high thinking, finish `stop`, 4990 prompt/10091 completion tokens.

Storage needed one localized repair to remove an unrequested constraint DROP. Media source was correct; two private acceptance bugs falsely rejected legal formatting/DDL. Sol independently preserved the original frozen harness, corrected host trailing whitespace and scanning CREATE OR REPLACE instead of executable authorization, refroze revised hash `01dc18992000fb0204c646e30080c05c176bcc66a55e63f7f7af6d178f27f345`, and proved three privacy-weakening snapshots still failed. The unnecessary formatting repair and original HTTP400 (unknown error-body cause) remain recorded; later runner JSON-prefix/error retention is explicit.

Prompt-order slice passed first try. Initial shipped test passed valid SQL but missed four negative snapshots (browser grant ALL, disabled host guard, final default allow, removed actual0032 webp MIME). One localized DeepSeek test repair catches all five negative controls, including existing missing-own-player rejection. No valid SQL changed for test-only repair. Final frozen acceptance11/11, full repository620/620, new shipped15/15; syntax and diff checks pass. Protected baseline92files remain byte-identical. These are SOURCE checks, not executed SQL or DB privilege proof.

Output-budget result: shipped test generation completed with30094tokens (26324reasoning), exceeding the former16384 cap, at documented65536 thinking budget; tests then required the recorded coverage repair. The prior #42 same-prompt retry fit under the old cap and was not causal proof; this larger complete output demonstrates why the larger ceiling matters, without claiming general reliability. Shared batch balance observed18.39->18.06 ($0.33, delayed cent-precision billing); Sol/Codex allowance is separate.

Outstanding: independent exact-published-SHA Sol review; Matthew must apply0037 after his migration-ledger preflight and retain the actual has_table_privilege query result versus pre-application list. The new session_battle_generations table must not be newly unreadable by service_role. No production SQL, real-room write, deployment, provider generation, owner acceptance, merge or lifecycle completion occurred.

### 2026-10-02 — delegation v3: harness-dispatched, Luna-controlled process (docs + routing)

Branch `claude/delegation-v3`, base `2198c09`. Claude (cloud session, not a Codex execution) at Matthew's request. No ticket claimed, no batch started, no product code changed.

**Why:** Codex's usage report for the October 1 batch (GPT-6.1 Sol rates) put ~85% of Codex credits in the single long dispatcher conversation (179M input tokens) and ~15% in all ticket sessions for #15–#17. Every session also read ~165 KB of process docs before starting.

**Changes:** new portable `docs/DELEGATION.md` (fit gate for design/research tickets, Express/Standard/Protected lanes, script-run dispatcher, pre-authorized Flash→Pro ladder, DeepSeek-drafted locked acceptance tests with red-on-base and mutant checks, Codex token budgets, single-account limits (no rotation across accounts; optional owner-capped credits), ledger and Sol audit sampling); `docs/delegation/HARNESS_SPEC.md` (build spec for `tools/delegate/`, not yet built); role cards for Controller, Verifier and Sol (harness-launched sessions read only their card, ~5 KB with AGENTS.md); `model:controller` (`gpt-6-luna`) execution-role profile in config and routing; AGENTS.md, CLAUDE.md and WORKING_A_TICKET.md updated; October 1 rehearsal lessons and trial observations moved to `docs/roadmap/LESSONS.md`; old DeepSeek guide reduced to a pointer. Tickets claimed under the October 1 policy finish under it (linked at `2198c09`).

**Checks:** `npm ci` exit 0; baseline `npm test` 638/638; after changes 639/639 (new test: Luna controller claim accepted only with written mismatch; `gpt-6-luna` removed from the unsupported-model list, `gpt-6-astra` used instead).

**Unproven:** the harness does not exist yet; budgets, ladder cut-offs and audit rates are starting values to tune from the ledger; the field names for Codex's rate-limit usage, and whether credits are drawn automatically past the plan limit, are unconfirmed; Luna's adequacy as Controller in this repo is unmeasured until the pilot.

### 2026-10-05 — routing: a Claude Code session may hold a claim

Branch `claude/routing-claude-sonnet`. Claude Code (Opus 5.5), desktop session on Matthew's Mac. Files: `docs/roadmap/config.json`, `docs/roadmap/routing.md`, `test/roadmap-lifecycle.test.js`.

Matthew froze the delegation harness and assigned Ready ticket #18 to an interactive Claude Code session, with a Claude Sonnet sub-agent implementing. The claim wrapper only accepted DeepSeek, Luna and Sol model ids (`MODEL_UNSUPPORTED` otherwise), so a truthful claim was impossible. Added the execution-role profile `claude` (`claude-opus-5-5`, efforts medium/high), never a product-issue label, plus its row and claim rule in routing.md. `npm test` 679/679.

Unproven: the first real claim with it (#18).

### 2026-10-05 — #18 Prompt Battle host engine selector and cost readout

Branch `claude/pb-engine-selector-18`, base `0999c67` (origin/main). Claude Sonnet 5.5 sub-agent of a Claude Code Opus 5.5 session; the coordinating session holds the claim. Files: `app.js`, `quiz-core.js`, `styles.css`, `test/battle-engine-selector.test.js`, `docs/CLAUDE_WORKLOG.md`. Feature commit `e92991f`.

**Built:** the existing host test panel's model menu is now the single engine selector. `battleEngineMenu` (quiz-core.js) = `BATTLE_TEST_MODELS` entries permitted by every `prompt_battle` round (the rule `set_battle_engine` enforces); `BATTLE_TEST_MODELS` entries now carry `provider`. Picking an entry calls `roomApi.setBattleEngine` with the entry's provider and model and only moves the menu once the server accepts it. `loadSavedBattleEngine` reads `get_host_battle_state`'s `engine` back on host refresh. The Test button sends the same selection (`effectiveBattleModel()`). Loading, failure and success render as separate blocks (`battle-test-state--loading|failure|success`); success shows images, the reported `costUsd` and cost per image. A quiz with no battle round no longer shows the panel; an empty intersection shows a notice instead of a menu. No Worker change, no migration, no spend-to-date readout, kaplan_proxy not added (issue #21).

**Commands run:** `node --test test/battle-engine-selector.test.js` red first (missing quiz-core exports), then 28/28; `node --check app.js` ok; `npm test` 707 tests, 707 pass, 0 fail.

**Unproven:** the screen itself (layout, the three states, menu after a real refresh) has not been seen in a browser; nothing was run against a server or Supabase. Matthew's acceptance is outstanding. With nothing saved, the menu shows the round default as "not saved yet"; the Worker's own read of the saved engine is a later slice.

### 2026-10-05 — Prompt Battle generation RPCs (issue #20, migration 0038)

Branch `claude/pb-generation-rpcs-20` (from origin/main `a04918a`). Claude Code (Opus 5.5) sub-agent of a Claude Code Opus 5.5 session; the ticket claim is held by the coordinating session. Files: `supabase/migrations/0038_prompt_battle_generation_rpcs.sql` (new), `test/battle-generation-rpcs.test.js` (new), this entry.

**Built:** `authorize_battle_generation(room, token, prompt)` (service_role): membership, `phase::text = 'battle_prompt'`, an existing entry (late joiners refused), attempt budget, `maxSessionSpendUsd` (null or absent = no cap, 0 = disabled, positive = ceiling on summed `cost_usd`), `maxSessionGenerations` (pending and complete rows count, refunded do not); reserves a pending row and returns generationId, promptText, provider, model, variants, resolution, outputFormat, attemptsRemaining (plus attemptIndex, playerPrompt, steps). Engine = `sessions.battle_engine_provider/model`, falling back to the round's `defaultProvider/defaultModel` when the host never set one; never a request argument. Locks `sessions` (`for update of s`) then the entry (`for update of e`). `record_battle_generation(id, asset_ids, cost)` and `refund_battle_attempt(id, 'provider_error'|'safety_block', reason)`: both lock the generation row and replay idempotently (record never re-costs; refund restores the attempt once). `get_player_battle_state(room, token)` (anon, authenticated): own prompt text, attempts remaining, own generations' attempt index, status and asset IDs; `entry: null` for a late joiner or outside a battle phase. The three Worker RPCs are `revoke all ... from public, anon, authenticated` then `grant execute ... to service_role`.

**Commands run:** `node --test test/battle-generation-rpcs.test.js` before the migration existed: 22 tests, 1 pass (vacuous), 21 fail. After: 22/22. Nine hand mutations of the migration (drop either lock, coalesce the spend cap to 0, grant authorize to anon, accumulate cost, leak cost to the player read, remove the refund replay guard, take the provider from a request argument, `>` budget off-by-one) each failed at least one test; file restored and re-run 22/22. `npm test`: tests 701, pass 701, fail 0.

**Unproven:** the SQL has never been executed. It is checked only by reading and by text-level contract tests; it has not been parsed by Postgres, applied, or exercised under real concurrency. Matthew applies 0038. No Worker route calls these RPCs yet (out of scope), so the error messages and payload shapes are untested end to end.

### 2026-10-05 — Prompt Battle openrouter adapter (issue #44)

Branch `claude/pb-openrouter-44` (from origin/main `23b373c`). Claude Code (Opus 5.5) sub-agent of a Claude Code Opus 5.5 session; the ticket claim is held by the coordinating session. Files: `image-engine.js`, `test/image-engine-openrouter.test.js` (new), `test/image-engine.test.js` (stale header comment only), this entry.

**Built:** `ENGINES.openrouter` on the plural adapter contract. `resolveAuth` reads and trims `OPENROUTER_API_KEY` and returns `{ url: "https://openrouter.ai/api/v1/images", headers: { Authorization: "Bearer …" } }`; a missing, blank or non-string key throws an error naming the variable without its value. `buildRequests` takes `config.auth` (as `kaplan_proxy` does) and returns one http descriptor per variant (1-4) with body `{ model, prompt, n: 1 }`, plus `resolution` / `output_format` only when the round sets them; seeds are never sent. `parseResponses` (expectedVariants 1-4) sums `usage.cost` exactly; a failed result is an unbilled OpenRouter error only when it has a non-2xx HTTP status and OpenRouter's `{ error: { … } }` envelope at `result.error.body` (contract Decision 4); every other failed result (no response, an unparseable 2xx body, or a non-2xx without that envelope, such as a 524 edge timeout) throws "Unaccounted OpenRouter outcome", as does a bad `usage.cost`; `content_policy_violation` / `refusal` give `blocked` with that error's message when no image came back; a missing `media_type` is inferred from the base64 prefix (PNG, JPEG, WebP) and anything else is dropped with its cost kept. Adapter status header updated. No Worker change.

**Commands run:** `node --test test/image-engine-openrouter.test.js` before the adapter existed: 21 tests, 0 pass, 21 fail. After: 21/21. Seven hand mutations (no-response treated as unbilled, negative cost accepted, no media-type inference, seed forwarded, blocked despite images, key not trimmed, variants 5 accepted) each failed at least one test; file restored. `npm test` at `3c59205`: tests 722, pass 722, fail 0. Review fix (`07cf758`): the first version accepted any non-2xx as unbilled without the error envelope; tightened to Decision 4, A3/A4/A7 fixtures now carry the error body, and a new test pins the bodyless and 524 cases. That new test failed against the previous code (22 tests, 21 pass, 1 fail) and passes after (22/22). `npm test` at `07cf758`: tests 723, pass 723, fail 0.

**Unproven:** no live OpenRouter call was made. The refusal error shape on `/images` and the n=1 behaviour come from OpenRouter's docs and get checked later with the host test button once a Worker ticket enables the provider. The Worker's `runBattleDescriptor` throws away a non-2xx response body (it keeps only `error.status`). The Worker ticket that enables openrouter must attach the parsed error body as `error.body` in `runBattleDescriptor` and pass `config.auth` to `buildRequests`. Until then every OpenRouter failure is refused as "Unaccounted OpenRouter outcome", which is the safe direction: an unknown charge is never assumed to be zero.

### 2026-10-06 — Prompt Battle player generation (issue #22)

Branch `codex/battle-generate-22`, base `a687c29de4fceb287107b835f3fab615c494398a`. Sol coordinates the owner-authorized interactive protected path; DeepSeek authored all product code and tests. Flash high implementation attempts 1/2 failed recorded acceptance checks; Pro high attempt 3 corrected the remaining safety message. Separate Pro high test author and pre-review; Flash low mutation author. No synthetic Codex execution IDs.

Files: `cloudflare-worker.js`, `test/battle-generate-route.test.js`, `test/battle-generate-failure.test.js`, changelog and per-ticket evidence. The route authorizes/reserves before provider dispatch, reads stamped ownership, executes existing descriptors, persists private images with 30-day expiry and records known cost before returning IDs. Unknown charges and uncertain persistence never become a zero-cost success or an invented refund. No migration, UI, OpenRouter enablement or deployment.

Checks run by Sol: `node --test --test-reporter=junit test/battle-generate-route.test.js test/battle-generate-failure.test.js`: 13 pass, 0 fail, 0 skip. `npm test`: 736 pass, 0 fail, 0 skip (base 723). All 13 new cases failed by assertion on the untouched base; frozen test hashes remained unchanged through implementation. Three effective DeepSeek mutants killed by A1/A8/A13; one unreachable variant was discarded and replaced without changing tests. Fresh Pro pre-review returned no findings. `git diff --check` and implementation allowlist passed.

Unproven: no production/provider calls, deployment or visual UI verification; production Storage and media_assets insert privileges require deployment preflight. Independent clean-checkout verification and the final tested SHA are recorded in lifecycle comments after publication.

### 2026-10-06 — Prompt Battle player screen: prompt, Generate, variant grid (issue #23)

Branch `claude/battle-player-screen-23` (from origin/main `ef6df5a`). Claude Code (Opus 5.5), working the ticket directly at Matthew's request. Files: `battle-player.js` (new; pure logic and markup), `app.js` (player battle branch and glue), `room-api.js` (`getPlayerBattleState`), `styles.css`, `prepare-deploy.mjs` (ships the new module), `test/battle-player-screen.test.js` (new), `test/battle-pairing.test.js` and `test/battle-phase-3a.test.js` (two slice-3a assertions narrowed, see below), `tools/battle-player-preview.html` (new, dev-only), this entry.

**Built:** In `battle_prompt`, a paired phone reads only its own entry through `get_player_battle_state` (prompt, attempts remaining, its own generations) and shows the prompt, a textarea, Generate, and the attempts left. Generate posts to the Worker's `/battle/generate` with the player token. Whatever the reply, the entry is then re-read, and success is shown only when every returned asset ID appears in that re-read as a complete generation (`settleGenerateRequest`). The screen has distinct states: loading, load-error with retry, late-join holding, idle, pending, confirmed (including partial), failed/unconfirmed, safety-blocked, refused, over-budget, and a server-pending attempt that is "still being checked". The variant grid loads through `/media` with the player token, cached by asset ID for the round, so a redraw never refetches. Tapping a variant marks a favourite (per-tab sessionStorage); submission is a later issue. A battle render key covers only structural fields. Typing never redraws, and a redraw caused by anything else restores focus and the caret.

**Superseded assertions:** `battle-phase-3a` pinned the slice-3a everyone-holds screen ("Your prompt is on its way"), and `battle-pairing` pinned "no player-token battle wrapper yet". Both now assert the #23 shape instead: the battle branch still returns before any question rendering and holds no pairing, and `getPlayerBattleState` is the only player battle wrapper.

**Commands run:** `node --test test/battle-player-screen.test.js`: 15/15 (one ordering test first failed on my own comment and now ignores comment lines). `npm test`: tests 779, pass 779, fail 0. In-browser: `node server.mjs` on 4183, `tools/battle-player-preview.html` at 375×812 with `styles.css` and `kaplan-brand-layer.css`, every state checked by screenshot, no horizontal overflow. Real `app.js` player tab driven into `battle_prompt` over the local-demo BroadcastChannel: the module loaded with no console errors and the phone showed the load-error state (no Supabase config on this Mac).

**Unproven:** The real generate → record → `/media` image path was not exercised. This Mac has no `.env.local`, and `/media` has no CORS for a localhost origin, so the grid's proxy fetch only works same-origin on the deployed Worker. Matthew's acceptance walk (`npm run dev` on the work PC, `workers_ai`, generate / failure / blocked / over-budget) is still required. The preview page approximates the shell (no top bar or identity badge).
### 2026-10-06 — Prompt Battle matchup resolution and scoring (issue #30, migration 0042)

Branch `claude/battle-score-30` (from origin/main `ef6df5a`). Claude Code (Opus 5.5), working the ticket directly at Matthew's request instead of through the Codex/DeepSeek harness. Files: `supabase/migrations/0042_prompt_battle_resolution.sql` (new), `test/battle-resolve-runtime.test.js` (new), `test/helpers/migrated-db.js` (new), `package.json` / `package-lock.json` (`@electric-sql/pglite` dev dependency, approved by Matthew), this entry.

**Built:** `resolve_battle_matchup(room, hostSecret, matchupId)`. Locks the session and then the matchup. A resolved matchup replays its stored `result` snapshot and writes nothing. Otherwise it requires `battle_vote` and the session pointer at this matchup, then scores the matchup: no viable entry means skipped, with nobody paid; one viable entry wins by default; otherwise the top vote count wins, and every tied entry gets full `winnerPoints`. Unless the matchup is skipped, every voter gets `voterPoints`. Events go to `score_events` with `question_id` `battle-r<round>-m<matchup>` and an explanatory reason. `base_points`/`multiplier` are null, so neither the door multiplier nor 0026's catch-up trigger applies. A partial unique index on `(session_id, question_id, player_id)` for system battle events backs idempotency. The function sets phase to `battle_result` and bumps the revision, and the result payload reveals creators.

**Test infrastructure:** `test/helpers/migrated-db.js` applies every migration to PGlite (in-process Postgres 17 via WASM) with minimal Supabase stubs: roles, `extensions.pgcrypto`, `auth`, and `storage`. As a result `npm test` now executes battle SQL instead of only reading its text. All 42 migrations apply cleanly in about 5 s. That is also the first time 0036–0041 have been parsed and run by Postgres in this repo's tests.

**Commands run:** `node --test test/battle-resolve-runtime.test.js` before 0042 existed: 15 tests, all failing (function missing). After: 15/15. Five hand mutations (single winner on a tie, no `resolved_at` guard, catch-up multiplier applied to voters, veto ignored, voters paid on a skip) each failed 1–3 tests; file restored and re-run 15/15. `npm test`: tests 779, pass 779, fail 0.

**Decisions to confirm:** (1) A matchup with zero votes, which is every matchup in a 2–3 player room, is a tie, so all viable entrants get `winnerPoints`. (2) The late-join catch-up boost is also excluded from battle points, not only the door multiplier. (3) Resolving moves the phase to `battle_result`, so issue #32's Reveal button is a single call.

**Unproven:** PGlite is not Supabase. Grants and roles are stubbed, and concurrency was not exercised (single connection), so the two-tab race relies on the session `for update` lock plus the unique index. The function uses a transaction-scoped temp table. That is fine under PostgREST's per-request transaction but has not been run on the live project. Matthew applies 0042 after ledger preflight. Before applying, `select count(*) from public.score_events where created_by = 'system' and question_id ~ '^battle-r[0-9]+-m[0-9]+$';` should return 0.

### 2026-10-06 — Prompt Battle privacy contract suite (issue #35)

Branch `claude/battle-privacy-35` (from origin/main `6b2921a`). Claude Code (Opus 5.5). Files: `test/battle-privacy-contract.test.js` (new), this entry. No product code changed: no leak was found.

**Built:** One five-player room is driven through a whole battle in PGlite using the real RPCs. The sequence is pairing (a duel and a three-way), two generations per player through `authorize_battle_generation` / `record_battle_generation`, submission, lock (with one real forfeit), veto, `battle_vote` on matchup 1, votes, `resolve_battle_matchup`, then `battle_vote` on matchup 2, plus a late joiner. At every step, each player's `get_live_room_state` and `get_player_battle_state` is checked against everything that player must not hold: other players' ids, tokens, entry ids, names and assets; other matchups' prompts; their own entry and player id; any media URL. Public state may carry only `battleRoundIndex` / `battleMatchupIndex` / `battleMatchupCount`. `can_access_live_media` is checked phase by phase: own variants only while prompting and in review; in voting, only the current matchup's viable submissions, never unused variants, future or previous matchups, vetoed entries or forfeits. `publicRoomState()` is checked to forward only the battle position.

**Commands run:** First runs failed on two test bugs, not leaks. The name "Bo" matched inside `lateJoinBonus`, so the test now uses full names. A player who generated images but never submitted gets auto-submitted at lock (per spec), not forfeited, so the forfeiter now generates nothing. After that, 11/11. Four temporary leaky migrations (opponent names in `get_player_battle_state`, media open to any battle asset, pairing written to public state at lock, creators written to public state at resolve) failed 8, 4, 5 and 3 tests respectively; the file was removed and the suite re-run 11/11. `npm test`: see the PR.

**Unproven:** Client-side broadcast is checked at the `publicRoomState()` source level only; the realtime transport itself is not exercised. #31 will add vote-phase public fields, and this suite's allowlist must grow with them deliberately.

### 2026-10-06 — Prompt Battle phone voting, on-stage and result, plus full-screen images (issue #31)

Branch `claude/battle-voting-31`, stacked on `claude/battle-player-screen-23` (#73), with `claude/battle-privacy-35` (#75) and main `6b2921a` merged in. Claude Code (Opus 5.5). Files: `battle-vote.js` (new), `app.js`, `battle-player.js`, `room-api.js` (`castBattleVote`), `styles.css`, `prepare-deploy.mjs`, `tools/battle-player-preview.html`, `test/battle-vote-screen.test.js` (new), `test/battle-privacy-contract.test.js` (ballot and result now leak-checked; allowlist grown), `test/battle-pairing.test.js` and `test/player-submission-states.test.js` (see below), this entry.

**Design decision (flag for #32/#33):** No player RPC lists a matchup's images and #31 allows no migration, so the ballot travels in public room state. `battleVote` = `{ matchupId, matchupIndex, entries: [{ entryId, assetId }] }`, viable entries only, sorted by entry ID; the host payload sorts by player name, which would leak who is who. `battleResult` = the resolution with names, votes and winner, never player IDs. `publicRoomState()` re-whitelists both field by field and phase-gates them. #32 must set `state.battleVote` from `publicBattleVote(hostPayload, index)` and `state.battleResult` from `publicBattleResult(resolution)`. A phone recognises its own entry only by finding one of the ballot's images among its own variants (on-stage).

**Built:** Screens for review-wait, vote-wait, the ballot (idle, pending, confirmed, rejected, retryable; "already voted" counts as confirmed; a confirmed vote is remembered per matchup for the tab), on-stage, result-wait, and result (creators, votes, winner, "(you)", "Your vote", skipped). Full-screen viewer (Matthew's request): tapping an image opens it full screen with previous/next, Esc and arrow keys, focus moved in and returned, and the surface's action inside (Vote for X / Make this my favourite). A separate button under each tile votes or favourites, so a tap on a picture never votes. The viewer is lifted out of the card to `#app` after render, because the brand layer's `backdrop-filter` on `.player-card` traps `position:fixed` children.

**Existing tests touched:** `battle-pairing` now allows `castBattleVote` alongside `getPlayerBattleState`. `player-submission-states` sliced from the first `function renderPlayer`, which now matched the battle helpers above it (which legitimately read sessionStorage); it is anchored to `function renderPlayer() {`.

**Commands run:** `npm test`: tests 821, pass 821, fail 0. The whitelist test caught that a sloppy host object could carry a vetoed entry's asset ID; the whitelist now drops entries marked non-viable, vetoed or forfeited. Browser at 375×812: every vote and result state in the preview page; the real `app.js` player tab driven over BroadcastChannel through ballot → tap-to-expand → ArrowRight → Esc (focus back on the tile) → vote from inside the viewer (closes; retryable message, no Supabase here) → result.

**Unproven:** Real voting against Supabase and real images through `/media` (this Mac has no `.env.local`). The host side that broadcasts `battleVote` / `battleResult` is #32.

### 2026-10-06 — Prompt Battle on Presentation: vote, result and reveal (issue #33)

Branch `claude/battle-presentation-33`, stacked on `claude/battle-voting-31` (#76). Claude Code (Opus 5.5). Files: `battle-presentation.js` (new), `app.js`, `battle-vote.js`, `styles.css`, `prepare-deploy.mjs`, `test/battle-presentation.test.js` (new), `test/battle-vote-screen.test.js` and `test/battle-privacy-contract.test.js` (current prompt now allowed in the ballot), this entry.

**Built:** `renderPresenter()` sends `battle_review`, `battle_vote` and `battle_result` to `presenterBattleStage()`. Before this, those phases fell through to the question card and would have shown the previous round's question during voting. The scenes come from `presentationBattleScene()` / `presentationBattleMarkup()` and use only `state.battleVote` / `state.battleResult`. Judging and waiting cards have no images. In `battle_vote` the big screen shows the prompt, images side by side lettered A/B(/C), and "Vote on your phone". In `battle_result` it shows the heading (winner, tie, default win), creators with logos, vote bars and counts, and crowns. Images load through the shared asset-ID cache with the host secret (`battleMediaCredential()`) and stay hidden until all have decoded, then fade in together; the bars animate after. The round header now labels the battle phases ("Prompt Battle · Judging / Vote / Results") instead of "Final standings".

**Change to #31's broadcast:** `battleVote` and `battleResult` now carry the current matchup's `promptText`, so the big screen can show it. Only future prompts are secret, and #35's ballot check now allows exactly the current prompt.

**Commands run:** `npm test`: tests 828, pass 828, fail 0. #23's guard (no `hostSecret` in the phone block) caught the first version of the shared image fetch; the credential choice now lives in `battleMediaCredential()` outside that block. Browser at 1920×1080: the real `app.js` Presentation view driven over BroadcastChannel through review, vote, result (win and three-way tie) and skipped. The first pass showed the frames overflowing the card, white-on-white prompt and CTA text on the white Presentation card, a broken-image icon before load, and the "Final standings" label; all were fixed and re-checked. For screenshots only, stand-in pixels were placed into the `<img>` tags by console, because `/media` 404s on the dev server.

**Unproven:** Real images through `/media` with the host secret, and the real host broadcast (#32). Needs Matthew's check on a second screen at presentation size.

### 2026-10-06 — Prompt Battle score audit: CSV and leaderboard (issue #34)

Branch `claude/battle-score-audit-34` (from origin/main `6b2921a`, after #30 merged and 0038–0042 were applied to production). Claude Code (Opus 5.5). Files: `app.js` (`scoreEventsCsv` extracted from `exportDetailedResults`, no output change), `room-api.js` (`resolveBattleMatchup` wrapper, `resolveBattleMatchupWithStandings`), `test/battle-score-audit.test.js` (new), `test/helpers/battle-fixtures.js` (new, moved out of `test/battle-resolve-runtime.test.js`), `test/battle-resolve-runtime.test.js` (now imports the shared fixtures), this entry.

**Audit result:** Battle events already flowed through both reads unchanged. `get_live_leaderboard` sums every score event, and the detailed CSV prints question ID, points and reason. Battle rows read as `battle-r<round>-m<matchup>`, blank base points and multiplier, and a reason such as `Prompt battle tie (2 ways) · 1 of 2 votes`. No export label change was needed. The one real gap was freshness: standings show battle points only after a fresh leaderboard read. `resolveBattleMatchupWithStandings` mirrors `lockAndScoreWithRecovery` (resolve, then re-read; a failed re-read is reported, never blocking), ready for #32's Reveal.

**Commands run:** `node --test test/battle-score-audit.test.js`: 6/6. The first run crashed because the test's `window` stub, needed by room-api, made PGlite assume a browser; the stub now exists only around that import. `npm test`: tests 785, pass 785, fail 0.

**Unproven:** No host UI calls the new helper yet (#32). The CSV was checked through the lifted builder against real RPC output in PGlite, not through a browser download.

### 2026-10-06 — Prompt Battle host roster (issue #27)

Branch `codex/capacity27-deepseek`, starting commit `d07055a9d0630adf1b419334e0140c90090c20cf`. Matthew authorized finishing #27 from DeepSeek’s green commit and requested race, broadcast and focus coverage. The genuine coordinating Sol claim remains held by the parent task; independent verifier native ID: `01a111fb-df03-7ac0-bde6-6e7762b53b7e`.

**Authorship:** DeepSeek Pro/high authored the product changes and initial regression tests in artifacts `0cd427f9-a0e9-45ed-8588-d3ff7d3be925` and `654db3f2-f7fa-4782-9e5f-872a13a41a77`; corrective artifact `0c935a8f-62ea-4568-a79a-1ba963df75c6` fixed serialization, uncertain-lock guards and stale revisions. Merge artifact `cd05663d-f9d2-447d-be1c-3260de7d03bd` combined #27 with current main's player, vote and Presentation flows; copy artifact `d05fd667-897d-4a17-a0ba-97357200cae1` made the no-image judging card explicitly say submissions are locked. Codex applied those artifacts, updated regression expectations, and completed verification. The inherited PGlite test helper now uses Node's `fileURLToPath` for paths with spaces.

**Built:** host roster refresh requests remain serialized across round changes and clean up only their owning panel; lock requests queue behind old saves and keep phase writes guarded until the server confirms the result; confirmed refreshes publish only aggregate progress. Polling patches the roster in place, preserving focused controls and typed drafts. Current-main vote and result Presentation scenes remain; the locked judging card stays neutral and image-free.

**Checks:** `node --test test/battle-host-sync.test.js test/battle-phase-3a.test.js`: 40/40. At published implementation SHA `d47e21cc1842bfc9526d24fd387959827da38898`, `npm test`: 846/846, no skips. Browser regression: 3/3 with host-to-Presentation `BroadcastChannel`, focus/draft preservation, and at least 4.5:1 text contrast on both prompt and judging cards; the locked card rendered no battle images. All 18 frozen acceptance checks passed. `npm run build:video`, syntax checks and `git diff --check` passed. Draft PR #79 is open. The final published SHA and independent lifecycle review are recorded in the evidence file and issue thread.

**Unproven:** Matthew’s Producer screen acceptance and any real-room rehearsal remain pending. Current main was merged locally; no production migration was applied, deployed or called, and the issue PR was not merged or closed.

### 2026-10-06 — Prompt Battle media purge functions (issue #38, migration 0043)

Branch `claude/battle-purge-38` (from origin/main `0d0b8ea`, after #73–#77 merged). Claude Code (Opus 5.5). Matthew assigned migration number 0043 in chat (recorded on #38). Files: `supabase/migrations/0043_prompt_battle_media_purge.sql` (new), `test/battle-media-purge.test.js` (new), this entry.

**Built:** `purge_expired_battle_media(limit)` lists expired battle images (`source = 'battle'`, non-null `expires_at` in the past) as `{ assetId, storagePath }`, oldest first, bounded to 1–1000, and writes nothing. `finalize_battle_media_purge(assetIds)` deletes rows only for listed assets that are battle-sourced, expired, and whose `storage.objects` row is already gone. An object the Worker failed to delete keeps its row and is reported as `keptObjectStillPresent`. Before deleting, it clears `session_battle_entries.submitted_asset_id` (a foreign key) and removes the ID from `session_battle_generations.asset_ids`, so entries, votes and score events survive. Both functions are service-role only. The design is two-phase because Supabase refuses direct SQL deletes from `storage.objects`, so the Worker (#39) removes objects through the Storage API between the two calls.

**Commands run:** `node --test test/battle-media-purge.test.js`: 6/6. Hand mutations: deleting rows while the object still exists failed 3; finalize touching author media failed 1; listing author media failed 1; not clearing the submitted reference failed 1. A first "undated images" mutation was redundant (another guard still filtered) and survived; the corrected version, with both guards removed, failed 1. File restored. `npm test`: tests 840, pass 840, fail 0.

**Unproven:** Not applied. Matthew applies 0043 (`npx supabase migration list --linked` should show only 0043 local-only). No Worker calls it yet (#39). PGlite's `storage.objects` is a stub, so whether the live table matches by `bucket_id` / `name` is confirmed only by 0013 and 0014 using the same columns.


### 2026-10-07 — Prompt Battle host review grid (issue #28)

Branch `codex/host-review-veto-28`, based on `b45be75c4f884989fcb14b90c84f0f15d1c1e087`. Implementation commit `4ba125eae163cf558258996923cbd646f36ce369`. Codex `gpt-6-luna` (logical medium, effective max). Matthew explicitly authorized this Luna Max implementation and Sol review on 2026-10-06; the issue claim records the genuine branch, base and native task identity. The required deploy manifest entry and room API wrapper were included so the helper ships and the existing host-only RPC can be called.

**Built:** the host-only `battle_review` screen shows each submitted image, the player prompt tied to that image, its creator, veto status/reason, and server-reported skipped matchups. Veto and undo call `veto_battle_entry` and then re-read `get_host_battle_state`, including after an uncertain RPC response. Review data stays in the private host panel; public state retains only aggregate battle progress. Start voting remains disabled until a matchup has a viable entry, selects the first viable matchup, and saves/restores the `battle_vote` phase. No vote collection or result handling was added.

**Checks at implementation commit `4ba125eae163cf558258996923cbd646f36ce369`:** frozen `npm ci` completed; `npm test`: 859/859 passed; focused host sync, phase and review tests: 47/47; `node --check` passed for the application, helper, deploy manifest and changed JS tests; `git diff --check` passed. Offline browser fixture using bundled Playwright and installed Chrome: 4/4 passed. It blocked external-origin requests and covered image fetch with the host secret, presentation/public-state privacy, veto and undo across host refresh, skipped/no-viable controls, viable matchup selection, and saved voting-phase recovery.

**Unproven:** Matthew did not personally view or accept the screen; parent-coordinated independent Sol review remains separate. No real room/provider call, migration, deployment, or live rehearsal was run. Producer acceptance and real-room behavior remain unproven.

### 2026-10-07 — Repair Prompt Battle score event identity (issue #30)

- **Branch and claim:** `codex/scoring-records-30`, based on `b45be75c4f884989fcb14b90c84f0f15d1c1e087`. Claimed through the lifecycle gate by Codex thread `01a11478-5125-77f2-942a-93d469bfcf4e` as GPT-6 Luna with effective effort `max` for this invocation; claim: https://github.com/mbelinkie/brainstorm/issues/30#issuecomment-6030507310. Independent Sol verification is pending.
- **Authorship and files:** Codex (GPT-6 Luna, effective max) authored `supabase/migrations/0044_battle_score_event_identity.sql` and `test/battle-score-event-identity.test.js`, updated `test/battle-resolve-runtime.test.js` to assert the new structural identity key, and appended this log plus `CHANGELOG.md`. No existing migration was edited.
- **Finding:** The old unique index used the readable `battle-r<round>-m<matchup>` `question_id` as event identity. An ordinary question can use that free-text ID: scoring it before battle resolution blocked the resolver, while re-scoring it after resolution deleted battle awards but left the resolved result snapshot in place. Both cases reproduced against the pre-fix migrations in PGlite.
- **Change:** Migration `0044` adds nullable `score_events.battle_matchup_id`, tags new winner and voter awards, replaces the label-shaped unique index with a partial unique key over session, matchup and player, and limits ordinary re-score deletion to rows without battle identity. It backfills winners from exact resolved-result entries and their generated award reason, and voters from the resolved matchup's persisted ballots and voter award reason; the readable label alone never classifies an event. Backfill updates identity metadata only. No FK was added: score events retain their existing session/player cascade behavior without introducing a new deletion dependency on matchup rows. The existing leaderboard and detailed CSV continue reading every event and use the unchanged readable `question_id`; `base_points` and `multiplier` remain null for battle rows, so ordinary boost paths stay excluded.
- **Checks:** Before the repair, `node --test test/battle-score-event-identity.test.js` failed both collision regressions (battle-first ordinary re-score removed the battle events; ordinary-first caused the resolver's label-index duplicate-key error). After the repair, `node --test test/battle-score-event-identity.test.js test/battle-resolve-runtime.test.js test/battle-score-audit.test.js test/battle-privacy-contract.test.js` passed 36/36 with no skips. `npm test` passed 855/855 with no skips. A body comparison confirmed the resolver still matches 0042 except for writing the new identity field, and the latest scorer matches 0035 except for preserving battle rows during ordinary re-scoring. `npm ci` completed; npm reported four high-severity audit advisories, and no audit fix was run.
- **Unproven / excluded:** The regression harness applies migrations and calls the SQL functions in in-process PostgreSQL via PGlite, with Supabase auth/storage/roles stubbed. No linked or production database was accessed, and migration 0044 was not applied. Production SQL behavior and independent Sol review remain pending.

### 2026-10-07 — Block voting from stale Prompt Battle review state (issue #28 follow-up)

Repair commit `c5a97d5` (`gpt-6-luna`, max) disables both rendered and patched Start voting controls while the authoritative host roster is stale, and `startBattleVoting()` independently rejects stale-state calls with a refresh instruction. The offline Chrome regression confirms that a successful final-entry veto followed by a failed host-state read cannot write a voting phase; a retry confirms the skipped roster but stays disabled, and undo only enables voting after fresh state confirms a viable entry.

**Checks on repair commit `c5a97d5`:** `npm test`: 859/859; offline Chrome fixture: 5/5; `node --check app.js`, `node --check test/battle-host-browser.mjs`, and `git diff --check` passed. No production room/provider call, deployment, or migration was run. Independent Sol verification and delegated acceptance remain pending on the combined published SHA.

### 2026-10-07 — Prompt Battle host voting and results (issue #32)

- **Branch and claim:** `codex/host-vote-result-32`, claimed from `0ad938043c33f74145c115c8ca7ff6706273f8fb` and then integrated the current `origin/main` at `1f6951836500c42b6b3f6916467652c0d3788c60`. Claimed by this Codex task with native identity `01a11476-86c4-7021-9f40-2b20dd9b5252`. Codex `gpt-6-luna` (logical medium, effective max) used the explicit user-authorized per-run routing override; tracked routing configuration was not changed.
- **Built:** Host controls start voting on the first viable matchup, show refreshed vote progress, reveal a result once, advance over skipped/nonviable matchups, and finish through the existing normal round-end/finale transition. Battle position, vote and result restore across host refresh. Finishing clears the battle fields; all-skipped rounds can finish only after a fresh authoritative host roster confirms no viable matchups. The phone receives only the existing public ballot/result projections, and no Presentation code was changed.
- **Checks:** focused host sync, phase and pairing tests: 60/60; `npm test`: 863/863 with no skips; offline installed-Chrome fixture with external origins blocked: 6/6, covering host review, two matchups, a three-way matchup, refresh recovery in vote/result phases, double-Reveal idempotency, stale-veto recovery and all-skipped finish; `node --check` and `git diff --check` passed. Local screenshots are under `/tmp/host-vote-result-32-evidence/`.
- **Unproven / excluded:** No real room, Supabase provider, or image provider was called. No migration, deployment or production change was made. The fixture uses mock RPC responses; independent Sol verification and delegated acceptance remain separate. Producer acceptance and live-room rehearsal remain unproven.

### 2026-10-07 — Prompt Battle host refresh and result readability repair (issue #32 follow-up)

- **Change:** The shared host refresh control now updates its native `disabled` property along with its accessible state, so it becomes clickable after the initial private roster read settles in voting and result phases. Host result rows now use one text column with dark, contrasting creator and vote-count colors on the light host card; the phone's dark result styling is unchanged.
- **Checks:** focused host sync, phase and pairing tests: 60/60; `npm test`: 863/863 with no skips; offline installed-Chrome fixture with external origins blocked: 6/6. The fixture clicks the actual refresh control after vote and result reloads, confirms the progress/result reads, and checks result names and vote counts remain visible with contrasting colors. `node --check` and `git diff --check` passed. Screenshots: `/tmp/issue-32-luna-browser/host-vote-result-first.png` and `/tmp/issue-32-luna-browser/host-vote-result-finale.png`.
- **Unproven / excluded:** No production room, Supabase/image provider, migration or deployment was used. The browser flow uses mocked RPC responses. Independent Sol verification and delegated acceptance remain pending on the updated published SHA; producer acceptance and live-room rehearsal remain unproven.

### 2026-10-07 — Prompt Battle recovery and contrast regression assertions (issue #32)

- **Attribution:** The two bounded browser-test assertions in `test/battle-host-browser.mjs` were authored by DeepSeek Flash (request `20e487d8-4eaa-4c02-a435-e79a74661121`) and applied from its reviewed artifact without edits. The recovery, lifecycle and publication work is by Codex GPT-6 Luna at effective effort `max` under native execution `01a1162f-e36e-7893-8251-a6bd28f6c93b`; tracked routing configuration remains unchanged.
- **Regression coverage:** A failed initial result-state read after reload must leave the persisted result stale while the real refresh control remains enabled; clicking it after the fixture recovers must restore the result without another resolve or score award. Every rendered host result row now has a measured creator-text and vote-count contrast assertion of at least 4.5:1.
- **Checks:** Focused host sync, phase and pairing tests: 60/60; `npm test`: 863/863 with no skips; offline installed-Chrome fixture with external origins blocked: 6/6, including the failed-read recovery and measured host-row contrast checks. `node --check app.js`, `node --check test/battle-host-browser.mjs`, and `git diff --check` passed. Fresh local screenshots were inspected; the run-only evidence is not published.
- **Unproven / excluded:** The browser fixture uses mocked RPC responses. No production room, provider, migration or deployment was used. Independent Sol review and delegated Producer acceptance remain pending; producer acceptance and live-room rehearsal remain unproven. This task records no merge or completion.

### 2026-10-07 — Schedule Prompt Battle media purge (issue #39)

Branch `codex/scheduled-purge-39`, started from `main` at `0ad938043c33f74145c115c8ca7ff6706273f8fb` after #38 was Done. Codex (`gpt-6-luna`, effective `max` for this invocation) claimed #39 through the lifecycle gate with native thread `01a11478-5125-77f2-942a-93d469bfcf4e`; claim: https://github.com/mbelinkie/brainstorm/issues/39#issuecomment-6031044067. The claim used a per-run routing clone and recorded Matthew's authorized model mismatch; tracked routing config was not changed. Before final checks, the branch was fast-forwarded to `origin/main` at `1f6951836500c42b6b3f6916467652c0d3788c60`.

**Changed:** `cloudflare-worker.js` exports an awaited `scheduled()` handler that lists up to 100 expired battle assets through migration 0043's service-role RPC, removes each `battle/` object through the Supabase Storage API using the existing admin header helper, and finalizes only IDs whose deletes returned success. Per-object failures remain eligible for a later run; malformed/non-battle paths are never sent to the privileged delete endpoint. Batch list/finalize failures reject the invocation while leaving rows for the next daily run. `wrangler.jsonc` adds one daily 03:00 UTC cron. `test/battle-media-scheduled.test.js` covers cron config, call order, partial/throwing Storage deletes, finalization retry, empty results, and refusal of author paths. `CHANGELOG.md` and this entry were appended. No existing migration or dependency manifest changed.

**Checks:** `npm ci` completed from the lockfile (49 packages added; npm reported four high-severity audit advisories, and no audit fix was run). Before Worker code was added, all six scheduled-handler regressions failed because `scheduled()` was absent. After implementation, focused Worker/PGlite checks passed 24/24 with no skips: `node --test test/battle-media-scheduled.test.js test/battle-media-purge.test.js test/battle-generate-route.test.js`. The merged-main full suite passed 869/869, no skips, with `npm test`. `node --check cloudflare-worker.js`, `node --check test/battle-media-scheduled.test.js`, `git diff --check`, and a config check against the installed Wrangler 4.125.0 schema passed; its `triggers.crons` property accepts string arrays.

**Unproven / excluded:** The Worker and cron were not deployed or invoked by Cloudflare. All Worker Storage/RPC calls used deterministic fakes; PGlite exercised 0043's SQL functions but not Supabase's real Storage API or production configuration. No live Supabase, provider, production migration, or real object deletion was performed. Independent Sol verification remains pending.

### 2026-10-07 — Batch Prompt Battle media purge (issue #39, PR #85)

Branch `codex/scheduled-purge-39`, resumed at `9c0f8908ebe2a6b58a7a114b4959bf0cbb726689` with current `main` already integrated at `1f6951836500c42b6b3f6916467652c0d3788c60`. The prior stopped claim was released through the lifecycle gate on Matthew's checkpoint evidence; this run claimed #39 with native thread `01a11634-e57b-7c50-a614-b20cb4aa61cc`. Codex `gpt-6-luna`, effective effort `max` under the per-run mapping; tracked routing config unchanged. Files: `cloudflare-worker.js`, `test/battle-media-scheduled.test.js`, `CHANGELOG.md`, and this entry.

**Changed:** The previous Worker issued one Storage delete per asset, so a 100-object list needed 102 external subrequests including list and finalization. It now sends one Storage batch deletion for validated battle paths and finalizes the corresponding IDs only after that request succeeds. Migration 0043 still protects metadata by deleting rows only when each Storage object is absent; a `keptObjectStillPresent` result fails the run while leaving those rows retryable. The daily batch is capped at 1,000 objects (the API limit); paginate if the backlog exceeds that ceiling. Invalid IDs or paths stay out of both privileged calls and logs.

**Checks:** `node --test test/battle-media-scheduled.test.js test/battle-media-purge.test.js test/battle-generate-route.test.js`: 27/27; `npm test`: 872/872, no skips; `node --check cloudflare-worker.js`; `node --check test/battle-media-scheduled.test.js`; `git diff --check`. The runtime fakes cover a 1,000-object batch in three subrequests, thrown/HTTP-failed batches without finalization, partial finalization, retry, and mixed valid/invalid paths.

**Unproven / excluded:** The Worker and cron were not deployed or invoked by Cloudflare. Worker Storage/RPC calls used fakes; PGlite exercised migration 0043, not live Supabase Storage or production configuration. No live Storage deletion, production migration, provider call or deployment occurred. Independent Sol verification remains pending.

### 2026-10-07 — Player submission outcome on refresh (issue #84)

Branch `codex/player-submission-state-84`, based on `main` at `1f6951836500c42b6b3f6916467652c0d3788c60`. Codex `gpt-6-luna` (logical high, effective max). The stopped prior claim was released through the lifecycle gate using the 2026-10-07 checkpoint evidence; #84 was then claimed with this run's native ID under Matthew's resumed Luna Max authorization.

**Files:** `supabase/migrations/0045_player_battle_submission_state.sql` (new), `test/battle-privacy-contract.test.js`, `CHANGELOG.md`, this entry.

**Built:** the existing player RPC now adds `entry.submissionStatus`, derived from `forfeited_at` and `submitted_at`; it retains its player credential check, battle phase guard, current-round/own-player lookup, null-entry behavior, prompt, attempts and own generations. Runtime coverage now observes a manual submit, a lock auto-submit, a forfeit, a repeated lock and fresh reads, plus invalid room/player credentials, null entries and current-round scoping. The first focused run exposed an old fixture assertion that assumed lock selected each player's first image; the fixture now checks the actual submitted image while keeping the existing privacy assertion.

**Checks:** `ctx-wire run rtk proxy node --test test/battle-privacy-contract.test.js`: 13/13. `ctx-wire run rtk proxy node --test test/battle-generation-rpcs.test.js test/battle-submission-rpcs.test.js test/battle-privacy-contract.test.js`: 47/47. `ctx-wire run rtk proxy npm test`: 863/863, no skips. All SQL ran in the existing PGlite database fixture. No production migration, external service, or deployment was used.

**Unproven:** migration `0045` has not been applied; live Supabase behavior and the dependent player UI are not covered here. Independent Sol verification of the published commit is pending.


### 2026-10-07 — OpenRouter comparison preparation and agreed game contract (#90)

Branch `codex/image-comparison-90`, based on verified remote main `0404395682f477a25e641f9ab4ee906378b4b019`. Matthew explicitly requested implementation of the approved $5/ten-model/three-prompt comparison plan. Codex built this direct research/local-tool package; no product coding harness was dispatched. The old staged research note and desktop checkout remain untouched.

**Files:** `tools/openrouter-comparison.mjs`, `scripts/setup-openrouter-comparison.command`, `test/openrouter-comparison.test.js`, `.gitignore`, `docs/research/openrouter-comparison-2026-10-07.md`, `CHANGELOG.md`, this entry. No application runtime, lockfile or migration changed. The native image tool belongs in `tools/`, following the existing bootstrap utility precedent; `scripts/` retains its GitHub transport guard.

**Built:** sequential one-image probe with exact approved prompts and model IDs, current endpoint validation/pinning, fixed high OpenAI quality and supported 1K square fields; dedicated non-resetting key limit no greater than $5 checked before every paid dispatch; pending ledger before dispatch; two retries only for confirmed temporary unbilled errors; unknown-charge stop; no successful-picture rerolls. Supported signatures and full native macOS decoding verify originals, sizes and MIME. The HTML grid shows all 30 cells, original links, reported cost/unknown charges, dimensions, provider time, slow flags and failure placeholders. A two-stage setup wizard stores only its own key file in ignored local state, mode 0600, using the unchanged wizard library. No key appears in artefacts or browser assets.

**Actual checks:** `npm ci --ignore-scripts` restored the existing lockfile dependencies (49 packages added; four audit advisories reported; no dependency/lockfile edit or audit fix). The first full-suite run failed the two roadmap transport-guard tests because the utility imported child_process under scripts/. Moving it to tools/ fixed the cause without weakening the guard. Focused runner + guard tests passed 6/6; final `npm test` passed 901/901, zero failures/skips. `node --check tools/openrouter-comparison.mjs`, `bash -n scripts/setup-openrouter-comparison.command`, wizard-library byte comparison and `git diff --check` passed. The runner check uses fake HTTP, tests retry ceilings/cost totals/unknowns/credit and invalid errors/budget stopping/secret exclusion/rerun behavior, and decodes a valid 1x1 PNG with native sips on this Mac.

**Public preparation:** `node tools/openrouter-comparison.mjs --prepare` fetched the live catalogue and ten endpoint records on 2026-10-07; all ten have a compatible current profile. Local dated metadata and pending grid live under ignored `.local/openrouter-comparison/`. Browser inspection verified 10 model rows, 30 cells, three exact prompt disclosures, and a separate clearly labeled synthetic layout fixture with decoded images, original links, costs, >60s flags, unknown-cost image retention and failure/not-run placeholders. Synthetic fixture state is separate from the actual paid ledger. The loopback-only preview server cannot serve key or environment files.

**Contract:** owner-approved one image/three logical attempts, no game dollar cap, shared account initially funded with $20, locked round model, two same-model retries and host redo for everyone before voting. Request-level accounting/session summaries, retry recovery and safe redo/round locking are separately bounded production follow-ups. Cost estimates remain deferred; #91/#92 consume the eventual owner-selected shortlist/default. All three issue body revisions are routed through the existing API gate, preserving lifecycle/labels/board state.

**Unproven / outstanding:** no paid generation, real provider cost, latency, refusal or failure fixture has been observed. The dedicated local key, actual grid, Matthew's model/default choice and independent published-contract review remain pending. #90 is not marked complete. Production provisioning/deploy/auth/storage/accounting and real players remain #36/#37. No production SQL, room write, external message, deploy, commit, push or PR was performed.

**Launcher correction:** Matthew's first setup run stopped at line 193: the double-quoted dollar amount expanded as an unset positional parameter under `set -u`. A focused offline check evaluates every authored instruction with `/bin/bash -u`, without running the browser/input/key-writing stages. It reproduced `$5: unbound variable`; escaping the three literal dollar signs in the title and balance note made it pass. The same comparison check, `bash -n` and `git diff --check` now pass. No key was read or paid request sent during this correction.

### 2026-10-07 — Real paid comparison and cost ordering (#90)

Matthew confirmed the dedicated key was ready and authorized continuing the paid run. On `codex/image-comparison-90`, `node tools/openrouter-comparison.mjs --run` completed all ten candidates/three prompts sequentially: 27 images, 36 requests (six retries), $2.152507 reported costs, zero unresolved charges. Nano Banana 2.1 produced nine confirmed unbilled HTTP 429 errors; the other nine models returned three images each. Final read-only key usage was $2.152507, with $2.847493 of the $5 limit remaining, exactly reconciling the ledger total. Every request records elapsed time; five successful requests exceeded 60 seconds. FLUX and Riverflow response charges differ from their dated catalogue rates; both values remain documented.

**Files/evidence:** updated the research note with actual cost/timing/outcome rows and remaining acceptance; saved the ignored local grid, originals, metadata, ledger, sanitized receipts, summary and final key-limit receipt. A verification command decoded all 27 original 1024-square PNG/JPEG files with native sips again and checked 36 completed ledger entries, known costs, retry bounds, 30 grid cells and exact original/thumbnail links. Browser inspection confirmed all ten model rows, images, costs, times and three 429 placeholders. Generated artifacts contained no credential/authorization patterns. Full `npm test` after the launcher correction passed 901/901, zero failures/skips. Through the shared API gate, #90's paid evidence and verified acceptance checklist items were updated and re-read; lifecycle/labels/board and owner-selection/review items remain untouched.

**Owner display request:** Matthew asked for cheapest-to-most-expensive ordering. The renderer now sorts a copy of the models by total reported request cost divided by usable images, placing missing-image/unknown-cost rows last. It preserves provider dispatch order and original files. The existing offline check now proves a confirmed zero-cost failure is last rather than treated as a free image model; the focused check passes. Regenerating the grid used `--render` only, with no additional paid call.

**Final sorting verification:** the visible browser row order is FLUX, Qwen, Seedream, Grok, Sunburst, Flare, Gemini Flash, Gemini Pro, Riverflow, then the failed Nano Banana row. `npm test` after the renderer change passed 901/901 with zero failures/skips (32.0 seconds); `git diff --check` passed. The grid remains open as a local deliverable. The changelog now reflects the completed paid probe rather than a pending key.

**Still pending:** Matthew's approved shortlist/default and independent review of published code/contract. No production integration, migration, real-game verification, commit, push, PR or deployment was performed.

### 2026-10-07 — Owner model selection recorded (#90–#92)

Matthew inspected the real grid and selected `bytedance-seed/seedream-5-0-pro` as default, with `qwen/qwen-image-3-pro`, `openai/gpt-image-2.5-sunburst` and `openai/gpt-image-2.5-flare` also approved. On `codex/image-comparison-90`, recorded those four exact IDs and supported fixed profiles in the research note and changelog, plus ignored local `selection.json` derived from the dated metadata. Seedream/Qwen use n:1, square aspect and 1K resolution; Sunburst/Flare use n:1, square aspect and high quality with no resolution parameter. The benchmark and its original files remain intact.

The shared API gate re-read #90/#91/#92, checked for concurrent body edits, patched the owner-selection/default/profile contract and confirmed every body. #90's owner-selection acceptance item is now checked; independent review remains open. Labels, lifecycle and board were not changed. `git diff --check` and exact-ID/profile documentation checks passed; no production code changed and no new paid call was sent. The previously verified code remains 901/901 passing. Publication/independent review and #36/#37 production/real-player gates remain outstanding; no commit, push, PR, migration or deployment was performed.

### 2026-10-07 — Revised shortlist after speed comparison (#90–#92)

Matthew replaced the earlier four-model/Seedream choice with this preference order: `x-ai/grok-imagine-image-quality` default; `google/gemini-3.1-flash-image` labeled more expensive; `black-forest-labs/flux-3-image` labeled less expensive. Relative prices use Grok as the baseline. The observed mean costs/times are $0.050000/5.8s, $0.068556/8.1s and $0.024000/22.3s respectively. All use their tested n:1, square, 1K profiles. The research note, changelog and ignored selection receipt now record this revised contract, replacing the current old choice while preserving the ten-model benchmark and historical worklog.

The shared API gate re-read and confirmed the revised #90/#91/#92 bodies, preserving unrelated fields and lifecycle/labels/board state. Local checks verified the three exact ordered IDs, Grok default, relative-cost labels and tested settings; `git diff --check` passed. No product code changed, paid call was sent, issue was promoted or implementation started. Matthew's explicit instruction not to start remains in effect. Independent review and existing dependency/release gates remain outstanding.

### 2026-10-07 — OpenRouter image generation and host catalogue (#91)

Branch `codex/openrouter-worker-91`, starting from the accepted #90 baseline `17445ba1452fd16b2974ebd0ffdb829922892ebe`; fast-forwarded to `origin/main` at `07d943459fdae80b0c174d8f4e58a784fae01851` before final verification so #18 remains included. Codex `gpt-6-luna`, effective effort `max`, claimed #91 through the lifecycle gate under native thread `01a1190e-0e36-7622-ae88-2b711969c1b9`.

**Files:** `cloudflare-worker.js`, `image-engine.js`, focused route/adapter tests, `test/battle-engine-selector.test.js`, `RUNBOOK.md`, `DEPLOYMENT.md`, `CHANGELOG.md`, and this entry. No schema, dependency, client/sample, or unrelated application changes.

**Built:** the server allowlist now includes Grok Imagine Image Quality (default), Gemini 3.1 Flash Image, and FLUX.3 Image with fixed n:1, square, 1K profiles and their tested endpoint tags (`xai`, `google-ai-studio`, `black-forest-labs`). Requests pin `provider.only` to that tag and disable fallbacks. Both host test and player generation use that server-owned profile and Worker-only `OPENROUTER_API_KEY`; explicit conflicting profile values fail before dispatch, and client-supplied model/engine/price settings cannot override the selected profile. `/battle/models` exposes `{models:[{id,provider,label,default}]}` only after the existing host authorization RPC and filters entries by available Worker binding or key. OpenRouter host test makes one n:1 request; Workers AI and Kaplan retain their prior behavior. Bounded error-envelope parsing only refunds a documented/valid unbilled failure when there is no image evidence or contradictory charge; malformed, positive/invalid-cost, image-bearing and otherwise unknown outcomes remain pending and generic to players. Successful OpenRouter image bytes must match the declared PNG/JPEG/WebP raster signature before storage; mismatches remain pending without refund or persistence. Worker AI and OpenRouter both require an exact model/provider allowlist pair; Kaplan keeps its synthetic-model path but cannot claim a known model owned by another provider. Partial successful storage/accounting remains intact. The #18 static selector assertion now compares its existing Workers AI choices strictly against Worker AI entries and leaves OpenRouter to the dynamic catalogue; `app.js` remains unchanged for #92. Deployment notes name the secret only and contain no credential value.

**Checks:** focused adapter/route/failure tests passed 61/61. After integrating `origin/main` and the selector-test adjustment, `npm test` passed 946/946 with zero failures or skips. `node --check` passed for the Worker, adapter and changed tests; `git diff --check` passed. `sips` decoded the new 1×1 PNG fixture. All provider paths were mocked; no paid OpenRouter call, secret provisioning, production change, or deployment occurred.

**Unproven / pending:** Sol's review findings on endpoint pinning and raster validation have been addressed; final independent confirmation and parent publication remain pending. The browser UI has not yet consumed the catalogue (#92), and no live host room/provider, production key, or deployment has been exercised.

### 2026-10-07 — Host OpenRouter model selector and sample (#92)

Branch `codex/openrouter-host-92`, starting at `main` baseline `593572537184346ec1c38aa95e2ead4b522d7e49`. This run claimed #92 through the lifecycle gate with native execution `01a11939-2560-7be3-83eb-b693c4bda75a`; Codex GPT-6 Luna (`gpt-6-luna`), logical medium / effective max, under Matthew's explicit routing override. Existing uncommitted #92 work from the stopped execution was preserved. This run added visible provider text below the model selector and the matching selector/browser assertions.

**Files:** `app.js`, `quiz.battle.sample.json`, `RUNBOOK.md`, `test/battle-engine-selector.test.js`, `test/battle-host-browser.mjs`, `test/quiz-battle-fixture.test.js`, `CHANGELOG.md`, and this entry. The sample now defaults to Grok Imagine Image Quality through OpenRouter, permits the approved three-model shortlist, uses one image and three attempts, and has no dollar cap. The selector consumes the host-authenticated catalogue, filters against every battle round, persists the provider/model through the existing RPC, reads that choice back after refresh, and blocks Test when saved state is unavailable or unconfirmed. The former Kaplan-backed sample route is documented as deferred; its adapter notes remain for internally approved events.

**Checks:** `node --test test/battle-engine-selector.test.js test/quiz-battle-fixture.test.js`: 27/27. `npm test`: 939/939, zero failures or skips. `node --check app.js`, `test/battle-engine-selector.test.js`, and `test/battle-host-browser.mjs`, plus `git diff --check`, passed. The isolated Chrome/Playwright fixture passed 7/7 with every non-local origin aborted; it covered all three OpenRouter models through select → Test → refresh, confirmed costs (including zero and unavailable), partial and failed responses, stale saved-model refusal, and the keyboard-open guard. Screenshots and `results.json` are in the ignored local `.codex-tmp/issue-92-01a11939-browser/` directory.

**Unproven / excluded:** The browser uses synthetic RPC and Worker responses; no production room, Supabase write, provider call, migration, key configuration, deployment, or live-player rehearsal was used. Matthew's Producer acceptance, independent Sol review at the published SHA, and #36/#37 real-service/player checks remain outstanding.

### 2026-10-07 — Integrate current main into player submission review (#26)

Branch `codex/submit-26-autonomous`, preserving the published PR #89 history from `b842d28f9f15dad24fd64e38377f4777e604b2a6` and normally merging `origin/main` at `3b5b0299bd87ed69326d10c673a80aaaaf9e8d82`. This Codex execution (`gpt-6-luna`, logical medium, effective max; native thread `01a11939-2560-7be3-83eb-b693c4bda75a`) claimed #26 through the lifecycle gate under Matthew's explicit per-run Luna Max authorization. DeepSeek Flash (`deepseek-flash`) supplied the validated import-union artifact; Codex applied it and resolved the merge.

**Files:** `app.js`, `test/battle-vote-screen.test.js`, and this entry. `app.js` retains current-main's battle-engine selector helpers and all PR #89's player submission helpers, with `resolveBattleMatchupWithStandings` imported once. In the phone-vote render conflict, current-main's reconnect-error heading/holding state and PR #89's submission markup/submission-aware render key are both preserved. The vote-screen test VM now seeds the phase-loader state introduced by PR #89. No product behavior was newly authored.

**Checks:** focused player/pairing/vote tests passed 65/65; `npm test` passed 962/962 with zero failures or skips. The isolated Chromium phone fixture passed all five submission cases at 390×844: pending selection, rejected refresh, retryable confirmation, submitted lock, and forfeited lock. Its Supabase/RPC and media responses were synthetic; other external requests were blocked. `node --check app.js`, `node --check test/battle-vote-screen.test.js`, and `git diff --check` passed.

**Unproven / excluded:** no live room, Supabase write, provider call, migration, deployment, or real-player rehearsal. Matthew's Producer acceptance and independent Sol review of the final published SHA remain pending.

### 2026-10-07 — Restore #92 host selector regression tests

Branch `codex/openrouter-host-92`, based on the existing published #92 commit `5ce8cd4e4a08a44b1575d58fbba2f1df5d66a75e`. This test-only follow-up kept the same live lifecycle claim under native thread `01a11939-2560-7be3-83eb-b693c4bda75a`. DeepSeek Flash (`deepseek-flash`, low) authored five Sol-approved regression tests in a validated append artifact (reported response: 10,683 tokens / 22.3 seconds). Codex GPT-6 Luna, effective max, applied the exact append and formatted only the new tests.

**Files:** `test/battle-engine-selector.test.js` and this work log. The five restored cases cover a rejected stale saved-engine read after a successful save; pending-save control disabling and error display; mutually exclusive test states plus two-image total/per-image cost; blocked reason and provider diagnostics; and direct host-identity/authorization guards. No application or helper code changed.

**Checks:** `node --test test/battle-engine-selector.test.js` passed 29/29; `npm test` passed 944/944 with zero failures or skips. `node --check test/battle-engine-selector.test.js` and `git diff --check` passed. The full output was retained in the local temporary test log. The existing isolated browser proof remains 7/7 on the unchanged application source; Sol's independent final browser verification is pending.

**Unproven / excluded:** The added tests use the existing synthetic fixtures. No production room, provider call, migration, secret, deployment, or live-player rehearsal was used. Matthew's Producer acceptance, independent Sol review at this published SHA, and #36/#37 real-service/player checks remain outstanding.


### 2026-10-07 — Integrate latest main into host selector branch (#92)

Branch `codex/openrouter-host-92` normally merged `origin/main` at `6b93b7d9747b3c3eeba51419abe474e51dbe127c` into #92's published test-restoration commit `183e07a670453bdbe04ed613dd8e5f4174f26166` after the merge preview found conflicts in `app.js` and this work log. Codex GPT-6 Luna, effective max, resolved the import union: the #92 host-selector imports and all current-main helper imports are retained, with `resolveBattleMatchupWithStandings` imported once. Both #92 and #26 work-log entries remain intact. No new product behavior was authored.

**Files:** `app.js` (import union) and this work log. The ordinary merge also retains all already-merged current-main files and history.

**Checks:** `node --test test/battle-engine-selector.test.js` passed 29/29; `npm test` passed 961/961 with zero failures or skips. `node --check app.js`, the selector test, and the browser harness passed; `git diff --check` passed. The isolated Chrome/Playwright fixture passed 7/7 with every non-local origin aborted and no page errors. Its local results and screenshots were retained in the temporary evidence directory.

**Unproven / excluded:** The browser uses synthetic RPC and Worker responses; no production room, Supabase write, provider call, migration, key configuration, deployment, or live-player rehearsal was used. Matthew's Producer acceptance, independent Sol review/browser verification at the final published SHA, and #36/#37 real-service/player checks remain outstanding.

### 2026-10-08 — Host export of Prompt Battle winning images (#40)

Branch `codex/winning-export-40`, starting at `main` baseline `c0beb0700a8815a01009d75026ce7ccfc18e8156`. Claimed #40 through the shared lifecycle gate with native thread `01a119a9-8a32-70f1-ba3c-96299d05af29`; Codex GPT-6 Luna (`gpt-6-luna`), logical medium / effective max, under Matthew's explicit Luna Max authorization.

**Files:** `app.js`, `cloudflare-worker.js`, `wrangler.jsonc`, `test/battle-winner-export.test.js`, `test/battle-host-browser.mjs`, `CHANGELOG.md`, and this entry. The existing app and Worker deployment packaging is unchanged; the existing Worker entry handles the new route, and Wrangler now sends `/battle/winners*` through it before static assets. No new deploy helper, dependency, or migration was added.

**Built:** a host-only control exports every stored resolved winner across the room, including ties and defaults, with creator, matchup prompt, player prompt, filename, and per-file result in a CSV manifest. Vetoed, forfeited, skipped, unavailable, and expired entries are excluded or clearly marked. Each Worker request reauthorizes the host before session-scoped metadata lookup; each image is freshly checked against the persisted result and strict `expires_at > now` boundary before streaming. The manifest omits database IDs and Storage paths; formula-like creator/prompt cells, including values preceded by whitespace or control characters, receive a tab prefix inside the quoted CSV field; the Presentation has no export control.

**Checks:** frozen `npm ci` completed; baseline `npm test` passed 973/973. Final `npm test` passed 977/977 with zero failures or skips. One prior full-suite attempt hit the existing 3-second subprocess timeout in `test/kaplan-proxy.test.js`; that unchanged file passed 40/40 in isolation and the final full-suite rerun passed. The focused Worker/config tests passed 4/4; `node --check` passed for changed JavaScript and `git diff --check` passed. After independent review found a host rerender leaving the current export control stuck busy and formula-like metadata unescaped, browser regressions reproduced both before the app fix and passed afterward. The isolated Chromium fixture then passed 11/11 with external-origin requests intercepted and aborted; it downloaded actual image bytes and verified exact bytes, creator/prompt CSV contents, formula-prefix neutralization, rerender completion and busy-guard behavior, partial failures, object-URL revocation, and Presentation exclusion. Passing artifacts are in `/tmp/winning-export-40-final-browser/`; earlier failing reports were retained in `/tmp/winning-export-40-rerender-repro/` and `/tmp/winning-export-40-security-regressions-red/`, alongside Sol's supplied rerender evidence.

**Unproven / excluded:** all Supabase, Storage, and Worker HTTP fixtures were synthetic; no live room, provider, migration, or deployment was used, and no production services were changed. No public sharing or live-player rehearsal was performed. Playwright allowed downloads in the fixture; Chrome's interactive multi-file download permission prompt and user-settings behavior remain unverified. Producer acceptance and independent Sol review at the published SHA remain pending.


### 2026-10-08 — Kaplan CrowdStrike handoff preparation (#19 / #94)

Branch `codex/kaplan-crowdstrike-handoff`, base `2ca966729250d4e96b99af867ac4ad0bc78f98b2`. Codex coordinator authored `docs/KAPLAN_CROWDSTRIKE_HANDOFF.md` and the linked Kaplan section in `DEPLOYMENT.md`; independent `gpt-6-sol` (high) reviewed the credential and deployment boundaries. Its authentication-permission and test-mount findings were corrected.

**Evidence:** authenticated Chrome confirmed all three Falcon secret names, enabled version 1 on each, and Secret Accessor for Matthew on 3 of 3. No secret values were opened. `node --test test/kaplan-proxy.test.js` passed 40/40, with no failures or skips. `git diff --check` passed. Proxy source and tests are unchanged from #94's pin.

**Remaining:** user performs Docker/sensor patch and push, private Gen 2 deployment, approved live Vertex-location selection and the bounded paid checks. Tenant region/provisioning-token handling, separate application-secret setup, SecOps sensor reporting and administrator public invocation are not verified. No cloud mutation, credential retrieval, deployment, email or paid generation occurred. This is partial preparation, not External acceptance or a lifecycle state change.

# Claude Work Log

Durable record of Claude's contributions to this repo, separate from `CHANGELOG.md`. One entry per session.

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

```
$ npm test        # baseline, before any edit
ℹ tests 149
ℹ pass 148
ℹ fail 1          # pre-existing: test/deploy-manifest.test.js, see below

$ npm test        # after the fix
ℹ tests 161
ℹ suites 0
ℹ pass 161
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The 1 baseline failure was `test/deploy-manifest.test.js` — `author.js references "./video-processor.worker.bundle.js", which does not exist` — a git-ignored generated artifact absent from any fresh worktree, failing identically before I touched anything. As a previous session did, I copied the already-built bundle from the main checkout into this worktree to get a clean full-suite run; I did not rebuild it, run `npm install`, or touch `package-lock.json` (`node_modules` and its `esbuild` devDependency are absent here). The file is git-ignored and is not in my commit.

Verified the new tests actually fail without the fix, per TDD: restored `app.js` and `quiz-core.js` from `HEAD` into the worktree (backing my versions up to the scratchpad first, then copying them back) and re-ran the two test files — 4 structural tests in `player-logo.test.js` failed and `quiz-core.test.js` failed to load at all on the missing imports. Also confirmed the behavioural delta directly: with a store holding room `ABC123` last active one hour ago, a TTL-only lookup returns `"Belinkie"` for room `XYZ789` (the bug) while `playerIdentityForRoom()` returns `null`, and the same-room lookup still returns `"Belinkie"`.

### Not regressed

`test/player-logo.test.js`'s Android join-screen logo-layout test (commit `6532ffc`, the `min-height: 0` grid-row collapse) is untouched and passes; my change touches no CSS. The auto-submit test ("auto-submit skips a selection after its question has closed or changed") passes. Two pre-existing string-matching assertions in `player-logo.test.js` referenced storage mechanisms this change removes (`savePlayerValue("musicTriviaPlayerId", playerId)`, `savePlayerValue("quizPlayerLogoKey", playerLogoKey)`, and the `PLAYER_SESSION_ACTIVITY_KEY` wiring); I rewrote those assertions onto the new mechanism while keeping each test's original intent, and the behavioural guarantees they were proxying for are now covered by real unit tests in `quiz-core.test.js` instead of string matching.

### Could not verify

- **No real device, no live room.** Everything is a `localStorage` model verified in unit tests plus structural assertions that `app.js` is wired in the right order. I did not open the app on a phone, scan a QR code, or watch a join screen appear. The manual steps to confirm are in the handoff.
- **The legacy migration path on a device that actually holds legacy keys.** The gate is asserted structurally and its TTL-carryover behaviour is unit-tested through `writePlayerIdentityForRoom()`, but I could not exercise a real phone whose storage predates this change. This is the highest-value thing for the user to spot-check on a handset that played before the deploy.
- **The `PLAYER_IDENTITY_ROOM_LIMIT` cap of 8.** A judgment call. Visiting a room writes an entry even before a name is chosen, so casually opening several room URLs inside one TTL window consumes slots; 8 is far above any realistic quiz night, and eviction is least-recently-active first, but the number is not derived from data.
- Did not touch `supabase/migrations/` — this is entirely client-side join-screen gating, no schema or server change.

# Claude Work Log

Durable record of Claude's contributions to this repo, separate from `CHANGELOG.md`. One entry per session.

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

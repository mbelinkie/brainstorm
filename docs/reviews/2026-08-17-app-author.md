# Code review — `app.js` and `author.js`

Date: 2026-08-17
Branch: `main` (clean worktree, `b85a1fd`)
Scope: `app.js` (2,463 lines — host / player / presentation) and `author.js` (1,684 lines).
Read-only review. No code changed. Supporting files consulted: `quiz-core.js`,
`quiz-validation.js`, `room-api.js`, `video-utils.js`, `cloudflare-worker.js`,
`supabase/migrations/0003|0013|0017`, `test/*`, `quiz.sample.json`,
`music-trivia.question-bank.json`, `styles.css`.

Findings are ordered by the `CLAUDE.md` "Review priorities" ranking. Each finding
names the surface, question format, phase, and the action sequence that produces
the wrong result. Findings with no reachable scenario are in
[Unproven](#unproven) at the end. Proposed `mistakes.md` additions are in
[Proposed mistakes.md additions](#proposed-mistakesmd-additions) — `mistakes.md`
itself was not edited.

---

## Summary

| # | Finding | Priority | Lesson |
|---|---|---|---|
| [F1](#f1) | `arrange_in_order` reveal shows the wrong "Correct order" on Presentation and on player phones | 2 | recurrence of #7 |
| [F2](#f2) | A failed auto-save renders in the *confirmed/locked* visual state, and any later redraw replaces it with "saved" | 2 | recurrence of #4 / #5 |
| [F3](#f3) | Presentation fully remounts on `players`, `scoreNotification`, `doorPicks`, `screenHistory` | 2 | recurrence of #14 |
| [F4](#f4) | Presentation replays a long-finished audio/video cue after arming or refresh — commands carry no sequence | 2 | recurrence of #3 |
| [F5](#f5) | Manual Submit bypasses `submitLiveAnswerWithRecovery`; the 2026-08-17 race fix covers only auto-submit | 2 | recurrence of #4 |
| [F6](#f6) | Presentation computes the `closest_number` winner in the browser, from a possibly partial guess list | 2 / 5 | recurrence of #7 |
| [F7](#f7) | `matchingBoard` prints a literal `${…}` template string on the shared screen | 2 | — |
| [F8](#f8) | `quiz.sample.json` fails validation, and its empty rounds dead-end the host state machine | 3 | recurrence of #8 |
| [F9](#f9) | Two divergent `validateQuiz` implementations; the shipped one is not the tested one | 3 | recurrence of #8 / #12 |
| [F10](#f10) | Host refresh loses `state.submitted`: "answers received" reads 0, "Who got it right" disappears | 4 | recurrence of #1 |
| [F11](#f11) | Timer auto-lock racing Reveal produces a modal alert and aborts the reveal; the retry latch never resets | 4 | — |
| [F12](#f12) | Author draft is discarded when the bundled bank fetch fails; the editor then throws | 4 | recurrence of #6 |
| [F13](#f13) | Importing JSON never persists the draft — a refresh silently reverts the import | 4 | recurrence of #6 |
| [F14](#f14) | Between-round "Remove audio" does nothing but reports "Saved in this browser" | 4 | recurrence of #4 |
| [F15](#f15) | Author image previews collapse "not signed in", "session expired", and "still loading" into one blank state | 4 | recurrence of #6 |
| [F16](#f16) | Presentation media failures are invisible: bare `console.warn`, and the command is marked handled before it succeeds | 6 | recurrence of #9 |
| [F17](#f17) | The reliability tests are source-text regexes; none of the above is asserted | 6 | recurrence of #10 |
| [F18](#f18) | Dead code and unreachable branches (11 items, each classified) | 7 | recurrence of #8 |
| [F19](#f19) | Duplicated logic that can drift (6 items) | 7 | — |

**No priority-1 findings.** I looked specifically for credential exposure,
authorization gaps, and player-payload leaks and did not find one.
`publicRoomState()` (app.js:147) is a genuine allowlist: reveal keys are gated on
`state.phase === "reveal"`, `submitted` is always emptied, `mediaCommand` is
projected down to five non-media fields, `publicDoorBonus()` strips the authored
`audio`, and `audioCommand` carries only `{id, volume, action, audioScope,
audioKey, questionId, clipId}` — never a `mediaAssetId` or URL. `revealImageAssetId`
and `questionImageAssetId` reach Presentation through `hostQuizDefinition` (host
secret required), not through the player payload. `config.js` holds only
publishable values.

---

## Priority 2 — product-invariant violations

### F1 {#f1}
### `arrange_in_order` reveal shows the wrong "Correct order" on Presentation and on player phones

`app.js:1060` (`orderBoard`), `app.js:147` (`publicRoomState`), `quiz-core.js:5`
(`toPlayerQuestion`).

`publicRoomState()` publishes `revealedCorrectOptionIds`,
`revealedCorrectCategories`, `revealedCorrectPairs`, `revealedMultiBlankAnswers`,
`revealedTextAnswers` and `revealedNumber` — **there is no
`revealedCorrectOrder`**. `toPlayerQuestion()` copies `items` but not
`correctOrder`. `orderBoard()` nevertheless renders a correct-order board from
the question object it is handed:

```js
const showingCorrectOrder = !presenter || state.phase === "reveal";
const items = orderedItems(question, player ? selectedObject() : showingCorrectOrder
  ? Object.fromEntries((question.correctOrder || []).map((id, index) => [id, index + 1]))
  : …);
```

Two wrong outcomes fall out of that:

**Presentation.** `answerControl({presenter:true})` passes `state.question` — the
player-safe projection. At reveal, `question.correctOrder` is `undefined`, so
every position resolves to the `999` fallback, `Array.prototype.sort` is stable,
and the board renders the **authored `items` order** numbered 1…N under the
heading "Correct order".

**Player phone.** `presenter` is `false`, so `showingCorrectOrder` is `!false ===
true` in *every* phase after `open`. From lock onward the player sees **their own
submitted order**, numbered 1…N, labelled "Correct order".

Reproduction — Presentation and player, `arrange_in_order`, phase `reveal`:

1. Author a five-item ordering question whose `items` array is not already in
   `correctOrder` sequence (the templates in `author.js:249` deliberately author
   `items` and `correctOrder` independently). Publish, create a room.
2. Host opens the question; a player drags the cards into any order and it
   auto-saves.
3. Host presses **R** (lock + reveal).
4. Presentation announces the authored `items` order as the correct answer.
   The player's phone announces the player's own order as the correct answer.
   The server (migration `0003`/`0017`, `arrange_in_order` branch) has already
   scored against the real `correctOrder`, so the shared screen and the
   scoreboard disagree.

Not caught by fixtures: neither `quiz.sample.json` nor
`music-trivia.question-bank.json` contains an `arrange_in_order` question, so
this has never been exercised. It is reachable by authoring alone — the type is
in the editor's dropdown (`author.js:427`) and has a template.

Fix boundary: add `revealedCorrectOrder` to `publicRoomState()` alongside the
other `revealed*` fields, and make `orderBoard` read it for both `player` and
`presenter` (mirroring how `matchingBoard` already reads
`state.revealedCorrectPairs` and `categorizeBoard` reads
`state.revealedCorrectCategories`). The "which key does this surface get in this
phase" decision is the same rule for all seven answer boards — a good candidate
to extract into **`quiz-core.js`** as a single `revealKeyFor(question, phase,
surface)` selector, so a new question type cannot be added with one surface
silently missing.

---

### F2 {#f2}
### A failed auto-save renders in the confirmed/locked visual state, and any later redraw replaces it with "saved"

`app.js:2150` (`queueAutoSubmission`), `app.js:2044` (`renderPlayer`),
`styles.css:111`.

Four states are required to be visibly distinct. They currently collapse into two
CSS treatments, and the failure state borrows the *success* treatment:

| State | Message | class | Rendered as |
|---|---|---|---|
| pending | "Saving selection…" | `""` | plain |
| confirmed | "Selection saved…" | `"submitted"` | bold green |
| abandoned | "The question moved on…" | `""` | plain — identical to pending |
| **failed / retryable** | "Selection was not saved. Tap it again to retry." | **`"submitted locked"`** | **bold red — identical to the locked-and-safe state** |

`styles.css:111` defines `.submitted { color: var(--green); font-weight: 700 }`
and `.locked { color: var(--red) }`. `renderPlayer` uses exactly
`class="submitted locked"` for the *normal* locked state (`state.phase ===
"locked"`). So a player whose answer was rejected sees the same bold-red styling
as a player whose answer is safely locked in.

Worse, the failure message is written straight to the live DOM by
`setSubmissionStatus()` and is **erased by the next `render()`**. `renderPlayer`
recomputes `phaseMessage` from
`sessionStorage["quiz-submitted:<room>:<questionId>"]`, which is set on the
*first* success for that question and never cleared.

Reproduction — player phone, `multi_fill_in_the_blank` (the piano finale), phase
`open`:

1. Player types intro 1's title. It auto-saves; `sessionStorage` flag set;
   status reads "Answers saved. You can keep editing…".
2. Player types intros 2–10. The phone drops off Wi-Fi for one debounce window,
   and `submitLiveAnswerWithRecovery` returns `{status:"failed"}`.
3. Status flips to "Answers were not saved. Edit a field to retry." — in bold
   red, indistinguishable from the locked state.
4. Any player joins, or the host makes a manual score adjustment. `players` /
   `scoreNotification` change, `playerRenderKey` changes, `render()` runs.
5. The phone now reads **"Answers saved. You can keep editing until the host
   closes the question."** Nine of ten titles were never saved. The player has no
   signal, and the host locks and scores the round.

Fix boundary: give the four states four class names, and hold the submission
outcome in module state (e.g. `lastSubmissionOutcome = {questionId, status}`) so
`renderPlayer` reconstructs it rather than letting a redraw erase it. The
`sessionStorage` "submitted" flag should record the *answer that was confirmed*,
not merely that some answer once was, so a later divergence is detectable. The
state-name → message/class mapping belongs in **`quiz-core.js`**.

---

### F3 {#f3}
### Presentation fully remounts on `players`, `scoreNotification`, `doorPicks`, and `screenHistory`

`app.js:643` (`presenterRenderKey`), `app.js:2050` (`render`), `app.js:783`
(`acceptPlayerPresence`), `app.js:2313` (`[data-adjust-score]`).

```js
const { activeClipId, audioCommand, revision, submitted, ...withAudioVolume } = roomState || {};
const { audioVolume, ...withMediaCommand } = withAudioVolume;
const { mediaCommand, ...visualState } = withMediaCommand;
return JSON.stringify(visualState);
```

Lesson #14 asks that every broadcast field be classified structural / visual /
transport-only before it enters the remount boundary. Six fields were classified
and excluded. Four were not:

- **`players`** — visual on `title`, `round_end` and the finale screens;
  transport-only on the `question`, `locked` and `reveal` screens.
- **`scoreNotification`** — the celebration toast is a fixed overlay
  (`scoreCelebration()` is appended *after* `${card}`), never part of the scene.
- **`doorPicks`** — visual only during `door_choice` / `door_reveal`.
- **`screenHistory`** — pure host navigation transport, never rendered by
  Presentation at all.

A remount is not cheap here: `render()` (app.js:2050) revokes every entry in
`imageMediaObjectUrls` and `attachEvents()` re-issues a `/media/<uuid>` Worker
fetch for **every** `[data-private-image]` on screen, and all
`presentation-card--*` entrance animations restart.

Reproduction A — Presentation, `single_choice` with a question image, phase
`open`:

1. Question is open with `questionImageAssetId` attached; the card has finished
   its entrance animation.
2. A late player joins (or an existing player's phone reconnects and
   re-announces presence).
3. Host `acceptPlayerPresence` pushes the player and calls `emit()` — deliberately
   without `persistHostState()`, precisely because it is transport-only.
4. `players` differs → presenter render key differs → `app.innerHTML` is
   replaced → the question image blanks and re-downloads, and the card animates
   in again mid-question.

Reproduction B — Presentation, any format, phase `reveal` (this is the exact
symptom lesson #14 describes):

1. Host reveals a question that has a `revealImageAssetId`.
2. Host applies a manual score adjustment (a shipped feature, CHANGELOG
   2026-08-12).
3. `adjustScore` refreshes `state.players` *and* sets `state.scoreNotification`,
   then `emit()`s → Presentation remounts, the reveal image re-downloads, the
   reveal animation replays.
4. 6,600 ms later the expiry timer clears `scoreNotification` and `emit()`s
   again → **second** full remount, still during the reveal.

Fix boundary: destructure `scoreNotification`, `screenHistory` and `doorPicks`
out of the render key and update them in place, exactly as
`updatePresenterActiveClipState()` already does for `activeClipId`. `players` is
the harder case — the honest fix is a scene-scoped key (include `players` only
when `presentationScreen` is one of `title` / `round_end` /
`final_podium` / `final_scores`), which is the "authoritative scene projection"
that lesson #7 asks for. `presenterRenderKey` is the right thing to lift into
**`quiz-core.js`** so it can be unit-tested per scene instead of by regex.

---

### F4 {#f4}
### Presentation replays a long-finished cue after arming or refresh — commands carry no sequence

`app.js:1572` (`applyPresentationAudioCommand`), `app.js:1467`
(`applyPresentationMediaCommand`), `app.js:1517`/`1539` (arming), `app.js:71`
(`setAudioCommand`).

Lesson #3 requires a command to carry "room ID, quiz-version ID, question ID,
media ID, command ID, and sequence or timestamp", and to "ignore commands older
than the last applied sequence". The current command carries `{id, volume,
action, audioScope, audioKey, questionId, clipId}`. Missing: room, quiz-version,
media ID, and **any ordering or freshness marker**. The only staleness defence is
`command.id === handledPresentationAudioCommand` — module state that resets to
`null` on page load and is explicitly reset to `null` again by both arming
functions (app.js:1535, app.js:1551).

The command also survives a reload: it is part of `publicRoomState()` and is
persisted by `set_live_room_state`, so a reconnecting Presentation receives the
*last command ever issued* with no way to tell whether it was issued two seconds
or twenty minutes ago.

Reproduction — Presentation tab, `matching` (piano finale) or any audio question,
phase `reveal`:

1. Host cues clip 7 during the open question. Presentation plays it; playback
   ends.
2. Host locks and reveals. `state.audioCommand` is still `{action:"play",
   audioScope:"question", questionId:"q-finale", clipId:"song-7", id:"…"}` —
   nothing clears it.
3. The Presentation tab crashes, or the host reloads it, or moves it to a second
   display and reopens it.
4. On reload `handledPresentationAudioCommand` is `null` and the sound gate
   appears. The host clicks **Enable media** — a required, expected action.
5. `armPresentationAudio()` sets `handledPresentationAudioCommand = null` and
   calls `render()`; `attachEvents()` then runs
   `preparePresentationAudio().then(applyPresentationAudioCommand)`
   (app.js:2407), which sees an unhandled `play` command and **starts clip 7
   again**, over the answer reveal.

The video path is identical: `armPresentationMedia()` clears
`handledPresentationMediaCommand` (app.js:1551) and `attachEvents()` at
app.js:2410 re-applies the stored `mediaCommand`.

A second, quieter instance of the same gap: `preparePresentationAudio()` returns
early when it cannot resolve a source (`if (!sourceKey || sourceKey ===
presentationAudioSourceKey) return;`, app.js:1498), but
`applyPresentationAudioCommand` then still calls `startPresentationPlayback()`.
If the resolved clip is unavailable, the previously loaded clip plays instead of
the requested one — the original stale-clip bug class, now one level deeper.

Fix boundary: add `issuedAt` (or a monotonically increasing `sequence` derived
from `state.revision`) plus `roomCode`, `quizVersionId` and the resolved
`mediaAssetId` to both commands; have Presentation reject a command whose
sequence is not greater than the last applied one, and drop `play` commands
older than a small freshness window on a fresh mount. Command construction and
the accept/reject predicate belong in **`quiz-core.js`** so `cue A → cue B →
restart → reconnect → duplicate delivery` can be tested without a browser.

---

### F5 {#f5}
### Manual Submit bypasses `submitLiveAnswerWithRecovery`

`app.js:2328` (`[data-submit]`) vs `app.js:2138` (`queueAutoSubmission`);
`room-api.js:141` (`submitLiveAnswerWithRecovery`).

The 2026-08-17 changelog entry — "Auto-submit now recognizes the server's
stale-revision rejection, refetches room state, and retries once" — was applied
to `queueAutoSubmission` only. The manual Submit button still calls
`roomApi.submitAnswer` directly, has no stale-revision recovery, cannot
distinguish an expected race from a real failure, and reports every rejection as
a blocking `alert()` plus a `recordDiagnostic` (i.e. a Sentry error).

Manual submit is the path for `short_answer`, `fill_in_the_blank`,
`numeric_estimate` and `closest_number` (`manualSubmit`, app.js:2043).

Reproduction — player phone, `short_answer` with an attached audio clip, phase
`open`:

1. Host opens the question. Player types an answer.
2. Host presses **Space** to play the clip. The `[data-audio-command]` handler
   calls `persistHostState()`, which increments the server revision.
3. Within that window the player taps **Submit** with the pre-cue
   `state.revision`.
4. `submit_live_answer` raises "This question has changed; refresh and try
   again". The player gets a modal
   *"Your answer was not submitted. Please try again."*, and a Sentry issue is
   filed — for a benign, host-initiated revision bump on a question that is
   still open. The identical situation on a `single_choice` question recovers
   silently.

Also in this handler: `state.submitted[playerId] = selected` keys by the local
auth token rather than `doorPlayerRecordId`, unlike `sendSubmission`
(app.js:681). It is local-only state, so nothing miscounts, but it is the same
identity confusion the roster-identity fix removed elsewhere.

Fix boundary: route `[data-submit]` through `submitLiveAnswerWithRecovery` in
**`room-api.js`** and share one status-setting helper with
`queueAutoSubmission`. There should be exactly one submit path.

---

### F6 {#f6}
### Presentation computes the `closest_number` winner in the browser, from a possibly partial guess list

`app.js:1201` (`closestNumberResultsBoard`), `app.js:1196`
(`closestNumberResultEntries`), `supabase/migrations/0017_closest_number_scoring.sql:24`,
`cloudflare-worker.js` `/host-closest-number-guesses`.

`CLAUDE.md`: *"Presentation is a projection of authoritative state — never let it
compute a result the server owns."* Migration `0017` computes `winning_distance`,
`winner_count` and the split `shared_points`. The Worker endpoint returns raw
`{playerName, logoKey, guess}` rows and **no winner flag**. Presentation then
re-derives the minimum distance, the tie set, and the ★ "Closest!" badge itself.

Under normal conditions the two agree — both do exact decimal arithmetic
(Postgres `numeric`, `BigInt` in the browser). The failure is in the *input*, not
the arithmetic:

```js
function closestNumberResultEntries(questionId = state.questionId || state.question?.id) {
  if (closestNumberGuessesQuestionId === questionId) return closestNumberGuesses;
  return realtimeClosestNumberGuessesQuestionId === questionId ? [...realtimeClosestNumberGuesses.values()] : [];
}
```

When the authoritative Worker fetch fails, `closestNumberGuessesQuestionId` is
never advanced, and the board silently falls back to
`realtimeClosestNumberGuesses` — a map built only from `submission` broadcasts
that this tab happened to receive while it was open on this question
(`acceptSubmission`, app.js:558).

Reproduction — Presentation, `closest_number`, phase `reveal`:

1. Twelve players are in the room. The Presentation tab is opened (or reloaded)
   after the question is already open, so it misses the first four broadcasts;
   its realtime map holds eight guesses.
2. Host locks and reveals. The server scores the true closest guess — one of the
   four missed players.
3. `refreshClosestNumberGuesses()` calls `${workerOrigin}/host-closest-number-guesses`.
   The Worker returns 502 (its `sessions` or `submissions` lookup failed) or the
   request times out.
4. `closestNumberGuessesError = true`, but `rows` is non-empty from the realtime
   fallback, so the error copy is never shown. The shared screen crowns a
   **★ Closest!** winner out of the eight guesses it happens to hold, while the
   points went to someone who is not on the board.

Even in the happy path this is a duplicated rule: rank, tie detection and
"Tied winners" are implemented in both `0017` and `closestNumberResultsBoard`.

Fix boundary: have `/host-closest-number-guesses` in `cloudflare-worker.js`
return the server's `winningDistance` / `isWinner` / `points` per row, and let
Presentation render them. Failing that, at minimum: never fall back to the
realtime subset for a *ranked* board — show the "could not load" state instead.
The decimal parsing/formatting helpers (`closestNumberDecimal`,
`formatClosestDecimal`) are pure and belong in **`quiz-core.js`** next to
`tallyQuestionResults`, which already carries the "must mirror the migration"
warning.

---

### F7 {#f7}
### `matchingBoard` prints a literal `${…}` template string on the shared screen

`app.js:1076`.

```js
${unassigned.length && !presenter
  ? unassigned.map((clip) => dragCard(clip, "matching", enabled)).join("")
  : '<span class="drag-empty">${showingMatches ? "All items placed" : "Listen for each clip"}</span>'}
```

The `else` branch is a **single-quoted** string, so its `${…}` is never
interpolated. The audience sees the raw source text:

```
${showingMatches ? "All items placed" : "Listen for each clip"}
```

Reproduction — Presentation, `matching`, phases `open` / `locked` / `reveal`:

1. Publish `quiz.sample.json`'s `piano-intro-match` question (or any `matching`
   question) and open a room.
2. Host opens the question.
3. `presenter` is `true`, so `unassigned.length && !presenter` is always falsy
   and the else branch always renders. The literal string appears in the clip
   pool above the poster grid for the whole question, including the reveal.

The player path hits it too, from `categorizeBoard`'s sibling pattern being
correct: on a host/player board where every clip has been assigned,
`unassigned.length` is `0` and the same literal renders.

Not caught by `test/presentation-layout.test.js`, which asserts on source text
rather than rendered output — the regexes match the literal happily.

Fix boundary: backtick the string. Longer term this is an argument for rendering
Presentation from a scene object rather than from 400-character nested template
literals (lesson #7): a defect this visible survived because nothing renders the
markup in a test.

---

## Priority 3 — persisted data and compatibility

### F8 {#f8}
### `quiz.sample.json` fails validation, and its empty rounds dead-end the host state machine

`quiz.sample.json`, `app.js:372` (`startRound`), `app.js:244` (`advanceQuestion`).

`CLAUDE.md` names `quiz.sample.json` and `music-trivia.question-bank.json` as
compatibility fixtures to be validated via `quiz-validation.js` before shipping a
schema change. Run today:

```
music-trivia.question-bank.json => []
quiz.sample.json => ["Round 2 needs at least one question.",
                     "Round 3 needs at least one question.",
                     "Round 4 needs at least one question."]
```

Three of `quiz.sample.json`'s five rounds have `"questions": []`. No test in
`test/` loads either fixture (`grep -rn "quiz.sample" test/` returns nothing), so
the invariant is documented but unenforced.

That is more than a stale fixture — an empty round is an unrecoverable state for
the host:

```js
async function startRound(targetRoundIndex = state.targetRoundIndex) {
  if (!Number.isInteger(targetRoundIndex)) return;
  clearRoundStartAdvance();
  rememberCurrentScreen();
  if (hostQuizDefinition?.rounds?.length && !setHostQuestion(targetRoundIndex, 0)) return;   // ← silent dead end
```

Reproduction — Host, any format, phase `reveal` → `round_end`:

1. Publish a quiz whose round 2 has no questions (`quiz.sample.json` as-is, or a
   round created in the editor and later emptied).
2. Host reveals the last question of round 1 and presses **N**.
3. `advanceQuestion` → `startRoundEnd(1)` — it does not check whether round 2 has
   questions. Presentation shows "End of Round 1" plus the scoreboard.
4. Host presses **N** again → `startRound(1)` (or, with doors enabled,
   `openDoorChoice(1)` → doors → reveal → `advanceQuestion` → `startRound(1)`).
5. `setHostQuestion(1, 0)` returns `false`; `startRound` returns. **No state
   change, no error, no console output.** The button and the arrow key appear
   dead. The only way out is the "Testing shortcut" question-jump control, which
   is a debug affordance, and it cannot reach round 2 either.

Fix boundary: reject empty rounds in validation (both validators — see
[F9](#f9)); make `startRound` skip to the next non-empty round or surface an
explicit host error rather than returning silently; and add a fixture test that
runs `validateQuiz` over both compatibility banks so this cannot regress. The
"find the next playable question/round" walk is pure and belongs in
**`quiz-core.js`** — `advanceQuestion`, `startRound`, `jumpToQuestion` and
`showPreviousScreen` all reimplement pieces of it today.

---

### F9 {#f9}
### Two divergent `validateQuiz` implementations; the shipped one is not the tested one

`author.js:138` vs `quiz-validation.js:1`.

`author.js` does **not** import `quiz-validation.js`. It defines its own
`validateQuiz`, and that private copy is what runs on Publish (author.js:1580),
Validate (author.js:1652), Apply raw JSON (author.js:1655), Import
(author.js:1656) and the "Quiz health" panel (author.js:281).

`quiz-validation.js` is imported by exactly three test files
(`quiz-validation.test.js`, `door-bonus.test.js`, `video-clips.test.js`) and is
shipped to the browser by `prepare-deploy.mjs` — where nothing loads it. The
tested validator is not the shipped validator.

They have already drifted, in both directions:

| Rule | `author.js` | `quiz-validation.js` |
|---|---|---|
| Question-type allowlist | yes (11 types) | **absent** — any `type` string passes |
| `finale.audio` asset IDs | validated | **not validated** |
| `betweenRoundBonus.audio` asset IDs | **not validated** | validated |
| `arrange_in_order` order key | validated | **absent** |
| `categorize` category/assignment key | validated | **absent** |
| `fill_in_the_blank` blanks | validated | **absent** |
| `matching` `correctPairs` key | validated | key contents unchecked |
| `question.audio.mediaAssetId` | validated | **absent** |
| Empty round rejected | no | no |

Concrete consequence today: `music-trivia.question-bank.json` passes
`quiz-validation.js` and would **fail** `author.js`'s validator if its
`numeric_estimate` entry were inside a round rather than under `optionalTieBreak`
(the author allowlist has no `numeric_estimate`). Conversely, a quiz with a
broken `arrange_in_order` answer key passes `quiz-validation.js` — the module
`CLAUDE.md` instructs you to validate compatibility fixtures with — and would be
scored as zero points for every player by migration `0003`'s
`arrange_in_order` branch.

`docs/TITLE_SCREEN_SRT_LYRICS.md:116` and `docs/VIDEO_CLIPS_TECH_PLAN.md:51`
already instruct contributors to "update both validation surfaces", which is the
project acknowledging the drift rather than removing it.

Fix boundary: delete `author.js`'s copy and import **`quiz-validation.js`**,
promoting the stricter author-side rules (type allowlist, all answer-key checks,
`finale.audio`) into the shared module. `test/quiz-validation.test.js` then tests
the code that actually runs.

---

## Priority 4 — recovery, idempotency, and atomicity

### F10 {#f10}
### Host refresh loses `state.submitted`

`app.js:147` (`publicRoomState` sends `submitted: {}`), `app.js:792`
(`connectHostedRoom`), `app.js:1614` (`answerResultsPanel`), `app.js:1730`
(`submittedCount`).

`state.submitted` is host-local, accumulated from realtime `submission`
broadcasts. It is deliberately stripped from the public state (correct — that is
the privacy allowlist), and nothing re-fetches it on reconnect:
`getHostRoomState` returns the public state, whose `submitted` is `{}`.

Reproduction — Host, any format, phase `open` → `reveal`:

1. Twelve players joined; eight have answered. The host panel reads **8 / 12
   answers received**.
2. The host's laptop sleeps, or the host reloads the tab (an explicitly supported
   recovery path — CHANGELOG 2026-08-12 "host-refresh recovery").
3. `connectHostedRoom` restores phase, question, timer and screen. The counter
   now reads **0 / 12** while all eight answers are safely in the database.
4. Host has no way to tell whether anyone has answered, and either waits or locks
   blind.
5. Host presses **R**. `answerResultsPanel()` computes
   `tallyQuestionResults(hostQuestion, state.submitted)` over an empty object,
   gets `totalSubmitted === 0`, and returns `""` — the "Who got it right"
   summary shipped on 2026-08-17 silently does not render.

This is the "reconnect *into* a phase rather than transitioning into it" case the
brief asks about, and it affects the two host readouts that drive live pacing.

Fix boundary: the Worker already proves the pattern — `/host-text-answers`
re-reads `submissions` with the service credential after verifying the host
secret. A `/host-submissions` (or a `get_host_submissions` RPC) returning
`{playerId, answer}` for the active question would restore both the counter and
the tally on reconnect. Belongs in **`room-api.js`** + `cloudflare-worker.js`.

---

### F11 {#f11}
### Timer auto-lock racing Reveal produces a modal alert and aborts the reveal; the retry latch never resets

`app.js:959` (`updateTimer`), `app.js:865` (`lockQuestion`), `app.js:888`
(`revealQuestion`).

The database is safe: `lock_and_score_live_question`
(`0003_server_scoring.sql:24`) takes `SELECT … FOR UPDATE` on the session and
re-checks `phase <> 'question_open'`, so a second concurrent call **cannot**
double-score. It raises `'The active question is not open'` instead. The client
handles that badly.

```js
function updateTimer() {
  …
  if (remaining === 0 && view === "host" && state.phase === "open" && !timerExpiryLocking) {
    timerExpiryLocking = true;      // set before the await
    lockQuestion();                 // not awaited, no in-flight guard
  }
}
```

```js
} catch (error) {
  recordDiagnostic("lock-and-score", error, …);
  alert(`Could not lock and score this question: ${error.message}`);   // state.phase stays "open"
}
```

Reproduction A (double-fire) — Host, any format, phase `open` with a 30-second
timer:

1. Timer reaches 0. `updateTimer` latches `timerExpiryLocking` and fires
   `lockQuestion()`.
2. Within the RPC round-trip (~150–400 ms on Supabase Free) the host presses
   **R** or **N**, as a host watching a clock hit zero naturally does.
3. `revealQuestion()` sees `state.phase === "open"` (the first call has not
   returned) and calls `lockQuestion({renderAfter:false})`.
4. The second RPC blocks on the row lock, then raises "The active question is not
   open".
5. A modal `alert()` appears on the shared laptop mid-show. `state.phase` is
   never set to `"locked"` by the failing call, so `revealQuestion`'s
   `if (state.phase !== "locked") return;` aborts — **the reveal does not
   happen**. The host must dismiss the alert and press R again.

Reproduction B (unrecoverable auto-lock) — same setup, no second keypress:

1. Timer reaches 0; `timerExpiryLocking = true`; `lockQuestion()` fires.
2. The RPC fails for a transient reason (network blip, Supabase 5xx).
3. `alert()`; `state.phase` stays `"open"`; `timerExpiryLocking` stays `true`.
4. `updateTimer` runs every 250 ms forever and never retries, because the latch
   is only cleared by `startTimer()`. The question stays open past its timer with
   no automatic lock, and the host is not told the auto-lock is dead.

Fix boundary: guard `lockQuestion` with a single in-flight promise (the file
already has this pattern — `submissionSequence`, app.js:53); clear
`timerExpiryLocking` in the `catch`; and treat "The active question is not open"
as a benign already-locked outcome — resync from `getHostRoomState` and continue
to reveal rather than alerting. Classifying that message belongs next to
`classifySubmitAnswerError` in **`room-api.js`**, which already owns the
"expected RPC rejection vs real failure" vocabulary.

---

### F12 {#f12}
### Author draft is discarded when the bundled bank fetch fails; the editor then throws

`author.js:1666–1682`.

```js
try {
  const bundledBank = await fetch(BANK_URL, { cache: "no-store" })…;   // ← first statement
  originalBank = clone(bundledBank);
  lastPublishedBank = restorePublishedSnapshot();
  const draft = restoredDraft();                                        // ← never reached on failure
  if (draft) { bank = draft.bank; … }
  else { bank = bundledBank; … }
  render();
} catch (error) {
  $("#nav-title").textContent = "Question bank is not connected";
  …                                                                     // bank stays undefined
}
```

`restoredDraft()` was written specifically to preserve temporarily-invalid
in-progress work across refresh (`test/reliability-contract.test.js:16` asserts
it does not call `validateQuiz`). But it is sequenced *behind* a network fetch of
a static file that the draft does not depend on. Lesson #6's "not loaded",
"invalid" and "missing" collapse again: the bundled bank being unreachable is
treated as the author having no work.

Reproduction — Author, any question, any state:

1. Author has an hour of unpublished edits saved under
   `quiz-control:author-draft:v1`.
2. They reload `author.html` while the dev server is restarting, or the deployed
   asset request 502s / times out once.
3. The header reads "Question bank is not connected". The draft is on disk and is
   never read. `render()` never runs, so the editor pane keeps whatever the
   `#empty-state` template shows.
4. `initialiseAuth()` still runs (author.js:1683) and calls `loadMediaAssets()`
   → `renderMediaLibrary()` → `JSON.stringify(bank).includes(asset.id)` with
   `bank === undefined` → `TypeError: Cannot read properties of undefined
   (reading 'includes')`, reported as an unhandled rejection to diagnostics/Sentry.
5. Every editing control is bound but throws on `bank.rounds` / `question()`.

Secondary risk: any control that reaches `markChanged()` before throwing writes
`JSON.stringify({bank: undefined, selection, savedAt})`, which drops the `bank`
key entirely — `restoredDraft()` then returns `null` on the next load and the
draft is gone for good. I did not find a control that reaches `markChanged()`
without first dereferencing `bank`, so I am not claiming this path is proven.

Fix boundary: restore the draft **before** fetching the bundled bank, and treat
the fetch as an optional source for `originalBank` and the no-draft fallback.

---

### F13 {#f13}
### Importing JSON never persists the draft

`author.js:1656` vs `author.js:1655`.

`#apply-raw` calls `markChanged()` (which calls `saveDraft()`); `#import-file`
does not — it sets `bank`, sets `#save-state`, and calls `render()`. `render()`
does not save. `syncPublishControl()` is also skipped, so the Publish button's
enabled/disabled state and tooltip are stale until the next edit.

Reproduction — Author:

1. Author imports `my-quiz-v3.json`. Status reads "Imported and validated
   my-quiz-v3.json — download to keep edits". The editor shows the imported
   quiz.
2. Author reviews it without touching a field (reading is the normal first thing
   to do after an import) and reloads, or closes and reopens the tab.
3. `restoredDraft()` returns the *previous* draft. The import is gone with no
   warning; the copy claimed only that it needed downloading to keep *edits*.

Fix boundary: call `markChanged()` (and `syncPublishControl()`) in the import
handler, as `#apply-raw` does. Both handlers are the same three-step
parse → validate → adopt flow written twice; extracting `adoptQuiz(candidate,
sourceLabel)` removes the drift.

---

### F14 {#f14}
### Between-round "Remove audio" does nothing but reports "Saved in this browser"

`author.js:301` (`privateAudioPreview`), `author.js:524` (`[data-remove-audio]`),
`author.js:383` (`betweenRoundSoundEditor`).

`betweenRoundSoundEditor` renders the shared preview component with a
`between:<key>` target, which emits `<button data-remove-audio="between:roundEnd">
Remove audio</button>`. The handler recognises only `"question"`, `"finale:"` and
`"clip:"`:

```js
if (target === "question") { … }
else if (target.startsWith("finale:")) { … }
else if (target.startsWith("clip:")) { … }
markChanged();      // ← runs regardless
renderEditor();
renderPreview();
```

Reproduction — Author, between-round bonus editor, "Door selection" slot:

1. Author attaches a suspense clip to the `doorChoice` slot.
2. The card now shows two removal controls: **Remove audio** (inside the preview
   block) and **Remove sound** (the `[data-remove-between-round-audio]` button
   below it).
3. Author clicks **Remove audio**.
4. Nothing is deleted. `markChanged()` runs, so `#save-state` changes to *"Saved
   in this browser — download or publish when ready"* and the draft is
   re-persisted. The clip is still attached and still plays in the room.

This is the authoring-side shape of lesson #4: a confirmation for an action that
did not occur.

Fix boundary: handle the `between:` prefix, and only call `markChanged()` when a
branch actually matched — an unmatched target should be a no-op or an error, not
a "saved" confirmation.

---

### F15 {#f15}
### Author image previews collapse "not signed in", "session expired", and "still loading" into one blank state

`author.js:70` (`attachedImagePreview`), `author.js:1340` (`loadMediaPreview`),
`author.js:1369` (`loadMediaAssets`).

`attachedImagePreview` has an explicit loading-vs-missing distinction, but it
only applies to **non-UUID** legacy placeholders:

```js
if (!asset && !uploadedImagePreviewUrls.has(assetId) && !validAssetId(assetId)) {
  if (!mediaAssetsLoaded) return "…Loading private image… Checking your private media library.";
  return "…Image unavailable · This older placeholder is not an uploaded private image.";
}
```

For a valid UUID it always emits `<img data-media-preview>` and hands off to
`loadMediaPreview`, whose image branch has no status element (`status` is only
found inside `.audio-preview`):

```js
if (!supabase) { if (status) status.textContent = "Sign in to preview this private clip."; return; }
const { data: { session } } = await supabase.auth.getSession();
if (!session?.access_token) { if (status) status.textContent = "…expired…"; return; }
```

For an image, both of those are a **silent `return`**. Resulting map:

| Real state | Image renders as |
|---|---|
| loading | blank `<img>`, caption "Attached private image" |
| not signed in | blank `<img>`, caption "Attached private image" |
| session expired | blank `<img>`, caption "Attached private image" |
| object missing / 404 | "Image unavailable — Private image request failed (stage) [404]" |
| legacy non-UUID placeholder | "Image unavailable — This older placeholder is not an uploaded private image" |

Reproduction A — Author, any question with an attached option image:

1. Author's magic-link session has expired (they last signed in days ago).
2. They open `author.html`. `initialiseAuth()` runs *after* the bank load, so the
   first `renderEditor()` happens with `supabase === undefined`.
3. Every attached image renders as an empty box labelled "Attached private
   image", with no indication that this is an auth problem rather than a deleted
   asset. Lesson #2's exact failure — treating absence of credentials as absence
   of the asset.

Reproduction B — Author, a question carrying a legacy non-UUID
`imageAssetId`:

1. Author is signed out. `loadMediaAssets()` short-circuits at
   `if (!supabase || !currentUser)` and leaves `mediaAssetsLoaded = false`.
2. `attachedImagePreview` therefore renders **"Loading private image… Checking
   your private media library."** — permanently. "Will never load because you are
   signed out" is displayed as "loading".

Also in `loadMediaAssets`: on the final error path it sets `mediaAssetsLoaded =
true` and calls `renderEditor()` only — not `renderMediaLibrary()` or
`renderPreview()` — so the library panel keeps stale content next to a status
line saying the load failed.

Fix boundary: give the private-media resource the five explicit states lesson #6
asks for (`idle`, `loading`, `ready`, `error`, `missing`) plus an
`unauthenticated` state, and render all of them for images as well as audio. The
state machine is shared by the author preview, the host audio loader and the
Presentation image loader — a good candidate for a small module alongside
**`video-utils.js`**.

---

## Priority 6 — untested failure states and misleading completion

### F16 {#f16}
### Presentation media failures are invisible, and a failed command is never retried

`app.js:605`, `app.js:1470`, `app.js:1575`, `app.js:2407`, `app.js:2410`;
`docs/SENTRY_INTEGRATION_GUIDE.md`.

Every Presentation media failure is swallowed by a bare `console.warn` — no
`recordDiagnostic`, therefore no local diagnostics entry and no Sentry issue:

```js
if (presentationAudioArmed) applyPresentationAudioCommand().catch((error) => console.warn("Presentation clip unavailable.", error));
if (presentationMediaArmed)  applyPresentationMediaCommand().catch((error) => console.warn("Presentation video unavailable.", error));
```

Audio/media cueing is the subsystem with the longest bug history in this
repository (lessons #2, #3, #7, #14), and it is the one subsystem that reports
nothing. `downloadDiagnostics` on the presentation tab will show a clean log
after a show in which no clip ever played. Per the Sentry guide's own framing —
"browser failures are kept locally so the app remains diagnosable" — these
belong in `recordDiagnostic("presentation-media", …)` with `{roomCode,
questionId, commandId, assetId}` as context. They are operational failures, not
expected races, so unlike the auto-submit case they should reach Sentry.

Compounding it, both apply functions mark the command handled **before** doing
the work:

```js
handledPresentationAudioCommand = command.id;   // line 1575
presentationAudioPlayer.volume = normalizedAudioVolume(command.volume);
if (command.action === "volume") return;
await preparePresentationAudio(command);         // ← can throw
```

If `loadPrivateHostAudio` throws (Worker 404/502, expired room secret), the
command is already latched. It is retried only if the host clicks Play again,
generating a new command ID — with no on-screen indication that anything failed.
The Presentation surface has no pending / failed / retryable states at all, which
is the same gap [F2](#f2) describes on the player.

### F17 {#f17}
### The reliability tests are source-text regexes

`test/reliability-contract.test.js`, `test/presentation-layout.test.js`,
`test/roster-identity-contract.test.js`.

All three read `app.js` / `author.js` as strings and assert with
`assert.match(source, /…/)`. They are useful as anti-regression tripwires for
specific lines, but they cannot observe behavior, and several give more
confidence than they earn:

- *"player UI waits for server confirmation before recording submission"* slices
  only the `[data-submit]` handler and checks statement order. It does not cover
  `queueAutoSubmission` — the path [F2](#f2) breaks — nor the status classes.
- *"presenter applies audio-only updates without remounting the shared screen"*
  asserts `/activeClipId, audioCommand, revision, submitted/` appears in the
  destructuring. It cannot see that `players`, `scoreNotification`, `doorPicks`
  and `screenHistory` are still in the key ([F3](#f3)).
- *"presentation replaces its loaded private audio when the host cues another
  clip"* cannot see the early-return-then-play path in [F4](#f4).
- Nothing renders any board, so [F7](#f7)'s literal `${…}` passes every regex.
- Nothing loads either compatibility fixture, so [F8](#f8) went unnoticed.

The cheapest high-value additions, in lesson #10's order: (1) run `validateQuiz`
over both fixture banks; (2) unit-test `presenterRenderKey` per scene with a
fixture room state; (3) unit-test the reveal-key selector per question type per
surface; (4) unit-test a command accept/reject predicate for cue A → cue B →
restart → reconnect → duplicate. All four become possible once the logic is in
`quiz-core.js` / `quiz-validation.js`.

---

## Priority 7 — dead code, unreachable branches, and duplication

### F18 {#f18}
### Dead code and unreachable branches

Each is classified as *residue* (unreachable by any supported data) or
*reachable* (still on a live path).

| # | Item | Location | Status |
|---|---|---|---|
| 1 | `quiz-validation.js` itself | shipped by `prepare-deploy.mjs`, imported by no browser file | **Residue in production, live in tests.** See [F9](#f9). |
| 2 | `state.mediaPlayback` | app.js:614, app.js:2380 | **Residue.** Written twice, read nowhere, not in `publicRoomState()`. |
| 3 | `media-ended` realtime event | broadcast at app.js:706; `connectHostedRoom` subscribes to `state`, `submission`, `presence`, `door-choice`, `audio-ended`, `request-state` — **not** `media-ended` | **Reachable only via `BroadcastChannel`** (same browser). Cross-device it is silently dropped. Since its only consumer is item 2, nothing breaks today — but the plumbing implies a feature that does not exist. |
| 4 | `[data-phase="locked"]` handler | app.js:2256 | **Residue.** No markup emits `data-phase="locked"`; `renderHost` emits only `data-phase="open"`. Consequence: the `locked` phase is reachable **only** through timer expiry, so the presenter's "Answers locked" label, `presentation-card--locked` styling, and the answer wall's "once the host locks the question" copy never appear in a show run without timers. |
| 5 | `numeric_estimate` | app.js:1244, 1249, 1377, 2043; `music-trivia.question-bank.json` `optionalTieBreak` | **Residue with a latent scoring hole.** Not in the editor dropdown, not in `author.js`'s type allowlist, and **no branch in any scoring migration** — a published `numeric_estimate` question would silently score zero for everyone. It survives in the bank only under `optionalTieBreak`, which is never played. `quiz-validation.js` would accept it (no allowlist). |
| 6 | `round_scoreboard` screen | app.js:483, 1737, 2168 | **Residue for new rooms; reachable for a room persisted before the screen was retired.** Handled on Host (Next, intermission action, button removal) but **not** in `renderPresenter` or `renderPlayer` — both fall through to the generic "Next question coming up" intermission while the host offers "Open door selection". |
| 7 | `scoreboard` between-round audio slot | authored at author.js:387; `cueBetweenRoundAudio` is only ever called with `roundEnd`, `doorChoice`, `doorReveal`, `roundStart` | **Residue.** The author UI offers a "Scoreboard transition" upload that can never play. Paired with item 6. |
| 8 | `audio.assetId` legacy field | written by `[data-add-audio]` (author.js:498) as the literal `"audio-clip"`; surfaced as an editable "Opaque asset ID" field (author.js:359) | **Reachable and actively producing legacy data.** Nothing in `app.js` reads `assetId`; `hasPlayableAudio` checks `mediaAssetId || url`. Clicking "Add audio cue" produces an audio object that can never play. |
| 9 | `[data-player]` "Add demo player" | app.js:1743, rendered unconditionally in `renderHost` | **Reachable in production.** In a hosted room it pushes a client-side player with a random UUID and `emit()`s it, inflating the "answers received" denominator, the Presentation waiting-room roster and the scoreboard until the next `getLeaderboard`. A demo control on the live host panel. |
| 10 | `presentation-card--final` branch | app.js:1935 (`state.phase === "complete"` with a non-finale `presentationScreen`) | **Residue for new rooms.** `startFinale` always sets `presentationScreen`; reachable only from a room persisted before the three-cue finale existed. |
| 11 | `hostQuestion.audioLabel` / `audioHelp` | app.js:127–128, read at app.js:1387/1395 | **Residue.** Only the hard-coded local-demo sample question sets them; no authored quiz can. |

### F19 {#f19}
### Duplicated logic that can drift

1. **`validateQuiz` × 2** — [F9](#f9). Fix: import `quiz-validation.js` from `author.js`.
2. **Question-type templates × 2** — `changeQuestionType` (author.js:237) and
   `addQuestionTemplate` (author.js:577) contain the same eight `Object.assign`
   default shapes. Fix: one `questionTemplate(type)` in **`quiz-core.js`**.
3. **`closest_number` winner rule × 2** — [F6](#f6): migration `0017` and
   `closestNumberResultsBoard`. The browser must not decide who won.
4. **Answer-normalization × 3** — `normalizeAnswerText` (quiz-core.js:35),
   `normalizedTextAnswer` (app.js:1086), and the inline
   `String(answer).replace(/[^a-z0-9]+/gi,"").toLowerCase()` in `answerControl`
   (app.js:1252), all mirroring `regexp_replace(lower(…), '[^a-z0-9]+', '', 'g')`
   in `0003`/`0030`. `quiz-core.js:26` already carries the "if that migration's
   comparison logic changes, this must change with it" warning — it should be the
   only copy. Fix: export it from **`quiz-core.js`** and use it everywhere.
5. **Rank-with-ties × 4** — `resultsCsv` (app.js:1634), `presentationLeaderboard`
   (app.js:1753), `closestNumberResultsBoard` (app.js:1212) and
   `finalScoreTitlePage` (app.js:1836) each re-derive tie-aware ranking, and
   `finalScoreTitlePage` does **not** share ranks for ties (it uses
   `firstRank + index`) while the CSV and the leaderboard do. The exported
   standings and the on-screen final standings can therefore show different ranks
   for tied players. Fix: one `rankPlayers()` in **`quiz-core.js`**.
6. **Roster identity × 2 remaining sites** — `sendSubmission` and
   `announcePlayerPresence` were fixed to use `doorPlayerRecordId`, but
   `playerScoreCards` (app.js:1967, `leader.id === playerId`) and `renderPlayer`'s
   door branch (app.js:2021, `entry.playerId === playerId`) still compare the
   local auth token against server roster IDs. Consequences: the player's own row
   in the mini-leaderboard is **never** highlighted in a hosted room; and after a
   refresh during `door_choice` the phone shows the chosen door card as "Your
   pick" (that path uses `doorPlayerRecordId`) while the status line beneath it
   still reads "Choose a door to lock in your chance."

Minor, same category, not separately numbered:

- `renderHost` (app.js:1743) and `renderPlayer` (app.js:2045) interpolate
  `hostQuizDefinition.title`, `state.question.roundTitle` and
  `state.question.prompt` **unescaped**, while `renderPresenter`,
  `renderHostDoors` and `renderHostFinale` escape the same values. Authored
  content only, so not a live exploit, but an apostrophe or `<` in a prompt
  renders differently on three surfaces.
- `uploadPrivateVideo` removes the orphaned storage object if registration fails
  (author.js:723); `uploadPrivateAudio` and `uploadPrivateImage` do not.
- Choosing an existing audio asset (`[data-existing-media='audio']`,
  author.js:540) does not `delete question().video`, while
  `uploadPrivateAudio` and `[data-existing-video]` both maintain the
  audio-xor-video invariant. The result is caught at publish, as a validation
  error rather than as a prevented action.
- `renderMediaLibrary`'s `inDraft` check is `JSON.stringify(bank).includes(asset.id)`
  — current draft only. An asset used by a *published* version but not the open
  draft shows a Delete button; the `delete_unused_media_asset` RPC
  (`0013:16`) correctly refuses, so the user gets an error instead of a disabled
  button.
- `screenHistory` (up to 50 snapshots, each embedding full `doorPicks` and
  `doorResults` arrays) is persisted into `set_live_room_state` and rebroadcast
  on **every** state change, including each audio cue. With 20 players this grows
  the payload materially over a five-round game. The comment at app.js:186
  describing it as "only screen identifiers and score-display data" understates
  what it carries.

---

## State-machine map

Phases (`state.phase`): `lobby`, `open`, `locked`, `reveal`, `door_choice`,
`door_reveal`, `complete`.
Screens (`state.presentationScreen`): `title`, `intermission`, `question`,
`round_end`, `round_start`, `doors`, `final_suspense`, `final_podium`,
`final_scores`, plus retired `round_scoreboard`.

| From | Trigger | To | Notes |
|---|---|---|---|
| `lobby`/`title` | `startRound(0)` / **N** | `lobby`/`round_start` | |
| `lobby`/`round_start` | 2,600 ms auto **or** **N** | `open`/`question` | Both guarded; `setPhase("open")` clears the timer. Correct. |
| `open` | `revealQuestion` (**R**, **N**, Reveal button) | `reveal` | Locks and reveals in one step. |
| `open` | timer expiry | `locked` | **The only route into `locked`** — see [F18](#f18) item 4. Races Reveal — see [F11](#f11). |
| `locked` | **R** / **N** | `reveal` | |
| `reveal` | `advanceQuestion` | `open`/`question` (same round) | Skips `intermission` by design. |
| `reveal` | `advanceQuestion` (round boundary) | `lobby`/`round_end` | Does not check that the next round has questions — [F8](#f8). |
| `lobby`/`round_end` | **N** | `door_choice`/`doors` or `lobby`/`round_start` | |
| `door_choice` | `revealDoorRewards` (**R**/**N**) | `door_reveal` | Server-resolved; refresh cannot reroll. Correct. |
| `door_reveal` | **N** | `lobby`/`round_start` | via `advanceQuestion` → `startRound`. Silent dead end if the round is empty — [F8](#f8). |
| `reveal` (last question) | `advanceQuestion` | `complete`/`final_suspense` | |
| `complete`/`final_suspense` | **N** | `final_podium` | One-way; guarded by screen check. |
| `complete`/`final_podium` | **N** | `final_scores` | |
| `complete`/`final_scores` | **N** | — | Terminal. Correct. |
| any | `showPreviousScreen` (**P**/**←**) | popped snapshot | Refuses to reopen a scored question (`open` → `locked`). Correct. Loses `state.submitted` via `setHostQuestion` — see below. |
| any | `jumpToQuestion` | `lobby`/`intermission` | Debug affordance. |

Refresh / reconnect **into** a phase:

| Surface | Restores | Does not restore |
|---|---|---|
| Host | phase, question, screen, timer, doors, `screenHistory`, `revision`, quiz definition | **`state.submitted`** ([F10](#f10)); `timerExpiryLocking` resets to `false`, which is the safe direction |
| Presentation | full public state, quiz definition (host secret required) | media arming (by design); **but re-applies a stale `audioCommand`/`mediaCommand` on arm** ([F4](#f4)); `round_scoreboard` and legacy `complete` screens fall through to a generic intermission ([F18](#f18) items 6, 10) |
| Player | full public state, own submission flag via `sessionStorage` | `selected` is `null` after reload, so the answer boards render empty even though the server holds the submission; `lateJoinBonus` only via a fresh `joinRoom` |

The player point above is worth a note on its own: after a mid-question refresh, a
`multi_fill_in_the_blank` player's ten text fields come back **blank** while the
status line reads "Answers saved. You can keep editing until the host closes the
question." Typing into one field then auto-submits an answer object containing
only that field. `submit_live_answer` replaces the stored answer, so the other
nine saved titles are lost. I have not traced whether the RPC merges or replaces
`submission_items`, so this is listed under [Unproven](#unproven) rather than as a
finding.

---

## Unproven

Reachability not established; listed so they are not lost.

1. **Presentation can write authoritative room state.** `connectHostedRoom`
   (app.js:792) runs its host-restore block for `["host", "presenter"]`. In the
   `else if (setHostQuestion(0, 0))` branch it calls `await persistHostState()` —
   a `set_live_room_state` write — and `persistHostState` is gated only on
   possessing the host secret, which the same-browser Presentation tab has. That
   branch requires `savedRoom.state.questionId` to be falsy, and `createRoom`
   always seeds `initialState: publicRoomState()` (which includes a
   `questionId`), so I could not construct a reachable case without inspecting
   `create_live_room`'s handling of `p_initial_state`. If it is reachable, a
   Presentation tab can reset a live room to the title screen. Worth closing
   regardless, since Presentation should never hold a write path.
2. **Mid-question player refresh may truncate a multi-blank answer.** Described
   at the end of the state-machine map. Depends on whether `submit_live_answer`
   replaces or merges the stored answer object; I did not read
   `0002_live_room_rpc.sql` closely enough to assert it.
3. **`video.url` questions show working Host controls that do nothing.**
   `questionPresentationMedia` (app.js:74) and `videoPanel` (app.js:1400) treat
   `video.url` as playable, but `preparePresentationVideo` (app.js:1450) requires
   `video.mediaAssetId` and returns early otherwise. The author UI never writes
   `video.url`, so this is reachable only through hand-written JSON import — which
   `author.js`'s validator would allow.
4. **`mediaPreviewUrls` growth in the author.** Object URLs are pushed by
   `loadMediaPreview` on every `renderEditor()` but revoked only in
   `renderMediaLibrary()`. In a long editing session with many attached images
   this leaks; I did not measure whether it reaches a level that matters.
5. **Presentation on a second device.** `getHostSecret` reads
   `localStorage`/`sessionStorage`, so the "shareable presentation view"
   (PRODUCT_SPEC §2) only works in the host's own browser profile — without the
   secret, `loadPrivatePresentationVideo` throws, `loadPrivateImage` falls back to
   `x-quiz-player-token` with a non-joined UUID (403 → the image is removed), the
   quiz definition is never loaded, and `refreshAnonymousTextAnswers` /
   `refreshClosestNumberGuesses` return early. This may be the deliberate design
   (CHANGELOG 2026-08-12 mentions same-browser credential sharing as a fix), but
   the spec's wording and the "Open presentation view" link do not say so, and no
   UI explains the degraded state. Flagging as a spec/implementation ambiguity
   rather than a defect.

---

## Proposed `mistakes.md` additions

`mistakes.md` was **not** edited. These are proposals for your decision. Findings
that map onto existing lessons are tagged in the summary table above and are not
repeated here.

### Proposed #15 — I let the browser re-derive a result the server had already decided, and then let it fall back to partial data

Draws on [F6](#f6). Lesson #7 says Presentation should render an authoritative
projection; #11 says score events should be immutable and auditable. Neither
covers the specific failure of a *display* surface recomputing an outcome
(the closest-number winner) from a *different, weaker* input set than the server
used, and then silently degrading to an even weaker one when the authoritative
fetch fails. The audience believes what the shared screen says; a disagreement
between the ★ badge and the scoreboard is indistinguishable from a scoring bug.

*What to do next time:* when a server RPC decides an outcome, have the read
endpoint return the decision alongside the raw rows, and make the display render
it. Never let a display surface fall back from an authoritative source to an
opportunistically collected one for anything ranked, scored, or named as a
winner — degrade to an explicit "not available" instead.

### Proposed #16 — I duplicated a validator instead of importing the extracted one, and then tested the copy nobody runs

Draws on [F9](#f9). Lesson #8 covers legacy/fallback branches and #12 covers the
changelog as engineering memory, but neither covers this shape: an extracted,
tested module that the shipping code does not import, so the test suite reports
green on a validator no user path executes. Two docs already instruct
contributors to "update both validation surfaces", which normalises the drift.

*What to do next time:* a module extracted for testability must be imported by
the surface it was extracted from, and a test should assert the import exists. If
two copies are genuinely needed, one must be generated from the other. Add a
check that every file in the deploy manifest is reachable from an entry point.

### Proposed #17 — I persisted commands that had no notion of when they were issued

Draws on [F4](#f4). Lesson #3 already requires self-identifying commands and was
partly implemented — the audio command now carries the question and clip. What it
did not anticipate is that the command is also *persisted in room state* and
replayed to any client that mounts later. A command ID makes a command
deduplicable within one page lifetime; it does nothing across a reload, because
the "already handled" set does not survive. Arming and reconnect are exactly the
moments when a page mounts fresh, which is why they are the moments the bug
appears.

*What to do next time:* distinguish a command (a one-shot instruction, expires)
from state (a durable fact, replayable). If a command must live in persisted
state, give it an issue timestamp and a freshness window, and have late-mounting
clients reconcile to the *state* rather than replay the *command*.

### Proposed #18 — I wrote regression tests against source text, and they stopped seeing the product

Draws on [F17](#f17), and is the reason several of the findings above survived.
Lesson #10 is about test *ordering* (authorization first, UI last). This is about
test *kind*: `test/reliability-contract.test.js` and
`test/presentation-layout.test.js` assert with `assert.match(sourceCode, /…/)`.
They are effective at pinning a specific line against removal and structurally
incapable of catching a rendering bug ([F7](#f7)), a render-key regression
([F3](#f3)), a missing projection field ([F1](#f1)), or a fixture that no longer
validates ([F8](#f8)).

*What to do next time:* source-text assertions are acceptable only as a tripwire
for a deliberate decision that has no other expression. Anything with an input
and an output — a validator, a render key, a projection selector, a scene
mapping — gets a real unit test, which means the logic has to leave the 400-column
template literal first. Keep the tripwires; do not let them stand in for
coverage.

---

## Where fixes belong

| Finding | Extract to |
|---|---|
| [F1](#f1) reveal-key selection per surface/phase | `quiz-core.js` |
| [F2](#f2) submission state → message/class | `quiz-core.js` |
| [F3](#f3) `presenterRenderKey` (scene-scoped) | `quiz-core.js` |
| [F4](#f4) command construction + accept/reject predicate | `quiz-core.js` |
| [F5](#f5) single submit path | `room-api.js` |
| [F6](#f6) server-decided winner; decimal helpers | `cloudflare-worker.js` + `quiz-core.js` |
| [F8](#f8) next-playable-question/round walk | `quiz-core.js` |
| [F9](#f9) one validator | `quiz-validation.js` |
| [F10](#f10) host submission re-fetch on reconnect | `room-api.js` + `cloudflare-worker.js` |
| [F11](#f11) benign-rejection classification | `room-api.js` |
| [F15](#f15) media resource state machine | new module beside `video-utils.js` |
| [F19](#f19).2 question templates | `quiz-core.js` |
| [F19](#f19).4 answer normalization | `quiz-core.js` |
| [F19](#f19).5 tie-aware ranking | `quiz-core.js` |

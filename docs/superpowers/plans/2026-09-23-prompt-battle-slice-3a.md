# Prompt Battle slice 3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host can walk into a `prompt_battle` round, open it, and see it on every screen, with the host, player and Presentation views all rendering `battle_prompt`. The host can then leave with a temporary **End battle round** control.

**Architecture:** The host stays the only writer of phases. It adopts `open_battle_round`'s result into local state and saves it through the existing `set_live_room_state` path. Two pure helpers in `quiz-core.js` carry the testable logic: the round walk, and the position a save records. `app.js` gets one battle branch per surface. There is no migration and no Worker change.

**Tech Stack:** Plain ES modules (no bundler), `node:test` via `npm test`, Supabase RPCs through `room-api.js`.

**Spec:** `docs/superpowers/specs/2026-09-23-prompt-battle-slice-3a-design.md`

**Branch:** `claude/prompt-battle-3a`, which already contains the spec commit.

---

## Ground rules (from `CLAUDE.md`)

- **Shell:** Windows PowerShell 5.1. Before running `node` or `npm`, reset PATH first:
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.
  `&&` does not work; use `;`.
- **Staging:** stage explicit paths only. Never `git add -A` or `git add .`.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Formatting:** match the surrounding style. `app.js` uses long single-line template strings, so keep new markup the same way and do not reformat neighbouring code.
- **Production:** no `git push`, `npm run deploy`, `wrangler deploy` or `supabase db push`.
- **Baseline:** `npm test` passes 368/368 at the start of this plan.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `quiz-core.js` | Modify | `isBattleRound`, a battle-aware `firstPlayableRound` / `nextPlayablePosition`, and the new `hostSavedPosition` |
| `app.js` | Modify | Phase maps, `publicRoomState`, `playerRenderKey`, entering/opening/ending a battle round, the host battle screen, the player and Presentation battle views, keyboard guards, host refresh |
| `styles.css` | Modify | One line for the Presentation battle card |
| `test/battle-phase-3a.test.js` | Create | Pure-helper tests, plus source contracts for every `app.js` change |
| `test/battle-pairing.test.js` | Modify | Narrow two slice-2 assertions that the approved design deliberately changes (Task 4) |
| `CHANGELOG.md`, `docs/CLAUDE_WORKLOG.md` | Modify | Record the work (Task 7) |

## Known limits of 3a (deliberate; do not fix here)

- **A battle round cannot be round 1.** Room setup (`setHostQuestion(0, 0)` in `connectHostedRoom`) needs a question in round 1. A quiz whose first round is a battle round is out of scope until the round walk is used there too.
- **`state.questionId` and the question fields other than round number and title keep describing the previous round's last question** during a battle round. They are public, already-revealed data. Every battle branch returns before any code that renders them.
- **End battle round awards no points** and leaves the matchup rows unresolved. Slices 4 and 5 replace it.

---

### Task 1: The round walk reaches battle rounds

**Files:**
- Modify: `quiz-core.js:381-405` (`firstPlayableRound`, `nextPlayablePosition`)
- Create: `test/battle-phase-3a.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/battle-phase-3a.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { firstPlayableRound, isBattleRound, nextPlayablePosition } from "../quiz-core.js";

// Prompt Battle slice 3a. Spec:
// docs/superpowers/specs/2026-09-23-prompt-battle-slice-3a-design.md

const withQuestions = (count) => ({ questions: Array.from({ length: count }, (_, index) => ({ id: `q${index}` })) });
const BATTLE = { type: "prompt_battle", title: "Prompt Battle", prompts: [{ id: "p", text: "Draw it." }] };
const EMPTY = { questions: [] };

test("isBattleRound recognises only prompt_battle rounds", () => {
  assert.equal(isBattleRound(BATTLE), true);
  assert.equal(isBattleRound(withQuestions(2)), false);
  assert.equal(isBattleRound(null), false);
  assert.equal(isBattleRound({ type: "something_else" }), false);
});

test("firstPlayableRound treats a battle round as playable", () => {
  assert.equal(firstPlayableRound([EMPTY, BATTLE, withQuestions(1)], 0), 1);
  assert.equal(firstPlayableRound([withQuestions(1), BATTLE], 1), 1);
  assert.equal(firstPlayableRound([EMPTY, EMPTY], 0), -1, "an empty round that is not a battle round is still skipped");
});

test("nextPlayablePosition enters a battle round from the previous round", () => {
  const rounds = [withQuestions(2), BATTLE, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 1 }), { roundIndex: 1, questionIndex: 0, battle: true, roundChanged: true });
});

test("nextPlayablePosition leaves a battle round instead of re-entering it", () => {
  const rounds = [withQuestions(2), BATTLE, EMPTY, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 1, questionIndex: 0 }), { roundIndex: 3, questionIndex: 0, roundChanged: true });
  assert.equal(nextPlayablePosition([withQuestions(1), BATTLE], { roundIndex: 1, questionIndex: 0 }), null, "a battle round as the last round leads to the finale");
});

test("nextPlayablePosition from the start can land on a battle round", () => {
  assert.deepEqual(nextPlayablePosition([BATTLE, withQuestions(1)]), { roundIndex: 0, questionIndex: 0, battle: true, roundChanged: true });
});

test("question rounds walk exactly as before, including over both compatibility fixtures", () => {
  const rounds = [withQuestions(2), EMPTY, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 0 }), { roundIndex: 0, questionIndex: 1, roundChanged: false });
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 1 }), { roundIndex: 2, questionIndex: 0, roundChanged: true });
  for (const file of ["../quiz.sample.json", "../music-trivia.question-bank.json"]) {
    const quiz = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
    const total = quiz.rounds.reduce((sum, round) => sum + (round.questions || []).length, 0);
    let visited = 0;
    for (let position = nextPlayablePosition(quiz.rounds); position; position = nextPlayablePosition(quiz.rounds, position)) {
      assert.equal(position.battle, undefined, `${file} has no battle round`);
      visited += 1;
    }
    assert.equal(visited, total, `${file}: every question is visited exactly once`);
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/battle-phase-3a.test.js`
Expected: FAIL. The import throws because `isBattleRound` is not exported.

- [ ] **Step 3: Implement**

In `quiz-core.js`, replace `firstPlayableRound` and `nextPlayablePosition` (lines 381-405) with:

```js
// A prompt_battle round has prompts instead of questions (0036, slice 2), so
// "has questions" is not the only way a round can be playable.
export const isBattleRound = (round) => round?.type === "prompt_battle";

export function firstPlayableRound(rounds = [], startIndex = 0) {
  const list = Array.isArray(rounds) ? rounds : [];
  for (let index = Math.max(0, Number(startIndex) || 0); index < list.length; index += 1) {
    if ((list[index]?.questions || []).length || isBattleRound(list[index])) return index;
  }
  return -1;
}

// The question after `position`, skipping empty rounds. `position` omitted
// means "the first playable question anywhere". Returns null when the quiz has
// nothing left to play, which is the finale. `roundChanged` tells the caller
// to show the round-end card rather than moving straight on.
//
// A battle round is returned as { roundIndex, questionIndex: 0, battle: true }
// and is entered only from outside it: a position inside a battle round moves
// on to the next playable round, which is what End battle round relies on.
export function nextPlayablePosition(rounds = [], position = null) {
  const list = Array.isArray(rounds) ? rounds : [];
  let roundIndex = position ? Math.max(0, Number(position.roundIndex) || 0) : 0;
  let questionIndex = position ? Math.max(0, Number(position.questionIndex) || 0) + 1 : 0;
  for (; roundIndex < list.length; roundIndex += 1) {
    const round = list[roundIndex];
    if (isBattleRound(round)) {
      if (questionIndex === 0) return { roundIndex, questionIndex: 0, battle: true, roundChanged: true };
    } else if (questionIndex < (round?.questions || []).length) {
      return { roundIndex, questionIndex, roundChanged: !position || roundIndex !== position.roundIndex };
    }
    questionIndex = 0;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/battle-phase-3a.test.js`
Expected: PASS, 6 tests.

Run: `npm test`
Expected: 374 pass, 0 fail. `test/host-recovery.test.js` must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add quiz-core.js test/battle-phase-3a.test.js
git commit -m "feat: the host round walk reaches Prompt Battle rounds" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The position a host save records

**Files:**
- Modify: `quiz-core.js` (add `hostSavedPosition` directly after `nextPlayablePosition`)
- Modify: `app.js:877-885` (`hostStatePayload`) and the import on `app.js:2`
- Test: `test/battle-phase-3a.test.js`

- [ ] **Step 1: Write the failing tests**

Add `hostSavedPosition` to the import line at the top of `test/battle-phase-3a.test.js`:

```js
import { firstPlayableRound, hostSavedPosition, isBattleRound, nextPlayablePosition } from "../quiz-core.js";
```

Append:

```js
test("hostSavedPosition records the battle round while the host is on it", () => {
  const stale = { round: 2, questionInRound: 5 }; // the previous round's last question
  assert.deepEqual(hostSavedPosition({ phase: "lobby", battleRoundIndex: 2, question: stale }), { roundIndex: 2, questionIndex: 0 });
  assert.deepEqual(hostSavedPosition({ phase: "battle_prompt", battleRoundIndex: 2, question: stale }), { roundIndex: 2, questionIndex: 0 });
});

test("hostSavedPosition keeps today's rule outside a battle round", () => {
  assert.deepEqual(hostSavedPosition({ phase: "open", battleRoundIndex: null, question: { round: 3, questionInRound: 4 } }), { roundIndex: 2, questionIndex: 3 });
  assert.deepEqual(hostSavedPosition({ phase: "door_choice", targetRoundIndex: 4, question: { round: 3, questionInRound: 4 } }), { roundIndex: 4, questionIndex: 3 });
  assert.deepEqual(hostSavedPosition({}), { roundIndex: 0, questionIndex: 0 });
});

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js defines ${name}`);
  return app.slice(start, app.indexOf("\n}\n", start) + 2);
};

test("hostStatePayload saves battle_prompt and the hostSavedPosition result", () => {
  const body = fn("hostStatePayload");
  assert.match(body, /battle_prompt: "battle_prompt"/);
  assert.match(body, /hostSavedPosition\(state\)/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/battle-phase-3a.test.js`
Expected: FAIL. `hostSavedPosition` is not exported.

- [ ] **Step 3: Implement**

In `quiz-core.js`, directly after `nextPlayablePosition`:

```js
// Which round/question a host save records in sessions.current_round_index /
// current_question_index. open_battle_round() pairs the saved round, and
// during a battle round state.question still describes the previous round's
// last question, so the battle round index wins whenever it is set.
export function hostSavedPosition(roomState = {}) {
  if (Number.isInteger(roomState.battleRoundIndex)) return { roundIndex: roomState.battleRoundIndex, questionIndex: 0 };
  const roundIndex = ["door_choice", "door_reveal"].includes(roomState.phase) && Number.isInteger(roomState.targetRoundIndex)
    ? roomState.targetRoundIndex
    : Math.max(0, (roomState.question?.round || 1) - 1);
  return { roundIndex, questionIndex: Math.max(0, (roomState.question?.questionInRound || 1) - 1) };
}
```

In `app.js`, replace the body of `hostStatePayload()` with:

```js
function hostStatePayload() {
  const phaseMap = { lobby: "lobby", open: "question_open", locked: "question_locked", reveal: "answer_reveal", door_choice: "door_choice", door_reveal: "door_reveal", complete: "complete", battle_prompt: "battle_prompt" };
  const position = hostSavedPosition(state);
  return {
    phase: phaseMap[state.phase] || "lobby",
    roundIndex: position.roundIndex,
    questionIndex: position.questionIndex,
    publicState: publicRoomState()
  };
}
```

Add `hostSavedPosition` and `isBattleRound` to the named import from `./quiz-core.js` on `app.js:2`, keeping the existing alphabetical order of that list.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/battle-phase-3a.test.js`, then `npm test`
Expected: PASS. 377 total, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add quiz-core.js app.js test/battle-phase-3a.test.js
git commit -m "feat: host saves record the battle round and the battle_prompt phase" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Public state, the player render key, and the reload map

**Files:**
- Modify: `app.js` `publicRoomState()` return object (after `targetRoundIndex:`)
- Modify: `app.js` `playerRenderKey()` (after `targetRoundIndex:`)
- Modify: `app.js:1079`, the host/Presentation reload phase map in `connectHostedRoom`
- Test: `test/battle-phase-3a.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/battle-phase-3a.test.js`:

```js
const BATTLE_FIELDS = ["battleRoundIndex", "battleMatchupIndex", "battleMatchupCount"];

test("publicRoomState forwards exactly the three battle integers and nothing else battle-related", () => {
  const body = fn("publicRoomState");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: Number\\.isInteger\\(state\\.${field}\\) \\? state\\.${field} : null`));
  assert.doesNotMatch(body, /battleRoundPanel|matchups|promptText|entrants|shuffleSeed/);
});

test("the player render key includes the battle fields", () => {
  const body = fn("playerRenderKey");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: roomState\\?\\.${field}`));
});

test("a host or Presentation reload maps battle_prompt back instead of falling to lobby", () => {
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.match(reload, /complete: "complete", battle_prompt: "battle_prompt" \}\)\[savedRoom\.phase\]/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/battle-phase-3a.test.js`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Implement**

In `publicRoomState()`'s returned object, directly after the `targetRoundIndex: ...` line, add:

```js
    // Prompt Battle position only (slice 3a). Who is paired with whom, and
    // each matchup's prompt, stay on the host: they are future state.
    battleRoundIndex: Number.isInteger(state.battleRoundIndex) ? state.battleRoundIndex : null,
    battleMatchupIndex: Number.isInteger(state.battleMatchupIndex) ? state.battleMatchupIndex : null,
    battleMatchupCount: Number.isInteger(state.battleMatchupCount) ? state.battleMatchupCount : null,
```

In `playerRenderKey()`, directly after `targetRoundIndex: roomState?.targetRoundIndex,`, add:

```js
    battleRoundIndex: roomState?.battleRoundIndex,
    battleMatchupIndex: roomState?.battleMatchupIndex,
    battleMatchupCount: roomState?.battleMatchupCount,
```

`hostRenderKey` and `presenterRenderKey` in `quiz-core.js` already include every field they do not exclude, so the battle fields are structural there without any change. Do not add them to `HOST_LIVE_STATE_FIELDS` or to the transport-only list in `presenterRenderKey`.

On `app.js:1079`, change the inline reload map from `... door_reveal: "door_reveal", complete: "complete" })[savedRoom.phase]` to `... door_reveal: "door_reveal", complete: "complete", battle_prompt: "battle_prompt" })[savedRoom.phase]`. Change nothing else on that line.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/battle-phase-3a.test.js`, then `npm test`
Expected: PASS. 380 total, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add app.js test/battle-phase-3a.test.js
git commit -m "feat: battle position in public state, player render key and host reload" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Entering, opening and ending a battle round (host)

**Files:**
- Modify: `app.js` `setHostQuestion()` (`app.js:276`), `startRound()` (`app.js:456`), `startFinale()`, `showNextScreen()`, `showPreviousScreen()`, `battlePairingPanel()` (`app.js:2222`), `renderHost()` (`app.js:2242`), `attachEvents()` (the battle listeners at `app.js:2817-2840`), `connectHostedRoom()` reload branch
- Add to `app.js`: `enterBattleRound()`, `openBattleRoundFromHost()`, `endBattleRound()`, `refreshBattlePairing()`, `renderHostBattle()`
- Modify: `test/battle-pairing.test.js:191-200`
- Test: `test/battle-phase-3a.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/battle-phase-3a.test.js`:

```js
test("startRound enters a battle round without a question and without auto-advancing", () => {
  const body = fn("startRound");
  assert.match(body, /isBattleRound\(hostQuizDefinition\.rounds\[roundToStart\]\)/);
  assert.match(body, /enterBattleRound\(roundToStart\)/);
  assert.match(body, /if \(!Number\.isInteger\(state\.battleRoundIndex\)\) scheduleRoundStartAdvance\(\);/);
});

test("setHostQuestion and startFinale leave the battle round", () => {
  for (const name of ["setHostQuestion", "startFinale"]) {
    const body = fn(name);
    assert.match(body, /battleRoundIndex: null, battleMatchupIndex: null, battleMatchupCount: null/, `${name} clears the battle fields`);
  }
});

test("opening adopts battle_prompt, persists, and never puts the pairing on state", () => {
  const body = fn("openBattleRoundFromHost");
  assert.match(body, /roomApi\.openBattleRound\(\{ roomCode, hostSecret \}\)/);
  assert.match(body, /state\.phase = "battle_prompt";/);
  assert.match(body, /state\.presentationScreen = "battle_prompt";/);
  assert.match(body, /state\.battleMatchupIndex = 0;/);
  assert.match(body, /await persistHostState\(\);/);
  assert.match(body, /battleRoundPanel\.state = pairing;/);
  assert.doesNotMatch(body, /state\.(matchups|pairing|battleRoundPanel)\b|state = \{[^}]*pairing/);
});

test("End battle round walks on to the round-end card or the finale", () => {
  const body = fn("endBattleRound");
  assert.match(body, /nextPlayablePosition\(hostQuizDefinition\?\.rounds, \{ roundIndex: battleIndex, questionIndex: 0 \}\)/);
  assert.match(body, /startRoundEnd\(next\.roundIndex\)/);
  assert.match(body, /startFinale\(\)/);
});

test("N on a battle round opens it rather than a stale question, and does nothing in battle_prompt", () => {
  const body = fn("showNextScreen");
  assert.match(body, /if \(state\.phase === "battle_prompt"\) return;/);
  assert.match(body, /if \(Number\.isInteger\(state\.battleRoundIndex\)\) return openBattleRoundFromHost\(\);\s*return setPhase\("open"\);/);
});

test("P does not rewind out of a battle round in 3a", () => {
  assert.match(fn("showPreviousScreen"), /if \(Number\.isInteger\(state\.battleRoundIndex\)\) return;/);
});

test("the host has a battle_prompt screen and re-fetches the pairing after a reload", () => {
  assert.match(fn("renderHost"), /if \(state\.phase === "battle_prompt"\) \{ renderHostBattle\(\); return; \}/);
  assert.match(fn("renderHostBattle"), /data-battle-end-round/);
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.match(reload, /if \(view === "host" && state\.phase === "battle_prompt"\) refreshBattlePairing\(\);/);
});
```

Then edit `test/battle-pairing.test.js`. Two of its slice-2 assertions encode what slice 3a deliberately changes, and both are narrowed to what they actually protect.

Replace:

```js
  const callSites = app.match(/\$\{battlePairingPanel\(\)\}/g) || [];
  assert.equal(callSites.length, 1, "battlePairingPanel() should be called from exactly one render site");
```

with:

```js
  // Slice 3a renders the panel on the round-start screen (renderHost) and in
  // battle_prompt (renderHostBattle). Both are host renderers.
  const callSites = app.match(/\$\{battlePairingPanel\(\)\}/g) || [];
  assert.equal(callSites.length, 2, "battlePairingPanel() should be called from renderHost and renderHostBattle only");
```

Replace:

```js
  assert.doesNotMatch(app, /state\.battleRound/);
```

with:

```js
  // state.battleRoundIndex (slice 3a) is a public round position, not the
  // pairing. What must never reach state is the panel or its matchups.
  assert.doesNotMatch(app, /state\.battleRoundPanel|state\.battleRound\s*=|state\.(matchups|pairing)\b/);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/battle-phase-3a.test.js test/battle-pairing.test.js`
Expected: FAIL on the seven new 3a tests. It also fails the modified call-site count (1, expected 2).

- [ ] **Step 3: Implement**

**3a. `setHostQuestion()`.** In the `state = { ... }` object it builds, add one line after `submitted: {}`:

```js
    submitted: {},
    battleRoundIndex: null, battleMatchupIndex: null, battleMatchupCount: null
```

**3b. `startFinale()`.** In its `state = { ... }` object, add the same line after `submitted: {}`:

```js
    submitted: {},
    battleRoundIndex: null, battleMatchupIndex: null, battleMatchupCount: null
```

**3c. `enterBattleRound()`.** Add it directly above `async function startRound(`:

```js
// Prompt Battle slice 3a. A battle round has no question, so the round-start
// card is shown without setHostQuestion(). state.question keeps the previous
// round's question for the fields nothing renders during the battle, but its
// round number and title are moved to the battle round so the progress bar,
// round labels and the later round-end card name the right round.
function enterBattleRound(roundIndex) {
  const round = hostQuizDefinition.rounds[roundIndex];
  state = {
    ...state,
    phase: "lobby",
    presentationScreen: "intermission",
    question: { ...state.question, round: roundIndex + 1, totalRounds: hostQuizDefinition.rounds.length, roundTitle: round.title, questionInRound: 1, questionsInRound: 0 },
    timerEndsAt: null,
    timerDurationSeconds: null,
    activeClipId: null,
    scoreNotification: null,
    submitted: {},
    battleRoundIndex: roundIndex, battleMatchupIndex: null, battleMatchupCount: null
  };
  battleRoundPanel = { busy: false, error: "", state: null };
}
```

**3d. `startRound()`.** Replace the line

```js
    if (!setHostQuestion(roundToStart, 0)) return;
```

with

```js
    if (isBattleRound(hostQuizDefinition.rounds[roundToStart])) enterBattleRound(roundToStart);
    else if (!setHostQuestion(roundToStart, 0)) return;
```

At the end of `startRound()`, replace

```js
  await persistHostState(); emit(); render();
  scheduleRoundStartAdvance();
```

with

```js
  await persistHostState(); emit(); render();
  // Pairing fixes the roster, so a battle round waits for the host's Open.
  if (!Number.isInteger(state.battleRoundIndex)) scheduleRoundStartAdvance();
```

**3e. The open, end and refresh functions.** Add these directly below `enterBattleRound()`:

```js
// The host is the only writer of phases (spec decision). open_battle_round()
// also writes battle_prompt itself; adopting its result here and saving it
// through set_live_room_state keeps both copies identical instead of letting
// the next host save silently overwrite the server's (slice 2 review, finding 2).
async function openBattleRoundFromHost() {
  if (view !== "host" || !Number.isInteger(state.battleRoundIndex) || state.phase === "battle_prompt" || battleRoundPanel.busy) return;
  if (hostStateSaveFailure) { battleRoundPanel.error = "The room is not saved on the server yet. Wait for it to reconnect, then open the round."; render(); return; }
  const hostSecret = getHostSecret();
  if (!hostSecret) { battleRoundPanel.error = "Host authorization is required."; render(); return; }
  battleRoundPanel.busy = true;
  battleRoundPanel.error = "";
  render();
  let opened = false;
  try {
    const pairing = await roomApi.openBattleRound({ roomCode, hostSecret });
    battleRoundPanel.state = pairing;
    state.phase = "battle_prompt";
    state.presentationScreen = "battle_prompt";
    state.intermissionStage = null;
    state.battleMatchupIndex = 0;
    state.battleMatchupCount = Array.isArray(pairing?.matchups) ? pairing.matchups.length : 0;
    opened = true;
  } catch (error) {
    // The RPC's own message is the useful one ("A battle round needs at least
    // two joined players"), so it is shown as-is.
    battleRoundPanel.error = error?.message || "The battle round call failed.";
  } finally {
    battleRoundPanel.busy = false;
  }
  if (opened) await persistHostState();
  emit();
  render();
}

// Temporary in slice 3a: nothing is generated or voted on yet, so the host
// needs a way out. No points are awarded. Slices 4 and 5 replace this with
// Review and voting.
async function endBattleRound() {
  if (view !== "host" || !Number.isInteger(state.battleRoundIndex)) return;
  const battleIndex = state.battleRoundIndex;
  const next = nextPlayablePosition(hostQuizDefinition?.rounds, { roundIndex: battleIndex, questionIndex: 0 });
  state = { ...state, battleRoundIndex: null, battleMatchupIndex: null, battleMatchupCount: null };
  battleRoundPanel = { busy: false, error: "", state: null };
  if (next) await startRoundEnd(next.roundIndex);
  else await startFinale();
}

// Host-only. Fills the pairing panel after a reload into battle_prompt.
async function refreshBattlePairing() {
  const hostSecret = getHostSecret();
  if (view !== "host" || !hostSecret || battleRoundPanel.busy) return;
  battleRoundPanel.busy = true;
  try { battleRoundPanel.state = await roomApi.getHostBattleState({ roomCode, hostSecret }); battleRoundPanel.error = ""; }
  catch (error) { battleRoundPanel.error = error?.message || "Could not load the pairing."; }
  finally { battleRoundPanel.busy = false; render(); }
}
```

**3f. `showNextScreen()`.** Directly after `if (state.phase === "door_reveal") return advanceQuestion();`, add:

```js
  // End battle round is a deliberate click in slice 3a, never a stray N.
  if (state.phase === "battle_prompt") return;
```

In the `lobby` branch, replace the final `return setPhase("open");` with:

```js
    // On a battle round's start card, "next" is Open. setPhase("open") would
    // reopen the previous round's last question, which state.question holds.
    if (Number.isInteger(state.battleRoundIndex)) return openBattleRoundFromHost();
    return setPhase("open");
```

**3g. `showPreviousScreen()`.** Directly after its first line, `clearRoundStartAdvance();`, add:

```js
  // Rewinding out of a battle round would restore a question screen over a
  // paired round. Not supported in slice 3a.
  if (Number.isInteger(state.battleRoundIndex)) return;
```

**3h. `battlePairingPanel()`.** Replace the whole function with this version. It shows only while the host is on the battle round, hides Open once the round is open, and disables Open while the room is not saved:

```js
// Host-only Prompt Battle pairing panel (slice 2, placed by slice 3a): shown
// on the battle round's start card with Open, and in battle_prompt with
// Refresh only. The pairing lives in battleRoundPanel, never on `state`.
function battlePairingPanel() {
  const round = hostQuizDefinition?.rounds?.[state.battleRoundIndex];
  if (!isHostedRoom || !isBattleRound(round)) return "";
  const busy = battleRoundPanel.busy;
  const pairing = battleRoundPanel.state;
  const opened = state.phase === "battle_prompt";
  const errorLine = battleRoundPanel.error ? `<p class="battle-round-note battle-round-note--error" role="alert">${escapeHtml(battleRoundPanel.error)}</p>` : "";
  const matchups = Array.isArray(pairing?.matchups) ? pairing.matchups : [];
  const pairingView = matchups.length
    ? `<ol class="battle-pairing">${matchups.map((matchup) => `<li><p class="battle-pairing-prompt">${escapeHtml(matchup.promptText || "")}</p><ul class="battle-pairing-entrants">${(matchup.entrants || []).map((entrant) => `<li>${escapeHtml(entrant.playerName || "")}${entrant.submitted ? " <span>submitted</span>" : ""}${entrant.vetoed ? " <span>vetoed</span>" : ""}</li>`).join("")}</ul>${(matchup.entrants || []).length === 3 ? '<p class="battle-pairing-threeway">Three-way</p>' : ""}</li>`).join("")}</ol>`
    : opened
    ? `<p class="battle-round-note" role="status">${busy ? "Loading the pairing…" : "The pairing has not loaded. Press Refresh pairing."}</p>`
    : `<p class="battle-round-note" role="status">Pairing happens when you open the round. Players who join after that watch and vote but are not paired.</p>`;
  const seedLine = pairing?.shuffleSeed ? `<p class="battle-round-seed">Shuffle seed ${escapeHtml(pairing.shuffleSeed)}</p>` : "";
  const openButton = opened ? "" : `<button class="btn btn-primary" data-battle-open-round ${busy || hostStateSaveFailure ? "disabled" : ""}>${busy ? "Working…" : "Open battle round <span class=\"keyhint\">N</span>"}</button>`;
  return `<div class="battle-round-panel"><h3>Prompt Battle — round ${Number(state.battleRoundIndex) + 1}</h3><p class="battle-round-title">${escapeHtml(round.title || "Prompt Battle")}</p><div class="host-actions">${openButton}<button class="btn btn-secondary" data-battle-refresh-pairing ${busy ? "disabled" : ""}>Refresh pairing</button></div>${errorLine}${seedLine}${pairingView}</div>`;
}
```

After this change, run `grep -n "battleRoundDefinition" app.js`. If the only remaining hit is its definition near `app.js:117`, delete that `const battleRoundDefinition = ...` block together with its three-line comment. Nothing else uses it.

**3i. `renderHost()`.** Add a battle branch as its third line, after the `complete` branch:

```js
  if (state.phase === "battle_prompt") { renderHostBattle(); return; }
```

The existing `${battlePairingPanel()}` call inside `renderHost` stays where it is. It now renders only on the battle round's start card, because the panel returns `""` elsewhere.

**3j. `renderHostBattle()`.** Add it directly above `function renderHostDoors(`:

```js
// Host view for battle_prompt (slice 3a). Players are waiting for their
// prompts; generation arrives in slice 3b.
function renderHostBattle() {
  const round = hostQuizDefinition?.rounds?.[state.battleRoundIndex];
  const count = Number(state.battleMatchupCount) || 0;
  const presentationUrl = `${location.origin}${location.pathname}?view=presenter&room=${encodeURIComponent(roomCode)}`;
  app.innerHTML = shell(`${brandTopbar(true)}<main class="host-layout"><div class="game-meta"><span><strong>${escapeHtml(hostQuizDefinition?.title || "Quiz night")}</strong> · Room ${escapeHtml(roomCode)}</span>${roundProgress()}</div><section class="round-panel"><span class="round-number">Round ${Number(state.battleRoundIndex) + 1} of ${hostQuizDefinition?.rounds?.length || 1}</span><h1>${escapeHtml(round?.title || "Prompt Battle")}</h1><p>${count} matchup${count === 1 ? "" : "s"} paired. Players are waiting for their prompts.</p></section><div class="game-grid"><section class="question-card">${battlePairingPanel()}</section><aside class="host-panel"><h3>Session control</h3><div class="host-actions"><a class="btn btn-secondary" href="${presentationUrl}" target="_blank" rel="noopener">Open presentation view</a><button class="btn btn-primary" data-battle-end-round>End battle round</button><button class="btn btn-secondary" data-download-diagnostics>Download diagnostics</button></div><p class="battle-round-note">Ending the round awards no points yet.</p>${leaderboard()}</aside></div></main>${shortcutGuide()}`);
}
```

**3k. `attachEvents()`.** Replace the two battle listener lines

```js
  document.querySelector("[data-battle-open-round]")?.addEventListener("click", () => runBattleRoundCall((args) => roomApi.openBattleRound(args)));
  document.querySelector("[data-battle-refresh-pairing]")?.addEventListener("click", () => runBattleRoundCall((args) => roomApi.getHostBattleState(args)));
```

with

```js
  document.querySelector("[data-battle-open-round]")?.addEventListener("click", () => openBattleRoundFromHost());
  document.querySelector("[data-battle-refresh-pairing]")?.addEventListener("click", () => runBattleRoundCall((args) => roomApi.getHostBattleState(args)));
  document.querySelector("[data-battle-end-round]")?.addEventListener("click", () => endBattleRound());
```

Keep `runBattleRoundCall`, because Refresh still uses it.

**3l. Reload into `battle_prompt`.** In `connectHostedRoom()`, just before the `emit();` that follows the saved-room `if/else`, add:

```js
        if (view === "host" && state.phase === "battle_prompt") refreshBattlePairing();
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/battle-phase-3a.test.js test/battle-pairing.test.js`, then `npm test`
Expected: PASS. 387 total, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add app.js test/battle-phase-3a.test.js test/battle-pairing.test.js
git commit -m "feat: host enters, opens and ends a Prompt Battle round" -m "Adopts open_battle_round's result and saves it through set_live_room_state (slice 2 review finding 2). Guards N and P on a battle round." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Player and Presentation battle views

**Files:**
- Modify: `app.js` `renderPlayer()` (after the doors branch), `renderPresenter()` (`phaseLabel` and the `card` chain)
- Add to `app.js`: `presenterBattlePrompt()`
- Modify: `styles.css` (one line after the `.battle-round-panel` line)
- Test: `test/battle-phase-3a.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/battle-phase-3a.test.js`:

```js
test("players see a holding screen in battle_prompt with no prompt, pairing or image", () => {
  const body = fn("renderPlayer");
  const start = body.indexOf('if (state.phase === "battle_prompt")');
  assert.ok(start >= 0, "renderPlayer has a battle_prompt branch");
  assert.ok(start < body.indexOf("state.question.prompt") || body.indexOf("state.question.prompt") === -1, "the battle branch returns before any question rendering");
  const branch = body.slice(start, body.indexOf("return;", start));
  assert.match(branch, /Your prompt is on its way/);
  assert.doesNotMatch(branch, /<img|promptText|battleRoundPanel|matchups/);
});

test("Presentation shows the round and matchup count in battle_prompt, never images", () => {
  const presenter = fn("renderPresenter");
  assert.match(presenter, /state\.phase === "battle_prompt" \? "Prompt Battle"/);
  assert.match(presenter, /: state\.phase === "battle_prompt"\s*\? presenterBattlePrompt\(\)/);
  const card = fn("presenterBattlePrompt");
  assert.match(card, /battleMatchupCount/);
  assert.doesNotMatch(card, /<img|promptText|matchups|imageAssetId/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/battle-phase-3a.test.js`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement**

**Player.** In `renderPlayer()`, directly after the closing `}` of the `if (["door_choice", "door_reveal"].includes(state.phase)) { ... }` branch, add:

```js
  // Prompt Battle slice 3a: a phone cannot read its own matchup's prompt until
  // slice 3b adds a player RPC, so every phone gets the same holding screen.
  if (state.phase === "battle_prompt") {
    app.innerHTML = shell(`<main class="player-main player-main--holding">${brandTopbar()}<section class="player-card player-card--holding player-holding-card"><header class="player-round"><p class="eyebrow">Round ${Number(state.battleRoundIndex) + 1} · Prompt Battle</p><h1>Get ready</h1></header><section class="player-question"><p>Your prompt is on its way.</p></section></section></main>`);
    return;
  }
```

**Presentation phase label.** In `renderPresenter()`'s `phaseLabel` expression, insert `state.phase === "battle_prompt" ? "Prompt Battle" : ` immediately before the final fallback `"Final standings"`. The tail of the expression then reads:

```js
... : state.phase === "door_reveal" ? "Rewards revealed" : state.phase === "battle_prompt" ? "Prompt Battle" : "Final standings";
```

**Presentation card.** In the `card` chain, insert before the `: ["door_choice", "door_reveal"].includes(state.phase)` line:

```js
    : state.phase === "battle_prompt"
    ? presenterBattlePrompt()
```

Add, directly above `function renderPresenter(`:

```js
// Presentation during battle_prompt (slice 3a): a strict projection of public
// state. Never images in this phase (architecture spec section 7).
function presenterBattlePrompt() {
  const round = hostQuizDefinition?.rounds?.[state.battleRoundIndex];
  const count = Number(state.battleMatchupCount) || 0;
  return `<section class="presentation-card presentation-card--battle-prompt" aria-live="polite"><p class="eyebrow">Prompt Battle</p><h2>${escapeHtml(round?.title || "Prompt Battle")}</h2><p>${count} matchup${count === 1 ? "" : "s"} · check your phone for your prompt</p></section>`;
}
```

The corner join QR is already added for every screen except the title page (`titleCornerJoinQr` in `renderPresenter`), so it appears here with no change.

**CSS.** In `styles.css`, directly after the line that starts `.battle-round-panel{`, add one line:

```css
.presentation-card--battle-prompt{display:grid;place-items:center;gap:14px;text-align:center}.presentation-card--battle-prompt h2{font-size:clamp(40px,6vw,88px)}.presentation-card--battle-prompt p{margin:0;font-size:clamp(18px,2vw,28px)}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/battle-phase-3a.test.js`, then `npm test`
Expected: PASS. 389 total, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add app.js styles.css test/battle-phase-3a.test.js
git commit -m "feat: player and Presentation views for battle_prompt" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Manual verification, locally

No real room is used here; a real room is Task 8 and needs Matthew's approval.

**Files:** none, unless a defect is found. In that case, fix it with a test first, in its own commit.

- [ ] **Step 1: Start the dev server**

PowerShell, run in the background:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); npm run dev
```

Expected: the server listens on `http://127.0.0.1:4173`.

- [ ] **Step 2: Check the editor still refuses a battle round**

Open `http://127.0.0.1:4173/author.html`. Paste the bank plus a `prompt_battle` round into Apply raw JSON.
Expected: "Not applied: Round N is a Prompt Battle round…". This is the regression check for `f0d457c`.

- [ ] **Step 3: Check the host and player views open with no console errors**

Open `http://127.0.0.1:4173/?view=host` and `http://127.0.0.1:4173/?view=player`. Read the console with the browser tool.
Expected: no errors. The local demo has no battle round, so this only proves nothing regressed. The battle path needs a hosted room (Task 8).

- [ ] **Step 4: Stop the dev server** and record what was and was not checked for the work log.

---

### Task 7: Changelog and work log

**Files:**
- Modify: `CHANGELOG.md`, under the existing `## 2026-09-23` heading
- Modify: `docs/CLAUDE_WORKLOG.md` (append)

- [ ] **Step 1: Add the changelog line**

Under `## 2026-09-23`, add:

```markdown
- Prompt Battle rounds can now be reached in a live room. The host moves into a Prompt Battle round like any other round, presses **Open battle round** (or N) when everyone has joined, and the pairing appears on the host screen only. Player phones show a "Get ready" screen and the shared screen shows the round title and the number of matchups. Image generation, submissions and voting are not built yet, so the host leaves with **End battle round**, which awards no points. A refresh of any screen during the round comes back on the round instead of the lobby.
```

- [ ] **Step 2: Append the work-log entry**

Append a `## 2026-09-23 — Prompt Battle slice 3a` entry to `docs/CLAUDE_WORKLOG.md`, following the format of the existing entries. It needs:
- **Branch:** `claude/prompt-battle-3a`.
- **Files touched**, each with its reason.
- **Judgment calls:** round number and title moved onto `state.question`; `battleRoundDefinition` removed if it was unused; two slice-2 assertions narrowed, with the reason.
- **Commands actually run,** with their real `npm test` totals.
- **Manual checks:** what was done in Task 6, and that no real room was used.
- **Still unproven:** the whole battle path in a hosted room (Task 8), including `open_battle_round` on a real roster and its idempotency under a real refresh.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/CLAUDE_WORKLOG.md
git commit -m "docs: changelog and work log for Prompt Battle slice 3a" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Real-room rehearsal (ask Matthew first)

This writes rows to the production Supabase project, because local development uses it. It deploys nothing. **Do not start it without Matthew's explicit yes in the session.** It also needs a published quiz that contains a battle round after at least one question round. The editor cannot author one yet (`f0d457c`), so Matthew decides how such a quiz is published: through `publish_quiz_version` from a script, or not at all until authoring exists.

- [ ] **Step 1: Ask Matthew** whether to rehearse, and how the test quiz gets published.
- [ ] **Step 2: If approved, rehearse** with one host tab, one Presentation tab and at least two player tabs:
  1. Play through round 1.
  2. Walk into the battle round.
  3. Press N and confirm the round opens rather than a question.
  4. Check the pairing on the host, "Get ready" on the phones, and the count on Presentation.
  5. Refresh the host and confirm it returns to `battle_prompt` with the same pairing.
  6. Press Open again, or N, and confirm nothing re-randomises.
  7. Press End battle round and confirm the room reaches the next round or the finale.
- [ ] **Step 3: Record the results** in the work log, and remove the two slice-2 items this proves from "Still unproven".

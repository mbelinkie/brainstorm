# Prompt Battle slice 3a: entering and showing a battle round

Date: 2026-09-23
Branch: `claude/prompt-battle-3a`
Builds on: `2026-08-26-prompt-battle-architecture.md`, the source of truth for
Prompt Battle. This document covers only slice 3a.

## Why 3a exists

Slice 3 was split in two on 2026-09-23:

- **3a (this document):** the host can navigate into a `prompt_battle` round,
  open it, and every surface shows the `battle_prompt` phase. There is no
  migration and no image generation.
- **3b (next):** migration `0037`, the `/battle/generate` route, stored
  generations, media access, and the player's prompt and Generate screen.

3a comes first because the slice 2 review (`docs/CLAUDE_WORKLOG.md`,
2026-09-23, finding 2) showed the phase machine does not work yet, and 3b
cannot be tried in a real room until it does:

- The host's round walk skips any round without questions, so a battle round
  is unreachable.
- `open_battle_round` writes `phase = battle_prompt` itself, but the host
  never adopts it. The host's next `set_live_room_state` overwrites phase and
  state wholesale, with no revision check, and the battle phase disappears.
- No surface renders `battle_prompt`.
- `hostStatePayload()` maps any unrecognised local phase to `lobby`, and the
  host hydration map does the same in reverse. A battle phase would be saved
  and restored as `lobby`.
- During a battle round, `state.question` and `hostQuestion` still describe
  the previous round's last question. The saved `roundIndex`, which is derived
  from `state.question.round`, would therefore name the previous round.
  `open_battle_round` pairs `sessions.current_round_index`, so it would refuse.

## Decisions

| Decision | Choice |
|---|---|
| Who writes battle phases | **The host.** It adopts `open_battle_round`'s result into its own state and saves through `set_live_room_state`, like every other phase. `open_battle_round`'s own phase write becomes a redundant duplicate. No migration. |
| When the round opens | **The host presses Open.** No auto-advance, because pairing fixes the roster. |
| Player view in `battle_prompt` | **A holding screen with no prompt text.** A phone cannot read its own entry until 3b adds a player RPC. |
| Leaving the round in 3a | A temporary **End battle round** control. It awards no points, and slices 4 and 5 replace it with Review and then voting. |
| Prompt order | Prompts are handed out in list order today. Random order is a **3b** change, in `0037`. |

## Design

### 1. The round walk (`quiz-core.js`)

`firstPlayableRound` and `nextPlayablePosition` treat a round with
`type === "prompt_battle"` as playable. For a battle round,
`nextPlayablePosition` returns `{ roundIndex, questionIndex: 0, battle: true,
roundChanged }`. Question rounds return exactly what they return today, and a
round that is empty and not a battle round is still skipped.

A battle round is entered only at `questionIndex` 0. Called with a position
*inside* a battle round (`{ roundIndex: battleIndex, questionIndex: 0 }`), the
walk moves on to the next playable round and never returns the same battle
round again. That is what End battle round relies on.

### 2. Arriving at a battle round (host, `app.js`)

The host reaches the round the normal way: the round-end card, the door bonus
if it is enabled, then `startRound(battleIndex)`. For a battle round,
`startRound`:

- does not call `setHostQuestion`, because there is no question;
- sets `state.battleRoundIndex = battleIndex` and clears
  `battleMatchupIndex` and `battleMatchupCount`;
- shows the round-start card with the battle round's title;
- does **not** call `scheduleRoundStartAdvance()`.

**The position a save records** moves into a pure helper in `quiz-core.js`,
`hostSavedPosition(state)`. `hostStatePayload()` uses its result. When
`state.battleRoundIndex` is an integer, the helper returns that index with
question index 0. Otherwise it keeps today's rule: `targetRoundIndex` during
doors, and `state.question.round - 1` elsewhere. `battleRoundIndex` is cleared
whenever the host leaves the battle round (section 5).

### 3. Opening the round

The pairing panel from slice 2 (`battlePairingPanel`) is shown while the host
is on the battle round. **Open battle round** is disabled until the round-start
save has been confirmed.

On Open:

1. Call `roomApi.openBattleRound`. The existing busy guard stays.
2. On success, set `state.phase = "battle_prompt"`,
   `state.presentationScreen = "battle_prompt"`,
   `state.battleMatchupIndex = 0`, and
   `state.battleMatchupCount = matchups.length` from the response. Then
   `persistHostState(); emit(); render();`.
3. The pairing stays in `battleRoundPanel`. It is **never** assigned to
   `state`.

A second Open, or an Open after a refresh, returns the existing pairing
(`created: false`) and goes through the same adoption.

### 4. Phase mapping and public state

- `hostStatePayload()`'s map gains `battle_prompt: "battle_prompt"`, and the
  host hydration map gains the reverse. The enum value exists since `0036`.
- `publicRoomState()` explicitly adds `battleRoundIndex`,
  `battleMatchupIndex` and `battleMatchupCount`, each an integer or `null`.
  Nothing else about the battle reaches this payload: no pairing, no prompt
  text, no entrant names.
- Any other place that maps server phases to client phases gets the same
  addition. The implementation plan lists each one.

### 5. What each surface shows in `battle_prompt`

**Host.** The battle round's title and "N matchups", followed by the pairing
panel: each matchup's prompt and entrants, three-ways labelled, and Refresh
pairing. The leaderboard and the session controls are unchanged. **End battle
round** calls the existing round walk from the battle round. If a playable
round follows, it goes to `startRoundEnd(next)`; otherwise it goes to
`startFinale()`. Either path clears the three battle fields.

**Player.** "Prompt Battle — get ready. Your prompt is on its way." This one
screen is shown to every phone, paired or late-joined. It carries no prompt
text, no opponent and no image.

**Presentation.** The round title, "N matchups", and the join QR, all read
from public state. It computes nothing and **never shows images** in this
phase.

The battle checks go **before** any branch that renders `state.question`.
During a battle round that field still holds the previous round's last
question.

**Render keys.** `battleRoundIndex`, `battleMatchupIndex` and
`battleMatchupCount` are structural. They change only on a real screen change,
so they belong in all three render keys. Each surface's key is checked
explicitly, per `mistakes.md` #14 and #15.

### 6. Refresh recovery

- **Host.** Hydration restores phase `battle_prompt` and the battle fields
  from saved state, then calls `get_host_battle_state` once to fill the
  pairing panel.
- **Player and Presentation.** Read the phase and fields from room state and
  render the same view.

## Failure handling

| Situation | Behaviour |
|---|---|
| Fewer than 2 players, or the round-start save did not land | `open_battle_round` raises. The panel shows its message, the phase is unchanged, and Open can be pressed again. |
| Network failure during Open | The same. Retrying is safe because pairing is idempotent. |
| Open succeeded, host save failed | The server already holds `battle_prompt` from `open_battle_round`'s own write. The existing sync notice and save retry apply. |
| Double click, or a second host tab | The busy guard, plus server idempotency. |
| Player joins after pairing | Sees the holding screen and is in no matchup. Voting in slice 5 includes them. |
| Local demo | No battle round. Prompt Battle is hosted-only. |

## Testing

`node:test`, with no live services.

- `test/quiz-core.test.js`: the walk reaches a battle round with
  `battle: true` and `roundChanged`; empty rounds that are not battle rounds
  are still skipped; `hostSavedPosition` returns the battle round during a
  battle round and today's result otherwise.
- `test/quiz-fixtures.test.js`: both compatibility fixtures walk exactly as
  before.
- A new `test/battle-phase-3a.test.js` source contract:
  - after `openBattleRound`, the host sets `battle_prompt` and persists;
  - the pairing response is never assigned to `state`;
  - both phase maps contain `battle_prompt`;
  - `publicRoomState` adds only the three battle integers;
  - the player and Presentation battle branches render no prompt text and no
    `<img>`;
  - End battle round reaches `startRoundEnd` or `startFinale`.
- **Manual, local.** `npm run dev`, with host, player and Presentation tabs,
  through every step that does not need a real room.
- **Manual, real room.** A real rehearsal writes room and pairing rows to the
  production Supabase project, because local development uses it. It deploys
  nothing. **Ask Matthew before running it.** It is also the first real call
  of `open_battle_round`, which settles two items slice 2 left unproven:
  pairing a real roster, and idempotency under a real refresh.

## Out of scope

Migrations, image generation, players seeing their prompt, submission, review,
voting, scoring, and random prompt order. All of these are in 3b or later.

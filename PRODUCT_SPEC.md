# Music Trivia Live — Product Specification

Status: Active build record  
Audience: Product/design/engineering  
Initial use: Live work trivia for approximately 10–20 players over Google Meet

Last updated: 2026-08-18

## Build status

| Phase | Status | Notes |
|---|---|---|
| 0 — Product decisions and technical spike | Complete | Architecture, audio constraint, local transport proof, and quiz schema selected. A Supabase Free project in US East is live with the initial schema and RLS enabled. |
| 1 — UX and visual design | Substantially complete for MVP | Kaplan-inspired host, player, landing, and authoring surfaces are deployed. Visual polish remains. |
| 2 — Realtime game foundation | Complete for MVP | Public Cloudflare deployment, named-player join, host controls, refresh recovery, protected room state, server scoring, and the shared leaderboard have been rehearsed end-to-end. |
| 3 — Core questions, scoring, and leaderboard | Complete for MVP | Choice, text, matching, ordering, closest-number, categorize, and leaderboard scoring are implemented, along with manual score adjustment and richer reveal/leaderboard modes. |
| 4 — Music and advanced question formats | In progress | Matching, host-only audio cues/URLs, fill-in, ordering, categorization, and private audio/image upload are implemented. Real clip and image preparation remain. |
| 5 — Authoring workflow | In progress | Browser editor, JSON import/export, client-side schema validation, magic-link author authentication, protected publishing, host quiz selection, basic quiz/round management, search/filtering, templates for every supported question type, and a private media library with previews, names, asset reuse, and safe cleanup are live. |
| 6 — Hardening and dress rehearsal | In progress | Sentry error reporting is live in the browser build, and reconnect plus stale-revision submission recovery shipped 2026-08-17. Still needs a complete real-content Google Meet rehearsal with several phones. |

## Current implementation snapshot

### Live platform

- Hosted at `https://wild-haze-73b3.matthew-belinkie-3af.workers.dev` on Cloudflare Workers static assets.
- Supabase (US East Free plan) provides protected RPCs, Postgres persistence, Realtime Broadcast, Auth, and server-side scoring.
- Host creates a six-character room; players join with a room code and display name.
- The host alone advances lobby → open → lock → reveal → next question → complete. Player phones never receive future questions, answer keys, host reveal notes, or host-only media information.
- Between non-final rounds, enabled quizzes enter a host-controlled door-choice and reward-reveal phase. A resolved multiplier applies to automatic points in the immediately following round only. A second, independent multiplier — late-join catch-up — can also apply. Both are described in §7, “Score modifiers.”
- Sessions recover after a host refresh using the stored room state and fixed quiz version.
- Score totals derive from server-written score events and appear in a shared leaderboard.
- Door choices and randomized outcomes are persisted and resolved by protected server functions so refreshes cannot reroll rewards.

### Current question support

Eleven authorable types. §5 describes each one and marks the parts that were
specified but never built.

- Single choice, multiple choice, and true/false.
- Image selection, with private uploaded artwork per option rather than text labels. The player control is single-select.
- Short answer and fill-in-the-blank with normalized accepted-answer matching.
- Multi-blank fill-in-the-blank: independently scored, autosaved fields linked to numbered clips, with per-blank partial credit.
- Closest number: the closest valid guess wins, and tied closest guesses split the authored points.
- Arrange in order, exact-scored.
- Matching, with one point per correct pair; used for the piano-intro finale.
- Categorize: assign every listed item to a named category. The editor requires exactly two categories; the scoring RPC is category-count agnostic and scores all-or-nothing.

A twelfth type, `numeric_estimate`, has a player control and a line in this
document’s “Later formats” list, but no scoring branch anywhere. See §5.

### Authoring and access

- The browser editor can edit quiz/round/question titles and content, manage and reorder rounds/questions, change a question’s type, add host-only audio cues, validate, import JSON, and download JSON.
- Published quiz definitions are versioned. Publishing creates a new version rather than changing rooms that already exist.
- Authenticated authors are explicitly allowlisted. The current author account has publishing permission.
- Supabase Auth uses custom Resend SMTP with the verified `auth.matthewbelinkie.com` sender domain, avoiding the built-in two-emails-per-hour testing limit.

### Known limitations

- The editor opens the music bank by default; it can start a blank one-round quiz and add, duplicate, delete, or reorder rounds and questions. It cannot yet manage prior versions.
- Image selection accepts private JPG, PNG, and WebP uploads per option. Before upload, authors can choose square, widescreen, standard, or original framing and set an image focal point; the editor then converts the selected crop to a maximum-1600px WebP derivative and can copy originals into an author-chosen local folder. Joined players can retrieve only assets on the active question; richer library flow remains.
- Audio can be referenced by an optional host-only URL or played from a prepared external host source. Authors can upload private clips; the host retrieves them through an authorized application proxy. Hosted clips have play, pause, restart, volume, elapsed-time controls, and ready/unavailable status. Authors can trim a clip against a waveform, apply fades, and either accept automatic −16 dBFS loudness levelling or bake in a manual 1–150% gain. Replacing a clip in place, without reconfiguring the question, remains.
- Hosts have a lobby QR join code and 15/20/30/45/60-second question timers that synchronize to players and automatically request the authoritative lock when the host tab reaches zero. There is no host review queue, partial credit for sorting, or participant removal. The host can download final standings and detailed score-event audit CSVs, and record auditable manual score adjustments.
- A complete music-content pass is still needed: real licensed/authorized clips, consistent album art, and final cue windows.

### Development and version control

- The local project folder is the working copy; GitHub (`mbelinkie/kq`) is the authoritative backup and version history for source, documentation, tests, deployment configuration, and database migrations.
- Raw media originals remain local-only in `music quiz originals/`. Secrets remain local-only in `.env.local`. Neither belongs in GitHub.
- Working agreement: push each completed task to GitHub unless a reason not to push is explicitly flagged. Do not push partial experiments, unreviewed work, credentials, or raw media originals.
- Before work starts on another machine, clone the repository once and pull the latest `main` branch. Commit and push completed work before switching machines.

## Recommended next steps

1. Prepare the first music game’s assets: source the clips, choose clip windows, collect album art, crop/resize it consistently, and add the resulting URLs/cues.
2. Run a full Google Meet rehearsal with at least 5–10 devices, including tab-audio sharing and a refresh/reconnect test.

Three earlier items are done and have been removed: generic quiz creation
(blank-quiz template, round and duplicate management, quiz library), media
refinement (image crop and library, audio trimming and normalization), and
game-operation polish (QR join, timers, manual adjustments, results export).
Prior-version management in the editor is still outstanding.

## 1. Product definition

Music Trivia Live is a browser-based, host-controlled quiz game. The host presents a big-screen view in a video call, participants answer on their phones, and everyone sees synchronized questions, answer reveals, and a shared leaderboard.

This is **not** a general-purpose Genially clone. It is a focused live quiz runner and lightweight quiz authoring tool. That boundary is what keeps the project manageable.

### Primary promise

The host can run a polished, varied music quiz without manually collecting or totaling answers. Players cannot move ahead. Every connected device follows the host’s current game state.

### Success criteria for v1

- A new player joins in less than 30 seconds using a room code and nickname.
- The host can run a five-round, 20–30-question game without technical intervention.
- Player phones always show only the active question or synchronized interstitial.
- Answers are saved and scored exactly once, including after a reconnect.
- A live leaderboard can be shown between questions or rounds.
- Audio clips play from the shared big-screen browser tab and are audible in Google Meet.
- The UI feels intentional and game-like on both the shared display and phones.

## 2. Users and application surfaces

### Host

Creates or selects a quiz, starts a room, controls the game, plays audio, resolves manually graded answers, and reveals the leaderboard.

### Player

Joins with a nickname, answers only the current question, sees a clear submitted/locked state, and follows shared reveals and scores.

### Shared big-screen presentation view

The browser tab shared into Google Meet. It is the visual center of the game and the **source of audio playback**.

It shows:

- Lobby and join code/QR code
- Round title cards
- Current question and answer choices where appropriate
- Audio playback controls for audio questions
- Countdown and response count
- Answer reveal and response distribution
- Shared leaderboard and podium
- Small host controls or keyboard-driven controls

### Optional private host console — post-v1

A second screen for question notes, upcoming questions, moderation, manual grading, and score adjustments. It may command the shared display, but audio playback remains a direct action in the shared tab because browser autoplay policies can block remotely triggered sound.

## 3. Core game flow

The server owns the canonical session state. Clients render that state; they do not determine progression.

```text
Draft quiz
  → Lobby
  → Question open
  → Question locked
  → Answer reveal
  → Next question / next round
  → Door choice → Door reveal        (between non-final rounds, when enabled)
  → Final podium
  → Session complete
```

The authoritative phase lives in `sessions.phase`. Screens that are not phases
— the title page, round-start cards, and between-round intermissions — live in
a host-computed `presentationScreen` field inside the `sessions.state` JSONB,
alongside `intermissionStage` and `screenHistory`.

Two pieces of drift to know about before changing this:

- The `session_phase` enum still contains `round_intro`, `question_ready`, and
  `leaderboard`. **Nothing ever writes them.** Earlier versions of this document
  described them as live states.
- `locked` is written, but in practice it is reached only through timer expiry,
  so the presenter’s “Answers locked” scene does not appear in a timer-less
  show. Whether `locked` should be a scene the host can enter deliberately is an
  open question, not a settled behavior.

### State rules

- Players cannot request or infer the next question from the player interface.
- A question accepts submissions only while its server state is `open`, its question ID matches, and the client’s revision matches the server’s.
- Locking is authoritative on the server, not based on a phone’s local timer.
- Reconnected players receive the current state and their existing submission.
- Answer keys and future questions are never sent to player clients before reveal.
- The host’s “Jump to any question” control reopens a question with no override step and no guard. Re-scoring an already-scored question appends a second set of score events. This is a known defect, recorded here so the next session does not mistake it for the intended “explicit override” this document used to describe.

## 4. Audio experience

### Requirement

Audio clips are stored with the quiz and played from the big-screen host view being shared in Google Meet. Player phones do not play the clips.

### Why this shape

- Everyone hears the same playback at nearly the same time through the video call.
- The host controls when a clip begins, pauses, or replays.
- Player devices do not produce echo or reveal track metadata.
- Google Meet officially recommends sharing a browser tab when presentation audio needs to be shared.
- Browsers can block autoplay with sound, so playback must follow a direct host click or keyboard action in the shared tab.

### Host audio controls

- Three discrete buttons: Play, Restart, and Pause
- Volume slider. There is no mute toggle. The level carries forward to every later cue, including automatic between-round and finale audio
- Progress indicator; elapsed time visible to host
- Clip label such as “Clip 3 of 5.” Never put the filename or song title in it — this is an authoring guideline, not a constraint the app enforces
- Ready/unavailable status on the clip control. There is no pre-open preload pass
- Clear “Share this tab’s audio” setup reminder before the game starts
- Not built: an optional replay limit shown to the host

### Host keyboard shortcuts

These match the in-app guide, opened with `?`, which is the authoritative copy.

| Key | Action |
|---|---|
| `N` / `→` | Next screen |
| `P` / `←` | Previous screen |
| `R` | **Reveal and score the question.** During a door choice, reveal the door rewards |
| `Space` | Play the current audio clip. It does not pause — Pause is a separate button |
| `?` | Show the shortcut guide |
| `F` | Fullscreen. Presentation view only |

`R` reveals and scores. It does not restart a clip, and there is no restart
shortcut. Until 2026-08-18 this document said `R = restart`: a host following
that during a live show would have revealed the answer while trying to replay
audio.

### Audio file handling

Initial version:

- MP3, AAC/M4A, OGG, and WAV where browser support permits
- Recommended normalized MP3/AAC clips, typically 5–20 seconds
- Files stored privately or as deployment assets; audio URLs sent only to authorized host/display clients
- Quiz manifest references an opaque asset ID, not a revealing filename

Later authoring version:

- Upload file
- Select start/end points
- Preview and trim non-destructively
- Normalize loudness
- Fade in/out
- Replace clip without changing question configuration

### Operational constraint

The production runbook will instruct the host to share the **Chrome tab** containing the presentation and confirm “Share tab audio.” Window/desktop audio support varies by operating system, while tab sharing is the most reliable path.

## 5. Question formats

Question types should use one scoring interface and one lifecycle, even though their answer controls differ.

### Shipped formats

Eleven types are authorable. “Not built” below marks something this document
once described as a feature and that no code implements — kept in place rather
than deleted so it does not get re-specified by accident.

1. **Single choice** (`single_choice`)
   - Text answers, or private uploaded artwork per option
   - One correct option; full points for the correct answer
   - Not built: speed bonus

2. **Multiple choice** (`multiple_choice`)
   - Select all applicable answers
   - Scored as exact set equality. Not built: partial credit, and the configuration flag that would select it

3. **True or false** (`true_false`)
   - Authored and scored exactly as single choice, and rendered with the same control. There is no specialized two-option layout, and the editor accepts more than two options

4. **Image selection** (`image_selection`)
   - Private uploaded artwork per option, for artists, album art, and movie posters
   - The player control is **single-select**. The editor and the scoring RPC both accept several IDs in `correctOptionIds`, and the RPC awards full points for any one of them. These three surfaces disagree; treat multi-select image selection as unresolved rather than supported

5. **Short answer** (`short_answer`)
   - Exact and normalized accepted variants. Normalization lowercases and strips everything outside `[a-z0-9]`, on both the server and the host’s summary
   - Presentation shows an anonymous wall of submitted answers after lock
   - Not built: a host review queue for unmatched answers. Manual score adjustment (§7) is the shipped substitute

6. **Fill in the blank** (`fill_in_the_blank`)
   - Normalized comparison and accepted variants
   - Appropriate for short lyric fragments; avoid storing or displaying large lyric excerpts
   - **One field.** The player control renders one input and the scoring RPC reads `blanks[0]` only, but the editor validates every entry in `blanks[]` and will publish a question with several. A multi-blank question authored this way silently loses every blank after the first. Use `multi_fill_in_the_blank` instead

7. **Multi-blank fill in the blank** (`multi_fill_in_the_blank`)
   - Independently scored, autosaved fields linked to numbered clips. No enforced maximum; the piano-intro finale uses ten
   - Per-blank accepted answers, `pointsPerBlank`, and genuine partial credit: correct blanks × the rate
   - The row for the currently playing clip is highlighted without interrupting typing

8. **Arrange in order / sort** (`arrange_in_order`)
   - Touch-friendly vertical reorder
   - Scored all or nothing. Not built: position-based partial credit

9. **Matching** (`matching`)
   - One-to-one pairs, one point per correct pair
   - **Players get one `<select>` per clip**, with duplicate assignment prevented. The drag-and-drop board is the host and Presentation view, not the phone. §6 describes the phone interaction correctly
   - Supports the piano-intro finale as ten numbered clips matched to ten song titles

10. **Categorize** (`categorize`)
    - Sort listed items into named categories, using a mobile-friendly category selector per item
    - The editor requires exactly two categories. The scoring RPC counts assignments and is agnostic to how many categories there are
    - Full-credit automatic scoring when every item is assigned correctly; no partial credit

11. **Closest number** (`closest_number`)
    - A single numeric target, authored as `targetNumber`
    - The closest valid guess wins the authored points; tied closest guesses split them evenly
    - Presentation shows a ranked guess board after lock, fetched through the Worker with the host credential

### Half-built: `numeric_estimate`

`numeric_estimate` has a player control, submit handling, and a test pinning it
in the rendered type list. It has **no** scoring branch in any migration, is not
in the editor’s supported-type list, and has no validation rule. A
`numeric_estimate` question therefore renders, accepts answers, locks, and
awards zero points to everyone without saying so. An instance still sits in the
bundled question bank’s `optionalTieBreak`, outside `rounds` where no validator
walks, keyed on `answer` — a field no code reads.

Whether to finish it or retire it is an open decision. Do not author one until
that is settled.

### Later formats

- Swipe left/right rapid classification
- Numeric estimation with tolerance
- Hotspot on image
- Buzzer / first-to-answer
- Poll with no correct answer
- Wager question
- Team answer mode

A twelfth round type, **Prompt Battle**, has an approved design that this
document does not yet cover:
[docs/superpowers/specs/2026-08-17-prompt-battle-design.md](docs/superpowers/specs/2026-08-17-prompt-battle-design.md).
It is not implemented.

## 6. Piano-intro finale

This is a featured round, not ten unrelated questions. It can use either the reusable 10×10 matching format or multiple title-only fill-in fields.

### Big-screen view

- Lists Clips 1–10 with one Play button at a time
- Shows song options A–J for matching, or numbered listening tiles for multiple fill-in
- Host can play clips in sequence or replay a selected clip
- No correct mapping is shown until lock/reveal
- Response counter shows `submitted / connected`

### Player phone view

- Shows ten rows: Clip 1 through Clip 10
- Matching rows select one song from A–J and prevent duplicate assignments
- Multiple-fill rows accept a song title and save silently as the player types
- The row for the currently playing clip is highlighted without interrupting typing
- Players can edit until the host locks the round

### Scoring

- Matching defaults to one point per correct pair; multiple fill-in awards the authored points per correct blank
- Not built: a completion bonus
- No speed bonus. There is no speed bonus anywhere in the product; the round rewards recognition, not network latency

## 7. Scoring and leaderboard

### Scoring model

- Each question defines maximum base points. `matching` and `multi_fill_in_the_blank` are the exceptions: they define `pointsPerPair` and `pointsPerBlank`, and the maximum is implicit.
- Partial credit is supported for **matching and multi-blank fill-in only**. Ordering and multiple choice are all-or-nothing. §Known limitations already said there is no partial credit for sorting; §5 now agrees rather than contradicting it.
- Host adjustments are recorded as auditable score events rather than overwriting totals. Since 0022 they are unbounded in magnitude, and since 0027 the reason is optional.
- Ties share rank until a tie-breaker is played. Today this holds on the standings CSV and the Presentation scoreboard; the host leaderboard panel, the player mini-leaderboard, and a player’s own finish position each number rows sequentially instead, so two tied players can be shown different ranks. Those three are defects against this rule, not alternative choices.
- Not built: a speed bonus, in any form.

### Score modifiers

Two independent multipliers can apply to automatically awarded points. Neither
touches manual adjustments.

| | Door bonus (`0025`) | Late-join catch-up (`0026`) |
|---|---|---|
| Who gets it | Every player who picks a door during a between-round door phase | A player joining after the session has started, once only |
| Value | Whatever the chosen door’s randomized outcome resolves to | `1 + target_round_index / (total_rounds − 1)` |
| Range | Authored per door. **May be below 1.0** — a door can cost points. The bundled defaults are EV-balanced around 1.20× and include 0.8× and 0.6× outcomes | Always ≥ 1, capped at 2× |
| Cap | 10×, enforced in validation and in the database | 2× |
| Scope | The immediately following round only, automatic points only | One round only, automatic points only |

**Precedence is `greatest()`, not multiplication.** A `before insert` trigger on
`score_events` resolves the two and writes the larger, then recomputes `points`
from `base_points`. A player with a 1.2× door and a 1.6× catch-up gets 1.6×, not
1.92×.

`base_points`, `multiplier`, and the resolved `reason` are stored on the event
and survive into the detailed score-event CSV, so an audit can explain how any
total was reached.

Door choices and their randomized outcomes are persisted and resolved by
protected server functions, so a refresh cannot reroll a reward.

### Leaderboard views

- Between-round full leaderboard
- Final animated podium for top three
- Player’s own phone shows personal rank and score after reveal, plus a fixed top-eight list at the finale
- Not built: a top-five quick reveal after a question, a rank-change indicator since the previous reveal, and a hide-scores-keep-ranking control

### Fairness rules

- `submissions.submitted_at` is recorded but never read for scoring, because there is no speed bonus.
- There is **no server-side grace window**. `submit_live_answer` rejects outright on a phase other than `question_open`, a mismatched question ID, or a stale revision. Network jitter is absorbed on the client instead: a rejected submission refetches room state and resubmits once if the same question is still open, and the player sees pending, confirmed, rejected, and retryable as four distinct states.
- Duplicate submissions update the existing response while open; they do not create additional score events.
- Re-scoring is a different matter. `lock_and_score_live_question` re-reads the stored submissions and inserts a fresh set of score events every time it runs, and `score_events` has no uniqueness constraint. Reopening and re-revealing a scored question therefore awards its points twice. Reaching that state through the Previous-screen control is blocked; reaching it through “Jump to any question” is not. This is a known defect (see §3).

## 8. Quiz authoring

### v1 authoring strategy

Use a structured quiz file and validation tool rather than a full drag-and-drop editor. This is the largest scope-control decision.

A quiz contains:

- Metadata: title, theme, estimated duration
- Rounds and round introductions
- Ordered questions
- Question type and prompt
- Answer options and media assets
- Correct answer/accepted variants
- Scoring configuration
- Host notes and reveal text

The first quiz may be authored in JSON or YAML with a friendly preview page. A spreadsheet import can follow quickly if it improves content entry.

### Later visual authoring

- Quiz library
- Add/reorder rounds and questions
- Question-type-specific forms
- Image/audio upload and asset library
- Live preview for phone and big screen
- Duplicate question/round/quiz
- Validation and missing-asset warnings
- Publish immutable quiz version for a live session

## 9. Visual and interaction design

Design is a dedicated phase and a release gate, not end-of-project decoration.

### Brand foundation — Kaplan Visual Style Guide

The game should be recognizably Kaplan while still feeling like an upbeat live music game. The public Kaplan Visual Style Guide is the design authority for the initial release: https://brandguides.brandfolder.com/visual-guide

Required design decisions:

- **Anchor color:** Kaplan Purple `#240F6E` is present in every major surface, particularly the shared host view and primary actions.
- **Palette discipline:** use neutral colors for roughly half of a screen, Kaplan Purple for roughly a quarter, and one or two compatible secondary colors for the balance. Do not use a rainbow of accents at once.
- **Typography:** Merriweather, preferably Light, for round titles and large headings; Open Sans Regular/Semibold for body copy, answer choices, controls, scores, and labels. Georgia/Arial are the fallbacks when the primary web fonts cannot load.
- **Form language:** rounded cards, answer controls, and image masks make the game welcoming and premium rather than rigid. Use the dotted pattern sparingly as a background or round-transition accent.
- **Graphic detail:** use fine curved accent lines to frame questions, separate score areas, and draw attention to the music player; avoid heavy boxes and decorative clutter.
- **Photography:** when people are shown in game promotions or title cards, use candid, diverse, positive, naturally lit imagery—not posed stock-photo energy.

Suggested game-specific color roles:

| Role | Brand color | Usage |
|---|---|---|
| Primary canvas/action | Kaplan Purple `#240F6E` | Host-view framing, primary action, round intro |
| Interaction/action | Blue `#005DE8` | Active answer, timer, selected state |
| Correct | Green `#287D21` | Correct reveal and positive score movement |
| Attention | Yellow `#FFC82E` | Countdown, audio replay cue, spotlight moments |
| Incorrect/lock | Red `#D6083B` | Incorrect reveal and closed/late state |
| Supporting canvas | White, `#EFEFEF`, `#212121` | Readability, cards, text, and contrast |

The design system should validate contrast for all semantic color pairings. Color alone must never communicate correctness, lock state, or rank movement.

### Design goals

- Energetic music-gameshow personality without feeling childish
- Excellent legibility after video-call compression
- Phone controls that work one-handed
- Strong states: waiting, open, submitted, locked, correct, incorrect
- Motion used for transitions and score reveals, never to delay routine actions
- Accessible contrast, keyboard support, reduced-motion option, and non-color status cues

### Design deliverables

- Competitive scan and moodboard
- Game identity: name, palette, typography, icon style, motion style
- Information architecture and host/player flows
- Low-fidelity wireframes for every session state
- High-fidelity big-screen and phone designs
- Reusable component inventory/design tokens
- Clickable prototype covering lobby → question → reveal → leaderboard
- Responsive and accessibility review

### Big-screen layout principles

- Designed primarily for 16:9 at 1280×720 and above
- Critical text remains readable after Meet compression
- Questions and answers stay within safe margins
- Controls are visible enough for the host but visually subordinate to the game content
- Audio controls remain large and unambiguous

### Phone layout principles

- Minimum practical width: 320 px
- Primary answer targets at least 44×44 px
- Sticky submit/action area where appropriate
- Avoid precision drag gestures. Matching on a phone is one `<select>` per clip with duplicate assignment prevented, not tap-to-pair; the drag board is the host and Presentation view
- Reconnection and submission state always visible

## 10. Proposed technical architecture

### Implemented MVP stack

- **Frontend:** vanilla HTML, CSS, and ES modules; deliberately small and dependency-light for the 10–20 player target
- **UI:** CSS variables/design tokens with Kaplan-inspired host, player, and authoring views
- **Database/auth:** Supabase Postgres, protected RPCs, Realtime Broadcast, and magic-link author authentication
- **Realtime:** Supabase Realtime Broadcast for synchronized room and player state
- **Hosting:** Cloudflare Workers static assets; Supabase managed backend
- **Validation:** structured JSON quiz definitions with editor and RPC boundary checks

A React/TypeScript rebuild is not currently justified. It remains an option only if the authoring interface or component complexity outgrows the lightweight implementation.

Supabase is attractive because it combines persistence, storage, and low-latency Broadcast/Presence in one managed service. For 10–20 players, capacity is not the challenge; deterministic state and reconnection behavior are.

### Logical components

```text
Quiz definitions + media storage
              │
              ▼
      Authoring/validation
              │
              ▼
       Session state service
        ┌─────┴────────┐
        ▼              ▼
 Shared display     Player phones
 + host controls    + submissions
        │              │
        └─────┬────────┘
              ▼
       Scoring + leaderboard
```

### Security boundary

- Only authenticated hosts can create sessions or change session state.
- Players receive short-lived anonymous identities scoped to one session.
- Host operations are checked server-side.
- Answer keys, host notes, future questions, and audio assets are not included in player payloads.
- Room codes are short join identifiers, not authorization for host actions.

## 11. Core data model

**The quiz content model is not normalized.** A whole published quiz — rounds,
questions, options, answer keys, media references, title page, door
configuration, finale audio — is one JSONB document in
`quiz_versions.definition`. Every scoring RPC walks that document directly with
`jsonb_array_elements`. Earlier versions of this section listed seven
normalized tables (`rounds`, `questions`, `answer_options`,
`accepted_answers`, `session_state_events`, `submission_items`,
`leaderboard_snapshots`). **None of them were ever built.** They are recorded
here as never-built so that a future session does not write a migration against
them.

### Quiz content

- `quizzes`
- `quiz_versions` — holds the immutable JSONB `definition` for one published version
- `quiz_authors` (`0008`) — the publishing allowlist
- `media_assets` (`0010`, extended for video by `0032`) — private uploaded audio, images, and video derivatives

### Live game

- `sessions` — room code, phase, current round/question index, `revision`, and a `state` JSONB holding the host-computed screen model
- `session_players` — roster, display name, logo, join time, late-join catch-up bookkeeping
- `submissions` — one row per player per question, upserted
- `score_events` — append-only, with `base_points`, `multiplier`, `points`, `reason`, and `created_by`
- `session_door_choices` (`0025`) — persisted door picks and their resolved outcomes

### Important invariants

- A session references a fixed quiz version, and that version’s definition is immutable. Publishing creates a new version rather than changing rooms that already exist.
- One current submission exists per player/question; a repeat submission updates it.
- Score totals derive from score events, never from a mutable total.
- State changes are ordered and carry a monotonically increasing `revision`.
- Clients ignore stale revisions, and the server rejects submissions that carry one.
- Migration history equals production state: every persistent change is a new ordered migration, and applied migrations are never edited or renumbered.

## 12. Delivery phases

Estimates below are focused engineering/design effort for one experienced builder with AI assistance, not promises of calendar time. Review and content preparation can occur in parallel.

### Phase 0 — Product decisions and technical spike

Estimated effort: 1–2 days

Goals:

- Freeze v1 scope and question-type list
- Decide Supabase Realtime versus Socket.IO through a small synchronization test
- Prove Google Meet tab-audio playback from the shared display
- Define quiz schema and session state machine
- Decide whether initial authoring is JSON/YAML or spreadsheet import

Exit criteria:

- Two browser clients follow host state changes
- One test audio clip plays through a shared Meet tab
- Reconnect returns a client to the correct state
- Written architecture decision record exists

### Phase 1 — UX and visual design

Estimated effort: 3–5 days

Goals:

- Design the host/display and phone experience before feature implementation
- Establish the visual identity and responsive system
- Prototype the hardest interactions: joining, submitted/locked states, audio control, matching, and leaderboard reveal

Deliverables:

- Moodboard and visual direction
- Brand-alignment board drawn from the Kaplan guide: palette roles, typography specimens, rounded shape treatment, dot pattern, and accent-line behavior
- End-to-end user flows
- Wireframes for all game states
- High-fidelity screens for desktop 16:9 and mobile
- Design tokens and component list
- Clickable prototype

Exit criteria:

- Host can walk through an entire sample round in the prototype
- Phone matching works conceptually at 320 px width
- Shared display is legible at simulated 720p video-call quality
- Visual direction is approved before the main build

### Phase 2 — Realtime game foundation

Estimated effort: 3–5 days

Goals:

- Create/join room
- Player nickname and presence
- Canonical server-side session state
- Host-controlled progression and room locking
- Reconnect/resume behavior
- Basic shared display and phone shells using final design tokens

Exit criteria:

- 20 simulated/real clients stay synchronized
- Players cannot advance independently
- Duplicate nicknames and reconnects behave predictably
- Host reload does not destroy the room

### Phase 3 — Core questions, scoring, and leaderboard

Estimated effort: 4–7 days

Goals:

- Single choice, multiple choice, true/false, image selection
- Short answer with accepted variants and host review
- Server-authoritative submissions and scoring
- Question locking and reveals
- Between-round leaderboard and final podium
- Host score adjustment controls

Exit criteria:

- A complete conventional five-question round runs end to end
- Scores reconcile from stored submissions
- Changing an answer before lock updates rather than duplicates it
- Leaderboard is correct after reconnects and host adjustments

### Phase 4 — Music and advanced question formats

Estimated effort: 4–7 days

Goals:

- Host/display audio controls and preloading
- Fill in the blank
- Arrange in order
- Matching, including the ten-by-ten piano-intro round
- Partial-credit rules
- Audio operational checklist for Meet

Exit criteria:

- Full piano matching round works on common phone sizes
- Audio filenames/answer metadata never appear to players or on the shared screen
- Playback/replay works after a fresh page load and during tab sharing
- Partial-credit tests pass

### Phase 5 — Authoring workflow

Estimated effort: 3–6 days for a friendly structured importer; 8–15 additional days for a polished visual editor

Initial goals:

- Schema validation with actionable errors
- Quiz preview
- Asset upload or deployment workflow
- Duplicate/edit existing quiz data
- Spreadsheet import if preferred

Deferred visual-editor goals:

- Browser forms for all question types
- Drag-to-reorder rounds/questions
- Media library and audio trimming
- Draft/publish/version workflow

Exit criteria for v1:

- A non-developer can update the quiz using the documented workflow with limited assistance
- Broken answer keys and missing assets are caught before a session starts

### Phase 6 — Hardening and dress rehearsal

Estimated effort: 3–5 days

Goals:

- Cross-browser/mobile testing
- Accessibility and reduced-motion pass
- Slow network and reconnect tests
- Host recovery controls
- Logging, error reporting, and database backups
- Full rehearsal in Google Meet with 5–10 testers
- Final visual polish and transition timing

Exit criteria:

- Two full rehearsals complete without score correction or state reset
- Host can recover from accidental reload, disconnected player, and bad submission
- Audio is audible and balanced for remote participants
- Launch checklist and fallback plan are documented

## 13. Effort summary and honest assessment

### Narrow prototype

Phases 0–3 with only choice questions: approximately **8–14 focused days**.

### Useful music-trivia v1

Phases 0–4 plus a file/import-based authoring workflow and hardening: approximately **18–31 focused days**.

### Polished reusable product

Add the full visual editor, asset management, richer analytics, teams, and production operations: approximately **6–12 additional weeks**, depending on polish and collaboration features.

This is not a massive undertaking at the focused v1 level. It becomes massive only if “our own Genially” means a general visual presentation editor, template marketplace, arbitrary animations, and a full content-management platform.

## 14. Explicitly out of scope for v1

- General slide/page designer
- Arbitrary canvas positioning and animation authoring
- Template marketplace
- Native mobile apps
- Public quiz discovery/community library
- Payments/subscriptions
- Large-event scaling beyond the small-group target
- Built-in video conferencing
- Player-side audio synchronization
- Sophisticated anti-cheat controls
- Full analytics warehouse

## 15. Risks and mitigations

### Meet audio is configured incorrectly

Mitigation: preflight audio test, share-tab instructions, visible audio meter, and a rehearsal checklist.

### Browser blocks playback

Mitigation: require a direct host click/keyboard action; do not depend on autoplay.

### Realtime clients drift or reconnect mid-question

Mitigation: canonical server state, revision numbers, resync on focus/reconnect, idempotent submissions.

### Short answers create grading friction

Mitigation: normalized accepted variants plus a compact host review queue; use short answer sparingly.

### Mobile matching is cumbersome

Mitigation: tap-to-pair interaction, one-to-one assignment enforcement, sticky completion status, no precision dragging requirement.

### Authoring consumes the schedule

Mitigation: ship structured files/import first; build the visual editor only after the live runner is proven.

### The host interface is too complex during a live show

Mitigation: keyboard shortcuts, one dominant next action, rehearsed flow, optional private console later.

## 16. Recommended release boundary

The first production release should include:

- Lobby, join code, nicknames, and reconnect
- Host-controlled shared display
- Big-screen audio playback
- Choice, image, short answer, ordering, fill-blank, and matching questions
- Server-side scoring and host review
- Between-round leaderboard and final podium
- Structured quiz authoring/import and validation
- One complete five-round music quiz
- Rehearsal and fallback documentation

Do not wait for a drag-and-drop visual editor. The live runner, scoreboard, and music round are the valuable product; the editor is a convenience layer that can follow.

## 17. Reference notes

- Google Meet recommends sharing a browser tab when presentation audio needs to be shared: https://support.google.com/meet/answer/9308856
- Browser autoplay with sound can be blocked, so direct user-controlled playback is required: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/autoplay
- Supabase Realtime supports low-latency Broadcast and Presence suitable for synchronized game state and player presence: https://supabase.com/docs/guides/realtime

## 18. Presentation video clips

Ordinary questions may carry one private presentation medium: either audio or a video derivative, never both. Authors trim MP4, MOV, or WebM source locally and upload only a standardized private MP4; the source file and edit metadata remain local. Video is Host-cued but rendered only in Presentation, including embedded audio. Player payloads intentionally omit the video asset UUID, labels, source metadata, and playback URL.

## 19. Shipped features this document did not previously describe

Each of these is real, tested behavior. They are grouped here rather than
woven in, so the addition is visible in the diff; fold them into the relevant
sections when those sections are next revised.

### Player logos

Twenty selectable avatars, chosen at join alongside the display name, persisted
on `session_players.logo_key` (`0021`), and rendered on phones, the host panel,
Presentation, door groupings, and the podium.

### Opening title page and waiting-room music

A quiz may carry a `titlePage`: title, subtitle, presenter name, theme art, an
animated background, the join QR code, and host-cued music. It is the first
Presentation screen and is not a session phase.

### SRT and ASS lyric captions

Title-page audio may carry timed text parsed from SRT or ASS, including
karaoke segment timings. Bounded at 500 cues and 500 segments per cue, and
validated as such. Rendered only on Presentation, driven by the audio clock.

### Finale audio slots

Suspense, podium, and standings cues, authored per quiz under `finale.audio`.
Note that the editor’s validator checks these asset IDs and the shared
`quiz-validation.js` module checks `betweenRoundBonus.audio` instead — the two
validators check different parts of the document. Merging them is open work.

### “Who got it right” summary

A host-only, post-reveal panel showing how many submitted answers were correct,
with a per-part breakdown for matching, categorize, and multi-blank questions.
It is computed in the browser by `tallyQuestionResults` in `quiz-core.js`, from
data the host already holds.

**It is a deliberate hand-mirror of the comparison rules in
`0030_multi_fill_in_the_blank_scoring.sql`.** If that migration’s comparison
logic changes, this must change with it, or the host’s live “X of Y correct”
will silently disagree with the points actually awarded. Nothing currently
asserts the two agree.

### Host volume carry-forward and manual loudness

One host-set volume applies to every later cue across all scopes, including
automatic between-round and finale audio. Separately, an author can bake a
manual 1–150% gain into an uploaded clip in place of the automatic −16 dBFS
levelling.

### Client-side auto-submit retry

When a submission is rejected for a stale revision, the player’s client
refetches room state and resubmits once if the same question is still open.
This is the client-side stand-in for the server grace window §7 used to
describe, and it is also the mitigation for §15’s “Realtime clients drift”
risk.

### Sentry error monitoring

Live, not planned. The DSN ships in `config.js` and is public by design; that
file remains free of secrets.

### Question jump control

A “Jump to any question” select in the live host panel, labelled a testing
shortcut but rendered in real hosted rooms. See §3 and §7 for the re-scoring
defect it exposes.

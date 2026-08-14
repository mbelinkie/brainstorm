# Music Trivia Live — Product Specification

Status: Active build record  
Audience: Product/design/engineering  
Initial use: Live work trivia for approximately 10–20 players over Google Meet

Last updated: 2026-08-14

## Build status

| Phase | Status | Notes |
|---|---|---|
| 0 — Product decisions and technical spike | Complete | Architecture, audio constraint, local transport proof, and quiz schema selected. A Supabase Free project in US East is live with the initial schema and RLS enabled. |
| 1 — UX and visual design | Substantially complete for MVP | Kaplan-inspired host, player, landing, and authoring surfaces are deployed. Visual polish remains. |
| 2 — Realtime game foundation | Complete for MVP | Public Cloudflare deployment, named-player join, host controls, refresh recovery, protected room state, server scoring, and the shared leaderboard have been rehearsed end-to-end. |
| 3 — Core questions, scoring, and leaderboard | Complete for MVP | Choice, text, matching, ordering, closest-number, and leaderboard scoring are implemented. Manual score adjustment and richer reveal/leaderboard modes remain. |
| 4 — Music and advanced question formats | In progress | Matching, host-only audio cues/URLs, fill-in, ordering, categorization, and private audio/image upload are implemented. Real clip and image preparation remain. |
| 5 — Authoring workflow | In progress | Browser editor, JSON import/export, client-side schema validation, magic-link author authentication, protected publishing, host quiz selection, basic quiz/round management, search/filtering, templates for every supported question type, and a private media library with previews, names, asset reuse, and safe cleanup are live. |
| 6 — Hardening and dress rehearsal | Planned | Needs a complete real-content Google Meet rehearsal with several phones. |

## Current implementation snapshot

### Live platform

- Hosted at `https://wild-haze-73b3.matthew-belinkie-3af.workers.dev` on Cloudflare Workers static assets.
- Supabase (US East Free plan) provides protected RPCs, Postgres persistence, Realtime Broadcast, Auth, and server-side scoring.
- Host creates a six-character room; players join with a room code and display name.
- The host alone advances lobby → open → lock → reveal → next question → complete. Player phones never receive future questions, answer keys, host reveal notes, or host-only media information.
- Sessions recover after a host refresh using the stored room state and fixed quiz version.
- Score totals derive from server-written score events and appear in a shared leaderboard.

### Current question support

- Single choice, multiple choice, true/false, and label-based image selection.
- Short answer and one-blank fill-in-the-blank with normalized accepted-answer matching.
- Arrange in order, exact-scored.
- Matching, with one point per correct pair; used for the piano-intro finale.
- Categorize: assign every listed item to one of two named categories; full-credit automatic scoring when all assignments are correct.

### Authoring and access

- The browser editor can edit quiz/round/question titles and content, manage and reorder rounds/questions, change a question’s type, add host-only audio cues, validate, import JSON, and download JSON.
- Published quiz definitions are versioned. Publishing creates a new version rather than changing rooms that already exist.
- Authenticated authors are explicitly allowlisted. The current author account has publishing permission.
- Supabase Auth uses custom Resend SMTP with the verified `auth.matthewbelinkie.com` sender domain, avoiding the built-in two-emails-per-hour testing limit.

### Known limitations

- The editor opens the music bank by default; it can start a blank one-round quiz and add, duplicate, delete, or reorder rounds and questions. It cannot yet manage prior versions.
- Image selection accepts private JPG, PNG, and WebP uploads per option. Before upload, authors can choose square, widescreen, standard, or original framing and set an image focal point; the editor then converts the selected crop to a maximum-1600px WebP derivative and can copy originals into an author-chosen local folder. An author-only media assistant can suggest Wikimedia Commons images from question context, show the source/license for approval, and attach an approved derivative. Joined players can retrieve only assets on the active question; richer library flow remains.
- Audio can be referenced by an optional host-only URL or played from a prepared external host source. Authors can upload private clips; the host retrieves them through an authorized application proxy. Hosted clips have play/pause, restart, volume, elapsed-time controls, and ready/unavailable status. Trimming, normalization, and richer media management remain.
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
3. Improve generic quiz creation: blank-quiz template, round management, duplicate controls, and a cleaner quiz library/version view.
4. Add media refinement: image crop/library plus audio trimming, normalization, preload status, and media management.
5. Add game-operation polish: QR join, timer, manual adjustments, and results export.

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
  → Round intro
  → Question ready
  → Question open
  → Question locked
  → Answer reveal
  → Question results or leaderboard
  → Next question / next round
  → Final podium
  → Session complete
```

### State rules

- Players cannot request or infer the next question from the player interface.
- A question accepts submissions only while its server state is `open`.
- Locking is authoritative on the server, not based on a phone’s local timer.
- The host may reopen a question only through an explicit override.
- Reconnected players receive the current state and their existing submission.
- Answer keys and future questions are never sent to player clients before reveal.

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

- Large Play/Pause button
- Replay from beginning
- Optional replay limit shown to the host
- Volume control and mute
- Progress indicator; elapsed time visible to host
- Clip label such as “Clip 3 of 5,” never the filename or song title
- Preload status before the question opens
- Keyboard shortcuts: Space = play/pause; R = restart
- Clear “Share this tab’s audio” setup reminder before the game starts

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

### v1 formats

1. **Single choice**
   - Text or image answers
   - One correct option
   - Optional speed bonus

2. **Multiple choice**
   - Select all applicable answers
   - Configurable exact-match or partial-credit scoring

3. **True or false**
   - Specialized fast two-option layout

4. **Image selection**
   - One or multiple selectable images
   - Useful for artists, album art, and movie posters

5. **Short answer**
   - Exact and normalized accepted variants
   - Host review queue for unmatched answers
   - Optional manual award/reject/partial credit

6. **Fill in the blank**
   - One or more answer fields
   - Normalized comparison and accepted variants
   - Appropriate for short lyric fragments; avoid storing/displaying large lyric excerpts

7. **Arrange in order / sort**
   - Touch-friendly vertical reorder
   - Exact order or position-based partial credit

8. **Matching**
   - One-to-one pairs
   - Tap item, then tap match on phones; drag-and-drop is optional on larger screens
   - Supports the piano-intro finale as ten numbered clips matched to ten song titles

9. **Categorize**
   - Sort listed items into one of two named categories
   - Current MVP uses a mobile-friendly category selector per item
   - Full-credit automatic scoring when every item is assigned correctly

### Later formats

- Swipe left/right rapid classification
- Numeric estimation with tolerance
- Hotspot on image
- Buzzer / first-to-answer
- Poll with no correct answer
- Wager question
- Team answer mode

## 6. Piano-intro matching round

This is a featured round, not ten unrelated questions.

### Big-screen view

- Lists Clips 1–10 with one Play button at a time
- Shows song options A–J throughout the round
- Host can play clips in sequence or replay a selected clip
- No correct mapping is shown until lock/reveal
- Response counter shows `submitted / connected`

### Player phone view

- Shows ten rows: Clip 1 through Clip 10
- Each row selects one song from A–J
- Once a song is used, it is marked as assigned and can be moved
- “Unmatched” state is visually obvious
- Submit button is enabled only when all ten are matched, unless incomplete submission is allowed
- Players can edit until the host locks the round

### Scoring

- Default: one point per correct pair
- Optional completion bonus
- No speed bonus by default; the round rewards recognition, not network latency

## 7. Scoring and leaderboard

### Scoring model

- Each question defines maximum base points.
- Speed bonus is optional by question and capped.
- Partial credit is supported for matching, ordering, and configurable multiple choice.
- Host adjustments are recorded as auditable score events rather than overwriting totals.
- Ties share rank until a tie-breaker is played.

### Leaderboard views

- Between-round full leaderboard
- Optional top-five quick reveal after a question
- Final animated podium for top three
- Rank change indicator since previous reveal
- Player’s own phone may show personal rank and score after reveal
- Host can hide scores while retaining ranking if desired

### Fairness rules

- Server receipt time determines any speed bonus.
- A short grace window may absorb ordinary network jitter.
- Audio matching and host-reviewed short answers should not use speed scoring.
- Duplicate submissions update the existing response while open; they do not create additional score events.

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
- Avoid precision drag gestures; matching defaults to tap-to-pair
- Reconnection and submission state always visible

## 10. Proposed technical architecture

### Implemented MVP stack

- **Frontend:** vanilla HTML, CSS, and ES modules; deliberately small and dependency-light for the 10–20 player target
- **UI:** CSS variables/design tokens with Kaplan-inspired host, player, and authoring views
- **Database/auth:** Supabase Postgres, protected RPCs, Realtime Broadcast, and magic-link author authentication
- **Realtime:** Supabase Realtime Broadcast/Presence or a small Socket.IO service
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

### Quiz content

- `quizzes`
- `quiz_versions`
- `rounds`
- `questions`
- `answer_options`
- `media_assets`
- `accepted_answers`

### Live game

- `sessions`
- `session_players`
- `session_state_events`
- `submissions`
- `submission_items` for matching/multipart answers
- `score_events`
- `leaderboard_snapshots`

### Important invariants

- A session references a fixed quiz version.
- One current submission exists per player/question; revisions are timestamped.
- Score totals derive from score events.
- State changes are ordered and carry a monotonically increasing revision number.
- Clients ignore stale revisions.

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

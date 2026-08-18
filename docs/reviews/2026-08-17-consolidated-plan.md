# Consolidated plan of attack — the four 2026-08-17 reviews

Consolidation date: 2026-08-18. Verified against `main` at `b58adb7` (clean except two
untracked files, see [Working-tree state](#working-tree-state)).

Sources, cited throughout by tag:

| Tag | Report | Scope |
|---|---|---|
| **APP** | [2026-08-17-app-author.md](docs/reviews/2026-08-17-app-author.md) | `app.js` / `author.js` state handling (F1–F19) |
| **MIG** | [2026-08-17-migrations-rls.md](docs/reviews/2026-08-17-migrations-rls.md) | Migrations `0001`–`0032` + RLS (F1–F10) |
| **SPEC** | [2026-08-17-spec-conformance.md](docs/reviews/2026-08-17-spec-conformance.md) | `PRODUCT_SPEC.md` vs. shipped code (§0.1–0.3, §1–§9) |
| **TEST** | [2026-08-17-test-gaps.md](docs/reviews/2026-08-17-test-gaps.md) | Test coverage gaps (ranked gaps 1–15) |

This document plans; it does not fix. No code, SQL, spec, changelog, worklog, or
`mistakes.md` was modified.

---

## 0. Read this first

### Provenance and line-number drift

All four reviewers worked from **`b85a1fd`** or a worktree of it. `HEAD` is `b58adb7`,
four merges later (`claude/title-screen-url`, `claude/media-upload-limit`,
`claude/device-session-memory`, `claude/remove-image-suggest`). Net diff since the review
baseline: `app.js` +19/−7, `author.js` +11/−70, `cloudflare-worker.js` −30,
`quiz-core.js` +14, `video-utils.js` +13.

**Every line number in the four reports is now low by roughly 10–15 lines in `app.js`
and by up to 60 in `author.js`.** Current locations for the functions this plan names are
given inline below. Workers should grep by function name, not jump to the cited line.

### Baseline correction — the test-suite numbers in TEST are stale

TEST's baseline is *"140 tests, 139 pass, 1 fail (`deploy-manifest.test.js`)"*. Actual, run
just now on `b58adb7`:

```
ℹ tests 158
ℹ pass 158
ℹ fail 0
ℹ duration_ms 527.750962
```

Two things changed. The four merged branches added 18 tests
(`test/image-suggestion-removal.test.js` and additions to `player-logo`, `quiz-core`,
`video-clips`, `presentation-layout`, `access-control`). And the `deploy-manifest` failure
is **STALE in this working tree only** — `video-processor.worker.bundle.js` (1.0 MB, built
2026-08-17 12:51) is present here, so the "referenced but not shipped" assertion passes.
It will fail again on any clean checkout that has not run `npm run build:video`. TEST's
diagnosis of the underlying inconsistency (`generatedArtifacts` at
`test/deploy-manifest.test.js:24` excludes the bundle from three checks but not the
fourth) still stands and is worth closing — see [C34](#c34).

TEST's headline structural claim survives intact. Regex-against-source assertion counts
today: `reliability-contract` 133, `presentation-layout` 102, `door-bonus` 37,
`access-control` 31, `player-logo` 24, `brand-layer` 23, `video-clips` 21,
`image-suggestion-removal` 18, `late-join-bonus` 14, `scoring-contract` 8.

### Working-tree state

`git status --short --branch`:

```
## main...origin/main
?? image-engine.js
?? test/image-engine.test.js
```

Both are untracked **in-flight work for the Prompt Battle round type** (`image-engine.js`
header cites `docs/superpowers/specs/2026-08-17-prompt-battle-design.md` §7.3–7.4; the test
file has 9 cases and passes). Per CLAUDE.md rule 1 this is someone's live slice. **No batch
in this plan touches `image-engine.js`, `test/image-engine.test.js`, or the
`cloudflare-worker.js` region where the image-engine routes will land.** Batch F below is
flagged as a likely collision and should be scheduled after that slice lands or be given to
whoever owns it.

### Verification method

I spot-checked every S0 and S1 finding, and a sample of S2, directly against the code —
running `validateQuiz` over both fixtures, running `npm test`, and reading the migration
and `app.js`/`author.js` source. Per-finding status:

- **VERIFIED** — reproduced in the code at `b58adb7`.
- **VERIFIED (static)** — the code says what the report says; the *consequence* depends on
  live project state I cannot read from the repo (noted inline).
- **STALE** — no longer reproduces.
- **UNVERIFIED** — carried forward from the source report without a spot-check, because it
  is below the severity bar the brief set for verification.

Nothing in S0 or S1 came back STALE. The only STALE item found is the TEST baseline above.

---

## 1. Contradictions between reports

Called out explicitly, both positions stated, with what settles each. Nothing here is
silently resolved in the findings table below.

### X1 — "No priority-1 findings" (APP) vs. "two criticals and a high" (MIG) — **MIG is right**

**APP's position** (summary section): *"**No priority-1 findings.** I looked specifically
for credential exposure, authorization gaps, and player-payload leaks and did not find
one."*

**MIG's position** (§0): F1/F2 are critical — any anonymous browser mints a host credential
and reads the full answer key plus every private media file. F3 is high — every player's
answer is broadcast in cleartext on a public Realtime channel.

**What settles it: both, in different scopes — but F3 is squarely inside APP's scope and
APP missed it.**

- On F1/F2, APP is correct *about what it examined*. `publicRoomState()`
  ([app.js:147](app.js:147)) really is a sound positive allowlist, and MIG agrees
  explicitly: *"The player-payload allowlist … is correct and is not the problem. The
  problem is that it can be walked around entirely."* The leak is in the migration grants,
  outside APP's brief. Not a contradiction — a scope boundary.
- On **F3 it is a real miss**. The channel is created at [app.js:810](app.js:810):
  `supabase.channel(\`quiz-room:${roomCode}\`, { config: { broadcast: { self: false } } })`
  — no `private: true` — and `sendSubmission()` ([app.js:694](app.js:694)) posts
  `{playerId, playerName, playerLogoKey, questionId, answer}` to it on every submission.
  That is `app.js`, it is a player-payload leak, and APP's "did not find one" is wrong.

**Resolution: treat APP's no-priority-1 verdict as scoped to `publicRoomState`/
`toPlayerQuestion` only.** [C1](#c1), [C2](#c2), [C3](#c3) go to the top of the plan.

---

### X2 — Does re-locking a question double-score? APP says the DB is safe; SPEC and MIG say points double — **all three are right about different paths**

**APP's position** (F11): *"The database is safe: `lock_and_score_live_question`
(`0003_server_scoring.sql:24`) takes `SELECT … FOR UPDATE` on the session and re-checks
`phase <> 'question_open'`, so a second concurrent call **cannot** double-score."*

**SPEC's position** (§0.1) and **MIG's position** (F5): the RPC *"re-reads the still-present
`submissions` rows … and **inserts a fresh `score_events` row per correct answer**."* Points
double.

**What settles it:
[supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql:12-14](supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql:12)
and the absence of any unique index.** Verified:

```sql
select * into active_session from public.sessions where room_code = … for update;   -- line 12
if not found then raise exception 'Host authorization failed'; end if;              -- line 13
if active_session.phase <> 'question_open' then raise exception '…not open'; end if;-- line 14
```

and `grep -rn score_events supabase/migrations/*.sql | grep -i 'index\|unique'` returns
exactly one hit: `score_events_session_player_idx (session_id, player_id)`
([0001_initial.sql:91](supabase/migrations/0001_initial.sql:91)) — **not unique, and not
question-scoped**. There is no `delete from public.score_events` anywhere in the 32
migrations.

So: the `FOR UPDATE` + phase check defeats **concurrent** double-locking (APP is right —
the second caller loses the race and raises). It does nothing about **sequential** re-open
→ re-lock, because the phase is legitimately `question_open` again by then (SPEC and MIG
are right). Two different scenarios, no actual disagreement.

**Resolution: one finding, [C4](#c4), covering both the client control that reopens and the
server guard that should refuse. The server guard is the durable half.**

---

### X3 — Is the missing `categorize`/`arrange_in_order`/`fill_in_the_blank` validation an authoring-safety hole? TEST says yes; APP and SPEC say the editor catches it — **APP and SPEC are right**

**TEST's position** (ranked gap 13): `quiz-validation.js` has no branch for those types, so
*"An author publishes a categorize/ordering/fill-in-the-blank question with no
correct-answer key and `validateQuiz` reports it as valid; it publishes and is unscorable
live … this will currently **fail**, surfacing a real authoring-safety hole."*

**APP's position** (F9) and **SPEC's position** (§0.2): `author.js` has its *own*
`validateQuiz` that does check all three, and that is the one gating Publish.
`quiz-validation.js` is imported only by tests.

**What settles it: [author.js:136](author.js:136) and the import list at
[author.js:1](author.js:1).** Verified — `author.js` imports `diagnostics.js`,
`image-crop.js`, `subtitle-core.js`, and `video-utils.js`. It does **not** import
`quiz-validation.js`. Its private `validateQuiz` at line 136 carries a `supportedTypes`
allowlist of 11 types (line 138) and per-type answer-key checks.

TEST's *premise* is right (the tested validator is missing those rules) and its *conclusion*
is wrong (a real author cannot publish such a question through the editor). The actual risk
is narrower but not zero: a direct `publish_quiz_version` POST bypasses the editor entirely
— which is [C11](#c11), MIG F8.

**Resolution: TEST gap 13 folds into [C20](#c20) (the validator fork) as evidence, not as
its own authoring-safety finding. Its proposed test is still worth writing — after the fork
is closed, when `quiz-validation.js` is the code that runs.**

---

### X4 — TEST's proposed fixture assertion cannot pass today

**TEST's position** (ranked gap 3): *"Load both fixtures, assert `validateQuiz(fixture) ===
[]`."*

**APP's position** (F8): `quiz.sample.json` **fails** validation today.

**What settles it: running it.** Verified just now:

```
quiz.sample.json               => ["Round 2 needs at least one question.",
                                   "Round 3 needs at least one question.",
                                   "Round 4 needs at least one question."]
music-trivia.question-bank.json => []
```

Not a contradiction of fact — TEST simply never ran the assertion it proposed. It is a
**sequencing dependency**: the fixture must be repaired (or the empty-round rule decided)
before the test TEST asks for can be written green.

**Resolution: [C19](#c19) (fix the fixture + the host dead-end) blocks [C32](#c32) (the
fixture test). Same batch, fixture first.**

---

### X5 — "Players never receive asset IDs": CLAUDE.md's invariant vs. the shipped design — **the invariant text is wrong**

**APP's position**: `publicRoomState`'s `audioCommand` *"carries only `{id, volume, action,
audioScope, audioKey, questionId, clipId}` — never a `mediaAssetId` or URL"*, and
`revealImageAssetId`/`questionImageAssetId` reach Presentation via `hostQuizDefinition`, not
the player payload.

**MIG's position** (F4): `toPlayerQuestion()` deliberately forwards
`options[].imageAssetId` to players, and `0029`'s own comment endorses it.

**What settles it: [quiz-core.js:6](quiz-core.js:6).** Verified — `toPlayerQuestion` maps
options to `{ id, label, ...(imageAssetId ? { imageAssetId } : {}) }`. Both reports are
factually correct; they are describing different fields. APP's claims are scoped to
`audioCommand` and to reveal/question artwork and hold. MIG is right that CLAUDE.md's
blanket *"No … asset IDs, or usable media URLs reach a player payload before the host
reveals"* is contradicted by the shipped, deliberate, migration-endorsed behavior.

An asset ID is not a usable URL — the Worker still gates redemption via
`can_access_live_media`, which post-`0029` allows a player exactly the active question's
option artwork. The design is sound; the invariant sentence is stale.

**Resolution: [C30](#c30) — amend the CLAUDE.md/PRODUCT_SPEC invariant wording to
"no usable media URLs, and no asset IDs beyond the active question's option artwork".
MIG's second half of F4 (`items`/`categories` pass through unfiltered, so a `categorize`
item's artwork would reach players and then 403) is a real latent break — folded into
[C30](#c30) as a sub-item.**

---

### X6 — MIG F6 predicts the closest-number wall is *already broken*; APP F6 treats its failure as an edge case — **unresolved, one live check settles it**

**MIG's position** (F6): `/host-closest-number-guesses` embeds
`player:session_players(display_name,logo_key)`, PostgREST requires `SELECT` on
`public.session_players` for `service_role`, and **no migration ever grants it**
(`0028` grants only `sessions` and `submissions`). `service_role` has `BYPASSRLS`, which
bypasses policies, not grants. Predicted: `42501 permission denied`, Worker 502, silent
degraded reveal.

**APP's position** (F6): describes the Worker fetch failing as one branch — *"The Worker
returns 502 … or the request times out"* — alongside a Presentation tab that missed
broadcasts.

**What settles it, partly, from the repo:** verified —
[cloudflare-worker.js:148](cloudflare-worker.js:148) does contain that embed, and
`grep -rn "grant select" supabase/migrations/*.sql` returns exactly four lines
(`media_assets`→`service_role` in 0019, `media_assets`→`authenticated` in 0023,
`sessions` and `submissions`→`service_role` in 0028). **No grant on `session_players`
exists in the repo.**

**What does not settle from the repo:** whether this Supabase project carries the default
`GRANT ALL … TO service_role`. If it does, the embed works and 0019/0023/0028 were all
no-ops. MIG argues the existence of those three migrations is strong evidence against
defaults being present. I agree it is suggestive, not conclusive.

**Marked UNRESOLVED pending one read-only check Matthew runs:**

```sql
select relacl from pg_class where oid = 'public.session_players'::regclass;
```

**If MIG is right, this changes the severity of APP F6.** The realtime-subset fallback
stops being an edge case and becomes the **default path for every `closest_number`
reveal** — the shared screen would be crowning a winner from partial data at every show.
[C7](#c7) and [C8](#c8) are therefore ranked as one blast radius and batched together.

---

### X7 — `locked` phase reachability

**APP's position** (F18 item 4): `[data-phase="locked"]` has a handler but no markup emits
it, so `locked` is reachable *only* through timer expiry — meaning the presenter's "Answers
locked" scene never appears in a timer-less show.

No other report addresses this; **SPEC §3** independently notes that `round_intro`,
`question_ready`, and `leaderboard` are dead enum values. These are consistent, not
contradictory, but together they say something neither says alone: **the phase enum and the
phases the product actually uses have drifted in both directions** — three enum values are
never written, and one written value is nearly unreachable. Folded into [C30](#c30) and
[C37](#c37). UNVERIFIED (P7-tier; not spot-checked).

---

## 2. Deduplicated, severity-ranked findings

Ranking follows the brief: **security and correctness above cleanliness**, and anything
touching server-authoritative scoring/authorization, or any path where players could
receive answers, future questions, or usable media URLs before reveal, is promoted to the
top **regardless of how its source report rated it**. Promotions are called out.

Legend — **Mig?** column: `YES` = needs a new numbered migration (Matthew assigns the
number; these cannot be parallelized against each other). `NO` = client/worker/test/doc
only. `MAYBE` = depends on a design decision recorded in the entry.

---

### S0 — Critical: authorization and pre-reveal disclosure

These three are the plan. Nothing below them matters as much.

#### C1 — Any anonymous browser can mint a host credential and read any quiz's full answer key {#c1}

**Sources:** MIG F1 (critical); MIG F10 (no negative tests). Not seen by APP (out of scope —
see [X1](#x1--no-priority-1-findings-app-vs-two-criticals-and-a-high-mig--mig-is-right)).
Contradicts SPEC §10's *"Only authenticated hosts can create sessions."*
**Status: VERIFIED.** **Mig?: YES.** **Files: `supabase/migrations/` only.**

Verified chain, using only values published in `config.js`:

1. [0007_quiz_catalog.sql](supabase/migrations/0007_quiz_catalog.sql) — `list_quiz_catalog()`
   is `security definer`, has **no credential check of any kind**, and is
   `grant execute … to anon`. Returns `quizVersionId` for every version in the project.
2. [0002_live_room_rpc.sql:225](supabase/migrations/0002_live_room_rpc.sql:225) —
   `grant execute on function public.create_live_room(uuid, text, jsonb) to anon,
   authenticated`. Body checks exactly two things: `char_length(p_host_secret) >= 24`, and
   that the quiz version exists. **The caller supplies their own host secret.** No later
   migration redefines it — `grep -ln create_live_room supabase/migrations/*.sql` returns
   `0002` and nothing else.
3. [0005_host_quiz_access.sql:17-27](supabase/migrations/0005_host_quiz_access.sql:17) —
   `get_host_quiz_definition` returns `quiz_versions.definition` **verbatim** for whatever
   room the presented secret opens, and is granted to `anon`.

Result: a phone in the audience gets `correctOptionIds`, `acceptedAnswers`, `correctPairs`,
`correctCategories`, `correctOrder`, `targetNumber`, `clips[].acceptedAnswers`, host notes,
and every `mediaAssetId` — before question 1 opens.

Breaks CLAUDE.md's *"Players never receive future state"* outright.

**Smallest closure** (MIG's, and I agree): require `is_quiz_author()` in `create_live_room`,
or bind room creation to an author-issued grant. **This is a behavior change with host-flow
consequences — it is Matthew's design call, not a worker's.** Decide before the batch runs:
does the host browser authenticate today? If hosts run unauthenticated, closing this
requires a host sign-in flow, which is a feature, not a fix.

Also fold in: MIG §1.0(a) — in PostgreSQL `EXECUTE` on a new function is granted to `PUBLIC`
by default, revoked here exactly twice (`room_code()`, `token_hash()` in `0002`). Every
`grant … to authenticated` on an author RPC is therefore **decorative**; those RPCs are safe
only because of in-body `is_quiz_author()` checks. Any migration in this batch should state
that, and consider a blanket `revoke execute … from public`.

#### C2 — The same credential yields every private media file, at any phase {#c2}

**Sources:** MIG F2 (critical). Depends on C1. **Status: VERIFIED.** **Mig?: YES.**
**Files: `supabase/migrations/`; possibly `cloudflare-worker.js`.**

Verified — [0029_presentation_only_media.sql](supabase/migrations/0029_presentation_only_media.sql)
host branch, unchanged since `0011`:

```sql
if p_host_secret is not null and active_session.host_secret_hash = public.token_hash(p_host_secret) then
  return exists (select 1 from public.quiz_versions q
    where q.id = active_session.quiz_version_id
      and position(p_asset_id::text in q.definition::text) > 0);
end if;
```

True for **any asset ID appearing anywhere in the definition text, at any phase** — no
question scoping, no reveal gate. Correct for a real host (Presentation legitimately needs
arbitrary media). Catastrophic for a C1-minted room.

Verified the redemption path: [cloudflare-worker.js:181-196](cloudflare-worker.js:181) —
`/media/<uuid>` requires only `x-quiz-room` plus one of `x-quiz-host-secret` /
`x-quiz-player-token`, calls `can_access_live_media` with the service key, then streams the
private object. Every audio clip, reveal image, option image, and `0032` video is reachable.

`0029` narrowed the *player* branch (removing `questionImageAssetId` and
`revealImageAssetId`, leaving only `options[].imageAssetId`) and is the only migration in
the set that closes rather than opens. The host branch makes that narrowing moot for anyone
who can mint a host secret.

**Closing C1 closes C2 as a side effect.** Independently worth doing: scope the host branch
to the *active question plus already-revealed* assets, and write the role × object × phase
matrix down in one place — four migrations (`0011`, `0018`, `0020`, `0029`) each edited one
cell of it in isolation and the host row was never revisited.

#### C3 — Every player's answer is broadcast in cleartext on a public Realtime channel {#c3}

**Sources:** MIG F3 (high). **Missed by APP despite being in `app.js`** — see
[X1](#x1--no-priority-1-findings-app-vs-two-criticals-and-a-high-mig--mig-is-right).
**Promoted to S0** from MIG's "high": this is a path where players receive other players'
answers *while the question is still open*, which the brief puts at the top regardless of
source rating. **Status: VERIFIED (static).** **Mig?: MAYBE** (YES if the fix is a private
channel + `realtime.messages` policy; NO if the fix is to stop broadcasting `answer`).
**Files: `app.js`** — serializes against every other `app.js` batch.

Verified:

- [app.js:810](app.js:810) — `supabase.channel(\`quiz-room:${roomCode}\`, { config: {
  broadcast: { self: false } } })`. **No `private: true`.** A public Supabase Broadcast
  channel needs no `realtime.messages` policy, which is why no migration has one.
- [app.js:694](app.js:694) — `sendSubmission()` posts
  `{ playerId, playerName, playerLogoKey, questionId, answer }` on every submission.

The DB side is airtight (`submissions` is RLS-enabled with zero policies), and the `state`
payload on this channel is the correctly-allowlisted `publicRoomState()`. The `submission`
event is the hole, and it bypasses the entire migration layer.

Two exposure levels: any *joined* player already receives every other player's answer live
in devtools; and — **unproven, and the reason this is VERIFIED (static) rather than
VERIFIED** — any party holding the publishable key from `config.js` may be able to subscribe
to `quiz-room:<CODE>` **without joining at all**. MIG's settling check is right and cheap:
subscribe with the publishable key from a browser that has never joined the room.

Note the interaction with [C7](#c7): `realtimeClosestNumberGuesses` is built from exactly
these broadcasts. If C3 is fixed by removing `answer` from the payload, C7's fallback path
dies with it — which is the desired outcome, but the two must be sequenced.

---

### S1 — Correctness: server-authoritative scoring and what the audience is told

#### C4 — Re-opening a scored question double-awards every correct player {#c4}

**Sources:** SPEC §0.1 (priority 4/5); MIG F5 (high). APP F11 covers the concurrent case
only — see [X2](#x2--does-re-locking-a-question-double-score-app-says-the-db-is-safe-spec-and-mig-say-points-double--all-three-are-right-about-different-paths).
**Promoted to S1** (SPEC rated 4/5): this is server-authoritative scoring producing wrong
totals live. **Status: VERIFIED.** **Mig?: YES.** **Files: migration (durable half) +
`app.js` (the control that triggers it).**

Verified: `lock_and_score_live_question`
([0030](supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql)) guards only on
`phase <> 'question_open'` (line 14), inserts a fresh `score_events` row per correct
submission (line 63), **never deletes prior events**, and no unique index exists on
`(session_id, player_id, question_id)` — the only index is the non-unique
`score_events_session_player_idx` at [0001_initial.sql:91](supabase/migrations/0001_initial.sql:91).

Two client paths reach it:

- **`questionJumpControls()` ([app.js:1027](app.js:1027))** — verified gated only on
  `view !== "host" || !hostQuizDefinition?.rounds?.length`. It ships in every hosted room,
  labelled "Testing shortcut". `jumpToQuestion()` ([app.js:400](app.js:400)) resets the
  question to `lobby`; the host then presses Start question → Reveal, and scores again.
- The documented reopen override (`set_live_room_state(… 'question_open' …)`).

The correct-by-contrast case is already in the file: `showPreviousScreen()` carries an
explicit comment that scoring is irreversible and refuses to reopen a scored question. The
invariant was known and enforced in exactly one of the two places that can violate it.

Also in scope here (MIG F5, second half): **`reveal_live_door_rewards` re-rolls
`resolved_multiplier`** for every choice in the round whenever it is entered at
`phase = 'door_choice'`. A refresh is safe (the phase is already `door_reveal`); a host who
sets the phase back re-randomizes everyone's reward, contradicting PRODUCT_SPEC's
*"randomized outcomes are persisted … so refreshes cannot reroll rewards."* Same migration
should add a `revealed_at`-style guard.

And: **`submit_live_answer` never consults `submissions.is_locked`** — it gates on phase
alone — so a reopened question accepts edits to already-locked rows.

**Fix boundary is the server.** A partial unique index on
`(session_id, player_id, question_id) where created_by = 'system'`, or an explicit delete of
prior system events inside the RPC before the scoring loop. The `app.js` half (gate or
remove the jump control) is a *reminder*, not a constraint, and should not be the only fix.

#### C5 — `numeric_estimate` renders, accepts answers, and silently scores zero for everyone {#c5}

**Sources:** SPEC §0.3 (priority 5); APP F18 item 5 (rated P7 as "dead code"). **Promoted
to S1** — APP filed it under cleanliness; it is a scoring-correctness defect on a live
player surface. **Status: VERIFIED.** **Mig?: MAYBE** (YES if you add a scoring branch; NO
if you reject the type in validation and delete the UI). **Files: `app.js`, both validators,
`music-trivia.question-bank.json`, possibly a migration.**

Verified:

- `grep -rn numeric_estimate supabase/migrations/` → **zero hits.** No branch in any version
  of `lock_and_score_live_question`. Awards 0 to everyone, silently.
- Player UI exists and works: [app.js:1257](app.js:1257), [1262](app.js:1262),
  [1390](app.js:1390), [2056](app.js:2056) (`manualSubmit` includes it).
- **Not** in `author.js`'s `supportedTypes` ([author.js:138](author.js:138), 11 types,
  `numeric_estimate` absent) — so the editor rejects it.
- **Is** in `quiz-validation.js`'s reach, which has no type allowlist at all — so the
  *tested* validator accepts it. (This is [C20](#c20) biting.)
- Still live in the bundled fixture:
  [music-trivia.question-bank.json:226](music-trivia.question-bank.json:226) —
  `"type":"numeric_estimate" … "answer":1982`, using an `answer` key **no code path reads**
  (the shipped numeric type is `closest_number`, keyed on `targetNumber`). It survives only
  because `optionalTieBreak` sits outside `rounds`, where neither validator walks.

**Decision needed from Matthew before this can be batched:** finish the type (scoring
branch + author support + validation, i.e. a migration) or retire it (delete the UI, reject
the type, fix the fixture, no migration). SPEC's candidate mistakes.md #17 argues for the
general rule — a question type is one atomic unit across validation, scoring RPC, player
render, and presentation render; land all four or none — plus *make the scoring RPC fail
loudly on an unrecognized type rather than falling through to zero*, which is worth doing
regardless of which way this goes.

#### C6 — `arrange_in_order` reveal announces the wrong correct order on Presentation and on player phones {#c6}

**Sources:** APP F1 (priority 2). Not covered by the other three. **Promoted to S1** — the
shared screen and the scoreboard disagree about a correct answer. **Status: VERIFIED.**
**Mig?: NO.** **Files: `app.js`, `quiz-core.js`** — serializes against every other `app.js`
batch.

Verified, three parts:

1. **No `revealedCorrectOrder` exists anywhere.** `publicRoomState()`
   ([app.js:167-173](app.js:167)) publishes `revealedCorrectOptionId(s)`,
   `revealedCorrectCategories`, `revealedCorrectPairs`, `revealedMultiBlankAnswers`,
   `revealedTextAnswers`, `revealedNumber` — and nothing for order.
2. **`toPlayerQuestion()` ([quiz-core.js:4](quiz-core.js:4)) copies `items` but not
   `correctOrder`.**
3. **`orderBoard()` ([app.js:1073](app.js:1073)) reads `question.correctOrder` anyway:**
   `showingCorrectOrder = !presenter || state.phase === "reveal"`.

Consequences, both verified by reading `orderedItems` ([app.js:1069](app.js:1069)), whose
missing-position fallback is `999` and whose sort is stable:

- **Presentation at reveal**: `answerControl({presenter:true})` passes `state.question` (the
  player-safe projection, [app.js:1255](app.js:1255)), so `correctOrder` is `undefined`,
  every position resolves to `999`, and the board renders the **authored `items` order**
  numbered 1…N under the heading "Correct order".
- **Player phone**: `presenter` is false so `showingCorrectOrder` is true in every phase
  after open, and `items` come from `selectedObject()` — the player sees **their own
  submitted order** labelled "Correct order".

Meanwhile migration `0003`/`0017`'s `arrange_in_order` branch has already scored against the
real key. Never caught because neither fixture contains an `arrange_in_order` question, and
`presentation-layout.test.js` asserts on source text, not rendered output.

Fix boundary: add `revealedCorrectOrder` to `publicRoomState()` and have `orderBoard` read
it, mirroring `matchingBoard`→`state.revealedCorrectPairs` and
`categorizeBoard`→`state.revealedCorrectCategories`. APP's structural suggestion is good and
I'd keep it: extract one `revealKeyFor(question, phase, surface)` selector into
`quiz-core.js` so a new question type cannot ship with one surface silently missing.

#### C7 — Presentation computes the `closest_number` winner in the browser, and falls back to a partial guess list {#c7}

**Sources:** APP F6 (priority 2/5); APP F19 item 3. Composes with [C8](#c8) — see
[X6](#x6--mig-f6-predicts-the-closest-number-wall-is-already-broken-app-f6-treats-its-failure-as-an-edge-case--unresolved-one-live-check-settles-it).
**Status: VERIFIED.** **Mig?: NO.** **Files: `app.js`, `cloudflare-worker.js`,
`quiz-core.js`.**

Verified — [app.js:1209](app.js:1209):

```js
function closestNumberResultEntries(questionId = state.questionId || state.question?.id) {
  if (closestNumberGuessesQuestionId === questionId) return closestNumberGuesses;
  return realtimeClosestNumberGuessesQuestionId === questionId ? [...realtimeClosestNumberGuesses.values()] : [];
}
```

When the authoritative Worker fetch fails, `closestNumberGuessesQuestionId` never advances
and the board silently uses `realtimeClosestNumberGuesses` — a map built only from
`submission` broadcasts this tab happened to receive while open on this question. The ★
"Closest!" badge, the tie set, and the ranking are then re-derived in
`closestNumberResultsBoard()` ([app.js:1214](app.js:1214)) from that subset, while
[0017_closest_number_scoring.sql](supabase/migrations/0017_closest_number_scoring.sql)
computed `winning_distance`, `winner_count`, and split `shared_points` from the full set.
The Worker endpoint returns raw `{playerName, logoKey, guess}` rows and **no winner flag**
([cloudflare-worker.js:148](cloudflare-worker.js:148)).

Directly violates CLAUDE.md's *"Presentation is a projection of authoritative state — never
let it compute a result the server owns."*

Fix boundary: `/host-closest-number-guesses` returns the server's `winningDistance` /
`isWinner` / `points` per row; Presentation renders them. Minimum acceptable: **never fall
back to the realtime subset for a ranked board** — show the explicit "could not load" state
instead.

#### C8 — `0028` shipped an incomplete grant set; the closest-number reveal wall may be broken in production today {#c8}

**Sources:** MIG F6 (medium). **Promoted to S1** because of its interaction with C7 — if
this is live, C7's degraded path is the *normal* path at every show. **Status: VERIFIED
(static) — consequence UNRESOLVED, see [X6](#x6--mig-f6-predicts-the-closest-number-wall-is-already-broken-app-f6-treats-its-failure-as-an-edge-case--unresolved-one-live-check-settles-it).**
**Mig?: YES (one line).** **Files: `supabase/migrations/`.**

Verified: [cloudflare-worker.js:148](cloudflare-worker.js:148) embeds
`player:session_players(display_name,logo_key)`; the only four `grant select` lines in the
whole migration set cover `media_assets` (0019, 0023) and `sessions` + `submissions` (0028).
`session_players` is granted nothing, ever. `service_role`'s `BYPASSRLS` bypasses policies,
not grants.

`/host-text-answers` is unaffected (it selects only `answer,submitted_at`,
[cloudflare-worker.js:116](cloudflare-worker.js:116)) and has a Realtime fallback — which is
why this would not have surfaced alongside it.

Run the `pg_class` check in X6 first. If the grant is missing, this is a one-line migration
and should ship in the same numbered batch as C4's guard.

MIG's structural point is the durable one: `0019`, `0023`, and `0028` are each a grant
discovered by a production runtime failure, and `0028` — written in direct response to
mistakes.md #9 — still shipped an incomplete grant list for the very route it was enabling.
The prescribed machine-checkable manifest does not exist. See [C34](#c34) for the cheap
static test that would have caught it.

#### C9 — Ties share rank on two surfaces out of five {#c9}

**Sources:** SPEC §3 (`PRODUCT_SPEC` line 287, "code wrong", priority 5); APP F19 item 5.
The two reports identify **overlapping but not identical** sets — merged here.
**Status: VERIFIED.** **Mig?: NO.** **Files: `app.js`, `quiz-core.js`.**

Verified by reading each ranking site:

| Surface | Location | Tie-aware? |
|---|---|---|
| Standings CSV | [app.js:1652](app.js:1652) — `if (priorPoints === null \|\| … ) rank = index + 1` | **yes** |
| Presentation scoreboard | [app.js:1774](app.js:1774) — same pattern | **yes** |
| Closest-number board | [app.js:1229](app.js:1229) — `if (entry.distance !== previousDistance) rank = index + 1` | yes (by distance) |
| Host leaderboard panel | [app.js:1624](app.js:1624) — `players.map((p, i) => … ${i + 1}` | **no** |
| Player mini-leaderboard | [app.js:1980](app.js:1980) — `ranked.map((leader, index) => … ${index + 1}` | **no** |
| Presentation final-scores pages | [app.js:1868](app.js:1868) — `const rank = firstRank + index` | **no** (APP-only catch) |

SPEC names the host panel, the player mini-leaderboard, and the player's own finish
position; APP names `finalScoreTitlePage`. Both are right; together it is **four**
non-conforming surfaces, and the exported standings can show a different rank than the
on-screen final standings for the same tied players.

Fix: one `rankPlayers()` in `quiz-core.js`, used by all six sites.

#### C10 — `publish_quiz_version` validates ~3 things where the browser validates ~40, and the gap breaks a live game {#c10}

**Sources:** MIG F8 (medium). Related to [C20](#c20) and to
[X3](#x3--is-the-missing-categorizearrange_in_orderfill_in_the_blank-validation-an-authoring-safety-hole-test-says-yes-app-and-spec-say-the-editor-catches-it--app-and-spec-are-right).
**Promoted to S1** — the failure lands mid-show and blocks scoring entirely.
**Status: VERIFIED (static).** **Mig?: YES.** **Files: `supabase/migrations/`.**

`publish_quiz_version` ([0008](supabase/migrations/0008_author_publishing.sql)) checks
non-empty `id`, non-empty `title`, `rounds` is an array. Two concrete live-show failures MIG
identifies:

- **Unbounded `points`.** Both validators require only `Number.isFinite(points) && points >
  0`. `lock_and_score_live_question` declares `awarded_points numeric(7,2)` (max 99999.99).
  A question authored with `points: 100000` — one stray zero the client validator accepts —
  raises `numeric field overflow`, **rolls back the whole lock, and leaves the host unable
  to lock the question.** Nobody is scored.
- **Door multipliers.** `session_door_choices.resolved_multiplier` is
  `numeric(6,2) check (> 0 and <= 10)`. The identical range is enforced only in the browser;
  a definition that bypasses it makes `reveal_live_door_rewards` throw a check violation at
  the moment the host reveals rewards.

Author-gated, so this is robustness rather than security — but it is the one class of bug
that fails *during* a show with no recovery.

---

### S2 — Recovery, atomicity, and states the user is shown

#### C11 — A failed submission renders in the confirmed/locked visual state, and the next redraw replaces it with "saved" {#c11}

**Sources:** APP F2 (priority 2, recurrence of mistakes.md #4/#5); TEST invariant 5 rates
this area **Covered** on the strength of `answer-submission-recovery.test.js` — which is
true for the *recovery logic* and false for the *rendered state*, so TEST's "Covered" is
scoped narrower than it reads. **Status: UNVERIFIED (P2-tier, carried from APP).**
**Mig?: NO.** **Files: `app.js`, `styles.css`, `quiz-core.js`.**

Four required-distinct states collapse into two CSS treatments, and failure borrows the
*success* treatment: `class="submitted locked"` (bold red) is used both for a rejected
answer and for the normal locked-and-safe state. The failure message is written straight to
the DOM by `setSubmissionStatus()` and is **erased by the next `render()`**, because
`renderPlayer` recomputes `phaseMessage` from
`sessionStorage["quiz-submitted:<room>:<questionId>"]`, which is set on the first success
for that question and never cleared.

APP's reproduction (multi-blank finale, one dropped debounce window, then any unrelated
`players`/`scoreNotification` change) ends with the phone reading "Answers saved" while nine
of ten titles were never saved. Directly breaks *"Client success is never implied before
server confirmation."*

Fix: four class names for four states; hold the outcome in module state so `renderPlayer`
reconstructs it; make the `sessionStorage` flag record *which answer* was confirmed. Mapping
belongs in `quiz-core.js`.

#### C12 — Manual Submit bypasses the 2026-08-17 stale-revision recovery {#c12}

**Sources:** APP F5 (priority 2). **Status: VERIFIED.** **Mig?: NO.**
**Files: `app.js`, `room-api.js`.**

Verified — the auto-submit path calls `submitLiveAnswerWithRecovery`
([app.js:2153](app.js:2153)), but the `[data-submit]` handler
([app.js:2341-2358](app.js:2341)) calls `roomApi.submitAnswer` directly and on any rejection
does `recordDiagnostic("submit-answer", …)` plus a blocking
`alert("Your answer was not submitted…")`.

Manual submit is the path for `short_answer`, `fill_in_the_blank`, `numeric_estimate`, and
`closest_number` ([app.js:2056](app.js:2056)). So a benign, host-initiated revision bump —
the host pressing Space to cue a clip while a player is typing — produces a modal on the
player's phone and a Sentry issue, where the identical situation on a `single_choice`
question recovers silently.

Also verified in the same handler: `state.submitted[playerId] = selected` keys by the local
auth token rather than `doorPlayerRecordId`, unlike `sendSubmission`
([app.js:694](app.js:694)). Local-only, so nothing miscounts — but it is the same identity
confusion the 2026-08-17 roster fix removed elsewhere.

Fix: one submit path, through `room-api.js`.

#### C13 — Host refresh loses `state.submitted`: the counter reads 0 and "Who got it right" disappears {#c13}

**Sources:** APP F10 (priority 4); TEST ranked gap 4 (no behavioral test for host refresh
recovery). **Status: VERIFIED (static).** **Mig?: MAYBE** (YES if the fix is a
`get_host_submissions` RPC; NO if it is a Worker route). **Files: `app.js`, `room-api.js`,
`cloudflare-worker.js`, possibly a migration.**

Verified — `publicRoomState()` sends `submitted: {}` ([app.js:136](app.js:136), and again at
189, 216, 309, 347, 366). That is correct privacy behavior. Nothing re-fetches it on
reconnect: `getHostRoomState` returns the public state.

So after a host reload mid-question, "8 / 12 answers received" becomes "0 / 12" while all
eight answers sit safely in the database, and `answerResultsPanel()`
([app.js:1627](app.js:1627)) computes `tallyQuestionResults(hostQuestion, {})`, gets
`totalSubmitted === 0`, and returns `""` — the "Who got it right" summary shipped on
2026-08-17 silently does not render.

PRODUCT_SPEC §3 promises *"Sessions recover after a host refresh."* TEST independently notes
that `grep refresh test/*.test.js` finds nothing covering this.

Fix boundary: the Worker already proves the pattern — `/host-text-answers` re-reads
`submissions` with the service credential after verifying the host secret. A
`/host-submissions` route (or `get_host_submissions` RPC) returning `{playerId, answer}` for
the active question restores both readouts.

#### C14 — Presentation replays a long-finished cue after arming or refresh; commands carry no sequence {#c14}

**Sources:** APP F4 (priority 2, recurrence of mistakes.md #3); TEST ranked gap 7 (no
behavioral test for cross-tab audio sequencing); TEST lesson #14 row. **Status: UNVERIFIED
(P2-tier, carried from APP).** **Mig?: NO.** **Files: `app.js`, `quiz-core.js`.**

The command carries `{id, volume, action, audioScope, audioKey, questionId, clipId}` —
missing room, quiz-version, media ID, and **any ordering or freshness marker**. The only
staleness defence is `command.id === handledPresentationAudioCommand`, module state that
resets to `null` on page load *and is explicitly reset to `null` again by both arming
functions*. The command is part of `publicRoomState()` and is persisted by
`set_live_room_state`, so a reconnecting Presentation receives the last command ever issued
with no way to tell whether it is two seconds or twenty minutes old.

APP's sequence: host cues clip 7 → playback ends → host reveals (nothing clears the command)
→ Presentation tab reloads → host clicks the required "Enable media" → `armPresentationAudio`
clears the handled marker → `attachEvents` re-applies the stored `play` → **clip 7 plays over
the answer reveal.** The video path is identical.

Second, quieter instance: `preparePresentationAudio()` returns early when it cannot resolve
a source, but `applyPresentationAudioCommand` still calls `startPresentationPlayback()` — so
an unavailable clip plays the *previously loaded* clip instead. That is the original
stale-clip bug class, one level deeper.

Fix: add `issuedAt` (or a sequence derived from `state.revision`) plus `roomCode`,
`quizVersionId`, and the resolved `mediaAssetId`; reject commands not newer than the last
applied; drop `play` commands older than a small freshness window on a fresh mount.
Construction and the accept/reject predicate belong in `quiz-core.js` so cue A → cue B →
restart → reconnect → duplicate can be tested without a browser.

#### C15 — Presentation fully remounts on four transport-only fields {#c15}

**Sources:** APP F3 (priority 2, recurrence of mistakes.md #14); TEST lesson #14 row (notes
the existing regex guard cannot see *which* fields are in the key). **Status: VERIFIED.**
**Mig?: NO.** **Files: `app.js`, `quiz-core.js`.**

Verified — [app.js:656](app.js:656):

```js
const { activeClipId, audioCommand, revision, submitted, ...withAudioVolume } = roomState || {};
const { audioVolume, ...withMediaCommand } = withAudioVolume;
const { mediaCommand, ...visualState } = withMediaCommand;
return JSON.stringify(visualState);
```

Six fields classified and excluded. Four were not: **`players`** (visual on title/round_end/
finale screens, transport-only on question/locked/reveal), **`scoreNotification`** (a fixed
overlay appended after the card, never part of the scene), **`doorPicks`** (visual only
during door phases), **`screenHistory`** (pure host navigation, never rendered by
Presentation at all).

A remount is expensive here: `render()` revokes every entry in `imageMediaObjectUrls` and
`attachEvents()` re-issues a `/media/<uuid>` Worker fetch for **every**
`[data-private-image]` on screen, and all `presentation-card--*` entrance animations
restart. So a late player joining blanks and re-downloads the question image mid-question;
a manual score adjustment remounts the reveal **twice** (once on the adjustment, once
6,600 ms later when the notification expires).

Fix: destructure `scoreNotification`, `screenHistory`, `doorPicks` out and update in place.
`players` needs a scene-scoped key (include it only when `presentationScreen` is
`title`/`round_end`/`final_podium`/`final_scores`). Lift `presenterRenderKey` into
`quiz-core.js` so it can be unit-tested per scene instead of by regex.

#### C16 — Timer auto-lock racing Reveal produces a modal alert, aborts the reveal, and leaves a latch that never resets {#c16}

**Sources:** APP F11 (priority 4). See
[X2](#x2--does-re-locking-a-question-double-score-app-says-the-db-is-safe-spec-and-mig-say-points-double--all-three-are-right-about-different-paths)
— the DB is genuinely safe here; the client handles the safe rejection badly.
**Status: UNVERIFIED (P4-tier, carried from APP).** **Mig?: NO.**
**Files: `app.js` ([updateTimer](app.js:972), [lockQuestion](app.js:878),
[revealQuestion](app.js:901)), `room-api.js`.**

`updateTimer` sets `timerExpiryLocking = true` before an un-awaited `lockQuestion()`. If the
host presses **R** inside the RPC round-trip, the second call blocks on the row lock, then
raises "The active question is not open" → a modal `alert()` on the shared laptop mid-show,
and because `state.phase` is never set to `"locked"` by the failing call, `revealQuestion`'s
`if (state.phase !== "locked") return;` **aborts the reveal**.

Worse without a second keypress: if the auto-lock RPC fails transiently, `alert()`, phase
stays `open`, and `timerExpiryLocking` stays `true` forever — `updateTimer` runs every
250 ms and never retries, because the latch is only cleared by `startTimer()`. The
auto-lock is dead and the host is not told.

Fix: single in-flight promise guard (the file already has this pattern in
`submissionSequence`); clear the latch in `catch`; classify "The active question is not
open" as a benign already-locked outcome — resync from `getHostRoomState` and continue to
reveal. Classification belongs next to `classifySubmitAnswerError` in `room-api.js`.

#### C17 — `matchingBoard` prints a literal `${…}` template string on the shared screen {#c17}

**Sources:** APP F7 (priority 2). **Status: VERIFIED.** **Mig?: NO.**
**Files: `app.js` (one line).**

Verified — [app.js:1089](app.js:1089), inside `matchingBoard`:

```js
: '<span class="drag-empty">${showingMatches ? "All items placed" : "Listen for each clip"}</span>'
```

Single-quoted, so the `${…}` is never interpolated. The `presenter` branch is
`unassigned.length && !presenter`, which is **always falsy on Presentation**, so the else
branch always renders — the audience sees the raw source text in the clip pool for the whole
question, including the reveal. The host/player board hits it too whenever every clip is
assigned.

Not caught by `presentation-layout.test.js` because the regexes match the literal happily.
One-character fix; listed at S2 rather than S1 only because it misleads rather than
mis-scores. It is the single cheapest visible win in this document.

#### C18 — `quiz.sample.json` fails validation, and its empty rounds dead-end the host state machine {#c18}

**Sources:** APP F8 (priority 3); TEST ranked gap 3; TEST invariant 10. See
[X4](#x4--tests-proposed-fixture-assertion-cannot-pass-today).
**Status: VERIFIED (I ran it).** **Mig?: NO.**
**Files: `quiz.sample.json`, both validators, `app.js`, `test/`.**

Verified output reproduced in X4: three of five rounds have `"questions": []`.

The second half is worse than a stale fixture — an empty round is an **unrecoverable host
state**. `advanceQuestion` → `startRoundEnd(n)` does not check whether the next round has
questions; the host presses **N**, `startRound` ([app.js:372](app.js:372)) calls
`setHostQuestion(n, 0)` which returns `false`, and `startRound` returns. **No state change,
no error, no console output.** The button and arrow key appear dead. The only escape is the
"Testing shortcut" jump control — which cannot reach the empty round either.

Fix: reject empty rounds in validation (in the *merged* validator, [C20](#c20)); make
`startRound` skip to the next non-empty round or surface an explicit host error; add the
fixture test [C32](#c32) so it cannot regress. The "find the next playable question/round"
walk is pure and belongs in `quiz-core.js` — `advanceQuestion`, `startRound`,
`jumpToQuestion`, and `showPreviousScreen` each reimplement pieces of it today.

#### C19 — Two divergent `validateQuiz` implementations; the shipped one is not the tested one {#c19}

**Sources:** APP F9 (priority 3); SPEC §0.2 (priority 3/6); TEST ranked gap 13 (with a wrong
conclusion — see
[X3](#x3--is-the-missing-categorizearrange_in_orderfill_in_the_blank-validation-an-authoring-safety-hole-test-says-yes-app-and-spec-say-the-editor-catches-it--app-and-spec-are-right)).
Three of four reports found this independently — the most-duplicated finding in the set.
**Status: VERIFIED.** **Mig?: NO.** **Files: `author.js`, `quiz-validation.js`, `test/`.**

Verified: `author.js` imports `diagnostics.js`, `image-crop.js`, `subtitle-core.js`,
`video-utils.js` — **not** `quiz-validation.js`. Its own `validateQuiz` lives at
[author.js:136](author.js:136) with `supportedTypes` at line 138, and it is what runs on
Publish, Validate, Apply raw JSON, Import, and the Quiz health panel.
`quiz-validation.js` is imported by exactly three test files and is shipped to the browser
by `prepare-deploy.mjs` ([line 14](prepare-deploy.mjs:14)) — where nothing loads it.

Merged drift table (APP and SPEC agree on every row; SPEC found the sharpest one):

| Rule | `author.js:136` (runs) | `quiz-validation.js` (tested) |
|---|---|---|
| Question-type allowlist | yes, 11 types | **absent** — any `type` string passes |
| `fill_in_the_blank` blanks | validated | **absent** |
| `arrange_in_order` key | validated (unique + referential) | **absent** |
| `categorize` key | validated, exactly 2 categories | **absent** |
| `matching` key referential integrity | clip→option IDs resolved | pair-map presence only |
| `question.audio.mediaAssetId` UUID | validated | **absent** |
| `finale.audio` asset IDs | validated | **not validated** |
| `betweenRoundBonus.audio` asset IDs | **not validated** | validated |
| Empty round rejected | no | no |

The last two rows are SPEC's sharpest point: **the two validators check different parts of
the quiz document.** Door/between-round audio IDs are validated only in the module nothing
calls; finale audio IDs only in the module no test covers.

This contradicts CLAUDE.md twice over — *"Prefer putting new logic here … testability is the
point"* and *"validate against them via `quiz-validation.js` before shipping a schema
change."* Today, a green `npm test` proves nothing about what the editor accepts.
`docs/TITLE_SCREEN_SRT_LYRICS.md:116` and `docs/VIDEO_CLIPS_TECH_PLAN.md:51` already
instruct contributors to "update both validation surfaces" — the project normalising the
drift rather than removing it.

Fix: delete `author.js`'s copy, import `quiz-validation.js`, promote the stricter
author-side rules into the shared module, and add a test asserting the import exists.

#### C20 — Author draft is discarded when the bundled-bank fetch fails, and the editor then throws {#c20}

**Sources:** APP F12 (priority 4, recurrence of mistakes.md #6). **Status: VERIFIED.**
**Mig?: NO.** **Files: `author.js`.**

Verified — the init block fetches `BANK_URL` as its **first** statement, and
`restoredDraft()` is sequenced behind it:

```js
const bundledBank = await fetch(BANK_URL, { cache: "no-store" })…;   // first
originalBank = clone(bundledBank);
lastPublishedBank = restorePublishedSnapshot();
const draft = restoredDraft();                                        // never reached on failure
…
} catch (error) { $("#nav-title").textContent = "Question bank is not connected"; … }   // bank stays undefined
```

`restoredDraft()` exists specifically to preserve temporarily-invalid in-progress work
across refresh (`reliability-contract.test.js:16` asserts it does not call `validateQuiz`) —
but an hour of unpublished edits is discarded because a *static file the draft does not
depend on* failed to load once. `render()` never runs; `initialiseAuth()` still does, and
`loadMediaAssets()` → `renderMediaLibrary()` → `JSON.stringify(bank).includes(asset.id)`
throws `TypeError: Cannot read properties of undefined` as an unhandled rejection.

APP flags a secondary risk it did **not** prove: any control reaching `markChanged()` before
dereferencing `bank` would persist `{bank: undefined, …}`, losing the draft permanently. APP
found no such control. Carry it forward as unproven; don't act on it as fact.

Fix: restore the draft **before** fetching the bundled bank; treat the fetch as an optional
source for `originalBank` and the no-draft fallback.

#### C21 — Importing JSON never persists the draft {#c21}

**Sources:** APP F13 (priority 4). **Status: VERIFIED.** **Mig?: NO.**
**Files: `author.js`.**

Verified — [author.js:1584](author.js:1584) (`#apply-raw`) calls `markChanged()`;
[author.js:1585](author.js:1585) (`#import-file`) does not, and also skips
`syncPublishControl()`. An author imports a quiz, reads it without touching a field, reloads,
and gets the *previous* draft back. The status copy ("download to keep edits") only warned
about edits.

Fix: call `markChanged()` and `syncPublishControl()` in the import handler. Both handlers
are the same parse → validate → adopt flow written twice; extracting
`adoptQuiz(candidate, sourceLabel)` removes the drift.

#### C22 — Between-round "Remove audio" does nothing but reports "Saved in this browser" {#c22}

**Sources:** APP F14 (priority 4, authoring-side shape of mistakes.md #4).
**Status: VERIFIED.** **Mig?: NO.** **Files: `author.js`.**

Verified — [author.js:299](author.js:299) renders the shared preview with a `between:<key>`
target, emitting `data-remove-audio="between:roundEnd"`. The handler at
[author.js:521-532](author.js:521) recognises only `"question"`, `"finale:"`, and `"clip:"`
— and calls `markChanged()` **unconditionally**, outside every branch. So the clip is not
removed, the save state flips to "Saved in this browser — download or publish when ready",
the draft is re-persisted, and the clip still plays in the room.

Fix: handle the `between:` prefix, and only call `markChanged()` when a branch matched — an
unmatched target should be a no-op or an error, never a "saved" confirmation.

#### C23 — Author image previews collapse "not signed in", "session expired", and "still loading" into one blank state {#c23}

**Sources:** APP F15 (priority 4, recurrence of mistakes.md #2/#6); TEST invariant 7 and
ranked gap 11 (media state machine untested per role/transition).
**Status: UNVERIFIED (P4-tier, carried from APP).** **Mig?: NO.**
**Files: `author.js`, possibly a new module beside `video-utils.js`.**

`attachedImagePreview` ([author.js:68](author.js:68)) has a loading-vs-missing distinction,
but it applies only to **non-UUID legacy placeholders**. For a valid UUID it always emits
`<img data-media-preview>` and hands off to `loadMediaPreview`
([author.js:1276](author.js:1276)), whose image branch has no status element — `status` is
only found inside `.audio-preview` — so "not signed in" and "session expired" are both a
**silent return**. Resulting map: loading, not-signed-in, and session-expired all render as
a blank `<img>` captioned "Attached private image".

APP's inverse case is as bad: signed out, `loadMediaAssets()` short-circuits and leaves
`mediaAssetsLoaded = false`, so a legacy placeholder shows **"Loading private image…"
permanently** — "will never load because you are signed out" displayed as "loading".

Also: on its final error path `loadMediaAssets` sets `mediaAssetsLoaded = true` and calls
`renderEditor()` only — not `renderMediaLibrary()` or `renderPreview()` — so the library
panel keeps stale content beside a status line saying the load failed.

Directly breaks *"Loading, failure, absence, and invalidity are distinct states in the
authoring UI."* Fix: give the private-media resource explicit `idle`/`loading`/`ready`/
`error`/`missing`/`unauthenticated` states and render all of them for images as well as
audio. **Note the collision risk:** this is the same area the untracked `image-engine.js`
slice is working in.

#### C24 — Presentation media failures are invisible, and a failed command is latched as handled {#c24}

**Sources:** APP F16 (priority 6). **Promoted to S2** from APP's 6 — a silent failure in the
subsystem with the longest bug history here is a live-show risk, not a test gap.
**Status: UNVERIFIED (carried from APP).** **Mig?: NO.** **Files: `app.js`.**

Every Presentation media failure is swallowed by a bare `console.warn` — no
`recordDiagnostic`, therefore no local diagnostics entry and no Sentry issue. Audio/media
cueing is the subsystem behind mistakes.md #2, #3, #7, and #14, and it is the one subsystem
that reports nothing: `downloadDiagnostics` on the presentation tab shows a clean log after
a show in which no clip ever played.

Compounding it, both apply functions set `handledPresentation*Command = command.id`
**before** the work that can throw. If `loadPrivateHostAudio` throws (Worker 404/502,
expired room secret), the command is already latched and is retried only if the host clicks
Play again — with no on-screen indication anything failed. Presentation has no
pending/failed/retryable states at all, the same gap [C11](#c11) describes on the player.

---

### S3 — Audit trail, spec truth, and the test suite

#### C25 — Score events are immutable in storage but rewritten in flight, and can now carry no reason {#c25}

**Sources:** MIG F7 (medium, recurrence of mistakes.md #11); SPEC §6 (late-join catch-up
undocumented); SPEC §3 line 286. **Status: VERIFIED (static).** **Mig?: YES.**
**Files: `supabase/migrations/`, `app.js` (CSV export).**

The append-only half holds: `score_events` is RLS with no policies, and there is no `UPDATE`
or `DELETE` anywhere in 32 migrations. Two things erode the *auditable* half:

- **`0026`'s `BEFORE INSERT` trigger rewrites the event as it is written.**
  `apply_late_join_catch_up()` overwrites `new.multiplier`, recomputes `new.points`, and
  strips the door text out of `new.reason` via
  `regexp_replace(new.reason, ' · [0-9.]+x door bonus$', '')`. The "higher multiplier wins"
  rule is deliberate and correct — but the event no longer records that a door multiplier
  was resolved and discarded. `get_host_score_events` exports `basePoints`, `multiplier`,
  `reason`, so **the CSV cannot explain why a player's 1.5× door did not apply.** The
  evidence survives only in `session_door_choices`, which no export reads.
- **`0027` made `reason` nullable** — verified,
  [0027:5-6](supabase/migrations/0027_optional_manual_adjustment_reason.sql:5) drops and
  re-adds the check as `reason is null or char_length(reason) between 1 and 160`. Combined
  with `0022`'s ±99999.99 ceiling, **a single host action can move a player by up to
  99999.99 points with no recorded reason at all**, and the CSV shows an empty cell.

Breaks *"Score-affecting events are immutable and auditable. Manual adjustments, door
bonuses, and late-join catch-up all append audit events that the CSV exports can explain."*

MIG's root cause is right: the model has room for exactly one modifier, so the losing one
has nowhere to go. The fix is a schema change (record both modifiers and which won), which
makes it a migration and puts it on the serialized list.

#### C26 — Migration replay hazards and an orphaned RPC {#c26}

**Sources:** MIG F9 (priority 4). **Status: VERIFIED (static).** **Mig?: YES** (for the
orphan drop; the idempotency half is a discipline change plus optional cleanup migrations).
**Files: `supabase/migrations/`.**

Most of MIG's replay audit is good news and should be recorded as such: no migration edits
an earlier one; every `add column` is nullable or carries a check-satisfying default; every
constraint change widens; `0025`'s `ALTER TYPE … ADD VALUE` is transaction-safe *because*
every subsequent comparison is written `phase::text in (…)` rather than as an enum literal.
That last one is **correct, deliberate, and undocumented** — one `phase = 'door_choice'`
written by a future session breaks `supabase db push` for everyone. Write it down.

Two real problems:

- **`0010` cannot be re-run.** Five `create policy` statements with no
  `drop policy if exists`, and `create table public.media_assets` with no `if not exists`.
  `0001` and `0008` share the `create table` problem. `0025`, `0026`, `0027`, `0032` are
  fully re-runnable and are the model to copy. This matters because mistakes.md #13
  documents that this project's actual recovery workflow was hand-executing migration files
  against a live schema.
- **`0024`'s `get_host_text_answers` is dead, and `0028` is why.** `0024` created it
  specifically to avoid *"a partial failure between separate session and submission REST
  reads in the Worker"*; `0028` then widened `service_role` so the Worker could keep doing
  exactly those two reads. Verified: the Worker performs them at
  [cloudflare-worker.js:108](cloudflare-worker.js:108) and
  [116](cloudflare-worker.js:116), and `grep -c get_host_text_answers` across
  `cloudflare-worker.js`, `app.js`, `author.js` returns 0. Harmless (host-secret gated) but
  it is live `anon`-reachable surface nobody owns.

#### C27 — `PRODUCT_SPEC.md` has stopped describing the product, and one line is hazardous {#c27}

**Sources:** SPEC §1–§8 in full, priority-ordered in its §8; MIG F4 (invariant wording);
APP F18 item 4 + SPEC §3 (dead enum values, see [X7](#x7--locked-phase-reachability)).
**Status: the hazardous line VERIFIED; the rest UNVERIFIED (documentation).**
**Mig?: NO.** **Files: `PRODUCT_SPEC.md`, `CLAUDE.md`.**

SPEC's own priority order is sound and I would keep it. The top three:

1. **§4 line 171 — the `R` shortcut.** Spec says `R = restart`. Verified:
   [app.js:2463-2464](app.js:2463) — `R` calls `revealDoorRewards()` in `door_choice` and
   `revealQuestion()` in `open`/`locked`. **A host following the spec during a live show
   reveals the answer while trying to restart a clip.** The in-app guide is correct; the
   spec is not. This is the one documentation line that can lose a show, and it should be
   fixed in the same batch as anything else, not queued behind the rest of the spec work.
2. **Add a "Score modifiers" subsection to §7** covering *both* multipliers — door bonus and
   late-join catch-up — with precedence (`greatest()`, not multiplication), scope, the fact
   that door multipliers may be **< 1** (a door can cost points), the 10× DB cap, the 2×
   catch-up cap, and what survives into the audit export. The late-join catch-up
   ([0026](supabase/migrations/0026_late_join_catch_up.sql)) is **not mentioned once** in the
   spec today — a second scoring modifier with its own precedence rule, invisible in the
   authoritative document. This is the gap most likely to cause a wrong change to scoring.
3. **Rewrite §11 to describe the JSONB model.** The spec's seven normalized tables
   (`rounds`, `questions`, `answer_options`, `accepted_answers`, `session_state_events`,
   `submission_items`, `leaderboard_snapshots`) **do not exist**. The quiz is one JSONB
   document in `quiz_versions.definition`. SPEC calls this *"the largest single divergence …
   and the one most likely to mislead a future session into writing a migration against
   tables that were never built"* — which, given that migrations are the serialized
   bottleneck in this plan, is a direct risk to the next round of work.

Then SPEC's items 4–11: the eleven shipped question types vs. the nine listed; the tie rule
restated as an implementation contract (feeds [C9](#c9)); build status and Phase 6; the
matching interaction (players get `<select>` dropdowns with duplicate prevention, not
tap-to-pair); short sections for the dozen shipped-but-unspecified features (player logos,
title page + waiting-room music, SRT/ASS captions, finale audio slots, the "who got it
right" summary and its explicit coupling to `0030`, host volume carry-forward, the manual
loudness override, the client-side auto-submit retry); the §3 state machine reconciliation;
and a pointer to the Prompt Battle design so an approved twelfth format is not invisible.

Plus, from MIG F4 and X5: amend CLAUDE.md's *"no asset IDs"* invariant to match the shipped
design, and note that `toPlayerQuestion` passes `items` and `categories` through **unfiltered**
— so artwork attached to a `categorize` item or `matching` target would reach players and
then be refused by `can_access_live_media`, rendering broken. The payload allowlist and the
media policy were narrowed on different days and no longer describe the same set.

#### C28 — Nothing in `test/` asserts that an unauthorized caller is refused {#c28}

**Sources:** MIG F10; TEST ranked gaps 1 and 2; APP F17. All four reports converge here.
**Status: VERIFIED.** **Mig?: NO.** **Files: `test/`.**

Verified counts on `b58adb7`: `access-control.test.js` has 10 tests and 31
`assert.match`/`doesNotMatch` calls against `cloudflare-worker.js` and migration text. The
Worker's `export default { fetch(request, env) }` — the only place the service-role key is
used and the sole enforcement point for private media — **is never invoked by any test.**

Specifically absent: nothing asserts `create_live_room` requires authorization ([C1](#c1));
nothing asserts the host branch of `can_access_live_media` is scoped ([C2](#c2)); nothing
asserts submissions stay off the Realtime channel ([C3](#c3)); nothing asserts the `0010`
`media_assets` SELECT policy still exists, which is the single row gate standing behind
`0023`'s table-wide grant; nothing asserts the `service_role` grant list matches the tables
the Worker reads ([C8](#c8)).

TEST's ranked gap 2 is right that this is straightforwardly closable without network:
import the Worker's default export, call `fetch(request, env)` with a mocked `env`/`fetch`,
and assert 401/403 for missing host secret, wrong-room token, and pre-reveal media — the
same way `answer-submission-recovery.test.js` already injects a fake client.

TEST's ranked gap 1 (no executable test of any scoring RPC) is the harder half and needs a
decision: build a local Postgres/pglite harness, or explicitly accept SQL as
review-only-verified and write that acceptance down. Related: `tallyQuestionResults` in
`quiz-core.js` is a documented hand-mirror of `0030`'s comparison rules and **nothing
asserts the two still agree** — a change to one silently diverges the host's live
"X/Y correct" from the actual score.

#### C29 — Behavioral tests missing for the paths this plan is about to change {#c29}

**Sources:** TEST ranked gaps 3–9, 11; APP F17's four cheapest additions; APP F18's note
that no test renders any board. **Status: VERIFIED (structural).** **Mig?: NO.**
**Files: `test/`.**

The ones that directly protect fixes in this plan, in the order I'd write them:

1. **Both fixtures through `validateQuiz`/`toPlayerQuestion`** (TEST 3, APP F8) — blocked by
   [C18](#c18); see [X4](#x4--tests-proposed-fixture-assertion-cannot-pass-today).
2. **`presenterRenderKey` per scene** with a fixture room state (APP F17) — proves
   [C15](#c15).
3. **Reveal-key selector per question type per surface** (APP F17) — proves [C6](#c6) and
   prevents the next type shipping with one surface missing.
4. **Command accept/reject predicate**: cue A → cue B → restart → reconnect → duplicate
   (TEST 7, APP F17) — proves [C14](#c14).
5. **Host refresh/reconnect recovery** (TEST 4) — proves [C13](#c13).
6. **Leaderboard total recomputed from a synthetic `score_events` array** (TEST 5) — the
   proof mistakes.md #11 asks for, and the guard for [C25](#c25).
7. **Duplicate-roster behavioral test** (TEST 8) — the 2026-08-17 fix is regex-guarded only.
8. **Render each `presentation-card--*` into jsdom** (TEST 9) — would have caught
   [C17](#c17) instantly.
9. **Media state machine per role per transition** (TEST 11) — guards [C23](#c23).

#### C30 — Cheap deterministic checks that are missing {#c30}

**Sources:** TEST ranked gaps 10, 14, 15, and 12; MIG F10's grant-vs-caller check.
**Status: VERIFIED (structural).** **Mig?: NO.** **Files: `test/`.**

All five are small, offline, and independent of everything else in this plan — which makes
them the ideal filler for a worktree that finishes early:

- **Secret scan**: fail if any file `prepare-deploy.mjs` ships matches `service_role`,
  `SUPABASE_SECRET_KEY`, `sb_secret_`, or a JWT shape (TEST 10).
- **Migration numbering**: leading 4-digit prefixes unique and strictly increasing, no gaps
  (TEST 14). Directly protects the sequential-number discipline this plan depends on.
- **`music quiz originals/` never shipped**, mirroring `deploy-manifest.test.js`'s existing
  `local-reference/` check (TEST 15).
- **Grants vs. callers**: parse `rest/v1/<table>` and `select=…<embed>…` out of
  `cloudflare-worker.js` and check each against the `grant select on table` lines in
  `supabase/migrations/` (MIG F10) — this would have caught [C8](#c8) statically, in the
  style of the existing `deploy-manifest.test.js`.
- **Fix `deploy-manifest.test.js`'s fourth check** to honour `generatedArtifacts`
  (TEST §Baseline) so a clean checkout is green without `npm run build:video`.
- **Re-label `scoring-contract.test.js`** and its siblings as "migration presence checks"
  rather than scoring-correctness tests (TEST 12) — a naming change, but the green suite
  currently implies more safety than exists.

---

### S4 — Cleanliness

Lowest priority by construction. Two of these are live-room hazards despite their tier, and
are called out.

#### C31 — Two debug affordances render in live hosted rooms {#c31}

**Sources:** APP F18 items 9 and 6/7; SPEC §0.1 and §6. **Status: VERIFIED.** **Mig?: NO.**
**Files: `app.js`.**

- **"Add demo player"** ([app.js:1756](app.js:1756), `data-player`) is rendered
  unconditionally in `renderHost`. In a hosted room it pushes a client-side player with a
  random UUID and `emit()`s it — inflating the "answers received" denominator, the
  Presentation waiting-room roster, and the scoreboard until the next `getLeaderboard`.
- **"Testing shortcut" question jump** ([app.js:1027](app.js:1027)) — see [C4](#c4), where
  it is the trigger for double-scoring.

SPEC's proposed rule is the right one: *any control labelled "testing" must be gated out of
live rooms, or stop being labelled testing.*

#### C32 — Dead code and unreachable branches {#c32}

**Sources:** APP F18 (11 classified items). **Status: UNVERIFIED except where noted.**
**Mig?: NO.**

Keep APP's residue-vs-reachable classification; it is the useful part. The items that are
**reachable and actively producing bad data**, and so deserve promotion out of pure
cleanliness:

- **`audio.assetId` legacy field** — `[data-add-audio]` writes the literal `"audio-clip"`
  and surfaces it as an editable "Opaque asset ID". Nothing reads it (`hasPlayableAudio`
  checks `mediaAssetId || url`), so **clicking "Add audio cue" produces an audio object that
  can never play.**
- **`numeric_estimate`** — promoted to [C5](#c5).
- **`scoreboard` between-round audio slot** — the author UI offers a "Scoreboard transition"
  upload that can never play (`cueBetweenRoundAudio` is only ever called with `roundEnd`,
  `doorChoice`, `doorReveal`, `roundStart`), paired with the retired `round_scoreboard`
  screen.

Residue (safe to remove, no user impact): `state.mediaPlayback`, the `media-ended` realtime
event, `[data-phase="locked"]`, the `presentation-card--final` legacy branch,
`hostQuestion.audioLabel`/`audioHelp`. Note that removing `[data-phase="locked"]` interacts
with [X7](#x7--locked-phase-reachability) — decide whether `locked` is a scene you want
before deleting its handler.

**One correction to APP's item 1:** `quiz-validation.js` is described as "residue in
production." That is accurate today but it is the *destination* of [C19](#c19) — do not
delete it; make it the one that runs.

#### C33 — Duplicated logic that can drift {#c33}

**Sources:** APP F19 (6 items + 5 minor). **Status: partially VERIFIED (tie ranking, see
[C9](#c9); validator fork, see [C19](#c19)).** **Mig?: NO.**

Beyond the two already promoted:

- **Question-type templates × 2** — `changeQuestionType` and `addQuestionTemplate` carry the
  same eight `Object.assign` default shapes. → one `questionTemplate(type)` in `quiz-core.js`.
- **Answer normalization × 3** — `normalizeAnswerText` (`quiz-core.js:48`, not currently exported),
  `normalizedTextAnswer` (`app.js`), and an inline
  `String(answer).replace(/[^a-z0-9]+/gi,"").toLowerCase()` in `answerControl`, all mirroring
  `regexp_replace(lower(…), '[^a-z0-9]+', '', 'g')` in `0003`/`0030`. `quiz-core.js` already
  carries the "if that migration's comparison logic changes, this must change with it"
  warning — it should be the only copy.
- **Roster identity × 2 remaining sites** — `playerScoreCards` and `renderPlayer`'s door
  branch still compare the local auth token against server roster IDs. Consequences: **the
  player's own row in the mini-leaderboard is never highlighted in a hosted room**, and after
  a refresh during `door_choice` the phone shows "Your pick" while the status line still says
  "Choose a door to lock in your chance."
- **Unescaped interpolation** — `renderHost` and `renderPlayer` interpolate
  `hostQuizDefinition.title`, `roundTitle`, and `prompt` unescaped, while `renderPresenter`,
  `renderHostDoors`, and `renderHostFinale` escape the same values. Authored content only,
  so not an exploit — but an apostrophe or `<` renders differently on three surfaces.
- **`screenHistory` payload growth** — up to 50 snapshots, each embedding full `doorPicks`
  and `doorResults`, persisted via `set_live_room_state` and rebroadcast on **every** state
  change including each audio cue. The comment describing it as "only screen identifiers and
  score-display data" understates what it carries. Interacts with [C15](#c15), which wants
  `screenHistory` out of the render key anyway.
- **Orphan cleanup asymmetry** — `uploadPrivateVideo` removes the orphaned storage object if
  registration fails; `uploadPrivateAudio` and `uploadPrivateImage` do not.

#### C34 — Unproven items to keep on the list {#c34}

**Sources:** APP §Unproven (5 items); MIG §4 (5 items). Neither reviewer could establish
reachability; both were right to file rather than assert. Reproduced so they are not lost:

From APP — **Presentation may hold a write path** (`connectHostedRoom` runs its host-restore
block for both `host` and `presenter`, and one branch calls `persistHostState()`; reachability
depends on `create_live_room`'s handling of `p_initial_state`). *Worth closing regardless —
Presentation should never be able to write authoritative state.* Also: mid-question player
refresh may truncate a multi-blank answer (depends on whether `submit_live_answer` merges or
replaces); `video.url` questions show working host controls that do nothing;
`mediaPreviewUrls` growth in a long author session; Presentation on a second device is
degraded-by-design but nothing says so.

From MIG — Supabase default privileges (settles [C8](#c8)); whether `PUBLIC EXECUTE` is
intact on the ~29 `public` functions; whether Auth signups are open (decides whether `0023`'s
`authenticated` grant is self-service); whether an unauthenticated client can subscribe to
the Realtime channel (settles half of [C3](#c3)); and the `ensure_rls` event trigger from
mistakes.md #13, which lives outside this repo and should be written down here if it exists.

---

## 3. Migration-tagged findings — the serialized list

Every entry below needs a **new, sequentially numbered** `supabase/migrations/NNNN_*.sql`.
The current head is **`0032_video_media_assets.sql`**, so the next free number is `0033`.

**These cannot be parallelized against each other.** Matthew assigns the numbers; a worker
must never pick its own. Recommended protocol for the next round: Matthew hands each
migration-bearing batch its exact number and filename up front, and no batch that has not
been handed one is allowed to create a file in `supabase/migrations/`.

| Finding | What the migration does | Data-compatibility impact | Dependency |
|---|---|---|---|
| [C1](#c1) | Require authorization in `create_live_room`; consider `revoke execute … from public` as a baseline | **Breaking for the host flow if hosts are unauthenticated today.** Design decision required first. | none — do this first |
| [C2](#c2) | Scope `can_access_live_media`'s host branch to active + revealed assets | None (narrowing); Presentation must be re-verified for every media role | after C1 |
| [C4](#c4) | Partial unique index on system score events, or delete-prior-events in the RPC; `revealed_at` guard on door reveal; consider `is_locked` in `submit_live_answer` | A unique index **will fail to create** if a production session already carries duplicate system events from a past re-lock. Check first; may need a cleanup step. | none |
| [C8](#c8) | `grant select on table public.session_players to service_role` | None | run the `pg_class` check in [X6](#x6--mig-f6-predicts-the-closest-number-wall-is-already-broken-app-f6-treats-its-failure-as-an-edge-case--unresolved-one-live-check-settles-it) first |
| [C10](#c10) | Validate `points` ≤ 99999.99 and door multipliers 0 < m ≤ 10 inside `publish_quiz_version` | **Could reject an already-published definition on re-publish.** Verify the live bank passes before shipping. | none |
| [C25](#c25) | Record both modifiers (door + late-join) and which won; decide whether `reason` returns to NOT NULL for manual adjustments | Additive columns are safe; re-tightening `reason` would reject historical NULL rows — needs a backfill or a partial constraint | none |
| [C26](#c26) | Drop the orphaned `get_host_text_answers`; optionally re-issue `0010`'s policies idempotently | None | none |
| [C3](#c3) | *Only if* the fix is a private channel: a `realtime.messages` policy | None | design decision |
| [C5](#c5) | *Only if* `numeric_estimate` is finished: a scoring branch; plus "fail loudly on unknown type" | Failing loudly on an unknown type would make a bad definition break the lock instead of scoring zero — that is the point, but confirm the live bank has no unknown types first | design decision |
| [C13](#c13) | *Only if* the fix is `get_host_submissions` rather than a Worker route | None | design decision |

**Ordering recommendation:** `C1` → `C2` (C1 closes C2 as a side effect, so C2 may shrink to
a hardening change), then `C4` + `C8` together, then `C10`, `C25`, `C26`. The three MAYBEs
wait on Matthew's decisions.

---

## 4. Proposed batch structure for the next round of parallel workers

### The two hard constraints

1. **`app.js` (165 KB) and `author.js` (145 KB) are single-writer resources.** Any two
   batches that both edit `app.js` will conflict on merge, and CLAUDE.md forbids the
   reformat-y resolution that usually follows. **Exactly one worktree may hold `app.js` at a
   time; exactly one may hold `author.js`.** They may be different worktrees — `app.js` and
   `author.js` share no code today (that is part of [C19](#c19)'s problem, and briefly an
   advantage here).
2. **Migrations are numbered by Matthew and are strictly serial.** See §3.

A useful consequence: **the reports' own recommended fix boundaries push logic *out* of
`app.js` into `quiz-core.js`** ([C6](#c6), [C9](#c9), [C14](#c14), [C15](#c15),
[C18](#c18), [C33](#c33)). If the `app.js` batches land their extractions early, later
rounds parallelize far better. That argues for doing the `quiz-core.js` extraction batch
before the long tail of `app.js` fixes, not after.

### Batches

| Batch | Findings | Files owned | Migration? | Parallel-safe with |
|---|---|---|---|---|
| **A — Authorization** | [C1](#c1), [C2](#c2), [C28](#c28) (worker/authz negative tests) | `supabase/migrations/` (0033+), `test/access-control.test.js`, possibly `cloudflare-worker.js` | **YES — first numbers** | B, C, E, F, G |
| **B — Answer channel** | [C3](#c3) | `app.js` **(exclusive)** | MAYBE | A, C, E, F, G — **not** D, H |
| **C — Scoring integrity (server)** | [C4](#c4) server half, [C8](#c8), [C10](#c10), [C25](#c25), [C26](#c26) | `supabase/migrations/` | **YES — after A's numbers** | A, B, E, F, G |
| **D — Presentation correctness** | [C6](#c6), [C15](#c15), [C17](#c17), [C9](#c9), plus the `quiz-core.js` extractions those need | `app.js` **(exclusive)**, `quiz-core.js`, `test/` | NO | A, C, E, F, G — **not** B, H |
| **E — Author editor** | [C20](#c20), [C21](#c21), [C22](#c22), [C19](#c19) | `author.js` **(exclusive)**, `quiz-validation.js`, `test/quiz-validation.test.js` | NO | A, B, C, D, G — **not** F |
| **F — Author media states** | [C23](#c23) | `author.js` **(exclusive)** | NO | **collides with E and with the untracked `image-engine.js` slice — schedule last or fold into E** |
| **G — Cheap independent tests + docs** | [C30](#c30), [C27](#c27), [C18](#c18) fixture half, [C32](#c32) fixture entry | `test/`, `PRODUCT_SPEC.md`, `CLAUDE.md`, `quiz.sample.json` | NO | everything |
| **H — Player + host recovery** | [C11](#c11), [C12](#c12), [C13](#c13), [C14](#c14), [C16](#c16), [C24](#c24), [C18](#c18) host-dead-end half | `app.js` **(exclusive)**, `room-api.js`, `quiz-core.js`, `cloudflare-worker.js` | MAYBE (C13) | A, C, E, F, G — **not** B, D |
| **I — Cleanup** | [C31](#c31), [C32](#c32), [C33](#c33) | `app.js`, `author.js` | NO | **nothing — run alone, last** |

### The `app.js` queue

B, D, H, and I all need exclusive `app.js`. They must run **in series**, in this order:

**B → D → H → I**

Rationale: B is a security fix and one of the three S0s, so it goes first and stays small.
D lands the `quiz-core.js` extractions (`revealKeyFor`, `presenterRenderKey`, `rankPlayers`)
that H then builds on. H is the largest and benefits from D's groundwork. I is cleanup and
should absorb whatever churn the previous three created.

If you would rather widen the parallelism: **B and D can be merged into one worktree**
(they touch different functions and both are small-to-medium), which shortens the chain to
three. I would not merge D and H — D is mostly render-path, H is mostly async/error-path,
and reviewing them together would be harder than reviewing them apart.

### The `author.js` queue

E → F, in series. Or fold F into E and run one batch, which I'd prefer given F is a single
finding and E is already in the file. **Either way, check with whoever owns the untracked
`image-engine.js` slice before starting** — [C23](#c23) is in the same private-media preview
area.

### What can genuinely run at once

Round 1: **A** (migrations/authz) ‖ **B** (app.js) ‖ **E** (author.js) ‖ **G** (tests/docs).
Four worktrees, no shared files, one migration number handed to A.

Round 2: **C** (migrations, needs A's numbers assigned) ‖ **D** (app.js) ‖ **F** (author.js,
if not folded) ‖ remainder of **G**.

Round 3: **H** (app.js) ‖ [C29](#c29) behavioral tests (`test/` only, and much easier once
D has landed its extractions).

Round 4: **I** alone.

### Two sequencing dependencies that will bite if ignored

- **[C18](#c18) before [C29](#c29).1.** The fixture must validate before the fixture test can
  be written green. See [X4](#x4--tests-proposed-fixture-assertion-cannot-pass-today).
- **[C3](#c3) before or with [C7](#c7).** If B removes `answer` from the broadcast payload,
  `realtimeClosestNumberGuesses` stops being populated and C7's silent fallback dies with it
  — the right outcome, but D/H must not be simultaneously *relying* on that fallback. C7 is
  currently unassigned above because it straddles `app.js` and `cloudflare-worker.js`; the
  cleanest home is **H**, after B has landed.

### Before any batch starts, three decisions only Matthew can make

1. **[C1](#c1)** — do hosts authenticate today? Closing the answer-key leak may require a
   host sign-in flow, which is a feature, not a fix. Everything in batch A waits on this.
2. **[C5](#c5)** — finish `numeric_estimate` or retire it. Determines whether it needs a
   migration and which batch owns it.
3. **[X6](#x6--mig-f6-predicts-the-closest-number-wall-is-already-broken-app-f6-treats-its-failure-as-an-edge-case--unresolved-one-live-check-settles-it)** —
   run the one-line `pg_class` check on `session_players`. Decides whether [C8](#c8) is a
   live outage or a no-op, and whether [C7](#c7) is an edge case or the default path.

---

## 5. Proposed `mistakes.md` additions — consolidated

Four reports proposed **nine** new lessons between them (MIG 1, SPEC 4, APP 4, TEST 2). Many
overlap. MIG's own argument against padding is the right instinct and I'd apply it across
all four: mistakes.md ends at 14, and adding nine would dilute it — exactly the failure #12
warns about.

**Merged into four, with the source proposals each absorbs. Not written; for Matthew's
decision.**

- **#15 — I reviewed each migration alone and never reviewed the surface they compose.**
  (MIG's proposed #15, essentially verbatim — it is the best-written of the nine and covers
  MIG F1/F2/F6/F9 plus the `PUBLIC EXECUTE` default.) Absorbs SPEC's nothing, APP's nothing.
- **#16 — I forked a validator and tested the copy that does not run.** (SPEC's candidate
  #15 ‖ APP's proposed #16 — the same lesson written twice, independently, which is itself
  evidence for it.) Absorbs TEST ranked gap 13.
- **#17 — I made an outcome irreversible in one path and shipped a control that took the
  other.** (SPEC's candidate #16, plus APP's proposed #15 on display surfaces re-deriving
  server-owned results and degrading to weaker inputs — both are "the server owns this
  answer and something else decided it anyway.") Covers [C4](#c4) and [C7](#c7).
- **#18 — I wrote regression tests against source text, and they stopped seeing the
  product.** (APP's proposed #18 ‖ TEST's second candidate, near-identical.) With TEST's
  sharpest sentence kept: *a green, fast, large-looking test suite can itself become a false
  signal if too much of it asserts "the code says X" rather than "the code does X."*

Left out deliberately, as sub-points of the above rather than entries: SPEC's #17
(half-landed question type — a sub-case of #16's "one canonical list, derive every surface"),
SPEC's #18 (spec stopped being authoritative — real, but it is a process gate, and
[C27](#c27) is the action), APP's #17 (persisted commands with no issue time — a sharp point
that belongs *inside* existing lesson #3 as an amendment, since #3 already owns
self-identifying commands and simply did not anticipate persistence + replay).

TEST also proposes a 15th on the duplicate-roster bug. I'd fold that into the #3 amendment
too: it is the same class (a distributed message misusing a stable identifier) on the
presence channel instead of the audio channel.

---

## Appendix — finding-to-source index

| ID | APP | MIG | SPEC | TEST | Verified | Mig? |
|---|---|---|---|---|---|---|
| [C1](#c1) | — | F1 | §10 contradiction | — | VERIFIED | YES |
| [C2](#c2) | — | F2 | — | — | VERIFIED | YES |
| [C3](#c3) | *missed* | F3 | — | — | VERIFIED (static) | MAYBE |
| [C4](#c4) | F11 (partial) | F5 | §0.1, §3 | — | VERIFIED | YES |
| [C5](#c5) | F18.5 | — | §0.3 | — | VERIFIED | MAYBE |
| [C6](#c6) | F1 | — | — | — | VERIFIED | NO |
| [C7](#c7) | F6, F19.3 | — | — | — | VERIFIED | NO |
| [C8](#c8) | — | F6 | — | — | VERIFIED (static) | YES |
| [C9](#c9) | F19.5 | — | §3 line 287 | — | VERIFIED | NO |
| [C10](#c10) | — | F8 | — | — | VERIFIED (static) | YES |
| [C11](#c11) | F2 | — | — | inv. 5 (scoped) | UNVERIFIED | NO |
| [C12](#c12) | F5 | — | §3 line 301 | — | VERIFIED | NO |
| [C13](#c13) | F10 | — | §3 | gap 4 | VERIFIED (static) | MAYBE |
| [C14](#c14) | F4 | — | — | gap 7, #14 | UNVERIFIED | NO |
| [C15](#c15) | F3 | — | — | #14 | VERIFIED | NO |
| [C16](#c16) | F11 | — | — | — | UNVERIFIED | NO |
| [C17](#c17) | F7 | — | — | — | VERIFIED | NO |
| [C18](#c18) | F8 | — | — | gap 3, inv. 10 | VERIFIED | NO |
| [C19](#c19) | F9 | — | §0.2 | gap 13 | VERIFIED | NO |
| [C20](#c20) | F12 | — | — | — | VERIFIED | NO |
| [C21](#c21) | F13 | — | — | — | VERIFIED | NO |
| [C22](#c22) | F14 | — | — | — | VERIFIED | NO |
| [C23](#c23) | F15 | — | — | inv. 7, gap 11 | UNVERIFIED | NO |
| [C24](#c24) | F16 | — | — | — | UNVERIFIED | NO |
| [C25](#c25) | — | F7 | §6 | gap 5 | VERIFIED (static) | YES |
| [C26](#c26) | — | F9 | — | gap 14 | VERIFIED (static) | YES |
| [C27](#c27) | F18.4 | F4 | §1–§8 | — | partial | NO |
| [C28](#c28) | F17 | F10 | — | gaps 1, 2 | VERIFIED | NO |
| [C29](#c29) | F17 | — | — | gaps 3–9, 11 | VERIFIED | NO |
| [C30](#c30) | — | F10 | — | gaps 10, 12, 14, 15 | VERIFIED | NO |
| [C31](#c31) | F18.9 | — | §0.1, §6 | — | VERIFIED | NO |
| [C32](#c32) | F18 | — | §3 | — | partial | NO |
| [C33](#c33) | F19 | — | — | — | partial | NO |
| [C34](#c34) | Unproven | §4 | — | — | n/a | n/a |

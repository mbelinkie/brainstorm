# Cumulative authorization review — `supabase/migrations/0001`–`0032`

Date: 2026-08-17
Branch: `claude/migrations-rls` (clean tree, no local modifications)
Scope: read-only. No SQL executed, no migration applied, no live project contacted.
Files read: all 32 migrations, `cloudflare-worker.js`, `room-api.js`, `config.js`,
`app.js` (relevant sections), `quiz-core.js`, `quiz-validation.js`, `author.js`
(RPC call sites), `test/access-control.test.js`.
Deliberately **not** read: `.env.local`, `supabase/.temp/` (may contain a pooler
connection string with a password).

This is a static reconstruction from SQL text. Where a conclusion depends on
project-level state that is not in the repository — Supabase default privileges,
whether auth signups are open, the Postgres major version, the out-of-band
`ensure_rls` event trigger named in `mistakes.md` #13 — that is flagged inline
and, where it changes a verdict, marked **unproven** with the exact check that
would settle it.

---

## 0. Executive summary

The RPC bodies are, individually, careful. Almost every one re-derives authority
from a room secret or a player token rather than trusting the caller, and the
tables are uniformly RLS-enabled with no permissive policies, so no browser role
reads a game table directly. That is the good news, and it is most of the surface.

The problem is not in any single migration. It is that **`0002` grants
`create_live_room` to `anon` with no authorization check, and `0005` grants
`get_host_quiz_definition` to `anon` gated only on "you know a host secret for
*some* room."** Nothing in `0006`–`0032` narrows either. Composed, they let any
anonymous browser mint itself a host credential over a *production* quiz version
and read that quiz's complete answer key — and then, via `can_access_live_media`'s
host branch and the Worker media proxy, download every private audio clip, reveal
image, option image, and video attached to it.

This is reachable today, from a phone sitting in a live game, using only values
published in `config.js`. It breaks two of CLAUDE.md's product invariants
outright and contradicts `PRODUCT_SPEC.md` §10, which states "Only authenticated
hosts can create sessions."

Ten findings follow, ranked by CLAUDE.md's "Review priorities." Five are
recurrences of existing `mistakes.md` lessons.

---

## 1. Cumulative end state after 0001–0032

### 1.0 The two facts that govern the whole table

**(a) Every function in `public` is executable by `PUBLIC` unless revoked.**
PostgreSQL grants `EXECUTE` on a new function to `PUBLIC` by default. This
migration set revokes that exactly twice — `room_code()` and `token_hash(text)`
in `0002`. Every other `grant execute … to anon, authenticated` is therefore
**decorative**: the function was already reachable by `anon` the moment it was
created. The `grant … to authenticated`-only lines on the author RPCs
(`0008`, `0010`, `0013`, `0014`, `0016`, `0032`) do **not** keep `anon` out.

I checked each of those six: all are guarded in-body by `if not
public.is_quiz_author() then raise exception`, and `is_quiz_author()` reads
`auth.uid()`, which is `NULL` for `anon`. So nothing is protected by a GRANT
alone today. But the protection is entirely in the function bodies, and the
GRANT lines misdescribe the actual reach — a reviewer reading `0010` reasonably
concludes `anon` cannot call `register_media_asset`, and that conclusion is wrong.

*Settle it with:* `SELECT proname, proacl FROM pg_proc WHERE pronamespace =
'public'::regnamespace;` on the live database. An ACL of `NULL` means the
default `PUBLIC EXECUTE` is intact.

**(b) The migration set never establishes its own table-privilege baseline.**
There is no `REVOKE … ON ALL TABLES IN SCHEMA public FROM anon, authenticated`
anywhere, and no `ALTER DEFAULT PRIVILEGES`. Table reachability therefore depends
on project configuration outside the repo. Three separate migrations — `0019`,
`0023`, `0028` — exist *only* because a required grant was missing at runtime,
which is strong evidence that this project does **not** carry Supabase's usual
blanket default privileges. I have assumed that throughout. Under either
assumption the game tables are safe, because RLS is enabled with zero policies.

### 1.1 Tables and views

There are no views. `enable row level security` is present on every table; no
table is ever `FORCE`d, so `SECURITY DEFINER` functions owned by the migration
role bypass RLS on all of them — which is how the entire RPC layer works.

| Table | RLS | Policies (final) | Table grants (final) | Who actually reaches it |
|---|---|---|---|---|
| `public.quizzes` | on (`0001`) | **none** | none in repo | `SECURITY DEFINER` RPCs only (as owner). No `service_role` grant → a PostgREST read as `service_role` would fail. |
| `public.quiz_versions` | on (`0001`) | **none** | none in repo | `SECURITY DEFINER` RPCs only. Definitions (answer keys) live here. |
| `public.sessions` | on (`0001`) | **none** | `SELECT` → `service_role` (**`0028`**) | RPCs; Worker `/host-text-answers`, `/host-closest-number-guesses` (`select=id`) |
| `public.session_players` | on (`0001`) | **none** | **none** | RPCs. ⚠️ Worker embeds it (F6) — grant missing. |
| `public.submissions` | on (`0001`) | **none** | `SELECT` → `service_role` (**`0028`**) | RPCs; Worker answer-wall + closest-number reads |
| `public.score_events` | on (`0001`) | **none** | none | RPCs + the `0026` BEFORE INSERT trigger. No UPDATE/DELETE path exists anywhere. |
| `public.quiz_authors` | on (`0008`) | **none** | none | `is_quiz_author()` (definer) only |
| `public.media_assets` | on (`0010`) | 1: `SELECT` to `authenticated` `USING (public.is_quiz_author())` (`0010`) | `SELECT` → `service_role` (**`0019`**); `SELECT` → `authenticated` (**`0023`**) | author browser (`author.js:1372`, row-filtered by the single policy); Worker (`service_role`, RLS-bypassing) |
| `public.session_door_choices` | on (`0025`) | **none** | none | RPCs only |
| `storage.objects` (`quiz-media`) | Supabase-managed | 4: INSERT/SELECT/UPDATE/DELETE to `authenticated` `WHERE bucket_id='quiz-media' AND is_quiz_author()` (`0010`) | Supabase default | author browser; Worker via `service_role` |
| `storage.buckets` row `quiz-media` | — | — | `public = false`, 25 MB cap; MIME allowlist set `0010`, widened to add `video/mp4` in **`0032`** | — |

Net: **no browser role can read any game table directly.** Every read a player or
host performs goes through a `SECURITY DEFINER` RPC. That part of the design holds.

### 1.2 Functions — final grants and effective reach

"Effective callers" folds in the default `PUBLIC EXECUTE` from §1.0(a).
"Credential enforced in body" is what actually gates the call.

| Function | First / last defined | Definer | Explicit grants | Effective callers | Credential enforced in body |
|---|---|---|---|---|---|
| `room_code()` | 0002 | no | **revoked from PUBLIC** (0002) | none | — |
| `token_hash(text)` | 0002 | no | **revoked from PUBLIC** (0002) | none | — |
| `create_live_room(uuid,text,jsonb)` | 0002 | yes | anon, authenticated | anon (+PUBLIC) | **none — quiz version must merely exist** ⚠️ **F1** |
| `join_live_room(text,text,text)` | 0002 | yes | anon, authenticated | *dropped in 0021* | — |
| `join_live_room(text,text,text,text)` | 0021 / 0026 | yes | anon, authenticated (0021, 0026) | anon (+PUBLIC) | room code only (by design) |
| `get_live_room_state(text,text)` | 0002 / 0026 | yes | anon, authenticated | anon (+PUBLIC) | player token |
| `submit_live_answer(…)` | 0002 | yes | anon, authenticated | anon (+PUBLIC) | player token + phase + revision + question id |
| `set_live_room_state(…)` | 0002 | yes | anon, authenticated | anon (+PUBLIC) | host secret |
| `lock_and_score_live_question(text,text)` | 0003 / **0030** (also 0009, 0017, 0025) | yes | anon, authenticated (0003 only) | anon (+PUBLIC) | host secret + `phase = question_open` |
| `get_live_leaderboard(text,text)` | 0004 / 0021 | yes | anon, authenticated | anon (+PUBLIC) | host secret **or** player token |
| `get_host_quiz_definition(text,text)` | 0005 | yes | anon, authenticated | anon (+PUBLIC) | host secret for that room ⚠️ **F1** |
| `get_host_live_room_state(text,text)` | 0006 | yes | anon, authenticated | anon (+PUBLIC) | host secret |
| `list_quiz_catalog()` | 0007 | yes (sql) | anon, authenticated | anon (+PUBLIC) | **none** ⚠️ **F1** |
| `is_quiz_author()` | 0008 | yes (sql) | *none explicit* | anon, authenticated, service_role (PUBLIC default) | `auth.uid()` |
| `publish_quiz_version(jsonb)` | 0008 | yes | authenticated | anon reaches it (+PUBLIC); body denies | author allowlist ⚠️ weak payload validation, **F8** |
| `register_media_asset(…)` | 0010 | yes | authenticated | anon reaches it; body denies | author allowlist |
| `can_access_live_media(text,uuid,text,text)` | 0011 / **0029** (also 0018, 0020) | yes | anon, authenticated (0011, 0018); **+ service_role** (**0020**, 0029) | anon, authenticated, service_role | host secret (whole-definition match) **or** player token (option artwork only) |
| `adjust_live_score(…)` | 0012 / **0027** (also 0022) | yes | anon, authenticated | anon (+PUBLIC) | host secret; bounds ±99999.99 (**0022**); reason optional (**0027**) ⚠️ **F7** |
| `delete_unused_media_asset(uuid)` | 0013 | yes | authenticated | anon reaches it; body denies | author allowlist + not referenced by any published version |
| `register_media_asset_with_source(…)` | 0014 | yes | authenticated | anon reaches it; body denies | author allowlist |
| `get_host_score_events(text,text)` | 0015 / 0025 | yes | anon, authenticated | anon (+PUBLIC) | host secret |
| `rename_media_asset(uuid,text)` | 0016 | yes | authenticated | anon reaches it; body denies | author allowlist |
| `get_host_text_answers(text,text)` | 0024 | yes | anon, authenticated | anon (+PUBLIC) | host secret — **no caller anywhere in repo**, see **F9** |
| `choose_live_door(text,text,text)` | 0025 | yes | anon, authenticated | anon (+PUBLIC) | player token + `phase = door_choice` + door exists in definition |
| `get_host_live_door_choices(text,text)` | 0025 | yes | anon, authenticated | anon (+PUBLIC) | host secret |
| `reveal_live_door_rewards(text,text)` | 0025 | yes | anon, authenticated | anon (+PUBLIC) | host secret + phase in (`door_choice`,`door_reveal`) ⚠️ **F5** |
| `apply_late_join_catch_up()` | 0026 | yes (trigger) | *none explicit* | trigger context only | — ⚠️ **F7** |
| `jsonb_object_length(jsonb)` | 0031 | no (sql) | *none explicit* | PUBLIC default | — |
| `register_video_media_asset(…)` | 0032 | yes | authenticated | anon reaches it; body denies | author allowlist + `storage_path ~ '^<auth.uid()>/<uuid>.mp4$'` + MP4 metadata |

### 1.3 Where a later migration widened or replaced an earlier grant

| Migration | What it opened | Narrowed later? |
|---|---|---|
| **0019** `service_role_media_proxy` | `USAGE` on schema `public`, `SELECT` on `media_assets`, `EXECUTE` on `can_access_live_media` — all to `service_role` | **No.** Correct as designed: `service_role` is a Worker-only secret. Residual: anything holding that key reads every `storage_path` and source-metadata row. |
| **0020** `question_image_access` | Added `service_role` to the `can_access_live_media` grant list; widened the *player* branch to allow `question.questionImageAssetId` | Player widening **reverted by 0029**. `service_role` grant retained. |
| **0018** `reveal_image_access` | Widened the player branch to allow `state.revealImageAssetId` when `phase = 'answer_reveal'` | **Reverted by 0029.** |
| **0022** `unbounded_manual_score_adjustments` | Manual adjustment ceiling ±1000 → ±99999.99 (exactly `numeric(7,2)` range). **No new role reaches it**; still host-secret gated. | Not narrowed. `0027` kept the same bounds and additionally made `reason` nullable — see **F7**. |
| **0023** `grant_author_media_read` | `SELECT` on all of `media_assets` to **every** `authenticated` user | **No.** Safe only because the single `0010` `SELECT` policy is the sole row gate, and nothing asserts that policy still exists. |
| **0028** `answer_wall_service_role_read` | `SELECT` on all of `sessions` (**including `host_secret_hash`**) and all of `submissions` to `service_role` | **No.** Also silently orphaned `0024`'s RPC — see **F9**. |
| **0029** `presentation_only_media` | **Narrowed.** Removed `questionImageAssetId` and `revealImageAssetId` from the player branch, leaving players only `question.options[].imageAssetId`. Host branch unchanged. | This is the only migration in the set that closes rather than opens. |

---

## 2. Findings, ranked by CLAUDE.md "Review priorities"

### Priority 1 — authorization and player-privacy leaks

---

#### F1 — Any anonymous browser can read the full answer key of any published quiz

**Severity: critical. Reachable today with published values only.**

`create_live_room` (`0002`) is granted to `anon` and performs exactly one check:
that `p_quiz_version_id` exists. The caller supplies their own `p_host_secret`.
`get_host_quiz_definition` (`0005`) is granted to `anon` and returns
`quiz_versions.definition` verbatim for whatever room the presented host secret
opens. Neither is narrowed by `0006`–`0032`.

Concrete path, no credential the attacker does not already have:

1. `GET https://<site>/config.js` → `supabaseUrl`,
   `supabasePublishableKey`, and `defaultQuizVersionId`
   (`config.js:4-7`; these are publishable by design, and that is fine).
2. `POST /rest/v1/rpc/list_quiz_catalog` with the publishable key
   (`0007`, granted `anon`, **no credential at all**) → `quizVersionId` for
   *every* quiz version in the project, not just the default.
3. `POST /rest/v1/rpc/create_live_room` `{p_quiz_version_id: <victim version>,
   p_host_secret: "<48 random hex chars>"}` → a room code. The attacker is now
   the authenticated host of a room bound to the production quiz.
4. `POST /rest/v1/rpc/get_host_quiz_definition` `{p_room_code, p_host_secret}`
   → the entire definition: `correctOptionIds`, `acceptedAnswers`,
   `correctPairs`, `correctCategories`, `correctOrder`, `targetNumber`,
   `clips[].acceptedAnswers`, host notes, and every `mediaAssetId`.

A player can run all four steps from the phone they are playing on, mid-game,
before the host opens question 1.

Violates CLAUDE.md *"Players never receive future state… No upcoming questions,
correct answers, reveal media, asset IDs, or usable media URLs reach a player
payload before the host reveals."* Contradicts `PRODUCT_SPEC.md` §10: *"Only
authenticated hosts can create sessions or change session state."*

The player-payload allowlist (`publicRoomState()` in `app.js:147`,
`toPlayerQuestion()` in `quiz-core.js:4`) is correct and is not the problem.
The problem is that it can be walked around entirely.

**Recurrence of `mistakes.md` #5** — *"I hardened privacy after the payload
surface had already expanded."* The lesson's prescription was allowlisted
serializers plus *"contract tests that inject sentinel secrets into every
sensitive field and prove they never reach unauthorized clients."* The serializer
was built; the test was written against the serializer, not against the
authorization boundary, so it cannot see this path. `test/access-control.test.js`
has ten assertions and none touches `create_live_room`.

*Smallest thing that would close it:* require `is_quiz_author()` in
`create_live_room`, or bind rooms to an author-issued grant. Either is a behavior
change with host-flow consequences, so it is the user's call, not mine.

---

#### F2 — The same path yields every private media file, including reveal artwork

**Severity: critical. Depends on F1; otherwise fully reachable.**

`can_access_live_media`'s host branch has been identical since `0011` and was
left untouched by the narrowing in `0029`:

```sql
if p_host_secret is not null and active_session.host_secret_hash = public.token_hash(p_host_secret) then
  return exists (select 1 from public.quiz_versions q
    where q.id = active_session.quiz_version_id
      and position(p_asset_id::text in q.definition::text) > 0);
end if;
```

It returns true for **any asset ID appearing anywhere in the definition text**,
at **any phase** — no question-scoping, no reveal gate. That is correct for a
real host (the presentation tab needs arbitrary media, and `app.js:1599-1602`
sends the host secret from both the `host` and `presenter` views). It is
catastrophic for the attacker-created room from F1, because the attacker holds a
valid host secret for a room bound to the real quiz version.

Continuing from F1 step 4, for every `mediaAssetId` in the definition:

```
GET https://wild-haze-73b3.…workers.dev/media/<assetId>
    x-quiz-room: <attacker room code>
    x-quiz-host-secret: <attacker secret>
```

`cloudflare-worker.js` validates the UUID shape, calls `can_access_live_media`
with `service_role`, gets `true`, reads `media_assets.storage_path` (granted
`0019`), and streams the object from the private bucket with the service key.
Result: every audio clip, every reveal image, every option image, and every
`0032` video — before the host has revealed anything.

`0029` was written to stop players seeing question-stage and reveal artwork, and
it does stop the *player* branch. The host branch makes the narrowing moot for
anyone who can mint a host secret.

**Recurrence of `mistakes.md` #2** — *"I treated media as a UI feature when it
was really an authorization and lifecycle system,"* whose prescription was
*"Specify access rules by role and game phase in a table before implementation."*
Four migrations (`0011`, `0018`, `0020`, `0029`) each edited one branch of that
table in isolation; the host branch was never revisited, and no migration states
the role×phase matrix in one place.

---

#### F3 — Every player's answers are broadcast in cleartext on a public Realtime channel

**Severity: high. Outside the migration set, but it bypasses it entirely — which
is exactly the "a policy is only as good as the caller" cross-check.**

The database side is airtight: `submissions` is RLS-enabled with no policies, so
no browser role can read another player's answer. Then `app.js:797` opens

```js
supabase.channel(`quiz-room:${roomCode}`, { config: { broadcast: { self: false } } })
```

with no `private: true`, i.e. a **public** Supabase Broadcast channel. No
migration creates any `realtime.messages` policy, because a public channel needs
none. `sendSubmission()` (`app.js:~686`) then posts
`{playerId, playerName, playerLogoKey, questionId, answer}` to it on every
submission, and `receive()` (`app.js`, `data?.type === "submission"`) shows every
subscribed client is listening.

So: any joined player's browser already receives every other player's answer
while the question is still open — visible in devtools with no tooling. And any
anonymous party holding the publishable key from `config.js` can subscribe to
`quiz-room:<CODE>` **without joining the room at all** and watch answers, names,
and full room state live.

Violates CLAUDE.md *"Players never receive future state"* in spirit and
`PRODUCT_SPEC.md` §3 *"Players cannot request or infer the next question from the
player interface."* The `state` payload on this channel is `publicRoomState()`,
which is allowlisted and post-reveal-gated — that part is fine. The `submission`
event is not gated at all.

*Unproven:* whether Supabase would reject an unauthenticated subscribe on this
project. Public Broadcast channels do not require authorization by default, and
nothing here opts into private channels. Settle it by subscribing to
`quiz-room:<code>` with the publishable key from a browser that has never joined.

---

### Priority 2 — violations of the product invariants

---

#### F4 — CLAUDE.md's "no asset IDs to players" invariant and the shipped design disagree

**Severity: medium (documentation/invariant drift, not a leak).**

CLAUDE.md states players receive no *"asset IDs, or usable media URLs."* But
`toPlayerQuestion()` (`quiz-core.js:6`) deliberately forwards
`options[].imageAssetId`, and `0029`'s comment endorses it: *"Joined players
retain access only to option artwork required to answer image-based selection and
matching questions."* Image-selection questions cannot render otherwise. The
migrations and the client agree with each other; only the invariant text is out
of date.

Two real consequences worth separating from the wording problem:

- **Asset IDs are still not URLs.** A player gets a UUID, and the Worker will
  only serve it while it is on the active question's options. That is a sound
  design and the invariant should say so.
- **`items` and `categories` pass through unfiltered.** `toPlayerQuestion()`
  copies both verbatim (`quiz-core.js:7`). If an author ever attaches artwork to
  a `categorize` item or a `matching` target, its asset ID reaches players but
  `can_access_live_media` (post-`0029`) denies it — the image renders broken.
  The payload allowlist and the media policy were narrowed on different days and
  no longer describe the same set.

---

### Priority 3 — missing or out-of-order migrations

---

#### F5 — `phase` is a host-mutable field used as the only idempotency key for irreversible scoring

**Severity: high. Host-reachable, not player-reachable.**

`set_live_room_state` (`0002`) lets the host set `phase` to any enum value, in
any order, any number of times. Two irreversible operations use `phase` as their
sole guard:

- `lock_and_score_live_question` requires `phase = 'question_open'`, then inserts
  a fresh `score_events` row per correct submission. There is **no** uniqueness
  constraint on `(session_id, player_id, question_id, created_by)` and no check
  for existing events. A host who uses the documented reopen override
  (`set_live_room_state(… 'question_open' …)`) and then locks again
  **double-awards every correct player**. Concurrency itself is handled
  correctly — the `select … for update` on the session serializes two racing host
  tabs and the loser sees `phase = question_locked` and raises — so only the
  explicit reopen path double-scores.
- `reveal_live_door_rewards` re-rolls `resolved_multiplier` for every choice in
  the round whenever it is entered at `phase = 'door_choice'`. A plain refresh is
  safe (phase is already `door_reveal`, and the `case when phase::text =
  'door_choice'` guard correctly reads the pre-UPDATE value). But a host who
  sets the phase back to `door_choice` re-randomizes everyone's reward,
  contradicting `PRODUCT_SPEC.md`'s *"randomized outcomes are persisted and
  resolved by protected server functions so refreshes cannot reroll rewards."*

Also note `submit_live_answer` never consults `submissions.is_locked` — it gates
on phase alone — so a reopened question accepts edits to already-locked rows.

Missing: a migration adding a per-question scoring guard (a unique partial index
on system score events, or a `scored_at` marker on the session state) and a
`revealed_at`-based guard on the door reveal.

---

#### F6 — `0028` shipped an incomplete grant set; the closest-number reveal wall cannot work

**Severity: medium. High confidence from SQL + Worker text; one live check settles it.**

`cloudflare-worker.js` `/host-closest-number-guesses` issues:

```
/rest/v1/submissions?session_id=eq.…&select=answer,player:session_players(display_name,logo_key)
```

That PostgREST resource embedding requires `SELECT` on **`public.session_players`**
for the requesting role. `0028` grants `SELECT` on `sessions` and `submissions`
to `service_role` and stops there. No migration ever grants anything on
`session_players`. `service_role` has `BYPASSRLS`, which bypasses *policies* —
it does not bypass *grants*.

Predicted behavior: PostgREST returns `42501 permission denied for table
session_players`, the Worker returns 502, and `app.js:1345` sets
`closestNumberGuessesError = true` — a silent degraded reveal screen, exactly the
class of failure `mistakes.md` #6 warns about. `/host-text-answers` is unaffected
(it selects only `answer,submitted_at`) and additionally has a Realtime fallback,
which is why this would not have shown up alongside it.

**Recurrence of `mistakes.md` #9** — *"I discovered deployment prerequisites
through runtime failures,"* prescription: *"Maintain a machine-checkable manifest
of required secrets, bindings, tables, policies, grants, buckets."* `0019`,
`0023`, and `0028` are each a grant discovered by production runtime failure, and
`0028` — written in direct response to that lesson — still shipped an incomplete
grant list for the very code path it was enabling.

*Unproven only in this sense:* if the project does carry Supabase's default
`GRANT ALL … TO service_role`, the embed works and `0019`/`0023`/`0028` were all
no-ops. The existence of those three migrations argues strongly against that.
Settle it with `\dp public.session_players` (or
`SELECT relacl FROM pg_class WHERE oid = 'public.session_players'::regclass`).

---

#### F7 — Score events are immutable in storage but rewritten in flight, and can now carry no reason

**Severity: medium. Audit-trail accuracy.**

`score_events` is genuinely append-only: RLS with no policies, no UPDATE or
DELETE anywhere in 32 migrations, all writes through `SECURITY DEFINER`. That
half of the invariant holds. Two things erode the *auditable* half:

- **`0026`'s `BEFORE INSERT` trigger rewrites the event as it is written.**
  `apply_late_join_catch_up()` overwrites `new.multiplier` with the catch-up
  multiplier, recomputes `new.points`, and strips the door text out of
  `new.reason` via `regexp_replace(new.reason, ' · [0-9.]+x door bonus$', '')`.
  The "higher multiplier wins" rule is correct and deliberate, but the resulting
  event no longer records that a door multiplier was resolved and discarded.
  `get_host_score_events` exports `basePoints`, `multiplier`, `reason` — so the
  CSV cannot explain why the player's 1.5× door did not apply. The evidence
  survives only in `session_door_choices`, which no export reads.
- **`0027` made `reason` nullable** and `adjust_live_score` now inserts
  `nullif(trim(coalesce(p_reason,'')),'')` — a genuine `NULL`, not the old
  `'Host manual adjustment'` default. Combined with `0022`'s widened ±99999.99
  ceiling, a single host action can move a player by up to 99999.99 points with
  **no recorded reason at all**, and the CSV shows an empty cell.

Against CLAUDE.md: *"Score-affecting events are immutable and auditable. Manual
adjustments, door bonuses, and late-join catch-up all append audit events that
the CSV exports can explain."* Both of these are cases the export cannot explain.

**Recurrence of `mistakes.md` #11** — *"I did not make the score model extensible
enough before adding modifiers,"* prescription: *"Model a score event as inputs
plus calculation: base points, modifier, final points, reason… Store immutable
events rather than relying on a mutable total."* `0025` added `base_points` and
`multiplier` in exactly that spirit; `0026` then began mutating `multiplier` and
`reason` before they were ever committed, because there is nowhere to record a
*second* modifier that lost.

---

#### F8 — `publish_quiz_version` validates far less than the browser does, and the gap can break a live game

**Severity: medium. Author-reachable only.**

`publish_quiz_version` (`0008`) checks three things: non-empty `id`, non-empty
`title`, `rounds` is an array. `quiz-validation.js` checks roughly forty. An
allowlisted author who POSTs to `/rest/v1/rpc/publish_quiz_version` directly —
or any future authoring path that skips `validateQuiz()` — can publish a
definition that makes the *scoring* RPC throw mid-game:

- **Unbounded `points`.** `quiz-validation.js:52` requires only
  `Number.isFinite(points) && points > 0`. `lock_and_score_live_question` declares
  `awarded_points numeric(7,2)` (max 99999.99). A question authored with
  `points: 100000` — one stray zero in the editor, which the client validator
  accepts — raises `numeric field overflow`, rolls back the whole lock, and
  **leaves the host unable to lock the question**. Nobody is scored.
- **Door multipliers.** `session_door_choices.resolved_multiplier` is
  `numeric(6,2) check (> 0 and <= 10)`. `quiz-validation.js:31` enforces the
  identical `> 0 … <= 10` range — but only in the browser. A definition that
  bypasses it makes `reveal_live_door_rewards` throw a check violation at the
  moment the host reveals rewards.

Same class as `mistakes.md` #5's *"Default new fields to server-only until
deliberately exposed"* inverted: the server accepts fields it does not validate.
Realistically this is a robustness finding, not a security one — `publish_quiz_version`
is author-gated — but the failure lands in the middle of a live show.

---

### Priority 4 — idempotency and replay

---

#### F9 — Replay and idempotency audit

The good news first, because it is most of it:

- **No migration edits an earlier migration's file.** Every change is a new
  ordered file using `create or replace` or an additive `alter`. `0032` and
  `0027` drop-and-recreate named constraints (`media_assets_kind_check`,
  `score_events_reason_check`) rather than editing the file that made them,
  which replays cleanly: Postgres auto-names column-level checks
  `<table>_<column>_check`, so both `drop constraint if exists` calls hit their
  targets on a from-scratch run.
- **Nothing would fail against the oldest supported data.** Every `add column` is
  nullable or carries a default that satisfies its own check (`0021`'s
  `logo_key default 'spark'` matches `^[a-z0-9-]{1,40}$`; `0026`'s two columns are
  NULL-tolerant). Every constraint change widens: `0027` relaxes `reason` to
  nullable, `0032` adds `'video'` to the `kind` allowlist. No `ALTER` in the set
  can reject an existing row.
- **`0025`'s `ALTER TYPE … ADD VALUE IF NOT EXISTS` is transaction-safe here, on
  purpose.** New enum values cannot be *used* in the transaction that adds them.
  Every subsequent comparison against `door_choice`/`door_reveal` in `0025` and
  `0026` is written as `phase::text in (…)` rather than an enum literal, and the
  one enum-literal assignment (`set phase = 'door_reveal'`) lives inside a
  PL/pgSQL body that is not executed at migration time. That is correct and
  deliberate, but it is undocumented and one `phase = 'door_choice'` written by a
  future session would break `supabase db push` for everyone. *Version caveat:*
  `ADD VALUE` inside a transaction requires PG ≥ 12. No `supabase/config.toml`
  exists to pin the version — **unproven**, though Supabase has shipped ≥ 15 for
  years.

The two real problems:

- **`0010` cannot be re-run.** Its five `create policy` statements have no
  `drop policy if exists` and its `create table public.media_assets` has no
  `if not exists`. Re-running it fails at
  `policy "Quiz authors can read media records" for table "media_assets" already exists`.
  This is not academic: `mistakes.md` #13 documents that this project's actual
  recovery workflow was executing individual migration files by hand with
  `supabase db query --linked --file …` against a live schema. `0001` and `0008`
  share the problem (`create table` with no guard); `0025`, `0026`, `0027`,
  `0032` are fully re-runnable and are the model to copy.
- **`0024`'s RPC is dead, and `0028` is why.** `0024` created
  `get_host_text_answers` with the stated purpose of avoiding *"a partial failure
  between separate session and submission REST reads in the Worker."*
  `grep -c get_host_text_answers` returns **0** across `cloudflare-worker.js`,
  `app.js`, and `author.js`. The Worker performs exactly the two separate REST
  reads that `0024` existed to eliminate, and `0028` widened `service_role` to
  make that possible. So a migration's stated intent was reverted by its caller
  four migrations later, and neither file says so. The orphaned RPC is
  harmless — it is host-secret gated — but it is live `anon`-reachable surface
  that nobody owns.

**Recurrence of `mistakes.md` #13** for the idempotency half (that lesson's whole
premise is hand-replaying migration files against a live schema), and of
**`mistakes.md` #8** — *"I left legacy and fallback paths in place without enough
regression coverage… Inventory compatibility paths and give each an owner, test,
and removal date"* — for the orphaned `0024`.

---

### Priority 6 — untested failure states

---

#### F10 — The authorization boundary has no negative tests

`test/access-control.test.js` is a text-matching contract suite: it greps
`cloudflare-worker.js` and two migration files for expected substrings. It is
useful and it caught the `0029` narrowing (`assert.doesNotMatch(migration,
/questionImageAssetId|revealImageAssetId/)`). What it does not do — what nothing
in `test/` does — is assert that an unauthorized caller is *refused*:

- nothing asserts `create_live_room` requires authorization (F1);
- nothing asserts the host branch of `can_access_live_media` is scoped to a room
  the caller legitimately hosts (F2);
- nothing asserts submissions stay off the Realtime channel (F3);
- nothing asserts the `0010` `media_assets` SELECT policy still exists, which is
  the single gate standing behind `0023`'s table-wide grant;
- nothing asserts the `service_role` grant list matches the tables the Worker
  actually reads (F6) — a test that parses `rest/v1/<table>` and
  `select=…<embed>…` out of `cloudflare-worker.js` and checks each against the
  `grant select on table` lines in `supabase/migrations/` would have caught it
  statically, in the same style as the existing `deploy-manifest.test.js`.

**Recurrence of `mistakes.md` #10** — *"I added automated checks after high-risk
boundaries were already complex,"* which prescribes writing *"1. Authorization
and information-boundary tests"* first.

---

## 3. Recurrence summary

Five of the ten findings are lessons that did not take:

| Finding | Lesson | Why it counts as a recurrence |
|---|---|---|
| **F1** | **#5** — hardened privacy after the payload surface expanded | The allowlisted serializer was built exactly as prescribed. The prescribed *contract test* was pointed at the serializer instead of the authorization boundary, so the boundary was never covered — and that is where the leak is. |
| **F2** | **#2** — media treated as UI, actually authorization + lifecycle | The prescription was *"specify access rules by role and game phase in a table before implementation."* Four migrations each edited one cell of that table in isolation; the host row was never revisited and the matrix is still written nowhere. |
| **F6** | **#9** — deployment prerequisites discovered through runtime failures | `0019`, `0023`, `0028` are three grants each found by a production failure. `0028`, written after the lesson, still shipped a grant set that misses a table its own Worker route embeds. The prescribed "machine-checkable manifest of grants" does not exist. |
| **F7** | **#11** — score model not extensible enough before adding modifiers | `0025` implemented the prescribed inputs-plus-calculation event. `0026` then mutates that event before commit because the model still has room for only one modifier, so the losing one vanishes from the audit trail. |
| **F9** | **#13** (idempotency) and **#8** (orphaned `0024`) | #13's entire premise is hand-replaying migration files against a live schema; `0010` cannot survive that. #8's prescription — inventory compatibility paths, give each an owner and a removal date — is what `0024` needed and did not get. |

F3, F4, F5, F8, and F10 are new ground, though F10 is one remove from #10.

---

## 4. What I could not establish

- **Whether Supabase default privileges are present on this project.** It changes
  nothing about the game tables (RLS with no policies denies regardless) but it
  decides whether F6 is a live bug or a no-op. Settle with `\dp public.*`.
- **Whether the `PUBLIC EXECUTE` default is intact** on the ~29 functions in
  `public`. Settle with `SELECT proname, proacl FROM pg_proc WHERE pronamespace
  = 'public'::regnamespace`. If some out-of-band step revoked it, §1.0(a) is
  wrong and several "anon reaches it" cells narrow — but F1's three functions are
  *explicitly* granted to `anon`, so F1 stands either way.
- **Whether Supabase Auth signups are open on this project.** If they are,
  `0023`'s `authenticated` grant is self-service and the `0010` policy is doing
  all the work alone. Not visible from the repo.
- **F3's unauthenticated-subscribe claim.** The code shows a public channel and
  submission broadcasts; whether a never-joined client can subscribe needs one
  browser test against the live project.
- **The `ensure_rls` event trigger** noted in `mistakes.md` #13 lives outside this
  repository. If it force-enables RLS on new tables, it is a real guardrail that
  the migration set does not describe, and it should be written down here.

---

## 5. Proposed addition to `mistakes.md` — not applied, for your decision

`mistakes.md` currently ends at lesson 14. I would add **one** lesson, not five.
The five recurrences above are not five independent failures; they are one
failure — *no migration ever evaluated the composed authorization surface* —
expressed five ways. Adding five entries would pad the file and dilute the
existing lessons, which is the failure mode #12 already warns about.

Proposed, in the file's existing voice and "What to do next time" format:

> ### 15. I reviewed migrations one at a time and never once reviewed the surface they add up to
>
> Thirty-two migrations were each written in a session that could see its own
> file and, at best, the one it was replacing. Every one is individually
> defensible. The composition is not: `0002` grants `create_live_room` to `anon`
> with no authorization check, `0005` grants `get_host_quiz_definition` to `anon`
> gated only on possession of *a* host secret, and `0007` publishes every
> `quizVersionId` to `anon`. Read together — which nobody did for eleven months —
> those three let any phone in the audience mint itself a host credential over
> the production quiz version and read the complete answer key, and then use
> `can_access_live_media`'s unchanged host branch to pull every private clip and
> reveal image out of the Worker proxy.
>
> The same blind spot produced smaller versions of itself. `0018` and `0020`
> widened player media access and `0029` narrowed it back, but no migration ever
> revisited the host branch those three shared. `0019`, `0023`, and `0028` are
> each a `GRANT` added after a production failure, and `0028` still shipped
> without the `session_players` grant its own Worker route needs. `0024` created
> an RPC to replace two Worker table reads, and `0028` then widened `service_role`
> so the Worker could keep doing exactly those two reads; the RPC has had zero
> callers ever since.
>
> The contract tests did not catch any of it because they assert that the *code
> says the right thing* — they grep migration text and Worker source for expected
> substrings. Not one of them asserts that an unauthorized caller is refused.
> That is the difference between a test of the implementation and a test of the
> boundary.
>
> #### What to do next time
>
> - Keep a single role × object × phase authorization table in the repository,
>   next to the migrations, and require every migration that touches a `GRANT`,
>   a policy, or a `SECURITY DEFINER` body to update it in the same commit. That
>   table, not the migration files, is the reviewable artifact.
> - Write authorization tests as *negative* tests against a throwaway database:
>   anon calls the RPC, and the assertion is that it is refused. A test that
>   greps source text proves the code was written; only a refused call proves the
>   boundary holds.
> - Treat "who can create the credential" as part of every credential check. A
>   host-secret gate is worth nothing if anyone can mint a host secret.
> - Before any release that adds a `GRANT`, diff the tables and columns the
>   Worker actually reads against the grants the migrations actually make, and
>   fail the build on a mismatch. Both directions matter: a missing grant is an
>   outage, an unused one is surface.
> - Remember that in PostgreSQL `EXECUTE` on a new function is granted to
>   `PUBLIC` by default. `grant execute … to authenticated` does not keep `anon`
>   out; only `revoke … from public` does. Every author-only RPC here is safe
>   because of an in-body `is_quiz_author()` check, not because of its `GRANT`.
> - When a migration's stated purpose is later reverted by its caller, delete the
>   dead object in a new migration and say why. An orphaned `anon`-reachable RPC
>   is live surface nobody owns.

If you would rather have separate entries, the natural split is two: the
composition blind spot above, and a narrower one on grants-versus-callers
covering `0019`/`0023`/`0028`/`0024`. I would still not go past two.

---

## 6. Suggested order of work

Not a plan, just the dependency order if you decide to act:

1. **F1** — closes F2 as a side effect. Everything else is secondary to it.
2. **F3** — independent of F1, roughly as bad, and a smaller change (stop
   broadcasting `answer`, or move the channel to private with a
   `realtime.messages` policy).
3. **F6** — one-line migration, but confirm the grant state first.
4. **F10** — the negative tests, so 1–3 cannot silently regress.
5. **F5**, **F7**, **F8** — correctness and audit work, none of it urgent
   between shows.
6. **F4**, **F9** — documentation and hygiene.

No code, SQL, or configuration was changed by this review. `CHANGELOG.md`,
`docs/CLAUDE_WORKLOG.md`, and `mistakes.md` were not touched.

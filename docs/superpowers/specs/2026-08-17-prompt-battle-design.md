# Prompt Battle — design

Status: approved design, not yet planned or implemented.
Date: 2026-08-17
Branch: `claude/prompt-battle-spec`

## 1. Purpose

A new round type for the live quiz platform. Players are paired, each pair
receives the same comic prompt ("Depict the worst office party ever"), and each
player writes their own instructions to an AI image generator, iterates, and
submits one image. The room then votes blind on each pair in turn.

The intended setting is internal Kaplan team-building events of roughly 10–20
people. It is a creativity game, not a knowledge game: there is no answer key.

## 2. Decisions already made

These were settled during brainstorming and are not open for re-litigation
during planning.

| Decision | Choice |
|---|---|
| Participation | Quiplash model — every player generates; server pairs them |
| Generation budget | Budgeted iteration: N prompt attempts, 2–4 variants each, submit any one |
| Moderation | Host previews all submissions and can veto before the room sees them |
| Attribution | Blind during voting, creators revealed with the result |
| Scoring | Winner points plus a small participation point for casting a vote |
| Retention | Images persist to the private bucket, auto-purged after 30 days |
| Odd player count | One matchup becomes a three-way |
| Tie | All tied duelists receive full winner points |
| Credentials | Vertex AI via a Kaplan service account is the target; OpenRouter is the day-one build provider |

## 3. Why this is a round type, not a question type

Every existing question type shares one lifecycle (`open` → `locked` →
`reveal`), one submission per player per question, and scoring by comparison
against a stored answer key. Prompt Battle has none of these: no key, a
generate-iterate-submit loop before submission, and N sequential matchups
inside a single round.

Modelling it as a `question` would require weakening the scoring interface that
`PRODUCT_SPEC.md` treats as a v1 invariant. Instead it follows the precedent set
by the between-round door bonus (migration `0025`): its own phases on
`session_phase`, its own tables, its own `security definer` RPCs, resolved
server-side, with results landing in the shared `score_events` table.

## 4. Quiz definition schema

```json
{
  "rounds": [
    {
      "type": "prompt_battle",
      "title": "Prompt Battle",
      "engine": {
        "defaultProvider": "openrouter",
        "defaultModel": "google/gemini-3.1-flash-image",
        "permittedModels": [
          "google/gemini-3.1-flash-image",
          "google/gemini-3.1-flash-lite-image",
          "black-forest-labs/flux.2-klein-4b"
        ],
        "variants": 4,
        "attemptBudget": 3,
        "resolution": "512",
        "outputFormat": "webp",
        "maxSessionSpendUsd": 25.0
      },
      "prompts": [
        { "id": "pb-01", "text": "Depict the worst office party ever." },
        { "id": "pb-02", "text": "Illustrate Monday morning as a natural disaster." }
      ],
      "scoring": { "winnerPoints": 100, "voterPoints": 10 }
    }
  ]
}
```

`permittedModels` is the quiz author's shortlist. It is intersected at runtime
with the deployment's own allowlist (see §7.5); the effective menu the host sees
is the intersection. `variants` defaults to 4 but 2 is the recommended value for
cost (see §16).

`quiz-validation.js` gains rules for this round type. `quiz.sample.json` and
`music-trivia.question-bank.json` must still validate unchanged — this is an
additive round type, not a schema migration of existing content.

## 5. Phase machine

Four new values on the `session_phase` enum:

- **`battle_prompt`** — pairing and prompt assignment are already complete.
  Players write prompts, generate, iterate within budget, and submit one image.
  Host sees a submission roster. Presentation shows the round title and a
  progress indicator and **never shows images during this phase**.
- **`battle_review`** — host-only. A grid of every submitted image with a veto
  control per entry. A distinct phase rather than a tail of `battle_prompt` so
  that it survives a host refresh and so the gate is explicit in persisted
  state.
- **`battle_vote`** — the current matchup only. Two (or three) images shown
  unlabelled; players tap to vote.
- **`battle_result`** — creators revealed, vote counts shown, points awarded for
  the current matchup.

`battle_vote` and `battle_result` **cycle**: after `battle_result`, the host
either advances to the next matchup (back to `battle_vote`) or ends the round.
The current position lives in session state as `battleRoundIndex` and
`battleMatchupIndex`, so a host refresh resumes at the right matchup.

## 6. Pairing and prompt assignment

`open_battle_round` runs once when the host opens the round and is **idempotent**
— calling it again on an already-opened round returns the existing pairing
rather than reshuffling. This matters because a host refresh must not
re-randomise matchups that players have already started generating for.

Rules:

1. Take all joined players in the session, shuffled with a seed persisted on
   the session so the pairing is reproducible and auditable.
2. Pair them off. With an odd count, the final matchup takes three players.
3. Assign each matchup a prompt from the round's `prompts` array, cycling if
   there are more matchups than prompts.
4. Create one `session_battle_entries` row per player.

A player who joins **after** the round opens is not added to a matchup for that
round; they can still vote and earn `voterPoints`. This follows the existing
late-join catch-up precedent (migration `0026`) rather than inventing a second
rule.

## 7. Image generation

### 7.1 Endpoints

Generation is the only part that needs a provider credential, so it is the only
part that goes through the Worker. Submission, voting, and resolution are
ordinary Supabase RPCs called from the browser, exactly like `submitAnswer`.

| Route | Auth header | Purpose |
|---|---|---|
| `POST /battle/generate` | `x-quiz-room` + `x-quiz-player-token` | Player generates one attempt |
| `POST /battle/test-image` | `x-quiz-room` + `x-quiz-host-secret` | Host tests the effective model |
| `GET /media/{assetId}` | existing | Unchanged delivery path |

### 7.2 Player generation sequence

1. Worker calls `authorize_battle_generation(room_code, player_token)`.
   The RPC verifies phase, membership, remaining attempts, and cumulative
   session spend against `maxSessionSpendUsd`. It returns
   `{ generationId, promptText, provider, model, variants, resolution,
   outputFormat, attemptsRemaining }` and **reserves the attempt** by inserting
   a pending `session_battle_generations` row.
   The browser never decides whether budget remains.
2. Worker resolves the adapter and calls the provider.
3. On success: upload each variant to the private `quiz-media` bucket via the
   service role, insert `media_assets` rows, and call
   `record_battle_generation` with the asset IDs and the reported cost.
4. On provider error: call `refund_battle_attempt`. OpenRouter bills
   all-or-nothing per generation, so a failed call is not charged and the refund
   costs nothing.
5. On safety block: also refund, and return the block reason for a friendly
   "that one got blocked, try describing it differently" message. **No point
   deduction** — the filter's false positives are far more common than genuine
   abuse, and punishing them punishes the wrong people.
6. Response to the player is **asset IDs, not image bytes**, so delivery uses
   the existing `/media/` proxy and the "players never receive usable media
   URLs" invariant is preserved without amendment.

### 7.3 Adapter interface

New module `image-engine.js`, alongside `quiz-core.js`. Pure functions, no
fetching, so tests cover it from fixtures and never call a live provider —
`CLAUDE.md` forbids live external calls in tests.

```js
export const ENGINES = {
  openrouter: {
    resolveAuth(env),                  // async, cacheable -> { headers }
    endpoint(config),                  // -> full URL
    buildRequest({ model, prompt, variants, resolution, outputFormat }),
    parseResponse(json)                // -> { images: [{ mimeType, bytesBase64 }],
                                       //      costUsd, blocked, blockReason }
  },
  vertex: { /* same shape */ },
  openai: { /* same shape */ }
};
```

`resolveAuth` is deliberately **async and cacheable** rather than a static key
string. OpenRouter is a bearer token; Vertex is a token *lifecycle*. If the seam
is a string, the Vertex adapter cannot be dropped in without re-cutting it.

### 7.4 Adapters

**OpenRouter (day-one).** `POST https://openrouter.ai/api/v1/images`, bearer
token. Request carries `model`, `prompt`, `n` (1–10), `resolution`,
`aspect_ratio`, `output_format`, `output_compression`. Response is
`{ data: [{ b64_json, media_type }], usage: { cost } }`.

Two properties matter to this design. `n > 1` returns all variants from a
**single call**, so an attempt is one request, not N parallel ones — but the
docs note that single-image providers reject `n > 1`, so this must be verified
per model (the host test button in §7.5 does this empirically). And `usage.cost`
returns **actual spend per call**, which makes the session spend cap exact
rather than estimated.

**Vertex AI (target).** `POST https://{region}-aiplatform.googleapis.com/v1/
projects/{project}/locations/{region}/publishers/google/models/{model}
:generateContent`. Workers has no Google auth library, so `resolveAuth` must
sign an RS256 JWT with `crypto.subtle`, exchange it at
`oauth2.googleapis.com/token`, and cache the access token for ~55 minutes.
Vertex does **not** return a cost field, so the spend cap needs a per-model
price table maintained in `image-engine.js`.

**Direct OpenAI (event-day option).** Same shape as OpenRouter, one fewer vendor
in the data path. Recommended over the broker for any sanctioned event that ends
up running without Vertex, since by then the model is fixed and the broker's
optionality is worth nothing.

### 7.5 Host model test and live switch

The effective model is **session state, not just quiz definition**. The host can
test and switch it from the title screen immediately before the quiz starts,
without returning to the authoring tool.

- `set_battle_engine(room_code, host_secret, provider, model)` writes the
  effective engine to session state. It validates the choice against
  *deployment allowlist ∩ round's `permittedModels`*. The host picks from a
  menu; the host never types a model string.
- **The Worker reads the effective model from session state, never from the
  request body.** A model name accepted from a client is the allowlist defeated.
- `POST /battle/test-image` runs one generation outside any battle round. It
  does not touch player budgets, does not create matchup entries, and **does not
  persist** — the image returns inline as base64 to the host only, who is
  already trusted with all quiz media. This sidesteps the `uploaded_by` question
  in §8 for the test path entirely.
- Rate limited: debounced client-side, plus a hard per-session cap of 10 test
  generations. The button costs real money per press.
- The panel displays `usage.cost` from the response, so the host can see actual
  per-image cost and reason about the round budget before starting.

Because the effective engine is persisted session state, a host refresh mid-quiz
resumes on the chosen model rather than silently reverting to the authored
default.

## 8. Data model — migration `0033`

```sql
alter type public.session_phase add value if not exists 'battle_prompt';
alter type public.session_phase add value if not exists 'battle_review';
alter type public.session_phase add value if not exists 'battle_vote';
alter type public.session_phase add value if not exists 'battle_result';

create table public.session_battle_matchups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  round_index integer not null,
  matchup_index integer not null,
  prompt_id text not null,
  prompt_text text not null,
  resolved_at timestamptz,
  unique (session_id, round_index, matchup_index)
);

create table public.session_battle_entries (
  id uuid primary key default gen_random_uuid(),
  matchup_id uuid not null references public.session_battle_matchups(id) on delete cascade,
  player_id uuid not null references public.session_players(id) on delete cascade,
  attempts_used integer not null default 0,
  submitted_asset_id uuid references public.media_assets(id),
  submitted_at timestamptz,
  vetoed_at timestamptz,
  veto_reason text,
  unique (matchup_id, player_id)
);

create table public.session_battle_generations (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.session_battle_entries(id) on delete cascade,
  attempt_index integer not null,
  player_prompt text not null,
  provider text not null,
  model text not null,
  asset_ids uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'failed', 'blocked')),
  block_reason text,
  cost_usd numeric(8,4),
  created_at timestamptz not null default now(),
  unique (entry_id, attempt_index)
);

create table public.session_battle_votes (
  id uuid primary key default gen_random_uuid(),
  matchup_id uuid not null references public.session_battle_matchups(id) on delete cascade,
  voter_player_id uuid not null references public.session_players(id) on delete cascade,
  entry_id uuid not null references public.session_battle_entries(id) on delete cascade,
  cast_at timestamptz not null default now(),
  unique (matchup_id, voter_player_id)
);
```

`player_prompt` is persisted for every attempt, successful or not. That is the
audit trail that makes the "trust but attribute" half of moderation real.

### 8.1 Required change to `media_assets`

`media_assets.uploaded_by` is currently `not null references auth.users(id)`.
Players are anonymous and have no `auth.users` row, so this must change:

```sql
alter table public.media_assets alter column uploaded_by drop not null;
alter table public.media_assets add column source text not null default 'author'
  check (source in ('author', 'battle'));
alter table public.media_assets add column generated_by_player_id uuid
  references public.session_players(id) on delete set null;
alter table public.media_assets add column expires_at timestamptz;
alter table public.media_assets add constraint media_assets_owner_present
  check (source = 'battle' or uploaded_by is not null);
```

The existing RLS policy `"Quiz authors can read media records"` uses
`is_quiz_author()` and will now also match battle rows. That exposes only
`storage_path` and `mime_type` to authenticated authors against a private
bucket, which is acceptable, but it should be a conscious decision recorded in
the migration comment rather than an accident.

The `quiz-media` bucket's `allowed_mime_types` must gain `image/webp` if it is
not already present, since generated images are requested as WebP.

## 9. RPCs

| RPC | Caller | Notes |
|---|---|---|
| `open_battle_round` | host | Idempotent pairing and prompt assignment |
| `set_battle_engine` | host | Validates against allowlist intersection |
| `authorize_battle_generation` | service_role | Budget + spend check, reserves attempt |
| `record_battle_generation` | service_role | Completes a reserved attempt |
| `refund_battle_attempt` | service_role | Provider failure or safety block |
| `submit_battle_entry` | player | Asset must be from this player's own generations |
| `veto_battle_entry` | host | Sets `vetoed_at` + reason |
| `cast_battle_vote` | player | Rejects duelists in their own matchup; phase-gated |
| `resolve_battle_matchup` | host | Counts votes, writes `score_events`, idempotent |
| `get_host_battle_state` | host | Roster, submissions, review grid, vote progress |
| `purge_expired_battle_media` | service_role | Returns expired storage paths for deletion |
| `finalize_battle_media_purge` | service_role | Deletes rows after the Worker removes the objects |

`submit_battle_entry` must verify the submitted asset ID appears in one of that
player's own `session_battle_generations.asset_ids`. Without that check a player
could submit an opponent's image or an arbitrary asset ID.

`cast_battle_vote` rejects votes from players who are entrants in the matchup
being voted on. Those players see an "on stage" screen instead.

## 10. Scoring

`resolve_battle_matchup` writes to the existing `score_events` table. No second
scoring path is introduced, so CSV export, the audit trail, and manual
adjustments continue to work untouched.

- Winner receives `winnerPoints`. On a tie, **every tied entrant receives the
  full `winnerPoints`** — a tie means both images landed.
- Every player who cast a vote in that matchup receives `voterPoints`.
- A vetoed entry cannot win. If all entries in a matchup are vetoed, the matchup
  is skipped, no winner points are awarded, and voters receive nothing because
  no vote took place.
- Resolution is idempotent and guarded on `resolved_at`, so a host double-click
  or refresh cannot double-award.

**Door multiplier interaction:** battle points are excluded from the
between-round door multiplier. The multiplier is designed for automatic trivia
scoring, and applying it to a popularity vote produces results that are hard to
explain on stage. Recorded here as a decision to confirm rather than an
assumption to discover later.

## 11. Media access and privacy

`can_access_live_media` is redefined in migration `0033`, superseding the `0029` definition. It
preserves every existing author, host, and option-artwork rule and adds:

- A **player** may fetch any asset from their own `session_battle_generations`
  rows, at any point in the round. This is how they see their own variants.
- A **player** may fetch the submitted assets of the **current matchup only**,
  and only while phase is `battle_vote` or `battle_result`.
- A **host** may fetch any battle asset in their own session, which is what the
  review grid and veto gate require.
- Presentation authorises with the host secret and is therefore covered.

A player must not be able to fetch another player's un-submitted variants, or
the submissions of a matchup that has not yet reached the screen. Both are
future-state leaks of exactly the kind `PRODUCT_SPEC.md` prohibits.

## 12. Retention

Battle assets are written with `expires_at = created_at + interval '30 days'`.
The host can export winners at any point in that window.

Purging is a two-step operation because storage objects cannot be deleted from
SQL: `purge_expired_battle_media()` returns the expired storage paths, the
Worker deletes those objects via the service role, and a follow-up call deletes
the `media_assets` rows.

This runs from a **Cloudflare Cron Trigger** — a `triggers.crons` entry in
`wrangler.jsonc` and a `scheduled()` export in `cloudflare-worker.js`. That is
new infrastructure for this repo, but it is small and it is the honest place for
a scheduled job. The fallback, if a cron is unwanted, is a lazy purge invoked
opportunistically on room creation.

Test-image generations never persist and therefore need no retention rule.

## 13. Client surfaces

**Player (`app.js`).** Prompt entry with a textarea and a Generate button; a
variant grid with attempts-remaining shown; a Submit control; then a waiting
state. During voting, two or three unlabelled images with tap-to-vote, or the
"on stage" screen if they are an entrant in the current matchup.

**Host.** Title-screen engine panel with model menu, Test button, and live cost
readout. During the round: a submission roster, the review grid with veto
controls, per-matchup vote progress, and the phase advance controls.

**Presentation.** Round title and progress during `battle_prompt` — never
images. Side-by-side images during `battle_vote`. Vote bars plus creator reveal
during `battle_result`. Rendered strictly from broadcast state, computing
nothing, per the projection invariant.

## 14. Failure states and recovery

| Situation | Behaviour |
|---|---|
| Provider error | Attempt refunded; "the image machine hiccupped, try again" |
| Safety block | Attempt refunded; reason surfaced; no point penalty |
| Session spend cap reached | Generation disabled with a clear message; already-submitted entries unaffected |
| Player never submits | Last generated image auto-submitted at lock |
| Player generated nothing | Entry forfeits; opponent wins by default; matchup still shown |
| Player disconnects mid-round | Same as forfeit; a three-way collapses to a duel |
| Both/all entries vetoed | Matchup skipped, no points |
| Host refresh | All state is in Postgres; resumes at `battleMatchupIndex` |

## 15. Testing

Following `CLAUDE.md`: `node:test`, no live external calls, contract tests
asserting against migration SQL text where the existing suite does so.

- `test/image-engine.test.js` — request construction and response parsing for
  each adapter, from recorded fixtures. Includes the safety-block and
  provider-error shapes.
- `test/battle-pairing.test.js` — pairing with even and odd counts, three-way
  formation, seed determinism, idempotency on repeat `open_battle_round`.
- `test/battle-scoring-contract.test.js` — asserts the migration awards winner
  points on ties, excludes vetoed entries, and guards on `resolved_at`.
- `test/battle-access-contract.test.js` — asserts the `can_access_live_media`
  SQL denies cross-player variant access and non-current-matchup submissions.
- `test/quiz-validation.test.js` — extended for the new round type; existing
  fixtures must still validate.

Live-loop verification is manual per `RUNBOOK.md`.

## 16. Cost and latency

Per-image prices verified 2026-08-17. Worst case assumes 20 players × 3 attempts
× 4 variants = 240 images per round.

| Model | Per image | Worst-case round |
|---|---|---|
| `black-forest-labs/flux.2-klein-4b` @ 512px | ~$0.004 | ~$0.90 |
| `google/gemini-3.1-flash-lite-image` @ 1K | $0.034 | ~$8 |
| `google/gemini-3.1-flash-image` @ 512px | $0.045 | ~$11 |
| `google/gemini-3.1-flash-image` @ 1K | $0.067 | ~$16 |
| `openai/gpt-image-2` (high) | ~$0.165 | ~$40 |

Recommendations: **FLUX.2 Klein for development** (a 10× saving across the
hundreds of throwaway images the build will consume — note there is no free tier
on Google's image models), **Gemini 3.1 Flash Image at 512px WebP for events**,
and **`variants: 2`** rather than 4, which halves the round cost for little felt
loss.

Latency budget: allow 5–15s per attempt, and a 3–4 minute `battle_prompt` phase.

Imagen 4 is **not** an option — deprecated, shut down 2026-08-17.

## 17. Prerequisites and open items

1. **Vertex service account (blocking, external).** Kaplan IT must confirm
   whether a downloadable service-account key is permitted or whether Workload
   Identity Federation is mandatory. WIF from Cloudflare is a materially larger
   project. An email covering this has been drafted separately.
2. **`n > 1` per model.** OpenRouter's docs note single-image providers reject
   it. The host test button resolves this empirically before any event.
3. **Vertex cost metering.** No cost field in the response; the spend cap needs
   a maintained per-model price table.
4. **Door multiplier exclusion** (§10) — decided here, worth explicit
   confirmation.
5. **Presentation preload.** Images should be fetched before the matchup appears
   to avoid a visible pop on the big screen.

## 18. Out of scope

Player-uploaded images of any kind. Image editing or reference images. Cross-
session galleries. Public sharing. Team play. Anything that gives a player a
path to put bytes of their own choosing into the room.

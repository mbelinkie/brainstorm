# Prompt Battle — consolidated technical approach

Date: 2026-08-26
Branch: `claude/prompt-battle-engine`

**This is the current source of truth.** It consolidates and, where they
disagree, supersedes:

- `2026-08-17-prompt-battle-design.md` (base design)
- `2026-08-24-prompt-battle-free-engine-addendum.md` (adapter contract, Workers AI)

Those remain worth reading for rationale. Where a number or interface here
differs from them, this document is correct — several things have changed
under contact.

## Approved approach — read this first

**Decided and approved. Do not redesign around this.**

Image generation for Kaplan events runs through a **thin proxy service on Cloud
Run inside Kaplan's own GCP project**, which calls Vertex AI using the attached
service account's ambient credentials. The Cloudflare Worker calls that proxy
with a shared secret. **No Google credential of any kind exists outside Google's
infrastructure.**

Approved by Kaplan IT (David) on **2026-08-26**, in these words: "Option 2
(deploying a thin proxy on Cloud Run) is the cleanest, most secure solution. It
keeps credentials entirely within GCP's boundary and avoids the need to maintain
an external OIDC issuer."

**Ruled out, with reasons — these are closed questions:**

| Option | Status |
|---|---|
| Downloadable service account key in a Worker secret | **Refused by Kaplan policy.** IT requires short-lived credentials. |
| Workload Identity Federation direct from the Worker | **Not technically possible.** Cloudflare Workers has no native workload identity (open feature request, not shipped), and Cloudflare Access's OIDC issuer authenticates users, not Workers. |
| Running our own OIDC issuer on the Worker to satisfy WIF | **Rejected on the merits.** It still requires a long-lived private signing key in a Worker secret — the same credential class, plus an identity provider to operate, plus Kaplan federating trust to a personally-operated IdP. |
| Cloud Run proxy | **APPROVED.** No key leaves Google. A leaked shared secret buys image generation through one endpoint and nothing else. |

**Granted on 2026-08-26** to `matthew.belinkie@kaplan.com` in project
`quiz-platform-image-generation` (number `796189298588`):
`roles/run.developer`, `roles/iam.serviceAccountUser`,
`roles/artifactregistry.writer`. Service account
`quiz-platform-image-gen-sa@quiz-platform-image-generation.iam.gserviceaccount.com`.
APIs enabled: `aiplatform.googleapis.com`, `iamcredentials.googleapis.com`.
Budget alert: $75/month.

**Nothing further is pending from Kaplan IT.** The one possible follow-up ask is
a Cloud Build role, and only if the local-build deployment route in section 5.5
fails.

### Which provider runs when

| Context | Provider | Why |
|---|---|---|
| Development, smoke-testing, CI | `workers_ai` | Zero credentials, zero approval, runtime binding |
| Kaplan events | `kaplan_proxy` | The approved path above |
| Non-Kaplan events, or playtesting at quality | `openrouter` | Gemini 3.1 Flash Image, ~$0.045/image, no approval needed |

All three sit behind one adapter contract (section 4.1), so switching is a
configuration change, not a rewrite.


## 1. What Prompt Battle is

A round type for the live quiz platform. Players are paired; each pair gets the
same comic prompt ("Depict the worst office party ever"). Each player writes
their own instructions to an image generator, iterates within a budget, and
submits one image. The room then votes blind on each matchup in turn, and
creators are revealed with the result.

Intended setting: internal Kaplan team-building events, 10–20 people. It is a
creativity game with no answer key.

## 2. Status

| Slice | State |
|---|---|
| **1 — adapter layer, Worker test route, host test panel** | Done, committed (`153bbda`, `d595a7b`) |
| **2 — schema, pairing, engine selection** | Built, **uncommitted in git**; migration `0036` **is applied to production** |
| 3 — player generation loop | Not started |
| 4 — submit + host review/veto | Not started |
| 5 — voting, scoring, presentation | Not started |
| 6 — retention, purge, export, recovery | Not started |
| Kaplan Cloud Run proxy | Approved and unblocked; not started (parallel track) |

`npm test` passes 363/363 with slice 2 in the working tree.

### Corrections to the older specs

- **Migration numbering.** The base spec says the battle migration is `0033`.
  It is **`0036_prompt_battle_rounds.sql`** — 0033–0035 shipped for unrelated
  work in the meantime. Later battle migrations are 0037+.
- **The Vertex adapter described in base spec §7.4 is obsolete.** No JWT
  signing, no token exchange, no 55-minute caching. Kaplan requires Workload
  Identity Federation, which Cloudflare Workers cannot satisfy, so the Vertex
  path is now a Cloud Run proxy (§5).
- **The adapter contract is plural**, per the addendum: `buildRequests()` →
  descriptor array, `parseResponses({ results, expectedVariants })`. The base
  spec's singular pair cannot express a provider needing N calls for N
  variants.

## 3. Decisions

Settled and not open for re-litigation during implementation.

| Decision | Choice |
|---|---|
| Participation | Quiplash model — everyone generates, server pairs them |
| Generation budget | Budgeted iteration: N attempts, 2–4 variants each, submit any one |
| Moderation | Host previews every submission and can veto before the room sees it |
| Attribution | Blind during voting, creators revealed with the result |
| Scoring | Winner points + small participation point for voting, via `score_events` |
| Odd player count | Final matchup becomes a three-way |
| Tie | All tied entrants get full winner points |
| Retention | 30 days, then auto-purge |
| Door multiplier | Does **not** apply to battle points |
| Credentials | Cloud Run proxy inside Kaplan's GCP. No keys leave Google. |

## 4. Image generation

### 4.1 The contract

`image-engine.js` is pure: no fetching, no side effects, no randomness. That is
what lets `test/image-engine.test.js` run entirely from fixtures, which
`CLAUDE.md` requires.

```js
ENGINES[provider] = {
  async resolveAuth(env),                        // { headers } and/or { binding }
  buildRequests(config),                         // Descriptor[]
  parseResponses({ results, expectedVariants })  // { images, costUsd, blocked, blockReason, partial }
}
```

Descriptors are inert data, in one of two kinds:

```js
{ kind: "http",    url, headers, body }
{ kind: "binding", binding: "AI", model, encoding: "json" | "multipart", payload }
```

The Worker's `runBattleDescriptor()` owns **all** I/O, executes descriptors
under `Promise.allSettled` (never `Promise.all` — one flaky variant must not
discard the others), and folds results back through `parseResponses`.

**Partial success rules.** One attempt = one call to `buildRequests`, whatever
the descriptor count. If at least one image returns, the attempt is consumed
and the player gets what succeeded (`partial: true`). If zero return, the
attempt is refunded. `blocked` is reported only when zero images returned *and*
a failure was a safety rejection.

### 4.2 Provider status

| Provider | State | Use |
|---|---|---|
| `workers_ai` | Built, working | Development and smoke-testing. Zero credentials. |
| `openrouter` | Not built | Events without Kaplan. Gemini 3.1 Flash Image, ~$0.045/image. |
| `kaplan_proxy` | Not built, unblocked | Kaplan events. See §5. |

### 4.3 Workers AI — what testing actually established

Four models are wired into the host test panel. **Findings from live testing:**

- **`flux-1-schnell` cannot handle complex compositional prompts.** It is a
  4-step distilled model; distillation is what trades away prompt adherence.
- **`lucid-origin` is not materially better**, despite Cloudflare documenting
  "exceptional prompt adherence" and exposing a `guidance` dial.
- **`flux-2-klein-4b` / `-9b` remain unmeasured.** The multipart fix moved the
  error from schema rejection (5006) to quota exhaustion (4006), proving the
  request validates — but **no klein image has ever been generated**.
- Working hypothesis: every Workers AI image model is diffusion-generation, and
  complex compositional prompts are where that family loses to newer
  multimodal models. Two of three have now failed identically.

**The free tier cannot host an event.** 10,000 neurons/day, resetting at
**00:00 UTC** (8 PM EDT, not local midnight). A 120-image round is ~3,840
neurons on klein but ~90,600 on lucid-origin. On Workers Free this is a hard
stop mid-round; Workers Paid ($5/mo) turns it into overflow billing at
~$0.011/1,000 neurons. **Workers Paid is required before any real event that
uses Workers AI.**

### 4.4 Per-model call profiles, and why they exist

These models do **not** share an input schema, and they **reject unrecognised
properties outright** rather than ignoring them — so a payload built for one
hard-fails on another. `WORKERS_AI_PROFILES` in `image-engine.js` owns protocol;
`BATTLE_MODEL_ALLOWLIST` in the Worker is purely deployment policy.

**Cloudflare's published documentation has been wrong three times.** Every item
below is what the live API did:

1. `flux-1-schnell` **rejects `seed`** ("Additional or unevaluated properties
   '/seed' at '/' not allowed") though the model page documents it.
2. `flux-2-klein-*` **will not accept JSON in any shape.** They require real
   multipart/form-data — `env.AI.run(model, { multipart: { body, contentType } })`
   where `body` is a form stream and `contentType` carries the MIME boundary.
   Cloudflare's own example shows flat JSON and is simply incorrect. This is why
   descriptors carry an `encoding` marker and the Worker builds the FormData.
3. Step parameter names differ: `steps` vs `num_steps`.

**Trust the host test panel over the documentation.** That is the durable
lesson, and it is why the panel was built first.

**Variant diversity does not need `seed`.** lucid-origin returns visibly
different variants from identical calls; model non-determinism supplies it. No
model is sent a seed.

## 5. The Kaplan path — Cloud Run proxy

### 5.1 Why this shape

Kaplan requires Workload Identity Federation rather than downloadable service
account keys. Cloudflare Workers has **no native workload identity** — it is an
open feature request, not a shipped capability — and Cloudflare Access's OIDC
issuer authenticates *users*, not Workers. The only way to satisfy WIF literally
would be to run our own OIDC issuer, which still means a long-lived private
signing key in a Worker secret: the same credential class we were avoiding, plus
an identity provider to operate.

A proxy inside GCP avoids the problem entirely. Cloud Run receives the service
account's credentials natively from the metadata server. **No key exists
anywhere outside Google.** Kaplan IT approved this as "the cleanest, most secure
solution" on 2026-08-26.

### 5.2 What has been granted

Project `quiz-platform-image-generation` (number `796189298588`), service
account `quiz-platform-image-gen-sa@quiz-platform-image-generation.iam.gserviceaccount.com`.

Roles on `matthew.belinkie@kaplan.com`:
`roles/run.developer`, `roles/iam.serviceAccountUser`, `roles/artifactregistry.writer`.

Enabled APIs: `aiplatform.googleapis.com`, `iamcredentials.googleapis.com`.
Budget alert: $75/month.

### 5.3 Proxy design

A single-purpose HTTP service. Its narrowness is the security argument — a
leaked credential buys an attacker image generation and nothing else.

```
POST /generate
  Authorization: Bearer <shared secret>
  { "prompt": "...", "model": "gemini-3.1-flash-image", "variants": 2 }
->
  { "images": [{ "mimeType": "image/jpeg", "bytesBase64": "..." }],
    "costUsd": 0.09 }
```

- Deployed to Cloud Run in the Kaplan project, with the service account
  **attached** — it uses ambient credentials, never a key file.
- Calls Vertex AI for `gemini-3.1-flash-image`.
- **Computes and returns `costUsd` itself.** Vertex returns no cost field, so
  the proxy holds the price table. This closes an open item from the base spec
  and keeps the session spend cap exact.
- Authenticated by a shared secret held as a Cloudflare Worker secret.
  Cloud Run is set to allow unauthenticated ingress with the check enforced in
  the application, because a Worker cannot present GCP IAM credentials — that
  is the same problem the proxy exists to solve.
- Must do exactly one thing. No file access, no arbitrary model routing beyond
  an allowlist, no passthrough of client-supplied URLs.

### 5.4 The `kaplan_proxy` adapter

Structurally the simplest adapter of the three: `kind: "http"`, static bearer
token, fixed endpoint, `parseResponses` reading `body.images` and `body.costUsd`.
All the complexity the base spec feared has moved into the proxy, where ambient
credentials make it disappear.

### 5.5 Deployment gap to resolve

`gcloud run deploy --source .` builds via **Cloud Build**, and no Cloud Build
role was granted. Two options:

1. Ask David for `roles/cloudbuild.builds.editor`.
2. **Avoid Cloud Build entirely** — build the container locally, push to
   Artifact Registry (`roles/artifactregistry.writer` is granted), then
   `gcloud run deploy --image ...`. This works with current permissions and
   needs no further requests.

Option 2 first; only ask David if it fails.

## 6. Data model

### 6.1 As built — migration `0036_prompt_battle_rounds.sql` (applied)

- Four `session_phase` values: `battle_prompt`, `battle_review`, `battle_vote`,
  `battle_result`.
- `session_battle_matchups`, `session_battle_entries`, both with RLS enabled and
  **explicit `grant select ... to service_role`** (this project has no blanket
  service_role SELECT).
- Columns added to `sessions`: `battle_shuffle_seed`, `battle_engine_provider`,
  `battle_engine_model` — so pairing is reproducible and the host's engine
  choice survives a refresh.
- Functions: `open_battle_round`, `set_battle_engine`, `get_host_battle_state`,
  and the shared `host_battle_state_payload` helper.

**Migration `0036` is applied to production.** Verified 2026-08-26 with
`npx supabase migration list --linked`: local and remote are paired for every
migration 0001-0036 with no divergence. Note that it was applied while its
source file was still untracked in git, so the ledger led the repository — the
file must be committed to keep migration history and production state in
agreement (`CLAUDE.md`). Applied enum values cannot be removed; PostgreSQL has
no `DROP VALUE`.

`open_battle_round` is **idempotent**: it returns an existing pairing rather
than reshuffling, and leaves `phase` alone. A host refresh must never
re-randomise matchups players have already begun.

### 6.2 Still to come

| Migration | Slice | Contents |
|---|---|---|
| 0037 | 3 | `session_battle_generations`; `media_assets.uploaded_by` nullable + `source`/`generated_by_player_id`/`expires_at`; `can_access_live_media` redefinition |
| 0038 | 5 | `session_battle_votes`; `resolve_battle_matchup` writing `score_events` |
| 0039 | 6 | Retention purge functions |

`media_assets.uploaded_by` is currently `not null references auth.users(id)`.
Players are anonymous, so slice 3 must drop that constraint, add a
`source` discriminator with a guard constraint, and re-check the existing
`"Quiz authors can read media records"` RLS policy against the widened match set.

## 7. Phase machine

`battle_prompt` → `battle_review` → then `battle_vote` ⇄ `battle_result`
**cycling once per matchup**, with position held in session state, so a host
refresh resumes at the right matchup.

Presentation shows the round title and progress during `battle_prompt` and
**never images**. Images appear only in `battle_vote` and `battle_result`, and
only for the current matchup.

## 8. Invariants this feature must not break

- Scoring is server-authoritative; battle points go through `score_events` like
  everything else. No second scoring path.
- Players never receive future state — not another player's un-submitted
  variants, not the pairing, not a matchup that has not reached the screen.
- Presentation is a strict projection; it computes nothing.
- Generated images are private media served only through the Worker proxy.
- Migrations are append-only and ordered. Never edit an applied migration.
- `quiz.sample.json` and `music-trivia.question-bank.json` must still validate.

## 9. Gotchas registry

Each of these has already cost time on this project.

- **Compare phases as `phase::text`** (migration 0025's precedent). A newly
  added enum value cannot be used in the same transaction that adds it.
- **`service_role` has no blanket SELECT.** Every table the Worker reads
  directly needs an explicit grant.
- **A clean `git status` proves nothing** — check `git stash list` and untracked
  files. Never `git add -A`.
- **Deploys ship the working directory**, so a stale checkout deploys silently.
- **Cloudflare's Workers AI docs are unreliable** (§4.4). Verify against the
  panel.
- **Workers AI free allocation resets at 00:00 UTC**, not local midnight.

## 10. Open questions

1. **Is the game fun?** Nobody has played it. This is the largest unknown and
   it is not resolved until slice 5. Everything else is a swappable component.
2. **klein's output quality**, and whether its *output* shape matches
   `body.image` — its response is documented as a "multipart object", so
   `parseResponses` may find nothing and report "no images" with no error.
3. **Is `open_battle_round` genuinely idempotent under a live host refresh?**
   Contract tests assert the guard exists; only a real room proves it works.
4. **Does flux-schnell's fixed output size present acceptably** on the big
   screen? No generated image has been viewed at presentation size.
5. `isWorkersAiSafetyRejection` still returns `false` — no real safety-rejection
   error has been captured from any provider.

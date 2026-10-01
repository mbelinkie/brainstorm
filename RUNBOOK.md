# Quiz Control — Development Runbook

## Current state

Quiz Control is a deployed live-quiz platform backed by Supabase Realtime. Local development mirrors the separation between the shared host screen and player phone screen. The local server exposes only the Supabase URL and publishable key; no secret key is sent to a browser.

Protected Supabase operations cover room creation, joining, state changes, submissions, scoring, leaderboard retrieval, host refresh recovery, and private media access. The public deployment has been rehearsed with real named-player joins.

## Start locally

The easiest option on a Mac is to double-click **Open Quiz Authoring.command** in this folder. It starts the server in the background and opens the authoring editor automatically; Terminal does not need to stay open. The editor reuses the authorized sign-in stored by that browser, so email-link authentication is normally needed only once per browser profile.

Or, from this folder:

```sh
npm run dev
```

Open these URLs in separate browser tabs on the same computer:

- Host / big screen: `http://127.0.0.1:4173/?view=host`
- Player / phone simulation: `http://127.0.0.1:4173/?view=player`
- Question-bank editor: `http://127.0.0.1:4173/author.html`

If you start the app with `npm run dev`, keep that terminal running. Opening `author.html` directly from Finder cannot start the server or load the JSON bank; use **Open Quiz Authoring.command** instead.

The two tabs synchronize instantly through `BroadcastChannel`; deployed clients also use the Supabase Realtime room channel. Participants on another network should join through the public deployment.

## Demo flow

1. In Host view, click **Start question** or press `N`.
2. In Player view, select an answer; selection questions save automatically.
3. In Host view, click **Reveal answer** or press `R` to lock, score, and reveal.
4. Click **Reset demo** to start again.

## Audio workflow for the production version

1. Open the big-screen host view in Chrome.
2. Start a Google Meet call.
3. Present the **browser tab**, then turn on **Share tab audio**.
4. Use the large audio control in the shared host view to play or replay each clip.
5. Never rely on autoplay; a host click or keyboard interaction must start audio.

Player phones will receive question state and answer controls, but not audio playback.

## Video rehearsal checklist

1. Apply migration `0032_video_media_assets.sql` before publishing a quiz with video.
2. In current desktop Chrome or Edge, trim a short MP4/MOV/WebM and confirm the rendered MP4 preview, dimensions, and duration in the private media library.
3. Open Host and Presentation as separate hosted tabs, click **Enable presentation media** in Presentation, then verify Play, Pause, Restart, and replay.
4. Share the Presentation Chrome tab in Google Meet with tab audio enabled. Confirm player phones receive neither an asset ID nor a usable video URL.

The raw source stays local. Do not put original video files or generated derivatives in Git.

## Content workflow

`quiz.sample.json` is the current source-of-truth shape for quiz content. It contains:

- One sample single-choice audio question
- Placeholders for the five planned rounds
- A fully shaped 10×10 piano-intro matching round, ready for real song titles and clip assets

Do not put revealing track names in audio filenames or public asset paths.

## Before deploying a change

Run `npm test`. If the change includes a database migration, follow the migration preflight and push procedure in [DEPLOYMENT.md](DEPLOYMENT.md). Rehearse room creation, a phone join, an answer submission, lock/scoring, and reveal before a real game.

## Hosted backend status

- Supabase project: `music-trivia-live` (US East, Free plan)
- The first music quiz question bank is published as version `1` and is the default quiz version in local development.
- The protected room flow has been verified against Supabase: create a room, join a player, open a question, save an answer, then lock and score it from the stored quiz key.
- Public deployment, real named-player joins, server scoring, and the shared leaderboard have been verified in a browser rehearsal. Continue using a short pre-game rehearsal until the full-format and audio-asset checkpoints are complete.

## Prompt Battle sample and host model test

### Fixture summary

`quiz.battle.sample.json` is a single-round Prompt Battle quiz:

- one `prompt_battle` round with 6 family-friendly prompts;
- engine `defaultProvider` `kaplan_proxy`, `defaultModel` `gemini-3.1-flash-image`, `permittedModels` containing only that model;
- `variants` 2, `attemptBudget` 3;
- scoring `winnerPoints` 100, `voterPoints` 10;
- `maxSessionSpendUsd` 20.

The authored `maxSessionSpendUsd` is configuration only. Enforcement in the generation pipeline is pending, and the current standalone host model-test path does not enforce the fixture cap. Kaplan's approval covers internal Kaplan activities only; its $75/month budget is an alert, not a hard cap.

### Offline validation

1. From the repository root, validate the fixture without any network call:

   ```sh
   node --input-type=module - <<'NODE'
   import { readFileSync } from 'node:fs';
   import { validateQuiz } from './quiz-validation.js';
   const quiz = JSON.parse(readFileSync('./quiz.battle.sample.json', 'utf8'));
   const errors = validateQuiz(quiz);
   if (errors.length) {
     console.error(errors);
     process.exit(1);
   }
   console.log('quiz.battle.sample.json is valid');
   NODE
   ```

2. Run the whole test suite:

   ```sh
   npm test
   ```

   This includes `test/quiz-battle-fixture.test.js`, which validates the sample, confirms both existing compatibility fixtures still validate, and rejects a duplicate prompt ID clone. Record the tested commit ID and paste the real output into the acceptance note.

### Loading and publishing

Current `main` will not load this fixture through the editor: `author.js` refuses battle rounds on both JSON import and Apply raw JSON to protect drafts. There is no supported alternate file replacement or manual bypass for this fixture; a static JSON file is not a hosted version until it is published through an authorized flow.

The editor import → validate → publish → host select → create room path is conditional on the editor support for battle rounds being accepted and merged (#42 / PR #53). Once that support is available on `main`:

1. Open the question-bank editor.
2. Import `quiz.battle.sample.json`.
3. Let the editor validate it; do not apply it if battle rounds are still refused.
4. Publish the quiz as a version.
5. In Host view, select the published Prompt Battle version, create a hosted room, and confirm a phone can join.

Do not attempt to load the fixture by replacing `quiz.sample.json` or through any undocumented file path.

### Required Worker secrets and provider configuration

Existing secrets consumed by the Worker:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The current Workers AI model-test path uses the `AI` binding and identifies its adapter as `workers_ai`; it does not use a provider API key. Future Kaplan proxy wiring will use these planned names (not read by current code):

- `KAPLAN_PROXY_SECRET` — shared Bearer secret
- `KAPLAN_PROXY_URL` — endpoint configuration

These entries are names only in this documentation and in any references that must not carry secret values. Matthew provisions actual server-side values through secrets management under the existing deployment process; deployed configuration must use those real provisioned values. This document includes no secret values. Never put secret values in browser config, `.env.local` served to browsers, or fixture files. There is no downloadable service-account key for the Kaplan project; access is via the attached Cloud Run credentials. Provisioning is owner-managed; see [DEPLOYMENT.md](DEPLOYMENT.md) for the required secrets workflow (do not deploy or apply migrations as part of this documentation).

### Current host model test

This test is available on the title-screen lobby only, inside the panel **Prompt Battle — test image model**. It is separate from a round and persists no battle entries.

1. Use the original Host tab of an owner-authorized hosted room. That tab holds the host credentials after the room is created. There is no separate "sign in as host" action; author sign-in is only for publishing. If you do not have an owner-authorized room, ask Matthew to create one and open its original Host tab for you.
2. On the title screen, find the **Prompt Battle — test image model** panel.
3. Choose an existing allowlisted Workers AI model from the menu. The current deployment allowlist is limited to Workers AI models (for example, `@cf/black-forest-labs/flux-1-schnell`, `@cf/black-forest-labs/flux-2-klein-4b`, `@cf/black-forest-labs/flux-2-klein-9b`, `@cf/leonardo/lucid-origin`); Gemini and `kaplan_proxy` are not present.
4. Type a family-friendly prompt.
5. Press **Test**.
6. Inspect the returned images inline, plus any partial, blocked, cost, or provider-error notices.

The test requests 2 variants per press. It is best-effort limited to 10 generations per room in the current isolate; the count is in-memory and not durable across restarts or multiple isolates. Current `costUsd` reports `$0` for the Workers AI free tier. This test path does not enforce the fixture's `maxSessionSpendUsd`.

### Local development warning and pending Kaplan work

`npm run dev` is not an isolated sandbox. With the normal local configuration it talks to the production Supabase project and the deployed Worker. Publishing a quiz, creating a room, or pressing **Test** are real writes or provider activity; do not perform that rehearsal without Matthew's authorization. This section documents the steps only; no actual live rehearsal was performed for this issue.

The current model menu and Worker allowlist do not include `gemini-3.1-flash-image`, and the Kaplan proxy adapter (#15) is not yet wired. Do not attempt to test `kaplan_proxy` or `gemini-3.1-flash-image` through any invented `curl` endpoint or UI route; that path is pending accepted integration and owner authorization. A future Kaplan rehearsal must wait for those changes.

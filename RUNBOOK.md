# Quiz Control — Development Runbook

## Current state

This is a local visual prototype with a Supabase Realtime transport connection. It demonstrates the intended separation between the shared host screen and player phone screen. The local server exposes only the Supabase URL and publishable key; no secret key is sent to a browser.

The current transport lets a host display state and collect submissions across connected clients. Protected Supabase operations now cover room creation, joining, state changes, submissions, scoring, and leaderboard retrieval; the next checkpoint is completing the player join/reconnect and deployment experience.

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

The two tabs synchronize instantly through `BroadcastChannel`; when loaded from a deployed copy of this app, they also use the Supabase Realtime room channel. A participant on another network still needs a deployed app URL, which is not set up yet.

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

## Content workflow

`quiz.sample.json` is the current source-of-truth shape for quiz content. It contains:

- One sample single-choice audio question
- Placeholders for the five planned rounds
- A fully shaped 10×10 piano-intro matching round, ready for real song titles and clip assets

Do not put revealing track names in audio filenames or public asset paths.

## Next implementation checkpoint

Add protected, server-authoritative room operations (create room, join, submit, lock, score, and reveal), then deploy the static app so teammates can join from their phones.

## Hosted backend status

- Supabase project: `music-trivia-live` (US East, Free plan)
- The first music quiz question bank is published as version `1` and is the default quiz version in local development.
- The protected room flow has been verified against Supabase: create a room, join a player, open a question, save an answer, then lock and score it from the stored quiz key.
- Public deployment, real named-player joins, server scoring, and the shared leaderboard have been verified in a browser rehearsal. Continue using a short pre-game rehearsal until the full-format and audio-asset checkpoints are complete.

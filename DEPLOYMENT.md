# Deploying Quiz Control

The app is a small Node static server. It does not need a private Supabase key: the browser receives only the project URL, publishable key, and default quiz version ID.

## Database migrations

Apply every file in `supabase/migrations` in numeric order before deploying a newer app build. Migration `0021_player_logos.sql` is required for player logo selection, and `0026_late_join_catch_up.sql` adds server-authoritative late-join boosts.

## Required environment variables

Set these at the hosting provider, not in source control:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
DEFAULT_QUIZ_VERSION_ID=...
```

## Private media proxy

After applying `supabase/migrations/0010_private_media_assets.sql`, set the Worker secret below before deploying. It is used only by the Worker to verify the host’s room secret and stream private media; never place it in `config.js` or `.env.local` served to browsers.

```text
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

The Worker reads `SUPABASE_URL` from the existing deploy environment. Configure it as a Worker secret too if it is not already available to the Worker:

```text
wrangler secret put SUPABASE_URL
```

The provider should set `PORT`; the server listens on it automatically. Use `/healthz` for a health check.

## Container deployment

The included `Dockerfile` works on any Docker-compatible service. Build and run locally with your chosen container workflow, then open the public URL on the host display and phones.

## Before a real game

1. Open the public host URL on the computer that will share its Chrome tab.
2. Create a hosted room and confirm a phone can join over cellular—not just the office Wi-Fi.
3. Confirm the host locks an answer and the leaderboard changes.
4. In Google Meet, share the browser tab and enable **Share tab audio**.
5. Keep the host tab open; free Supabase projects pause after inactivity and may take a moment to wake.

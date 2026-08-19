# Where things stand — 2026-08-18 (pausing for a few weeks)

Written for whoever picks this up next, including future-Matthew who will not
remember any of it. Plain language on purpose.

## Status in one line

`main` is fully merged, green (**255 tests, 0 failures**), backed up to GitHub,
and **not deployed**. Production is deliberately running an older build.

## What happened on 2026-08-18

Eight `claude/*` branches were merged into `main`, plus in-flight work that had
been sitting uncommitted. All worktrees were removed and all merged branches
deleted. Nothing was lost.

Three merges needed real judgment rather than mechanical conflict resolution:

- `presenterRenderKey()` moved from `app.js` into `quiz-core.js`. The `app.js`
  copy was dropped and `patchHostLiveRegions()` kept.
- `leaderboardRows()` keeps the host-render-gate split (so host standings patch
  in place) *and* ranks through `rankPlayers()` (so tied players share a place).
  Taking either side alone would have silently dropped one of the two fixes.
- `test/migration-hygiene.test.js` listed `session_players` as a known-missing
  grant. Migration `0033` closes that gap, so the exception was removed.

## The three things only a human can do

### 1. Apply migration 0033 — DO THIS BEFORE DEPLOYING

`0033_closest_number_player_names.sql` is committed but **has never been run
against the database**. It grants the Worker permission to read `session_players`.

The new code reads that table. If you deploy the new code without applying the
migration first, the closest-number guess board fails mid-show with a 502 —
exactly the failure mode in `mistakes.md #9`, which has now happened four times.

```bash
npx supabase migration list --linked
npx supabase db push --linked
npx supabase migration list --linked
```

The first and last commands must show every local migration paired with the same
remote version. If the histories diverge, **stop** and audit the live schema. Do
not run `supabase migration repair` reflexively.

### 2. Then deploy

```bash
npm run deploy
```

Deploys ship **the working directory**, not a git ref. Confirm the checkout is
current first (`git status --short --branch`, HEAD matching `origin/main`), or
you will silently ship old code with no error.

Do not trust `/__version` to confirm what shipped — its `deployedAt` is
wall-clock deploy time and `commit` is always `null`. Grep the live asset for a
marker instead:

```bash
curl -s https://brainstorm.matthewbelinkie.com/app.js | grep -c patchHostLiveRegions
```

`0` means the new code is not live; a positive number means it is.

### 3. Verify the host-sync banner in a real room

The banner that appears when a host-state save fails has **never been seen in a
live room**. It has no automated coverage of its appearance — only its retry
rule is unit-tested. Trigger a save failure with a host open and confirm the
banner appears, is readable, and its retry button works.

## What is parked

Branch **`claude/prompt-battle-slice-1`** holds unfinished Prompt Battle work,
rescued from a `git stash` and two untracked files that were loose in the
checkout. It is one feature in three pieces, now committed together.

It adds a `/battle/test-image` Worker route that makes **billed AI image
generation calls**. Do not deploy it as-is:

- the per-session cap of 10 test generations is an in-memory `Map`, so it is not
  durable across isolate restarts and not shared between isolates;
- `set_battle_engine` and the allowlist-intersection logic are not built;
- it is branched from `b85a1fd` (2026-08-17), so it predates the eight merges
  and needs a merge with `main` before work resumes.

Design doc: `docs/superpowers/specs/2026-08-17-prompt-battle-design.md`.

## Traps worth remembering

- **Never `git add -A` in this repo.** Deliberately-untracked in-flight work has
  lived in this checkout before; a blanket add committed it by accident once
  already on 2026-08-18 (caught and reverted).
- **Migration numbers are assigned by a human.** Parallel sessions collide on
  them and git cannot detect it.
- **Diagnostics exports are device-local.** A host-side export contains zero
  player-phone errors; cross-check Sentry (org `ead-ot`, project `javascript`).

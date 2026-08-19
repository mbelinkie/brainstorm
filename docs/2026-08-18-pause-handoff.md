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

### 1. Apply migrations 0033, 0034, 0035 — DO THIS BEFORE DEPLOYING

**Corrected 2026-08-18 (later the same day).** The original text below said 0033
had never been run against the database. That was wrong, and the correction
matters because it changes what is actually risky here.

Current status of each:

| Migration | In the repo | Applied to production | Effect of applying |
|---|---|---|---|
| `0033_closest_number_player_names.sql` | yes | **yes — applied by hand** in the SQL editor on 2026-08-18, before a live game, and verified | no-op; `grant` is idempotent |
| `0034_categorize_partial_credit.sql` | yes | **yes — applied by hand** the same morning, and verified live | no-op; byte-identical function body already live |
| `0035_prevent_double_scoring.sql` | yes | **NO — applied nowhere** | **real behavioural change.** This is the one to be careful with |

So the deploy hazard the original text warned about — the closest-number board
failing mid-show with a 502 — **is already closed.** The grant is live.

0034 exists to close a drift, not to change behaviour: a `create or replace` of
`lock_and_score_live_question` was applied by hand and no migration was written
for it, so the chain stopped describing the live database. Its function body was
diffed against the exact SQL that was pasted into production: identical. Applying
it changes nothing; **not** having it meant the next scoring migration built on
`0030` would have silently reverted categorize partial credit.

0035 is the only one that alters live behaviour. It stops a re-locked question
from double-awarding, stops a door reward from being re-randomised by a phase
reset, and refuses edits to already-locked submissions. Verify it (section 4).

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

### 4. Verify the migrations and the host-recovery work in a real room

None of this is behaviourally verified. There is no database in the dev
environment and the scoring tests only read migration SQL text, so a green suite
says the SQL *says* the right thing, not that it *does* it. Everything below
needs a throwaway room.

**Scoring (0035):**

- **Re-lock no longer double-awards.** One player, one scorable question. Answer
  correctly, Reveal, note the score. Apply a manual host adjustment. Jump back to
  the same question (`?testing=1`), Start, Reveal again. The manual adjustment
  must survive and the automatic points must not double. The RPC returns
  `replacedEvents: 1`.
- **Door rewards survive a phase reset.** Reach `door_choice`, players pick, host
  reveals, record the multipliers. Set the phase back and reveal again — every
  multiplier must be identical. Negative control: one player picks a *different*
  door and reveals; only that player re-rolls.
- **Categorize partial credit still works.** Place 7 of 10 items correctly on a
  question with `pointsPerCorrectItem`. Expect 7, not 0 and not 10.
- **Locked submissions refuse edits.** Answer, Reveal, reopen to `question_open`,
  try to change the answer on the phone. It must fail, and read as "answers
  closed" rather than as an error.

**Host recovery:**

- **Timer vs Reveal.** Start a 15s timer, press **R** in the last second. The
  reveal must complete with no modal alert.
- **Stale cue.** Cue a clip, let it finish, reveal, reload Presentation, click
  *Enable presentation media*. The old clip must **not** play. Then cue a new one
  and confirm it does.
- **Failed submission.** A manual-submit question with wifi off. Status must read
  "Not submitted", must survive another player's answer arriving, and must not
  turn green.
- **Empty round.** A quiz with an empty middle round — **N** must land on the
  next round that has questions.
- **Host refresh.** Reload the host tab mid-question; the answer count and the
  "Who got it right" summary must come back. **Needs the Worker deployed** — the
  `/host-submissions` route is new.

### 5. One known cosmetic gap

`styles.css` was outside the host-recovery worker's ownership, so the new
`submission-pending` / `-confirmed` / `-failed` / `-abandoned` classes have no
rules yet. Nothing is unstyled — the legacy `submitted` (green) and `locked`
(red) classes still carry the colour — but **a failed submission and a locked
question still look alike**. The states are now distinct in the DOM and in
behaviour; only the colour is not yet distinct. Worth closing before relying on
the failure state visually in a live room.

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

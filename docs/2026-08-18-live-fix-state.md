# Live-fix state — 2026-08-18

**Why this file exists:** two changes were applied directly to the production database
this morning, ahead of a live game. Neither is in `supabase/migrations/` yet, so
**production and the migration chain have diverged.** A fresh replay of
`supabase/migrations/` would rebuild a database missing both. This file records what was
applied, how it was verified, and what the repo still owes.

Repo baseline: `main` at `b58adb7`, clean apart from untracked
`image-engine.js`, `test/image-engine.test.js` (another agent's in-flight slice) and the
2026-08-17 review docs. Nothing below was merged, pushed, or deployed.

---

## 1. Applied to production, NOT yet a migration

### 1.1 `grant select on session_players to service_role` — owed as a migration

```sql
grant select on table public.session_players to service_role;
```

Fixes consolidated-plan finding **C8**. `cloudflare-worker.js:148`
(`/host-closest-number-guesses`) embeds `player:session_players(display_name,logo_key)`;
PostgREST needs `SELECT` on the table for `service_role`, and no migration ever granted it.
`service_role`'s `BYPASSRLS` bypasses policies, not grants.

**Status: VERIFIED BROKEN, then fixed.** The pre-change ACL was read directly:

```
{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}
```

`Dxtm` is TRUNCATE / REFERENCES / TRIGGER / MAINTAIN. **No `r`, i.e. no SELECT**, for
`service_role`. So MIG F6's prediction was right and the closest-number reveal wall *was*
broken in production. After the grant, the audit query below no longer lists
`session_players`.

**Blast radius was exactly one route.** `session_players` appears once in
`cloudflare-worker.js`. The Worker reads only four tables directly (`media_assets`,
`sessions`, `submissions`, `session_players`); everything else goes through
`security definer` RPCs, which execute as `postgres` and are unaffected by table grants.

### 1.2 `categorize` partial credit — owed as a migration

`create or replace function public.lock_and_score_live_question(...)`, copied from
`0030_multi_fill_in_the_blank_scoring.sql` with **exactly one branch changed**:

```sql
    elsif active_question ->> 'type' = 'categorize' then
      select count(*) into correct_pair_count from jsonb_each_text(coalesce(active_question -> 'correctCategories', '{}'::jsonb)) expected_category where answer_row.answer ->> expected_category.key = expected_category.value;
      if coalesce(active_question -> 'scoring' ->> 'pointsPerCorrectItem', active_question ->> 'pointsPerCorrectItem') is not null then
        awarded_points := correct_pair_count * coalesce((active_question -> 'scoring' ->> 'pointsPerCorrectItem')::numeric, (active_question ->> 'pointsPerCorrectItem')::numeric);
      elsif correct_pair_count = jsonb_object_length(coalesce(active_question -> 'correctCategories', '{}'::jsonb)) then
        awarded_points := coalesce((active_question -> 'scoring' ->> 'points')::numeric, (active_question ->> 'points')::numeric, 1);
      end if;
```

Previously all-or-nothing: a 10-item sort scored 10 only if all 10 were right, 0 otherwise —
while the live quiz declares `proportional_partial_credit` with `pointsPerCorrectItem: 1`
and the host script promises partial credit. Partial credit is **opt-in by the presence of
`pointsPerCorrectItem`**, so any categorize question without that field keeps the old
behavior byte-for-byte.

The ready-to-number file is at
`/private/tmp/claude-501/-Users-matthewbelinkie-Downloads/7d29d8c0-8489-49f4-a21b-e91b3258eb33/scratchpad/NNNN_categorize_partial_credit.sql`
(session scratchpad — **copy it somewhere durable before that directory is cleaned**).

**Status: applied and confirmed live by Matthew, 2026-08-18.** Re-check at any time with:

```sql
select prosrc like '%pointsPerCorrectItem%' as partial_credit_live from pg_proc where proname = 'lock_and_score_live_question';
```

**Rollback:** re-run `supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql`
verbatim. That file is still the definition of everything except the categorize branch.

### 1.3 Migrations owed

Head is `0032_video_media_assets.sql`; `0033` and `0034` are free. Matthew assigns the
numbers. Note that `claude/tests-and-spec` adds a grant test that pins C8 as a **known
exception** — landing the grant migration must remove that exception in the same commit or
the suite goes red.

### 1.4 Standing constraint this exposed

**This project's `public` tables do not carry Supabase's default `GRANT ALL`.** `anon`,
`authenticated`, and `service_role` all hold only `Dxtm`. Every new Worker direct-table read
therefore needs an explicit grant, and `0019`, `0023`, `0028` and now this one are all the
same lesson. The audit query that finds the next gap in ten seconds:

```sql
select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  and not has_table_privilege('service_role', oid, 'select') order by relname;
```

Currently returns `quiz_authors`, `quiz_versions`, `quizzes`, `score_events`,
`session_door_choices` — all fine, because nothing reads them outside `security definer`
RPCs. Re-run it after adding any Worker route that reads a table directly.

---

## 2. Branch state — three worktrees, none merged

Worktrees at `../quiz-<name>`, all based on `b58adb7`.

| Branch | Findings | Size | Tests |
|---|---|---|---|
| `claude/author-editor` | C19, C20, C21, C22 | 6 files, +162/−109 | 159 pass |
| `claude/tests-and-spec` | C30, C27, C18 fixture, C32 | 11 files, +872/−102 | 165 pass |
| `claude/presentation-correctness` | C17, C7, C6, C15, C9 | 12 files, +988/−58 | 189 pass |

**Recommended merge order** (smallest first, `npm test` between each):
`claude/author-editor` → `claude/tests-and-spec` → `claude/presentation-correctness`.
Real conflicts land last: `test/door-bonus.test.js` (tests-and-spec ‖ presentation) and
`test/reliability-contract.test.js` (author-editor ‖ presentation), plus the usual
union-resolved `CHANGELOG.md` and `docs/CLAUDE_WORKLOG.md`.

### Two commits deliberately not taken before the game

Both were confirmed to cherry-pick cleanly onto `b58adb7` in a scratch clone:

- `cc18475` — **C17**, `matchingBoard` printed a literal `${…}` on the shared screen.
  Two characters (single quotes → backticks) plus a new test file.
- `5256d44` — **C7 minimum fix**, never rank the closest-number board from the realtime
  partial subset; show an explicit failure instead.

Not deployed because §1.1 removes the condition that triggers C7, and deploying `app.js`
before a live show was the larger risk. C17 remains cosmetic-but-visible until deployed.

### Test-count discrepancy, resolved

The consolidated plan's "158 tests" was measured in the main checkout, which carries the
untracked `test/image-engine.test.js` (+9). A clean worktree at `b58adb7` is **149 tests,
148 pass, 1 fail** — the failure being `deploy-manifest.test.js` hunting the git-ignored
video bundle. `claude/tests-and-spec` fixes that properly, so future worktrees won't need
the copy-the-bundle workaround two sessions have now used.

---

## 3. Findings about the live quiz (Music Trivia v36)

**The live quiz is a published version in the database, not
`music-trivia.question-bank.json`.** The bundled bank has no `closest_number` question; the
live one does. Any triage run against the bundled file is invalid for live play.

- **Finale worth 100, not 50 — intentional, per Matthew.** The `multi_fill_in_the_blank`
  branch reads top-level `pointsPerBlank` (10) and ignores `scoring.pointsPerBlank` (5) and
  `maximumPoints`. The file's own `scoringSummary` still says 50 and `totalBasePoints: 250`;
  **that prose is now wrong and should be updated.**
- **`optionalTieBreak` is `numeric_estimate`, which scores zero for everyone.** Zero hits
  across all 32 migrations, no branch in `0030`, and it is keyed on `answer` — a field no
  code path reads (the working numeric type uses `targetNumber`). Do not use it until
  finding C5 is resolved.
- Every other type in the live quiz — `single_choice`, `short_answer`, `image_selection`,
  `multiple_choice`, `matching`, `fill_in_the_blank`, `multi_fill_in_the_blank`,
  `closest_number` — scores as authored. `matching` correctly reads top-level
  `pointsPerPair`.

---

## 4. Still open

- **C1 / batch A (authorization).** Parked by decision: hosts are anonymous today and
  Matthew is not currently bothered by it. Closing the answer-key leak implies a host
  sign-in flow, which is a feature.
- **C5** — finish `numeric_estimate` or retire it.
- **Batches B, F, H, I** from the consolidated plan, unstarted.
- **C23** deliberately skipped — same private-media preview area as the in-flight
  `image-engine.js` slice.
- Behavioral hazards with no fix yet, avoided by host discipline: the "Testing shortcut"
  jump control re-scores a scored question (**C4**); pressing Reveal at timer expiry aborts
  the reveal and kills auto-lock (**C16**); a host refresh mid-question zeroes the submitted
  counter (**C13**); a Presentation reload can replay a stale cue (**C14**).

## 5. Next actions, in order

1. Write §1.1 and §1.2 as numbered migrations; remove the C8 known-exception from the
   grant test in the same commit.
2. Add whatever regression coverage is feasible for §1.2 — there is currently **no test at
   all** for categorize scoring, and the repo's scoring tests only regex migration source
   text, so they cannot catch a behavioral change either way.
3. Merge the three branches in the order above.
4. Update the live quiz's `scoringSummary` prose to match the intentional 100-point finale.
5. `CHANGELOG.md` gets its user-facing lines only once the migrations land and the branches
   merge — nothing above is committed work yet.

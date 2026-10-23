# First backup: preparation for #55

Historical preparation record, updated 2026-10-23 (America/New_York). Owner:
Matthew. The first attempt failed; after the approved metadata correction, the
fresh backup, private Kaplan Drive round trip and owner-run local restore all
passed. Current procedures and final evidence are in [backups.md](backups.md).
Retention was approved on October 23. The cadence is on demand before every
event; #55 does not implement an automatic schedule. Matthew's External acceptance
remains pending. Earlier preparation statements below describe their time of
execution, not the final result.

## First actual run: failed media integrity check

Matthew ran the prepared backup command on October 23. The process has exited.
Its manifest reports database `ok`, media `failed`, originals/roadmap/restore
`skipped`, and overall `failed`. `verifyBackup` returns `FAILED_MANIFEST`.
The schema and public-data dumps are present. Thirty-one of 88 non-battle media
objects were downloaded; the 31st WAV is 2,021,596 bytes while the archived
catalog says 1,857,348. The tool correctly refuses that mismatch.

An offline replay through the existing `collectSupabase` reproduced
`Media size mismatch`; two minimized single-object replays reproduce it too.
The mismatched bytes do not duplicate any of the preceding downloaded objects.
Matthew's subsequent owner-run diagnostic read a fresh public dump and fetched
the same object again. It reports archived/current catalog sizes both 1,857,348,
fresh Storage size 2,021,596, identical bytes to the first download, and catalog
size still not matching Storage. The mismatch persists across separate reads.
Local WAV checks find a valid RIFF/WAVE container with declared size matching
the full downloaded file, format/data chunks present and chunk boundaries intact.
This supports stale size metadata; the historical operation responsible remains
unproven. No production data or archive manifest has been changed. The failed
archive remains private and must
not be uploaded as a successful backup. A later run needs a new private output
root; do not retry the initial block against its already-existing dated folder.

Separately, code inspection found `normalizeExistingLibraryAudio` replaces the
Storage object but updates MIME type/size only in browser memory, with no catalog
persistence. Bounded follow-up [#104](https://github.com/mbelinkie/brainstorm/issues/104)
was created in Inbox after open/closed duplicate searches. It has not been
dispatched; whether it historically caused this particular mismatch is unproven.

Separate read-only extraction captured counts for all four required tables from the
attempted archive's exact data dump, bound to that dump's SHA-256, in a private
sidecar outside the archive. These are failed-attempt source evidence only; no
restored counts or accepted backup are claimed.

Matthew completed this read-only diagnostic from the same worktree terminal:

```sh
node "$BRAINSTORM_BACKUP_ROOT/check-media.private.mjs"
```

This prepared private diagnostic uses the existing backup runner to dump public
data again and fetch only the mismatched object into a new private directory.
It prints archived/current catalog byte sizes, fresh object size, and two
comparison booleans. Its syntax check passed. It performed no production write.
The confirmed result is recorded above.

Before proposing any production correction, Matthew's next read-only command is:

```sh
node "$BRAINSTORM_BACKUP_ROOT/audit-media.private.mjs"
```

This syntax-checked private diagnostic uses the existing runner for a fresh
public-data dump and all non-battle media downloads into a new private folder.
It reports progress every ten files, retains full paths/checksums only privately,
and prints only counts, mismatch ordinals, kinds and byte sizes. It performs no
production writes. Matthew completed it: all 88 author-media objects downloaded,
zero download failures, 15 size mismatches, all in catalogued WAVs. Their audit
ordinals are 31–38, 40–41, 44, 46, 48, 54 and 60. All 15 downloaded WAVs passed
local RIFF/WAVE structural checks and matched the audit's SHA-256 values.

## Approved size correction: owner reports execution

Prepared `review-media-size-correction.private.sql` under the private output root
for Matthew's local review. It updates only `public.media_assets.byte_size` for
the 15 exact audited author-WAV paths, from each recorded old value to its actual
downloaded byte count. The audio files, MIME values and other data are untouched.
Full paths/SQL remain private; the audit report retains old/new sizes and hashes.

The transaction locks the target catalog rows, checks that their old size/type
and non-battle status still match, and verifies matching size/MIME metadata in
the corresponding `storage.objects` rows. It requires exactly 15 matches and
15 updates; any missing/changed row, metadata mismatch or write failure aborts.
Do not remove a guard to make the proposal run. Keep media replacement/authoring
idle through correction and the subsequent backup to avoid a new mismatch.

The exact proposed SQL passed five isolated PGlite fixture checks: successful
15-row correction with an unrelated row unchanged, changed catalog rejection,
changed Storage metadata rejection, missing-object rejection, and rollback on a
write failure. Those are local SQL-safety checks, not production execution.

Review the private proposal locally:

```sh
open -e "$BRAINSTORM_BACKUP_ROOT/review-media-size-correction.private.sql"
```

Matthew explicitly approved these 15 `byte_size` corrections on October 23.
A private approval record is bound to the reviewed SQL SHA-256. Under #55's
owner-run boundary, Matthew must execute the full transaction in the intended
production project's SQL editor and report its sanitized result. To copy the
approved SQL from the same terminal:

```sh
pbcopy < "$BRAINSTORM_BACKUP_ROOT/review-media-size-correction.private.sql"
```

Expected selected result: `corrected_rows = 15`; some editors may instead show
only the final transaction status. If it fails, run `ROLLBACK;` and report the
error category; do not run subsequent fragments separately or remove guards.
Matthew subsequently reported **15 rows updated**. The owner's result was
recorded privately against the approved SQL hash. The successful retry's fresh
dump independently confirms all 15 corrected catalog sizes. No product code fix
or archive edit has occurred.

## Fresh backup retry after the size correction

Prepared a new private output directory (mode `0700`), confirmed outside all
registered worktrees. The failed archive remains untouched. Docker still
responds. A syntax-checked shell wrapper invokes only the existing backup CLI
without originals, locates its sole new dated archive, and runs `--verify` only
if the backup exits successfully. It keeps full command output in a private log.

Matthew's next owner-run command, from the same terminal:

```sh
bash "$BRAINSTORM_BACKUP_ROOT/run-backup-retry.private.sh"
```

Expected final messages: `Backup command exited 0.`, `Backup verification passed.`,
and `Backup retry and verification completed.` The wrapper's private output
location record allows the agent to inspect the fresh manifest and compare the
15 corrected values against the approved plan without revealing paths or data.
Matthew ran the wrapper and reported all three success messages. Independent
`verifyBackup` passed too; all six manifest steps report `ok`. The archive holds
88 author-media files, with raw originals excluded. The `restore` step means
restore notes were generated, not that a restore rehearsal has passed.

Separate source-count evidence from this exact successful dump is bound to its
SHA-256 and the manifest SHA-256 privately: `quizzes` 4, `quiz_versions` 41,
`quiz_authors` 1, `media_assets` 88. A private transfer copy also passed archive
verification. The failed archive remains untouched and is not being uploaded.

## Kaplan destination verified on October 23

The supplied folder opens in Chrome and the internal browser under Matthew's Kaplan account. Its observed
name is **Brainstorm BACKUPS**, in My Drive, with Matthew as owner. The Details
pane says **Private to you**; the sharing dialog lists only Matthew and General
access **Restricted**. The folder is empty. No access settings changed and no
backup had been uploaded at that initial check. The October 23 verified dated
folder subsequently uploaded through the internal browser: Drive reports one
upload complete, 97/97 items including directories. The dated folder also shows
Private to you. A fresh Drive ZIP download contains all 94 files; after safe
extraction, `verifyBackup` passes and the manifest, schema and data dump hashes
match the original verified archive. The restore will use this downloaded copy.
The folder's URL/ID is deliberately omitted here.

The connected Drive plugin is now available, but authenticates to Matthew's
personal Google account and returns `NOT_FOUND` for the Kaplan folder. Browser
access works through the Kaplan account, so the folder need not be shared with
the personal account for this task.

## Confirmed preparation

- Dedicated branch: `codex/backups-55`, from `main` commit
  `2ca966729250d4e96b99af867ac4ad0bc78f98b2`.
- #7 is closed, Done and accepted. #55 passed `ready --dry-run`, was promoted
  under Matthew's explicit start authorization, and was claimed by native
  execution `01a13886-d27f-7f53-b822-25f977fa1385`.
- Claim routing: Sol (`gpt-6.1-sol`), actual high effort, with a written
  coordination mismatch; issue labels remain `model:standard` / `effort:low`.
- Docker CLI 29.9.0 and daemon 29.5.2 respond after starting the existing
  Colima instance. No new VM or hosted resource was created.
- The worktree's existing project link matches published `config.js`.
  On October 23, `supabase projects list --output json` succeeded with the
  existing owner-managed login and confirmed access to the linked project.
  Only success/access booleans were reported; project listings and credentials
  were not printed. Database dump access is still unverified.
- Supabase CLI 2.120.0 was installed with Matthew's approval on October 13,
  then updated to 2.122.0 on October 23 at his request. Homebrew installation
  was blocked by outdated Command Line Tools, so the official macOS Intel
  release binaries were installed directly. The October 23 release SHA-256
  matched GitHub's official release digest; both `supabase` and `supabase-go`
  were installed, and the previous executable was preserved privately.
  The existing backup runner reports 2.122.0. Installed help confirms the dump
  and experimental Storage copy flags used by the backup tool.
- The earlier October 23 check found Drive integration uninstalled; it is now
  connected to the personal account. Kaplan browser access/privacy is verified
  above; no copy is claimed.
- A new private local output root was prepared with mode `0700`, outside all
  registered worktrees. Its absolute path is not recorded here.
- An empty, gitignored `music quiz originals/` directory was created in this
  worktree because the current tool requires that directory even when originals
  copying is disabled. No original file or inventory was imported from the
  primary checkout. The resulting archive will not protect raw originals.
- `npm ci` completed without lockfile changes. `npm test`: 977 passed, zero
  failed/skipped. `node --test test/backup.test.js`: 23 passed, zero failed.
- Existing `runBackup(..., { dryRun: true })` planned database, media, originals,
  roadmap, restore and integrity steps with originals excluded. It created no
  archive and did not contact production.
- October 23 recheck: focused backup tests passed 23/23, document secret scan
  and `git diff --check` passed. A separate private disposable restore directory
  was initialized with `supabase init`, no production project link and no copied
  migrations. Its Postgres major is 17, matching the existing cached source
  metadata; confirm compatibility against the actual dump before loading data.
  The stack has not been started and loopback binding still needs review.
  Its location is retained only in `restore-location.private.txt` under the
  private output root.

## Owner setup and first backup

The issue explicitly reserves production backup and restore execution to Matthew.
The agent guides and verifies results. Keep all provider sign-in and password
entry in the owner's terminal/browser; never paste credentials here or on GitHub.
The runner deliberately strips credential environment variables from its child
processes, so an environment variable alone is not proof that it can authenticate.

The CLI is now installed and updated. Check its version without reinstalling:

```sh
supabase --version
```

The installed version and required help flags were verified on October 23.
Matthew uses `supabase login` only if authentication expires. Confirm the linked
project in his dashboard before dumping; do not relink to an inferred ID.

The following initial block is retained as execution evidence; it has now been
run and failed. Do not rerun it unchanged against the occupied destination.
From this dedicated worktree, Matthew ran the following after setup. The output
root expression identifies the private directory prepared for this execution;
do not print its expanded value or share the private log.

```sh
umask 077
BRAINSTORM_BACKUP_ROOT="$HOME/Library/Application Support/Brainstorm Backups/01a13886-d27f-7f53-b822-25f977fa1385"
BRAINSTORM_BACKUP_DATE="$(date -u +%F)"
if node scripts/backup/backup.mjs --out "$BRAINSTORM_BACKUP_ROOT" > "$BRAINSTORM_BACKUP_ROOT/backup-run.private.log" 2>&1; then
  printf 'Backup command exited 0.\n'
else
  printf 'Backup command failed; keep the private log local.\n'
fi
```

Only after the backup command succeeds, verify the dated folder (if the run
crossed UTC midnight, confirm the actual folder date privately):

```sh
node scripts/backup/backup.mjs --verify "$BRAINSTORM_BACKUP_ROOT/brainstorm-backup-$BRAINSTORM_BACKUP_DATE"
```

Expected verification output: `Backup verification passed.` Inspect only sanitized
manifest status/step summaries for shared evidence. A manifest step called
`restore` means restore notes were written; it does not mean a restore was tested.
Do not use `--include-originals` without a separate Kaplan policy decision and
approved source preparation.

## Drive and restore preparation and completed checklist

October 23 progress: Matthew started the separate disposable stack. Image pulls
hit a transient registry rate limit but subsequently completed; startup succeeded.
Actual Docker port bindings for the API, database, Studio, mailbox and analytics
are all `127.0.0.1`, using the dedicated loopback-default Docker network. Read-only
queries confirmed PostgreSQL 17, zero public base tables, zero auth users and zero
Storage buckets. There is no production link in this disposable directory.

Prepared the owner-run `run-local-restore.private.mjs` outside the repo. Its
syntax check and read-only `--check` preflight passed. It rechecks archive/source
hashes, target identity, empty database and loopback ports; restores archived
schema plus one local auth UUID placeholder and public data in a transaction;
and compares all four counts before commit. A derived input removes the dump's
`session_replication_role = replica` setting, retaining all 20 foreign keys and
enforcing them during the load. The archive itself is unchanged. It then validates
a restored quiz and round-trips all 88 media objects through a private local
Storage bucket, checking manifest hashes. Matthew has been given the command;
Matthew subsequently ran it successfully: all four counts match (4/41/1/88), the
restored quiz validates with zero errors, all 20 foreign keys are validated, and
88 media objects were uploaded/downloaded with zero checksum mismatches. The
agent independently confirmed the counts, quiz validation and private bucket.

1. Matthew signs into Kaplan Google Drive and identifies an owner-private folder.
   Record its name and effective readers, including inherited permissions; prove
   General access is Restricted and no non-owner access is granted. Keep folder
   links and raw backups private. Upload the complete verified dated folder, then
   obtain a fresh private download for the restore and run `--verify` on it.
2. Before restoring, capture the four source counts from that exact archived
   `database/data.sql`, with its SHA-256. Never substitute a later live query.
   `MANIFEST.json` contains no table counts. On October 13 Matthew explicitly
   approved separate count evidence tied to the exact dump's SHA-256; #55's
   scope and acceptance were updated through the GitHub gate and re-read.
   All four restored counts must match this evidence. Do not edit an archive
   manifest to fabricate counts.
3. Use the separately initialized private disposable directory, with no
   production link or copied migrations. Confirm the source PostgreSQL version
   against the actual dump and review ports and loopback exposure, then Matthew
   runs `supabase start` there. Save its credential-bearing output privately.
   Do not start the stack from this production-linked worktree.
4. Once the actual schema is available, review exact local-only restore commands
   against the confirmed disposable container. Load the archived public schema,
   recreate the auth user UUIDs referenced by public foreign keys locally, then
   load public data with stop-on-error. Auth users/credentials are excluded from
   the archive; no production auth recovery is claimed. Do not disable foreign
   keys to make a restore look successful.
5. Compare all four restored counts:

   ```sql
   select 'quizzes' as table_name, count(*) as rows from public.quizzes
   union all select 'quiz_versions', count(*) from public.quiz_versions
   union all select 'quiz_authors', count(*) from public.quiz_authors
   union all select 'media_assets', count(*) from public.media_assets;
   ```

   Export a restored `quiz_versions.definition` privately and pass it to
   `validateQuiz` from `quiz-validation.js`; report only the number of validation
   errors. Restore author media into a private local `quiz-media` bucket, download
   the restored objects, and compare every restored file with its archived
   manifest SHA-256. Battle-generated payloads are excluded; table counts do not
   establish that battle images were backed up.
6. Record exact commands, exit results, source/destination count comparison,
   quiz validation, media checksum totals, Drive privacy and round-trip integrity
   as sanitized evidence. This checklist passed on October 23; the final commands,
   hashes and results are recorded in [backups.md](backups.md).

## Decisions and final documentation

Matthew approved the proposed retention rule on October 23: keep the last three
runs plus one per month for six months. This records the rule; no backup is
deleted during this task. Raw originals remain excluded pending Kaplan policy
approval. Cadence remains on demand before every event, as decided October 1;
an automatic schedule is outside #55.

Completed the actual-service runbook in `docs/ops/backups.md`, added backup to
`DEPLOYMENT.md`'s pre-game checklist, corrected the stale repository name in
`PRODUCT_SPEC.md`, and reconciled the verified status in the secrets inventory.
External acceptance remains Matthew's step on #55.

References: [issue #55](https://github.com/mbelinkie/brainstorm/issues/55),
[secrets inventory](secrets-and-recovery.md),
[Supabase local stack](https://supabase.com/docs/guides/local-development/cli/getting-started),
[Supabase backup/restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

# Backups and restore rehearsal

Owner: **Matthew**. First successful backup and restore rehearsal: **2026-10-23**
(America/New_York), tracked in [#55](https://github.com/mbelinkie/brainstorm/issues/55).
The rehearsal restored a fresh download from Kaplan Drive into a disposable local
Supabase stack. Matthew's External acceptance of #55 is still required.

## Location, access and retention

- Kaplan Google Drive → My Drive → **Brainstorm BACKUPS**. The first dated folder
  is **brainstorm-backup-2026-10-23**. Keep the folder link private.
- Matthew owns the destination. The parent sharing dialog showed only Matthew,
  General access **Restricted**; both parent and uploaded dated folder showed
  **Private to you**. No access settings were changed.
- Cadence: **on demand before every event**, decided by Matthew on October 1.
  No automatic backup schedule or automatic upload is configured by #55.
- Retention: **keep the last three runs plus one per month for six months**,
  approved by Matthew on October 23. Matthew reviews retained copies manually;
  no backup was deleted during this work.

## Scope

The existing `scripts/backup/backup.mjs` archives the Supabase public schema and
data, author quiz-media objects, roadmap JSON, restore notes, and a manifest with
file sizes and SHA-256 hashes. Its secret scan must pass. Public data includes
quiz answers and operational history, so the whole archive stays private.

Excluded from the proven backup:

- Raw music originals: no payload was copied. Kaplan policy approval is still
  needed before using `--include-originals`. The tool records an originals
  inventory; an inventory is not a copy of the original files.
- Auth schema, auth-user credentials, provider credentials, local environment
  files and Worker secrets. Reissue credentials through their issuers; see
  [secrets and recovery](secrets-and-recovery.md).
- Battle-generated image payloads. Public catalog/history rows do not establish
  that their image bytes are recoverable.
- Source-code recovery: use the GitHub repository and the archive's recorded
  source commit. The data archive is not a source checkout or a deployment.

## Run a backup

Matthew runs production commands. Use the intended production-linked checkout,
owner-managed Supabase and GitHub CLI logins, and a working Docker daemon.
The tested Supabase CLI version was **2.122.0**. Pause media replacement/authoring
through the dump and media copy so catalog metadata and object bytes stay aligned.

Set `BRAINSTORM_BACKUP_ROOT` privately to an owner-only folder outside every source
checkout. From the repository root, create a fresh output directory for each run:

```sh
umask 077
BRAINSTORM_RUN="$(mktemp -d "$BRAINSTORM_BACKUP_ROOT/run-XXXXXXXX")"
node scripts/backup/backup.mjs --out "$BRAINSTORM_RUN" > "$BRAINSTORM_RUN/backup.private.log" 2>&1
```

The runner creates `brainstorm-backup-YYYY-MM-DD` using UTC. Set `ARCHIVE` to that
actual dated folder, then run:

```sh
node scripts/backup/backup.mjs --verify "$ARCHIVE"
```

Expected: backup exit 0 and `Backup verification passed.` All six manifest steps
must be `ok`. The manifest's `restore` step means notes were generated; only a
separate rehearsal proves a restore. Keep logs local, and upload only the verified
dated folder to the private Kaplan destination. Download a fresh copy from Drive,
extract it privately, and run the same verification on that copy.

The tool requires its configured originals directory to exist even when payload
copying is off. This rehearsal used an empty, ignored originals directory in the
dedicated worktree. A failed attempt stays separate: do not overwrite it, edit its
manifest, or upload it as a successful run. If a media-size check fails, audit the
catalog/object mismatch before any owner-approved repair; do not weaken the check.

## Restore procedure used

This is a disposable **local** rehearsal. A production restore requires a separate
owner-approved recovery plan. Never run a reset, restore, link or migration repair
against production to reproduce these steps.

1. Verify the fresh Drive download before loading it. Capture counts for
   `quizzes`, `quiz_versions`, `quiz_authors` and `media_assets` from its exact
   `database/data.sql` COPY blocks and record that file's SHA-256. The manifest
   contains file hashes, not table counts; do not substitute a later live query.
2. Initialize a separate private directory with `supabase init`. It must have no
   production project link, no copied migrations and an empty public schema.
   Use PostgreSQL 17 for this archive. The owner started it with:

   ```sh
   supabase start --workdir "$RESTORE_WORKDIR" --network-id "$RESTORE_NETWORK"
   ```

   The dedicated Docker bridge used the option
   `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`. Inspect actual
   `NetworkSettings.Ports` for every container before loading data; the five
   published services in this run all bound to `127.0.0.1`. Also confirm the
   target's exact container ID/project label, empty public tables, empty auth
   users and empty Storage buckets. Keep CLI output containing local credentials
   private. Initial image pulls hit a registry rate limit, then completed.
3. Prepare a private SQL file containing only the auth UUIDs referenced by
   `media_assets.uploaded_by` and `quiz_authors.user_id`:

   ```sql
   INSERT INTO auth.users (id) VALUES ('<referenced UUID>'::uuid);
   ```

   One placeholder UUID was needed in this rehearsal. These local placeholders
   establish referential integrity; they do not restore accounts, passwords,
   identities or working sign-in.
4. Make a derived data input outside the archive that removes only the exact
   `SET session_replication_role = replica;` line, and explicitly sets
   `session_replication_role = origin`. Preserve every COPY row and the original
   archive. Load schema, placeholder UUIDs and strict data into the confirmed
   local database in one transaction, using stop-on-error:

   ```sh
   docker exec -i "$LOCAL_DB_CONTAINER_ID" psql -X -U postgres -d postgres -At --set ON_ERROR_STOP=1
   ```

   The private input begins with `BEGIN;`, includes those three inputs in order,
   checks all four counts and validated foreign keys, then ends with `COMMIT;`.
   The actual dump's COPY order worked with all 20 foreign keys enabled. No
   constraint was disabled or removed. A failed command aborts; do not continue
   with individual fragments to bypass an error.
5. Query the four restored counts and compare them with the exact dump evidence:

   ```sql
   SELECT 'quizzes' AS table_name, count(*) AS rows FROM public.quizzes
   UNION ALL SELECT 'quiz_versions', count(*) FROM public.quiz_versions
   UNION ALL SELECT 'quiz_authors', count(*) FROM public.quiz_authors
   UNION ALL SELECT 'media_assets', count(*) FROM public.media_assets;
   ```

   Export the newest restored `quiz_versions.definition` privately and pass its
   parsed JSON to `validateQuiz` from `quiz-validation.js`. Require zero errors.
   Check `pg_constraint` to confirm all restored public foreign keys are validated.
6. Recreate a **private** local `quiz-media` Storage bucket. Obtain local-only
   credentials in memory through `supabase status --workdir ... --output json`;
   do not copy production credentials. Through the loopback Storage API, upload
   each archived author-media object with its catalog MIME type and original
   storage path, download it again, and compare its bytes with the manifest's
   SHA-256 and size. Reject redirects and any non-loopback destination.

For this run, Matthew executed the prepared private wrappers:

```sh
bash "$BRAINSTORM_BACKUP_ROOT/run-backup-retry.private.sh"
bash "$BRAINSTORM_BACKUP_ROOT/start-local-restore.private.sh"
node "$BRAINSTORM_BACKUP_ROOT/run-local-restore.private.mjs"
```

These were one-off operating commands outside the repository, using the existing
backup tool. Full inputs, object identifiers and logs remain private; no new
backup/restore product tooling is added by #55. The disposable stack remains
available for owner review; it has not been stopped or deleted.

## Recorded result — October 23, 2026

Backup retry: exit **0**, all six steps **ok**, verification **passed**. Drive:
**97/97 items** uploaded, including directories; a fresh download contained all
**94 files** and passed verification. Manifest, schema and data hashes matched the
original archive.

| Table | Exact archived source | Restored local |
| --- | ---: | ---: |
| `quizzes` | 4 | 4 |
| `quiz_versions` | 41 | 41 |
| `quiz_authors` | 1 | 1 |
| `media_assets` | 88 | 88 |

- Archived public data SHA-256:
  `c38d307fdbdd60693dab5d206ad5f6d8b7dce57f5322e55bea5545504f56970c`.
- Manifest SHA-256:
  `76f58c67b222dc2b6d0e1a52711d0cac58d09d599b13a6a21fdcae98731843c6`.
- Restored quiz validation: **0 errors**.
- Restored media: **88 uploaded and downloaded, 0 checksum mismatches**.
- Foreign keys: **20/20 validated**. Local bucket private; all published ports
  loopback-only. Matthew reported the passing final JSON; the agent independently
  verified the four database counts, quiz validation and private bucket state.

Before this successful run, Matthew approved and executed corrections to 15
audited WAV catalog byte sizes; the fresh dump confirms them. No audio bytes were
changed. The underlying catalog-persistence fix remains separately tracked in
[#104](https://github.com/mbelinkie/brainstorm/issues/104).

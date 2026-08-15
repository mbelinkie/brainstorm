# Mistakes and Lessons Learned

This is a candid retrospective based on the project changelog. It focuses on patterns that caused rework, risk, or avoidable complexity—not on assigning blame. Where the changelog records a symptom but not its root cause, the lesson below is explicitly framed as an inference.

## 1. I built too many interconnected systems before hardening the core loop

The first major release combined hosted rooms, authentication, publishing, scoring, timers, presentation mode, nine question formats, private media, audio control, authoring, exports, diagnostics, and deployment. The following days were dominated by fixes to interactions among those systems.

The mistake was not ambition; it was integrating too many stateful features before the basic host → player → presentation loop had a small, stable contract and an end-to-end test matrix.

### What to do next time

- Ship a thin vertical slice first: join, show one question, submit, lock, reveal, score, advance, recover after refresh.
- Make every later feature prove that it preserves that loop.
- Define release gates for host refresh, player retry, presentation reconnect, and stale-tab behavior before expanding question types or media features.

## 2. I treated media as a UI feature when it was really an authorization and lifecycle system

Private media needed storage policies, Worker authorization, room/version references, author previews, metadata, source originals, optimized derivatives, deletion rules, and different visibility rules for questions versus reveals. Several follow-up fixes show that these concerns were initially coupled too loosely:

- private images were falsely marked unavailable when metadata was late or missing;
- newly uploaded images needed a local derivative to preview immediately;
- same-browser host and presentation tabs did not initially share the credentials needed to load media;
- database privileges and Supabase credential-header behavior needed correction;
- legacy image placeholders and removed captions left broken or blank UI states.

The likely root mistake was using media-library metadata as though it were the source of truth for whether an attachment was valid. A referenced asset ID, its authorization, its storage object, and its optional descriptive metadata are separate states.

### What to do next time

- Design an explicit media state machine before building controls: local source, processing, uploaded, referenced, authorized, available, missing, and deleted.
- Treat metadata enrichment as optional; never use it alone to decide whether a valid referenced asset exists.
- Specify access rules by role and game phase in a table before implementation.
- Test every media role independently: title, question, option, matching target, reveal, and audio.
- Test fresh upload, refresh, reconnect, missing metadata, missing object, expired authorization, and legacy records.

## 3. I did not make cross-tab audio commands self-identifying from the start

Presentation audio first retained the initial clip, then host commands were updated to identify the exact authored question and matching clip. This indicates that early commands described an action such as “play” without carrying enough identity to reject stale state.

### What to do next time

- Make every distributed command self-contained: room ID, quiz-version ID, question ID, media ID, command ID, and sequence or timestamp.
- Make commands idempotent and ignore commands older than the last applied sequence.
- Test cue A → cue B, restart, pause, reconnect, rapid navigation, duplicate delivery, and two open presentation tabs.
- Separate browser autoplay setup from playback synchronization in the original design.

## 4. I allowed the client to imply success before the server confirmed it

Player submission feedback initially appeared successful before server confirmation. Failed answers then had to be changed so they remained visibly unsubmitted and retryable.

For a server-authoritative quiz, optimistic success is the wrong default for irreversible actions. It creates ambiguity precisely when network reliability matters most.

### What to do next time

- Model submission as `idle → sending → accepted` or `idle → sending → failed`.
- Do not show locked-in success until the server returns the accepted submission ID or authoritative state.
- Preserve the response on failure and make retry obvious.
- Add tests for timeout, duplicate submit, late success, rejected submit after lock, reconnect, and retry.

## 5. I hardened privacy after the payload surface had already expanded

The changelog later introduces an explicit player-state allowlist and calls out the removal of answer keys, reveal notes, audio URLs, cue notes, and future questions. It also later adds explicit authorization for current-question images without weakening reveal-media privacy.

Although the changelog does not say that private data leaked, the safer architecture would have started with role-specific response models. Removing sensitive fields after features accumulate is brittle because every new server-side field can become client-visible by default.

### What to do next time

- Use allowlisted serializers for player, host, presentation, and author payloads from day one.
- Default new fields to server-only until deliberately exposed.
- Define phase-based visibility for lobby, answering, locked, revealed, between-round, and completed states.
- Keep contract tests that inject sentinel secrets into every sensitive field and prove they never reach unauthorized clients.

## 6. I relied on happy-path asynchronous state in the authoring experience

Drafts and previews exposed several timing problems: temporarily invalid drafts were not preserved across refreshes, media was labelled unavailable before the library finished loading, and immediate previews depended on a later library refresh.

The underlying mistake was conflating “not loaded,” “invalid,” and “missing.” Those states require different UI and persistence behavior.

### What to do next time

- Give asynchronous resources explicit `idle`, `loading`, `ready`, `error`, and `missing` states.
- Persist in-progress drafts even when they are temporarily invalid; validate at publish/export boundaries.
- Preserve last-known-good data while refreshing instead of replacing it with an error placeholder.
- Write refresh/recovery tests that interrupt editing during upload, validation failure, and metadata loading.

## 7. I did not define Presentation as a strict projection of authoritative state early enough

Presentation accumulated fixes for stale audio, typed-answer reveals, private media access, reveal-image composition, duplicated labels, blank caption panels, QR/preflight visibility, and answer stability during retries (as reflected in the later commit history).

These are signs that Presentation had too many special cases and local assumptions. A shared display should mostly render an authoritative scene description, not reconstruct game state from scattered flags or inherit host-only UI behavior.

### What to do next time

- Define a small scene model such as `title`, `scoreboard`, `question`, `locked`, `reveal`, `bonus`, and `final`.
- Have the server or a single shared selector derive the complete scene from authoritative room state.
- Give Presentation a fixed layout contract and visual snapshots for every question type and scene.
- Test direct navigation and refresh into every scene, not only transitions from the previous one.

## 8. I left legacy and fallback paths in place without enough regression coverage

The changelog mentions a legacy presenter reveal-image layout, legacy image placeholders, a legacy OpenAI secret name, an external host-audio fallback, and a bundled bank that needed migration to current schemas. Compatibility was useful, but every fallback created another behavior branch.

### What to do next time

- Inventory compatibility paths and give each an owner, test, and removal date.
- Normalize old data at one boundary instead of carrying legacy shapes throughout the UI.
- Run fixtures for the oldest supported quiz version as part of CI.
- Remove dead compatibility code once data migration and rollback windows are complete.

## 9. I discovered deployment prerequisites through runtime failures

The private-media proxy required missing `service_role` database privileges and corrected credential-header behavior. Sentry was prepared but remained inactive until a DSN was added. These are deployment-contract issues that should be verified automatically.

### What to do next time

- Maintain a machine-checkable manifest of required secrets, bindings, tables, policies, grants, buckets, and external configuration.
- Run pre-deploy smoke checks against authentication, room creation, media health, publish, join, and presentation access.
- Treat observability configuration as a release requirement when production diagnostics depend on it.
- Test deployment with production-equivalent credentials and permissions, not broader local credentials.

## 10. I added automated checks after high-risk boundaries were already complex

Automated checks for player-payload privacy, author validation, and Worker media access boundaries appear after those systems were implemented. They were valuable, but earlier contract tests would likely have prevented several follow-up fixes.

### What to do next time

Write tests in this order:

1. Authorization and information-boundary tests.
2. Server state-transition and scoring tests.
3. Reconnect, retry, duplication, and stale-command tests.
4. Schema compatibility and migration tests.
5. Visual snapshots for Presentation and phone layouts.
6. Happy-path UI tests.

## 11. I did not make the score model extensible enough before adding modifiers

The door bonus later required base points and multipliers to be preserved in the audit export, with the multiplier applying only to the following round. This is the correct resulting behavior, but it suggests modifiers were added after scoring had already been modeled mainly as final point totals.

### What to do next time

- Model a score event as inputs plus calculation: base points, modifier, final points, reason, source question/round, and effective scope.
- Store immutable events rather than relying on a mutable total.
- Define modifier precedence, duration, rounding, ties, manual adjustments, and replay behavior before adding the first bonus mechanic.
- Prove that recomputing totals from the event log produces the leaderboard.

## 12. The changelog itself is too feature-heavy to serve as an engineering memory

The log is thorough about what changed, but rarely records why a defect happened, how it escaped, which invariant was violated, or what test now prevents recurrence. That makes this retrospective more inferential than it should be.

### What to do next time

For every meaningful fix, record:

- user-visible symptom;
- root cause;
- violated invariant;
- scope of affected versions/data;
- corrective change;
- regression test or monitoring added.

## 13. I let the live database schema drift away from migration history

When migration `0030_multi_fill_in_the_blank_scoring.sql` was ready, the authenticated Supabase project had a working live schema but an empty remote migration-history table. A normal `supabase db push` therefore considered migrations 0001–0030 pending and would have tried to replay the entire database setup. The safe workaround was to execute only migration 0030 with `supabase db query --linked --file ...` and then inspect the live function definition to verify the new scoring branch.

That avoided a destructive replay, but it did not repair the underlying bookkeeping: the live project still cannot safely use ordinary migration pushes until its existing schema and migration files are audited and baselined. A migration file existing locally is not proof that the remote system recorded or applied it.

### What to do next time

- Link the repository to its Supabase project when the project is created, and keep the link/configuration reproducible for maintainers.
- Run `supabase migration list --linked` before every database push; stop if history is unexpectedly empty, divergent, or out of order.
- Never mark old migrations as applied merely because the application appears to work. Compare the live schema, functions, policies, grants, and relevant migration checksums first.
- After that audit, baseline migrations 0001–0030 in the remote history table so future `supabase db push` operations apply only genuinely pending files.
- Add a deployment preflight that fails when the live schema exists but the migration-history table is empty.
- Verify high-risk migrations by querying the resulting live function or schema, not only by trusting a zero exit code.

## 14. I treated audio cue state as visual state

When the host played a numbered finale intro, the presentation received a new `activeClipId`. Although `audioCommand`, submission data, and the state revision were already excluded from the presentation render key, `activeClipId` was still included. Each cue therefore remounted the whole presentation instead of only highlighting the current tile. This made the shared screen flash and could obscure the answer reveal.

### What to do next time

- Classify every broadcast field as structural, visual, or transport-only before adding it to a render key.
- Keep audio command IDs, active media IDs, revisions, and submission counters out of the presentation remount boundary unless the full layout genuinely changes.
- Update cue-specific DOM state in place: the active tile, playback marker, and timer readout should not require rebuilding the screen.
- Test cue A → cue B → playback end on every audio-enabled question type, and assert that the presentation render function is not called.

## Practices to carry into the next project

- Start with explicit contracts for state, roles, visibility, and ownership.
- Prefer allowlists and authoritative projections at trust boundaries.
- Represent loading, failure, absence, and invalidity as distinct states.
- Put stable identifiers and ordering information in every cross-client command.
- Build failure-path and reconnect tests alongside the happy path.
- Keep immutable audit events for anything that affects scores or permissions.
- Release one complete vertical slice before multiplying formats and integrations.
- Turn each production fix into a regression test and a short root-cause note.
- Treat migration history as production state, and block deployment when it disagrees with the live schema.

## A better release gate

Before calling the next real-time product ready, verify all of the following:

- Host, player, and presentation can each refresh and recover in every phase.
- Duplicate, delayed, stale, and failed commands have deterministic outcomes.
- Unauthorized clients receive no future, answer, reveal, author, or media data.
- Every user action distinguishes pending, confirmed, rejected, and retryable states.
- Production secrets, grants, storage, migrations, and observability pass preflight.
- Oldest-supported data fixtures still load, or have been explicitly migrated.
- Every supported layout has visual coverage with worst-case content.
- Audit exports explain how every score was calculated.

The central lesson is that the project needed stronger contracts sooner. Most of the costly follow-up work was not caused by isolated UI bugs; it came from ambiguity about identity, authority, lifecycle, and state across browsers and services. In the next project, those boundaries should be designed and tested before feature breadth becomes the priority.

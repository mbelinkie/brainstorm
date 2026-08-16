# Quiz Control — Change Log

This log records meaningful product, infrastructure, and data-model changes. Dates use the local project timezone (America/New_York).

## 2026-08-15

- Added private, browser-rendered presentation video clips for ordinary questions: trim, independent visual/audio fades, standardized MP4 generation, resumable upload, private-library reuse, and Host Play/Pause/Restart controls. Player payloads remain video-free.
- Added optional locally parsed SRT lyric captions for opening waiting-room music, including author import/replace/remove controls and a Presentation-only audio-clock overlay.
- Fixed production categorize-question scoring by adding migration `0031_jsonb_object_length.sql`, which provides the PostgreSQL-compatible JSONB object-cardinality helper used by the scoring RPC.
- Added a regression contract test for that helper and verified the full test suite passes.
- Audited the production Supabase schema and baselined migration history through `0031`; normal `supabase db push --linked` workflows are now safe again.

## 2026-08-14

- Added a reusable multiple-fill-in-the-blank audio format with per-blank partial credit, ten autosaved title fields, clip-following player and Presentation highlights, reveal feedback, and author-managed accepted spellings. Clip highlights now clear when playback ends for both this format and existing matching questions.
- Added a server-authoritative between-round door bonus: players choose one of three authored doors, Presentation groups names and player icons beneath each choice, and the host reveals persisted randomized rewards for everyone at once.
- Added balanced default doors with equal 1.20× expected value: Safe (100% 1.2×), Gamble (50% 1.6× / 50% 0.8×), and Hail Mary (25% 3.0× / 75% 0.6×).
- Added authoring controls for door names, icons, outcome probabilities, and multipliers, including validation, expected-value guidance, and one-click default restoration.
- Applied resolved multipliers to automatic points for the following round only, preserved base points and multiplier in the score audit export, and added persistent phone badges throughout the boosted round.

## 2026-08-13

- Added an optional persistent question image for single-choice and fill-in-the-blank questions. It appears while answering and is replaced by the optional answer-reveal image on reveal.
- Added explicit player authorization for the current question image without weakening answer-reveal media privacy.
- Changed player submission feedback to wait for server confirmation; failed answers now remain visibly unsubmitted and can be retried.
- Preserved temporarily invalid in-progress author drafts across refreshes, and fixed local Find Image requests with a Worker proxy.
- Fixed attached private images being falsely marked unavailable after refresh when the optional media-library metadata query failed or lagged. Valid UUID attachments now load directly through the authenticated Worker, with a minimal-schema library fallback.
- Fixed Presentation audio retaining the first loaded clip when the host cues another clip. Typed-answer questions now show an anonymous answer wall to Presentation after locking, without player names.
- Tightened Presentation image composition: question and reveal artwork now uses the full image pane without duplicate reveal labels or captions.
- Made host audio commands identify their exact authored question and matching clip, eliminating stale first-clip playback in Presentation. Limited the Host preflight checklist, QR code, and join-link panel to the opening title screen.
- Fixed the legacy presenter reveal-image layout so removing the caption no longer leaves a blank panel beneath the image.

## 2026-08-12

### Authoring media follow-up

- Fixed reopening authoring with private images: attached artwork now remains in a loading state until the authenticated media library is available, rather than being mislabelled as a legacy placeholder.
- Made a local originals folder part of the image workflow. Newly pasted or uploaded images save their full-size source there under quiz, section, question, and image-role names; the folder handle is remembered by the browser when permission permits.
- Added **Reformat image** beside attached option, matching-poster, reveal, and title-page artwork. It reloads the saved full-size original, opens the crop/focal-point editor, and attaches a revised optimized private derivative.

### Live quiz runner

- Deployed Quiz Control to Cloudflare Workers at `wild-haze-73b3.matthew-belinkie-3af.workers.dev`.
- Added Supabase-backed hosted rooms with room codes, named-player join, host secrets, Realtime state broadcasts, server-authoritative submission locking/scoring, leaderboard retrieval, final completion state, and host-refresh recovery.
- Added a host room link, room-code join flow, and Google Meet tab-audio reminder.
- Added a host quiz selector populated from the Supabase quiz-version catalog.
- Added host-only CSV export for final room standings, including tie-aware ranks, names, and points.
- Added host-only manual score adjustments with a player selection, positive/negative points, optional reason, and an immutable score-event audit trail.
- Added lobby QR join codes and host-controlled 30/45/60-second question timers, visible to players and locking the active question when the host reaches zero.
- Added 15- and 20-second timer presets for quick basic questions.
- Added a persistent per-room lobby preflight checklist and made host round-progress indicators reflect the actual quiz structure.
- Added host presentation-mode control and a discoverable keyboard-shortcut guide.
- Added a host-only detailed score-event CSV export, including player, question ID, points, reason, and recorded time.
- Made the player round indicator reflect the actual quiz round count rather than a fixed five-round assumption.
- Improved the player phone layout with full-canvas small-screen presentation, safe-area support, larger response controls, responsive type, input/select styling, and more visible keyboard focus.
- Replaced player dropdowns for ordering, matching, and two-bucket sorting with mouse- and finger-draggable cards.
- Refined image-based matching: the authored movie targets stay fixed (and can show private poster artwork), while players drag the song-title cards onto them.
- Added a dedicated shareable presentation view with no host controls or production notes. Manual host score adjustments now create a synchronized celebratory presentation notification with the player, points, and reason.
- Upgraded the presentation view into a show-oriented surface with animated question/reveal entrances, a live-scoreboard intermission before each question or round, and an animated podium-style final standings board. The host view remains intentionally utilitarian.
- Added automated checks for player-payload privacy, author validation, and Worker media/author access-control boundaries.
- Added local, privacy-safe diagnostics for host and author errors, with downloadable JSON logs for support or troubleshooting.
- Created a Sentry Browser JavaScript error-monitoring project and prepared the app to send privacy-filtered operational errors once its public DSN is added to configuration.

### Question formats and scoring

- Implemented single choice, multiple choice, true/false, image selection, short answer, fill-in-the-blank, arrange-in-order, matching, and numeric-estimate UI support.
- Added `closest_number`: players submit a numeric guess, the closest valid guess wins, and tied closest guesses split the authored points evenly.
- Added exact server scoring for choice, text, ordering, and matching responses; matching awards points per correct pair.
- Added the `categorize` type: two editable categories, item-by-item player assignment, and full-credit automatic server scoring when all assignments are correct.

### Audio and privacy

- Added a quiz-level opening title page: title/subtitle, optional transparent theme art, QR join code, gently animated presentation background, and host-controlled waiting-room music that plays through the presentation tab.
- Rebuilt Presentation as a fixed, no-scroll 16:9 broadcast canvas. Question-type-specific layouts compact choice images, ordering, categorization, ten-item poster matching, scoreboards, and answer-reveal artwork within the shared frame.
- Added host-only audio cues and optional host-only audio URLs.
- Expanded hosted-clip controls with restart, volume, and elapsed/total-time feedback; these remain host-display only.
- Hardened the player-state serializer with an explicit field allowlist, preventing reveal notes and advanced answer keys from reaching player clients.
- Added private Supabase media storage schema, author-only upload policies, and a host-authorized Worker proxy for uploaded clips.
- Added private JPG, PNG, and WebP upload controls for image-selection options. The Worker now limits a joined player to images on the active question; hosts retain access only to assets referenced by their room's fixed quiz version.
- Added optional private answer-reveal images. They remain hidden until reveal, then appear on the presentation view, host view, and joined player phones.
- Added an author-only private-media library that lists uploaded audio and images with their type and size.
- Added author-side image optimization: source JPG/PNG/WebP files are optionally copied to a user-selected local folder, resized to a maximum 1600px WebP derivative, and only that optimized derivative is uploaded privately.
- Added a pre-upload image cropper: authors can choose square, widescreen, standard, or original framing and click to set the focal point before the optimized derivative is produced.
- Added the author-only image suggestion assistant foundation: authorized authors can request question-aware Wikimedia Commons candidates, inspect source/license information, and approve an image for optimized private upload.
- Updated the image suggestion assistant to use the Cloudflare `OPENAI_QUIZ` secret (the legacy `OPENAI_API_KEY` name remains supported for compatibility).
- Made the image finder available beside every image upload, including matching-poster and answer-reveal artwork. It opens with the selected target and question context, understands a typed request, and supports a persistent draft-only Google Images reference mode that never downloads or attaches search results.
- Made image pasting the primary authoring action: each image control is now a compact `Paste image` split button, with Upload Image and Find Image under its caret menu. A pasted clipboard image follows the same local-original, crop/focal-point, optimization, and private-upload workflow as a selected file.
- Added in-editor thumbnails for attached private option, poster-target, and answer-reveal images.
- Replaced broken legacy image-placeholder previews with an explicit unavailable state, and added Remove image controls that safely unlink artwork from the draft while preserving the original asset in the private media library.
- Fixed immediate author previews for newly uploaded images: the optimized local derivative is retained for the active editing session rather than waiting on a media-library refresh.
- Fixed shared presentation media loading: host room credentials are now shared between same-browser host and presentation tabs, rather than being isolated to the host tab’s session storage.
- Moved audio controls entirely into Host view. Presentation view now keeps only a hidden audio element and receives synchronized play, restart, and pause commands from the host, leaving the shared display free of audio UI.
- Added a one-click presentation-sound setup screen to satisfy browser autoplay rules. It disappears after setup; the Host remains the only view with playback controls.
- Added the missing `service_role` database privileges required by the Cloudflare private-media proxy, and send modern Supabase server credentials only through the API-key header.
- Added privacy-safe private-media failure stages so hosts can distinguish room authorization, media-record, and storage-download failures without exposing credentials.
- Added a privacy-safe Worker media health check that verifies Cloudflare can authenticate to Supabase without exposing media or credentials.
- Improved audio trimming with an original-source player, a red waveform playhead, click-to-seek, and one-click “set start/end to playhead” controls alongside selection preview.
- Added question-type filtering in the navigator and a quick-insert template menu for every currently supported question type.
- Added an always-visible author quiz-health panel with question/format/media totals and a live publish-readiness indicator.
- Added authenticated private-media previews in the author library, with source title/license and source-link visibility where metadata exists.
- Added editable private-media asset names, and automatically name newly uploaded files for easier reuse in library and question-media pickers.
- Added host-side clip readiness/error status and a Space-bar play/pause shortcut outside form fields.
- Added browser-based audio trimming for author uploads: waveform range selection, start/end numeric controls, optional fade-in and fade-out, auditioning, and private upload of only the rendered WAV clip. Original audio can be copied into the author’s selected local source folder.
- Ensured player payloads exclude audio URLs, audio cue notes, answer keys, and future questions.
- Preserved support for a prepared external host audio source when no app-hosted URL is supplied.

### Authoring and publishing

- Added a browser question-bank editor with per-type forms, audio-cue fields, JSON import/export, raw JSON editing, add/delete question, and type initialization.
- Added a new-quiz template that starts with one editable round and question, with a confirmation before replacing unsaved work.
- Added in-place question duplication; copies are inserted immediately after the source with a fresh question ID.
- Added round creation, duplication, and guarded deletion. Round copies receive fresh IDs for the round and every copied question.
- Added move-up/move-down controls for both rounds and questions.
- Added client-side quiz validation before importing, downloading, and publishing; it checks IDs, prompts, points, options, and advanced answer keys.
- Updated the bundled music bank to the current matching and categorize schemas so it validates and can be edited without legacy fields.
- Added direct editing of the quiz title and selected round title.
- Added automatic browser-local draft recovery, a one-click discard-draft action, per-round question counts, and Alt+Up/Down question navigation.
- Fixed publishing so a successful version publish leaves the editor ready to publish a subsequent version after further edits.
- Added prompt/type search across the question navigator and selectors to reuse previously uploaded private audio or images without re-uploading them.
- Added safe author media deletion: draft-referenced assets cannot be selected for deletion, and the database rejects deletion of anything referenced by any published quiz version.
- Added Supabase magic-link author authentication and an explicit `quiz_authors` allowlist.
- Added protected publishing of immutable quiz versions and verified that published versions appear in the host selector.

### Email delivery

- Configured Resend custom SMTP using the verified `auth.matthewbelinkie.com` sender domain.
- Updated Supabase Auth to use the Resend SMTP sender instead of the restricted built-in provider.

## Earlier foundation work

- Defined the initial music-trivia schema and five-round question bank.
- Created the initial Supabase tables, RLS, RPC boundary, scoring functions, and leaderboard model.
- Created the Kaplan-inspired host, player, landing, and authoring visual system.
- Added a Cloudflare deployment script that stages only public assets and deploys with Wrangler.

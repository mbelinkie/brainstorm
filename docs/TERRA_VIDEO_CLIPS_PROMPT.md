# Terra kickoff prompt — private video clips

Suggested model: `gpt-5.6-terra`  
Suggested reasoning effort: `high`

Copy the prompt below into a new Codex task rooted at this repository.

---

Implement private, trimmed video clips for this Quiz Platform repository.

Start by reading `docs/VIDEO_CLIPS_TECH_PLAN.md` completely. Then inspect the current repository, its dirty working tree, the existing audio upload/editor/playback implementation, the latest Supabase migrations, and the existing tests before editing. Treat the plan as authoritative for scope, architecture, constraints, delivery sequence, and acceptance criteria. Where the current code has moved since the plan was written, preserve the plan's user-visible and security outcomes while adapting carefully to the actual code.

Outcome: an authorized author can select a local MP4, MOV, or WebM video; trim it; configure independent video and embedded-audio fade-in/out durations; render a standardized private MP4 derivative in a browser Worker; upload and reuse it through the private media library; attach it to an ordinary question; and control Play, Pause, and Restart from Host while the video and its sound play only in the shared Presentation tab.

This is an implementation task, not another planning pass. Carry it through code, migration, tests, documentation, and proportionate browser verification. Work milestone by milestone and keep the repository usable after each milestone.

Key constraints:

- Preserve every unrelated working-tree change. The repository is already dirty. Inspect `git status`, identify pre-existing modifications and untracked files, and do not overwrite, revert, reformat, stage, commit, or push unrelated work.
- Do not reset, clean, or delete the working tree.
- Do not deploy, apply the migration to a live Supabase project, upload production assets, create external resources, or push to GitHub unless the user separately authorizes it.
- Add the next migration after the actual latest local migration; the plan expects `0032_video_media_assets.sql`, but verify the current sequence first.
- Keep existing published audio quizzes backward compatible. Do not replace the audio schema or regress audio trimming, normalization, library operations, controls, or autoplay setup.
- Ship ordinary question-level primary video only. Architect reusable primitives, but do not expand into title, between-round, finale, matching, multi-blank, player-phone video, captions, posters, arbitrary cropping, HLS, or direct range-ticket delivery.
- Allow one primary presentation medium per question: playable audio or playable video, not both.
- Player phones must never receive a video asset UUID, storage path, filename, display name, source metadata, or usable playback URL.
- Only the rendered derivative may upload. The raw source stays local; optional originals-folder saving must never block the operation.
- Initial derivative: MP4 fast start, AVC/H.264, optional AAC, maximum 1280×720, maximum 30 fps, maximum 45 seconds, maximum 25 MB, approximately 2.5 Mbps video and 128 kbps audio.
- Strip descriptive metadata and discard thumbnails, subtitles, attachments, secondary tracks, and other source-identifying data.
- Normalize embedded audio to the existing −16 dBFS target with a −1 dBFS peak ceiling, and apply independent audio fades.
- Implement video fades to/from black through frame processing.
- Probe real browser codec support before editing or encoding and fail with specific, useful messages. Do not silently discard tracks.
- Use a pinned Mediabunny/WebCodecs browser implementation, lazy-loaded only for authoring. Do not use `ffmpeg.wasm`, server-side transcoding, Cloudflare Containers, or Cloudflare Stream for this scope.
- Perform expensive media work in a cancelable module Worker. Release VideoFrames, AudioSamples, encoders, decoders, canvases, object URLs, and other resources promptly.
- Use Supabase TUS resumable upload for video with the required 6 MB chunks and progress. Use unique paths and best-effort object cleanup if registration fails.
- Keep the Cloudflare Worker as an authorization/streaming proxy. Do not buffer or transcode video there. Full-blob preloading through the current credentialed fetch is acceptable under the 25 MB cap.
- Generalize Presentation's one-time sound activation into media activation for audible video. Do not assume a Host-tab click satisfies Presentation-tab autoplay policy.
- Media-only commands must not remount or flash the Presentation question/video DOM.
- Do not add secrets, raw media, generated test output, or originals to Git.

Implementation expectations:

1. Read and map the existing implementation before editing:
   - `author.html`, `author.css`, and `author.js` audio clipper/upload/library paths;
   - `app.js` audio controls, command persistence, presenter render keys, media activation, object URL lifecycle, and private-media fetch;
   - `quiz-core.js` player-safe allowlist;
   - both quiz validators;
   - `cloudflare-worker.js` private media routes;
   - the current `media_assets`, deletion, authorization, and grant migrations;
   - `prepare-deploy.mjs`, `server.mjs`, package scripts, and relevant tests.

2. Start with the technical spike required by the plan:
   - add the narrowly scoped bundled Mediabunny/WebCodecs processor and Worker;
   - prove source inspection, output codec capability checks, trimming, resize/frame-rate limiting, video fades, audio analysis/normalization/fades, metadata stripping, MP4 output, cancellation, and progress;
   - keep the spike as production code if it succeeds; do not leave throwaway scripts or large generated media in the repository;
   - if the fundamental AVC/AAC browser path cannot be made reliable in the current environment, stop after documenting concrete evidence and the smallest viable fallback instead of building UI around a broken encoder.

3. Implement persistence and library support:
   - add the next idempotent Supabase migration described in the plan;
   - preserve all audio/image RPC signatures and policies;
   - add checked video metadata and a narrow author-only registration RPC;
   - add resumable upload, registration, cleanup, preview, rename, reuse, safe deletion, and library metadata;
   - retain the library's backward-compatible column-selection fallback.

4. Implement question authoring:
   - add `question.video` with `mediaAssetId`, `suggestedWindow`, and `cue`;
   - add video UUID and mutual-exclusion validation in both validation implementations;
   - preserve video across question-type changes;
   - add a dedicated accessible video clipper, storyboard/timeline, playhead, numeric in/out fields, Set Start/End, four fades, source preview, rendered preview, progress, cancellation, and safe failure behavior;
   - leave a previously attached asset unchanged until a new render has uploaded and registered successfully;
   - update quiz health and draft/publish behavior.

5. Implement Host and Presentation:
   - add a backward-compatible generic presentation-media resolver and media command path;
   - never broadcast an asset UUID;
   - add Host control/readiness/playback state without rendering the video in Host;
   - render a stable, responsive, native-controls-free Presentation `<video>` with black background and `object-fit: contain`;
   - prefetch privately, create/revoke object URLs safely, distinguish fetch readiness from `canplay`, and make stale commands unable to override newer commands;
   - add media-ended signaling without persisting current playback time or incrementing revisions continuously;
   - generalize the direct-click Presentation activation gate and visibly recover from rejected playback;
   - preserve audio behavior and non-remount presentation behavior.

6. Test and document:
   - extract deterministic helpers where useful and add unit tests for fade math, range checks, dimensions, validation, media resolution, and player stripping;
   - add contract tests for migration security/limits, private-media authorization, public-state isolation, persistent presenter DOM, object URL cleanup, and legacy audio compatibility;
   - use only small, non-sensitive media fixtures and do not commit generated outputs;
   - run `npm test` and any new deterministic build/check commands;
   - run `npm run deploy` only if it has a safe local build-only mode; do not perform a real Wrangler deploy. Prefer invoking the build/preparation step directly;
   - update `PRODUCT_SPEC.md`, `RUNBOOK.md`, `DEPLOYMENT.md`, and `CHANGELOG.md` concisely;
   - perform a final diff review for private-data exposure, XSS, source metadata, orphan cleanup, resource leaks, autoplay behavior, reduced motion, accessibility, dependency pinning, generated artifacts, and accidental unrelated edits.

Use `apply_patch` for hand edits. Follow the repository's existing style rather than initiating broad formatting or framework refactors. Make reasonable implementation decisions within the plan without stopping for minor questions. Ask only if a missing product decision would materially change the data model or security outcome.

Verification is not complete merely because unit tests pass. If browser automation or a real codec environment is available, exercise the author workflow with small local fixtures. If Google Meet cannot be tested in the environment, leave a precise manual rehearsal checklist and report that single unverified item rather than claiming it passed.

When finished, report:

1. the user-visible result;
2. the processing/output profile and why the raw source stays local;
3. database/storage and security changes;
4. Host/Presentation command and autoplay approach;
5. files changed;
6. tests/build/browser checks run and exact results;
7. any remaining manual Meet check or known browser limitation;
8. confirmation that unrelated pre-existing working-tree changes were preserved.

Do not stop at a plan—implement and verify the feature.


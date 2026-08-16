# Video clips — technical implementation plan

Status: implementation-ready  
Target surfaces: quiz authoring, private media library, Host controls, and Presentation  
Primary scope: one host-cued video clip on an ordinary question  
Follow-on scope: title, between-round, finale, matching, and multi-blank media slots

## Goal

Let an authorized quiz author select a local video, trim it, add optional video and audio fades, render a standardized derivative in the browser, and upload only that derivative to private server storage. During a game, the Host controls playback and the video appears with sound in the shared Presentation tab. Player phones must not receive the asset ID, source metadata, or playback URL.

The feature should feel like the existing private-audio workflow while accounting for video-specific encoding cost, file size, playback visibility, and browser media restrictions.

## Product decisions

The first implementation should make these decisions explicit:

- Video is presentation-only and host-cued. It never plays on player phones.
- An ordinary question may have either a primary audio clip or a primary video clip, not both.
- A video may contain audio. Audio fades apply to that embedded audio track.
- Video fades mean fade from/to black.
- Trimming and fades are baked into the uploaded derivative. Runtime playback does not reproduce edit instructions.
- Only the derivative uploads. The source remains local and may optionally be copied to the existing originals folder.
- Initial authoring support targets a current desktop Chrome or Edge browser.
- Initial source formats are MP4, MOV, and WebM when the browser can decode them.
- Initial output is MP4 containing H.264/AVC video and optional AAC audio.
- The output is at most 1280×720, at most 30 fps, no longer than 45 seconds, and no larger than 25 MB.
- Preserve aspect ratio and source orientation. Do not crop unless a later product requirement adds framing controls.
- Retain the existing audio loudness policy: target −16 dBFS with a −1 dBFS peak ceiling.
- Primary question video ships first. The processing, storage, media-library, and command abstractions must be reusable by later presentation slots.

## Existing architecture to preserve

The current audio path is the model:

1. `author.js` validates the selected local file.
2. The browser decodes it, presents a trim/fade dialog, renders a WAV derivative, and normalizes its audio.
3. Only the derivative uploads to the private Supabase `quiz-media` bucket.
4. The browser registers an opaque UUID in `media_assets` and places that UUID in the quiz definition.
5. The Cloudflare Worker authorizes and proxies private media.
6. Host commands are persisted/broadcast without including a private asset ID.
7. Presentation resolves the asset from its host-authorized quiz definition and performs playback.
8. `toPlayerQuestion()` allowlists player-safe fields and strips authored media details.

Important existing implementation points:

- `author.html`: the audio editor dialog.
- `author.js`: `uploadPrivateAudio()`, `chooseAudioClip()`, normalization, upload, media-library previews, and reuse.
- `app.js`: `audioPanel()`, persistent Presentation audio playback, media commands, private-media fetch, and the one-time sound gate.
- `quiz-core.js`: player-safe question projection.
- `quiz-validation.js` and the author-local validator: quiz-definition validation.
- `cloudflare-worker.js`: `/author-media/:id` and `/media/:id` authorization proxies.
- `supabase/migrations/0010_private_media_assets.sql`: bucket and `media_assets` foundation.
- `supabase/migrations/0029_presentation_only_media.sql`: presentation-only media authorization.

Do not replace the existing audio schema or break existing published quizzes as part of this feature.

## Proposed architecture

```text
local source File
  -> author preview and edit specification
  -> dedicated browser media Worker
  -> standardized private MP4 Blob
  -> resumable Supabase Storage upload
  -> register video media row
  -> attach opaque UUID to question.video
  -> host-authorized Worker delivery
  -> persistent Presentation <video>
```

### Why browser-side encoding

The application is currently a static browser app backed by Supabase and a Cloudflare authorization Worker. The Worker should remain a streaming authorization proxy rather than becoming a transcoder. Browser-native WebCodecs can use available hardware decoders/encoders, keeps originals local, and matches the audio privacy model.

Use Mediabunny as a pinned npm dependency and bundle only the required browser code. It provides demuxing, muxing, trimming, conversion, progress, cancellation, codec probing, and per-video/per-audio sample processing on top of WebCodecs.

Do not use `ffmpeg.wasm` for the primary path. It is substantially heavier and slower for this use case. Do not introduce a Cloudflare Container or another server encoder in the first implementation.

### Module boundary

Add a dedicated module Worker, for example:

```text
video-processor.js
video-processor.worker.js
```

The main authoring UI owns file selection, local preview, edit controls, progress display, cancellation, and upload. The Worker owns capability checks, input inspection, decoding, fade processing, resizing, frame-rate adjustment, audio normalization, encoding, muxing, metadata removal, and output inspection.

Prefer a small typed message protocol even though the repository is JavaScript:

```js
// Request
{
  type: "encode",
  jobId,
  file,
  edit: {
    startSeconds,
    endSeconds,
    videoFadeInSeconds,
    videoFadeOutSeconds,
    audioFadeInSeconds,
    audioFadeOutSeconds
  }
}

// Progress
{ type: "progress", jobId, phase: "inspect" | "analyze-audio" | "encode", progress }

// Result
{
  type: "result",
  jobId,
  buffer,
  mimeType: "video/mp4",
  durationMs,
  width,
  height,
  hasAudio,
  byteSize
}
```

Transfer the final `ArrayBuffer` back to the main thread rather than copying it. Every job must be cancelable, and cancellation must release media frames, audio samples, canvases, encoders, decoders, object URLs, and other browser resources.

## Encoding specification

### Capability check

Before showing a usable editor, inspect the source and verify that the browser can:

- demux and decode the primary input video track;
- encode AVC/H.264 at the selected output dimensions and bitrate;
- decode the optional primary audio track;
- encode AAC, using the Mediabunny AAC extension only when native encoding is unavailable;
- write the result as MP4.

Fail before editing with a useful message that identifies whether the input cannot be decoded or the output cannot be encoded. Do not silently discard the video or audio track.

### Output profile

- Container: MP4 with fast-start layout.
- Video: AVC/H.264.
- Audio: AAC when the input contains audio; do not synthesize a silent track.
- Maximum output box: 1280×720, preserving aspect ratio.
- Frame rate: preserve when 30 fps or lower; reduce higher or variable rates to at most 30 fps.
- Video bitrate: approximately 2.5 Mbps.
- Audio bitrate: approximately 128 kbps, stereo maximum, 48 kHz maximum.
- Key-frame interval: approximately 2 seconds for responsive seeking/restart.
- Clip duration: 0.1–45 seconds.
- Output size: reject anything over 25 MB before upload.
- Metadata: empty descriptive tag set; retain no source title, filename, thumbnail, subtitle, attachment, or secondary track.

If a valid render exceeds 25 MB, keep the editor open and tell the author to shorten the selection. A later enhancement may offer a lower-quality retry, but automatic quality degradation is out of scope for the first implementation.

### Video fades

Force video transcoding. For every output frame, compute its output-relative timestamp and an opacity factor:

```text
fade-in factor  = clamp(t / fadeIn, 0, 1)
fade-out factor = clamp((duration - t) / fadeOut, 0, 1)
opacity         = min(fade-in factor, fade-out factor)
```

Treat a zero-length fade as factor `1`. Render black first, then draw the source frame at the computed opacity to an `OffscreenCanvas`. Clamp each fade to at most half of the selected clip duration. Close each input frame/sample after processing.

### Audio fades and normalization

If the primary video has audio:

1. Analyze the selected audio range to determine its audible RMS and peak using the existing −50 dBFS gate.
2. Compute the same normalization gain used by private audio clips: target −16 dBFS, limited by a −1 dBFS peak ceiling.
3. During encoding, multiply every sample by the normalization gain and the time-relative fade factor.
4. Clamp samples to the supported range before passing them to the encoder.

If the file has no audio, disable audio-fade controls and skip audio analysis/encoding.

## Authoring experience

Add a dedicated `video-clipper` dialog rather than overloading the audio canvas dialog.

### Question editor

Add a `Presentation video cue` section adjacent to the current audio section. The empty state provides:

- `Trim and upload video`;
- a private-video reuse selector;
- explanatory copy saying the video appears only in Presentation;
- validation that prevents attaching both primary question audio and primary question video.

When attached, show:

- an author-only `<video controls preload="metadata">` preview;
- display name, duration, dimensions, and file size;
- rename/reuse/remove/replace actions;
- the existing suggested-window and production-cue text fields or equivalent video fields.

### Video clipper

The dialog should include:

- local source `<video controls>`;
- current playhead time;
- thumbnail/storyboard strip generated from a small number of evenly spaced frames;
- selected-range shading and start/end handles;
- numeric start/end fields;
- `Set start to playhead` and `Set end to playhead`;
- video fade-in and fade-out fields;
- audio fade-in and fade-out fields;
- selected duration and projected output profile;
- a preview action;
- `Render and upload` and Cancel;
- encode and upload progress with current phase.

Use the source element for fast editing preview. Approximate visual fades with a black overlay and audio fades with temporary volume/gain changes. After encoding, make the actual rendered derivative available for final preview before or immediately after attachment.

Keyboard behavior should match the audio editor where practical: Space toggles playback, and Escape cancels without losing the existing attachment.

An invalid source, failed render, failed upload, or canceled operation must leave the previously attached video unchanged.

### Original-file handling

Offer the selected source to the existing optional originals-folder workflow. Failure to save an original must never block rendering or upload. Use the same safe naming conventions as other originals.

## Quiz schema

Add an optional ordinary-question field:

```json
{
  "video": {
    "mediaAssetId": "00000000-0000-4000-8000-000000000000",
    "suggestedWindow": "Video clip",
    "cue": "Play after reading the prompt"
  }
}
```

Do not store source filenames, codec details, trim times, or fades in published quiz JSON. They describe the generated derivative and are not needed at runtime.

Both validation implementations must:

- validate `video` as an object when present;
- validate `video.mediaAssetId` as a UUID when present;
- reject a question containing both playable `audio` and playable `video`;
- otherwise preserve all existing quiz behavior.

`changeQuestionType()` must preserve an attached primary video in the same way it currently preserves primary audio.

## Database and private storage

Add the next migration after the current migration history, expected to be:

```text
supabase/migrations/0032_video_media_assets.sql
```

The migration should:

- add `video/mp4` and, if a tested fallback needs it, `video/webm` to the bucket MIME allowlist;
- permit `video` in the `media_assets.kind` check;
- add nullable checked columns:
  - `duration_ms integer > 0`;
  - `width integer > 0`;
  - `height integer > 0`;
  - `has_audio boolean`;
- keep the current 25 MB bucket and row limit;
- add a narrow `register_video_media_asset(...)` security-definer RPC;
- verify the caller is a quiz author;
- verify the uploaded object exists;
- require `video/mp4` for the initial path;
- validate byte size and metadata bounds;
- grant only the required authenticated execution privilege;
- preserve all existing audio/image functions and policies.

The generic safe deletion flow already searches published quiz definitions for an asset UUID and should continue to work for video without special cases.

### Upload reliability

Use Supabase's TUS resumable upload path for video derivatives, with the required 6 MB chunk size, retry delays, unique object path, author bearer token, and upload progress. The object path remains opaque:

```text
<author-user-id>/<random-uuid>.mp4
```

Register the database row only after the object upload succeeds. If registration fails, attempt to delete that newly uploaded object and report the original registration error. Never use upsert for a newly generated asset.

## Private media library

Extend `loadMediaAssets()` to read the new optional metadata columns with the existing backward-compatible fallback behavior.

For `kind === "video"`, render:

- a compact author-only video preview;
- display name;
- duration and dimensions when present;
- file size;
- rename and delete/reuse behavior identical to other assets;
- `Used in open draft` protection when referenced.

Update quiz-health counts to include private video. Existing audio normalization controls must continue to operate on audio assets only.

## Host and Presentation integration

### Generic presentation-media resolver

Introduce a small runtime abstraction rather than cloning the audio state machine:

```js
function questionPresentationMedia(question) {
  if (question?.video?.mediaAssetId || question?.video?.url) {
    return { kind: "video", ...question.video };
  }
  if (question?.audio?.mediaAssetId || question?.audio?.url) {
    return { kind: "audio", ...question.audio };
  }
  return null;
}
```

The implementation may use a different name, but legacy audio quiz definitions must remain valid without migration.

### Command shape

Move new controls toward a generic command while accepting legacy audio state during rollout:

```js
{
  id: "uuid",
  kind: "video",
  action: "play" | "pause" | "restart",
  mediaScope: "question",
  questionId: "question-id"
}
```

Do not include the private asset ID, source name, or storage path in broadcast/persisted public room state. Presentation resolves the asset using its host-authorized full quiz definition.

Player render keys must ignore presentation-media-only command changes. Presentation render keys must also ignore command-only changes so play, pause, and restart never remount the question card or video element.

### Host controls

For a video question, Host should show:

- clip label;
- `Play clip`;
- `Pause`;
- `Restart`;
- elapsed time and duration;
- volume/mute if the current audio control already exposes it;
- readiness: loading, ready, unavailable;
- playback state: playing, paused, ended.

Host never renders the actual video. It remains a control surface.

### Presentation video

Keep one persistent Presentation video element or keep the question's element mounted across media-only updates. Configure it with:

```html
<video playsinline preload="auto"></video>
```

Do not expose native controls in Presentation. Display it inside the question card in a responsive 16:9-friendly stage with a black background and `object-fit: contain`. Portrait clips must remain fully visible.

Fetch the private derivative through the existing authenticated `/media/:assetId` path, turn the response into an object URL, and preload it when the question becomes current. Because the derivative is capped at 25 MB, full-blob preloading is acceptable for the first release and preserves the current custom-header authorization model.

Revoke replaced object URLs. Distinguish download readiness from media `canplay` readiness. A play command received before readiness should wait for `canplay` and then start, unless a newer command supersedes it.

On `ended`, update local UI state and send a transport event back to Host. Do not increment room revision merely because browser playback time advanced.

### Presentation media activation

Generalize the one-time `Enable presentation sound` gate to `Enable presentation media` when the quiz contains audio or audible video. The direct click must prime the persistent audio and video playback elements so later Host-tab commands are not rejected by autoplay policy.

Use a tiny bundled silent media primer if necessary. Always handle a rejected `play()` promise and leave a visible recovery action in Presentation. This behavior requires a real Chrome/Google Meet rehearsal; unit tests alone cannot prove it.

### Player safety

`toPlayerQuestion()` must continue to use an explicit allowlist and must not copy `video`. Player room state may contain a question ID and a generic command identifier, but never:

- `video.mediaAssetId`;
- storage path;
- filename or display name;
- source metadata;
- a directly usable media URL.

The presentation-only `can_access_live_media` behavior already allows a host-secret-authorized Presentation to retrieve quiz assets and denies presentation-only assets to player tokens. Add regression tests proving video follows the same rule.

## Worker delivery

For the first release, keep the Worker as an authorization and streaming proxy. Do not decode, inspect, or transcode video in the Worker. Preserve the upstream response body as a stream and return the registered MIME type with private, no-store caching and `nosniff`.

The initial full-blob client fetch does not require browser-driven range requests. Before supporting clips larger than 25 MB or direct `<video src>` streaming, add a separate delivery enhancement:

1. Host-authorized request obtains a short-lived, room-and-asset-bound media ticket.
2. `<video src>` uses the ticket without putting the host secret in a URL.
3. Worker verifies the ticket and forwards `Range` to Supabase.
4. Worker preserves upstream `206`, `Content-Range`, `Accept-Ranges`, `Content-Length`, and validators.

That ticket/range work is explicitly out of scope for the initial capped-blob implementation.

## Build and deployment

The project currently copies static source files into `.deploy-assets`. Add a deterministic media build step that:

- bundles the video processor and module Worker from pinned npm packages;
- produces stable local assets included by `prepare-deploy.mjs`;
- runs before deploy asset copying;
- does not rely on an unpinned CDN at authoring time;
- does not bundle the video encoder into the player/Host landing path;
- lazy-loads it only after an author selects a video or opens video editing.

If adding a general bundler would unnecessarily rework the application, use a narrowly scoped esbuild command for the video modules.

Update `server.mjs` MIME mappings if local serving of `.mp4`, `.wasm`, or Worker bundles requires it. Verify that any required Cross-Origin headers are actually needed before adding them; avoid globally changing isolation headers without testing Supabase authentication, CDN imports, and Presentation behavior.

## Testing strategy

### Pure unit tests

Extract and test deterministic helpers for:

- edit-range validation;
- fade-factor calculation at start, midpoint, boundaries, and end;
- fade clamping when fades overlap;
- output-dimension calculation for landscape, portrait, square, odd dimensions, and rotation;
- media-command resolution and legacy audio compatibility;
- quiz validation for video UUIDs and audio/video mutual exclusion;
- player-safe projection stripping video fields.

### Contract tests

Add repository-style contract tests proving:

- the bucket permits the expected video MIME and media kind;
- registration is author-gated and size-limited;
- `/media/:id` still requires room credentials and authorization RPC approval;
- the public question/state path does not expose the video asset ID;
- Presentation resolves the authored video privately;
- media-only commands do not remount Presentation;
- player render keys ignore media commands;
- media object URLs are replaced/revoked;
- audio-only quizzes retain their existing path.

### Browser integration fixtures

Use small, non-sensitive fixtures covering:

- MP4/H.264/AAC landscape;
- MOV from a phone with rotation metadata;
- WebM input;
- portrait video;
- silent video;
- source above 30 fps;
- video fade only;
- audio fade only;
- all fades;
- maximum-duration render near the output-size limit.

Verify trim accuracy within one output frame for video and a small audio tolerance. Confirm output metadata does not contain the source filename/title.

### Manual rehearsal

In a production-like deployment:

1. Author and publish a video question.
2. Open Host and Presentation in separate tabs.
3. Click the one-time media activation control.
4. Share the Presentation Chrome tab in Google Meet with tab audio.
5. Verify Play, Pause, Restart, volume, end state, and replay.
6. Refresh Host and Presentation and verify recovery.
7. Join from a phone and confirm the phone receives no video or identifying metadata.
8. Test a slow connection to confirm preload/readiness is understandable and play waits safely.

## Delivery sequence

### Milestone 1 — technical spike

- Add an isolated Mediabunny/WebCodecs experiment.
- Prove decode and standardized MP4 encode for the supported fixtures.
- Prove video fades, embedded-audio fades, and loudness normalization.
- Measure render time and memory on the target author laptop.
- Prove output playback and Google Meet tab sharing.
- Remove throwaway spike code or turn it into the production processor.

Do not proceed with broad UI integration until the codec/output spike succeeds.

### Milestone 2 — persistence and library

- Add the database migration.
- Add resumable private-video upload and failure cleanup.
- Add video registration metadata.
- Add video media-library preview, rename, reuse, delete, and usage protection.
- Add validation and player-safety tests.

### Milestone 3 — authoring editor

- Add question video attachment and audio/video mutual exclusion.
- Add the clipper, preview, storyboard, fades, progress, cancellation, and error recovery.
- Add originals-folder integration.
- Add quiz-health and draft/publish behavior.

### Milestone 4 — Host and Presentation

- Add generic media resolution and commands.
- Add Host video controls and readiness.
- Add persistent Presentation video rendering and private preload.
- Generalize the media activation gate.
- Add end events, refresh recovery, and non-remount behavior.

### Milestone 5 — hardening and documentation

- Complete automated tests and fixture checks.
- Perform browser and Meet rehearsal.
- Update `PRODUCT_SPEC.md`, `RUNBOOK.md`, `DEPLOYMENT.md`, and `CHANGELOG.md`.
- Review the final diff for security, private metadata, error cleanup, accessibility, reduced motion, and unrelated changes.

## Acceptance criteria

The work is complete when all of the following are true:

- An authorized author can select a supported local video and see its metadata and preview.
- The author can choose start/end points and independent video/audio fade-in/out durations.
- Rendering is cancelable and reports progress without freezing the authoring interface.
- Only a standardized derivative uploads; the original never uploads.
- Output is MP4/AVC with optional AAC, at most 720p/30 fps/45 seconds/25 MB.
- Output descriptive metadata is stripped.
- Embedded audio is normalized consistently with private audio clips.
- The private media library can preview, rename, reuse, and safely delete unused video.
- Publishing stores only an opaque video asset UUID and author cue text.
- Existing audio quizzes continue to validate, publish, and play unchanged.
- Host can Play, Pause, and Restart the current question video.
- Presentation shows the video and shares its sound through the presentation tab.
- A command does not remount the Presentation video or flash the question screen.
- Playback waits for readiness and surfaces a useful unavailable state.
- Host and Presentation refresh recovery works.
- Player phones do not receive the private UUID, metadata, or URL and cannot retrieve the presentation video with a player token.
- `npm test` passes.
- The production-like Chrome/Google Meet rehearsal passes.

## Known risks and fallback

### Browser codec variation

WebCodecs does not guarantee that every browser exposes every codec. Probe the actual requested configuration before editing and give a clear target-browser message. If AVC encode support proves unreliable on required authoring machines, the fallback architecture is a temporary private source upload plus an asynchronous native server encoder, followed by raw-source deletion. That is a separate infrastructure project and should not be mixed into this first implementation.

### Memory and thermal pressure

High-resolution phone sources can stress a browser even when the selected clip is short. Keep processing pipelined, use a Worker, close media resources promptly, downscale during processing, cap duration, and test 4K sources on the actual author hardware.

### Autoplay and cross-tab commands

Host-tab clicks do not count as direct gestures in Presentation. The one-time Presentation activation control and real Meet rehearsal are mandatory.

### Upload interruption and orphaned objects

Use resumable uploads, unique paths, explicit cancellation, and best-effort cleanup when registration fails. Do not overwrite existing assets in place.

### Scope growth

Do not expand the first implementation into a multi-track editor, arbitrary cropping, captions, posters, HLS, player-device video, title/finale video, or range-ticket delivery. Build reusable primitives, but ship and verify ordinary question video first.

## Technical references

- Mediabunny conversion and trimming: <https://mediabunny.dev/guide/converting-media-files>
- Mediabunny supported formats and codec probing: <https://mediabunny.dev/guide/supported-formats-and-codecs>
- Mediabunny AAC encoder fallback: <https://mediabunny.dev/guide/extensions/aac-encoder>
- WebCodecs specification: <https://w3c.github.io/webcodecs/>
- Supabase resumable uploads: <https://supabase.com/docs/guides/storage/uploads/resumable-uploads>
- Supabase storage limits: <https://supabase.com/docs/guides/storage/uploads/file-limits>
- Cloudflare Worker streaming: <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- HTTP range requests for the follow-on delivery phase: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests>


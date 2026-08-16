# Title-screen SRT lyrics

Status: implementation-ready  
Target surface: opening Presentation title screen  
Estimated effort: 4–8 focused hours, including tests and visual QA

## Goal

Allow a quiz author to import an `.srt` file for the opening theme song. While that title-page audio plays in Presentation, show the active lyric cue in a large, readable, semi-transparent bar. Fade the bar away during gaps with no active cue.

`.ass` files are also supported. When an ASS dialogue line uses karaoke tags (`\k`, `\K`/`\kf`, or `\ko`), the title overlay retains their centisecond timing and lights each timed lyric segment yellow from the Presentation audio clock. Ordinary ASS and SRT cues remain plain, whole-line captions.

The subtitle clock must be the Presentation tab's existing audio player. Do not create a second timer or attempt to synchronize captions through room state.

## User experience

### Authoring

In **Opening title page → Waiting-room music**, add an `Import SRT lyrics` action.

After a successful import, show:

- the source filename;
- the number of imported cues;
- actions to replace the SRT and remove the lyrics.

Importing an SRT parses it locally in the browser. Save normalized cues in the quiz definition alongside the title audio. Do not upload the raw SRT to Supabase.

Recommended quiz shape:

```json
{
  "titlePage": {
    "audio": {
      "mediaAssetId": "…",
      "captionSourceName": "theme-song.srt",
      "captions": [
        {
          "startMs": 12400,
          "endMs": 15800,
          "text": "First lyric line"
        }
      ]
    }
  }
}
```

The existing audio upload, trimming, URL fallback, and playback controls remain unchanged. Captions are optional and may be imported before or after audio is attached.

### Presentation

Only render the lyric overlay on `presentationScreen === "title"` and only when title-audio captions exist.

The overlay should:

- sit above the title screen as an overlay without reflowing the title, QR code, or waiting-room roster;
- use a dark semi-transparent bar with subtle backdrop blur;
- use large, high-contrast white text suitable for a shared 16:9 screen;
- preserve SRT line breaks;
- accept up to two or three lines without clipping;
- fade and move slightly into view when a cue begins;
- fade out during gaps, before the first cue, and after the final cue;
- remain stable when playback is paused inside an active cue;
- update correctly after Play, Restart, seeking, and a title-screen rerender;
- disappear immediately when Presentation leaves the title screen.

Suggested transition duration: 200–300 ms. Use opacity/visibility/transform rather than `display: none` so the exit can animate. Respect the project's existing reduced-motion behavior.

## Technical approach

### 1. Shared subtitle utilities

Prefer a small dependency-free module such as `subtitle-core.js`, imported by both `author.js` and `app.js`.

Export two independently testable operations:

1. `parseSrt(source)` → normalized cue array.
2. `activeCaptionAt(captions, timeMs)` → the active cue or `null`.

The parser should support:

- UTF-8 BOM;
- LF and CRLF line endings;
- numbered and unnumbered cue blocks;
- `HH:MM:SS,mmm` and `HH:MM:SS.mmm` timestamps;
- whitespace around the `-->` separator;
- optional cue settings after the end timestamp;
- multiline cue text;
- out-of-order input, normalized by ascending start time.

Reject malformed nonempty cue blocks with a useful error instead of silently dropping them. Reject cues whose end is not after their start. Keep caption text as plain text; never execute SRT markup as HTML.

Cue boundary semantics:

```text
active when startMs <= currentTimeMs < endMs
```

If cues overlap, select the active cue with the latest start time. Typical lyric SRT files should not overlap, but behavior must be deterministic.

### 2. Author integration

Extend `titlePageEditor()` in `author.js` with a file input accepting `.srt`, `application/x-subrip`, and `text/plain`.

On selection:

1. Read with `File.text()`.
2. Parse with the shared utility.
3. If parsing succeeds, set `titlePage().audio.captions` and `captionSourceName`.
4. Mark the draft changed and rerender the editor/preview as appropriate.
5. If parsing fails, leave the existing captions untouched and show the error to the author.

Removing lyrics should delete only `captions` and `captionSourceName`; it must not unlink the theme audio. Removing the theme audio should preserve the editor's current behavior of deleting the complete title-audio object, including its captions, so stale lyrics cannot later become attached to a different song.

Update both validation surfaces currently used by the project (`quiz-validation.js` and the author-side validation in `author.js`). Validate that optional captions are an array of plain objects with:

- finite nonnegative `startMs`;
- finite `endMs` greater than `startMs`;
- nonempty string `text`;
- a practical upper bound of 500 cues and 500 characters per cue.

`captionSourceName`, when present, must be a string no longer than 255 characters.

### 3. Presenter integration

The persistent `presentationAudioPlayer` in `app.js` is the source of truth. Add a title-caption overlay skeleton to `presentationTitlePage()` and update its text/class without rerendering the whole application.

Use `textContent` when inserting caption text. Do not interpolate untrusted SRT text into `innerHTML`.

Synchronize from the audio player's `currentTime`. A `requestAnimationFrame` loop while audio is playing is acceptable and gives good lyric timing, provided it stops when audio is paused or ended. Also update on `play`, `pause`, `seeked`, `timeupdate`, `ended`, source changes, and after a presenter render so restarts and title-screen rerenders cannot leave stale text.

Avoid adding captions to `audioCommand` or public room state. Host commands already reach the presenter and operate on the same audio element; caption timing should remain entirely local to Presentation.

When a different audio source is prepared, clear any displayed title caption before playback begins.

### 4. Styling

Add the Presentation lyric styling to `kaplan-brand-layer.css`, close to the existing title-screen and waiting-room rules.

The title screen is currently a two-column composition with the title/QR on the left and a waiting-room roster on the right. The lyric bar should span a comfortable portion of the lower canvas above both columns. Give it a higher stacking level than title content and the roster, but keep the one-time sound gate and fullscreen control above it.

Verify at:

- a normal desktop 16:9 presentation viewport;
- a narrow viewport at or below the existing 700 px breakpoint;
- zero players and eight visible waiting-room players;
- one-line and multiline cues.

## Files expected to change

- `subtitle-core.js` — new parser and cue-selection utilities.
- `author.js` — SRT import/remove UI, event handling, author validation.
- `app.js` — caption overlay and audio-clock synchronization.
- `quiz-validation.js` — published/imported quiz validation.
- `kaplan-brand-layer.css` — title-screen lyric bar styling.
- `test/subtitle-core.test.js` — parser and timing unit tests.
- `test/presentation-layout.test.js` and/or `test/reliability-contract.test.js` — integration contract coverage.
- `CHANGELOG.md` — concise user-visible entry.

No HTML, Worker, server, Supabase migration, or private-media policy change should be necessary.

## Acceptance criteria

1. An author can import a valid SRT and see its filename and cue count.
2. Imported cues survive draft save, publish, reload, and quiz JSON export/import.
3. Replacing an SRT replaces the prior cues only after the new file parses successfully.
4. Removing lyrics does not remove the attached title audio.
5. Removing the title audio also removes its captions, preventing stale lyrics from being reused with another song.
6. Invalid SRT produces a useful error and does not damage the previous caption data.
7. Playing the title song shows the correct cue from the Presentation audio clock.
8. Restarting returns caption timing to the beginning without stale text.
9. Pausing inside a cue leaves that cue visible; resuming continues naturally.
10. Before, between, and after cues, the lyric bar fades fully out and does not intercept pointer input.
11. Leaving the title screen removes the lyric overlay even if title audio has not yet been paused.
12. Multiline lyrics retain line breaks and remain legible without scrolling or clipping.
13. Caption text is rendered as plain text and cannot inject HTML.
14. Quizzes without captions behave and render exactly as before.
15. No caption data is added to player payloads or synchronized audio commands.
16. `npm test` passes.

## Test plan

Unit-test the parser with:

- a normal numbered CRLF SRT;
- BOM-prefixed content;
- unnumbered cues;
- decimal-dot timestamps and end-time cue settings;
- multiline text;
- out-of-order cues;
- malformed timestamps;
- missing text;
- end time equal to or earlier than start time.

Unit-test cue selection at:

- one millisecond before start;
- exact start;
- inside the cue;
- one millisecond before end;
- exact end;
- gaps;
- overlapping cues.

Add contract coverage proving that:

- title authoring exposes SRT import and remove controls;
- captions are updated from `presentationAudioPlayer.currentTime`;
- caption text uses `textContent`;
- the title page contains the overlay hook;
- the CSS includes hidden and visible states with an opacity transition;
- the player-safe payload remains caption-free.

Run the complete suite with:

```sh
npm test
```

## Out of scope

- Automatic transcription or lyric generation.
- Word-by-word karaoke highlighting.
- Captions for question clips, between-round sounds, or finale audio.
- Lyrics on player phones or Host view.
- Raw SRT storage in Supabase.
- Changes to audio trimming or audio transport.
- A general subtitle/media library.

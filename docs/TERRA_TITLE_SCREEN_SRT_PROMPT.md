# Terra kickoff prompt — title-screen SRT lyrics

Suggested model: `gpt-5.6-terra`  
Suggested reasoning effort: `medium`

Copy the prompt below into a new Codex task rooted at this repository.

---

Implement title-screen SRT lyric captions for this Quiz Platform repository.

Start by reading `docs/TITLE_SCREEN_SRT_LYRICS.md` completely, then inspect the relevant current code before editing. The implementation brief is authoritative for scope, data shape, behavior, acceptance criteria, and tests.

Outcome: an author can import an `.srt` file beside the opening waiting-room/theme music. The app parses it locally into normalized caption cues stored under `titlePage.audio`. While that music plays, Presentation displays the active lyric in a large semi-transparent bottom bar, fading the bar out whenever no cue is active.

Key constraints:

- Use the existing persistent `presentationAudioPlayer.currentTime` as the only subtitle clock.
- Do not add caption timing to room state, realtime broadcasts, or `audioCommand`.
- Do not upload or store the raw SRT as a private media asset.
- Do not add a Supabase migration or change Worker/server media handling.
- Keep captions limited to opening title-page audio; do not expand to question, bonus, finale, Host, or player-phone captions.
- Render caption text as plain text with `textContent`, never as HTML.
- Preserve all unrelated working-tree changes. The repository may already be dirty; inspect `git status` and do not overwrite or reformat unrelated files.
- Make the requested local changes and run relevant non-destructive validation without waiting for approval.

Preferred structure:

- Add a dependency-free `subtitle-core.js` shared by `author.js` and `app.js`.
- Export a robust `parseSrt(source)` and deterministic `activeCaptionAt(captions, timeMs)`.
- Store cues as `{ startMs, endMs, text }` plus optional `captionSourceName` under `titlePage.audio`.
- Add author import, replace, status, and remove controls.
- Add validation in both existing quiz-validation paths.
- Add an overlay hook to `presentationTitlePage()` and synchronize it from the audio element without remounting the whole presenter DOM.
- Style it in `kaplan-brand-layer.css` so it works with the current two-column title/waiting-room layout and the 700 px breakpoint.

Be careful about:

- BOM and CRLF input;
- numbered or unnumbered cues;
- comma or dot milliseconds;
- multiline cues and cue settings;
- exact cue boundary behavior;
- restart, pause, seek, ended, audio-source replacement, and title-screen rerenders;
- invalid imports preserving the previously valid cues;
- quizzes with no captions remaining unchanged;
- avoiding a runaway animation loop while audio is paused or after leaving the title screen.

Implement the feature fully, including unit and integration/contract tests and a concise `CHANGELOG.md` entry. Run `npm test`, fix failures caused by your changes, and perform a final diff review for scope, security, caption escaping, and accidental unrelated edits.

When finished, report:

1. the user-visible result;
2. the data shape and synchronization approach used;
3. files changed;
4. tests run and their result;
5. any remaining limitation or manual visual check worth doing.

Do not stop at a plan—carry the implementation through verification.


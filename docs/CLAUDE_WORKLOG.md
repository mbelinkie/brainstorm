# Claude Work Log

Durable record of Claude's contributions to this repo, separate from `CHANGELOG.md`. One entry per session.

## 2026-08-17 — Android join-screen logo picker overlap

- **Branch:** `claude/fix-android-logo-picker-overlap`
- **Bug:** On the player join screen ("Choose your player logo"), the logo choice cards rendered as an overlapping, fanned stack on Android Chrome at phone widths. Reported as fine on iPhone.
- **Files touched:**
  - `kaplan-brand-layer.css` — removed `min-height: 0;` from the mobile (`max-width: 520px`) `.player-logo-choice` rule.
  - `test/player-logo.test.js` — added a regression test asserting the mobile `.player-logo-choice` rule doesn't declare `min-height: 0`.

### Root cause (confirmed, not guessed)

`.player-logo-picker>div` (the scrollable list of choices) is `display: grid` with implicit `auto` row tracks. Each `.player-logo-choice` is a grid item and, at the mobile breakpoint, a flex container whose only real content is a large aspect-ratio-square avatar (`width: min(62vw,260px)`, `aspect-ratio: 1`) — roughly 230px tall on a typical phone.

The mobile rule also set `.player-logo-choice { min-height: 0; ... }`. On Chromium's grid track-sizing algorithm (used by both Android Chrome and this session's Chromium-based browser-preview tool), that explicit `min-height: 0` suppresses the grid item's automatic minimum size, and the implicit `auto` row track collapsed to ~28px (just the label chrome) instead of expanding to the ~230px avatar. The avatar itself still painted at full size, visually overflowing into the following rows — producing the fanned, mashed-together stack in the screenshot. WebKit (Safari/iOS) sizes the row to the item's content regardless of `min-height: 0`, which is why the same CSS looked correct on iPhone. This is a genuine cross-engine CSS Grid intrinsic-sizing divergence, not a data or JS bug, and not something specific to the user's device — it reproduced identically in the local dev server under an emulated Android-Chrome/mobile viewport.

`min-height: 0` did not appear to serve any purpose in this specific rule (the picker's own scroll clipping already happens via `overflow-y: auto` / `overflow: hidden` on ancestor elements), so removing it was the minimal fix.

### Reproduction

1. `npm run dev` (already running locally on `127.0.0.1:4173`).
2. Open `http://127.0.0.1:4173/?view=player&room=<any-code>` with `localStorage` cleared, at a viewport ≤520px wide (e.g. 375×812).
3. Before the fix: the "Choose your player logo" list rendered as a stack of overlapping ~28px-tall pink cards with a ~230px avatar bleeding out of each into the next.
4. After the fix: each choice renders as a full, non-overlapping card and the list scrolls normally.

Verified with actual computed styles in the browser (`getBoundingClientRect()` on `.player-logo-choice` showed `height: 28px` before the fix, `height: 260.5px` after), not just visual inspection.

### Commands run and actual output

```
$ npm test
...
ℹ tests 116
ℹ pass 116
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Also confirmed the new test fails against the pre-fix CSS (temporarily restored `min-height: 0` in a scratch copy, re-ran `node --test test/player-logo.test.js`, saw the expected `AssertionError`, then restored the fix) before finalizing.

### Verified manually

- Mobile width (375px, emulated Android/Chromium): choice cards no longer overlap; full scroll through all 19 avatars checked, none overlapping.
- Desktop width (1280px): the wider icon+name row layout (not the mobile single-column layout) still renders correctly with no regression.

### Could not verify

- Real Android hardware/Chrome — only reproduced under an emulated Chromium mobile viewport in this session's browser-preview tool (which the tool itself describes as emulating Android Chrome UA at widths <768px). The computed-style evidence (grid row collapsing under `min-height:0`) is a browser-engine-level explanation, not something specific to one physical device, so this should generalize to real Android Chrome, but a real-device check by the user is the safest final confirmation.
- Real iPhone/Safari — did not have one to confirm the "looks fine" baseline; took the user's report as ground truth for the before-state.
- No live-room / real Supabase join flow was exercised — this was purely a client-side rendering fix on the join form, before any name is submitted or `data-join-room` is clicked.

### Unrelated observation (not touched)

`room-api.js` appeared as a modified file partway through this session that was not part of the initial `git status` and that I did not edit. Left untouched per the "one owner per slice" rule; flagged to the user rather than investigated or included in this change.

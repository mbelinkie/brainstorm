import test from "node:test";
import assert from "node:assert/strict";
import { activeCaptionAt, parseAss, parseSrt, parseSubtitle, visibleCaptionAt } from "../subtitle-core.js";

test("parseSrt normalizes BOM, CRLF, multiline text, settings, and ordering", () => {
  const captions = parseSrt("\uFEFF2\r\n00:00:03.5 --> 00:00:05,000 align:start\r\nSecond line\r\n\r\n1\r\n00:00:01,020 --> 00:00:02,4\r\nFirst\r\nlyric");
  assert.deepEqual(captions, [
    { startMs: 1020, endMs: 2400, text: "First\nlyric" },
    { startMs: 3500, endMs: 5000, text: "Second line" }
  ]);
});

test("parseSrt accepts unnumbered cues and rejects invalid nonempty blocks", () => {
  assert.deepEqual(parseSrt("00:00:00,000 --> 00:00:01,000\nHello"), [{ startMs: 0, endMs: 1000, text: "Hello" }]);
  assert.throws(() => parseSrt("1\nnot a timestamp\nHello"), /Cue 1/);
  assert.throws(() => parseSrt("1\n00:00:01,000 --> 00:00:01,000\nHello"), /end after/);
  assert.throws(() => parseSrt("1\n00:00:01,000 --> 00:00:02,000"), /caption text/);
});

test("parseAss reads dialogue cues, strips style tags, and preserves ASS line breaks", () => {
  const captions = parseAss("[Script Info]\nTitle: Theme\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.45,Default,,0,0,0,,{\\i1}First\\Nline\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Second, with comma");
  assert.deepEqual(captions, [
    { startMs: 1200, endMs: 3450, text: "First\nline" },
    { startMs: 4000, endMs: 5000, text: "Second, with comma" }
  ]);
  assert.deepEqual(parseSubtitle("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello", "theme.ass"), [{ startMs: 0, endMs: 1000, text: "Hello" }]);
  assert.throws(() => parseAss("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,Hello"), /end after/);
});

test("parseAss keeps karaoke tag timing for word-level highlighting", () => {
  const [cue] = parseAss("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\k20}Hel{\\kf30}lo {\\ko10}there");
  assert.deepEqual(cue, {
    startMs: 1000,
    endMs: 2000,
    text: "Hello there",
    karaoke: [
      { startMs: 1000, endMs: 1200, startIndex: 0, endIndex: 3 },
      { startMs: 1200, endMs: 1500, startIndex: 3, endIndex: 6 },
      { startMs: 1500, endMs: 1600, startIndex: 6, endIndex: 11 }
    ]
  });
});

test("activeCaptionAt uses inclusive starts, exclusive ends, gaps, and latest overlap", () => {
  const captions = [{ startMs: 1000, endMs: 3000, text: "first" }, { startMs: 2000, endMs: 4000, text: "later" }];
  assert.equal(activeCaptionAt(captions, 999), null);
  assert.equal(activeCaptionAt(captions, 1000)?.text, "first");
  assert.equal(activeCaptionAt(captions, 1999)?.text, "first");
  assert.equal(activeCaptionAt(captions, 2000)?.text, "later");
  assert.equal(activeCaptionAt(captions, 3000)?.text, "later");
  assert.equal(activeCaptionAt(captions, 4000), null);
});

test("visibleCaptionAt bridges only brief gaps between subtitle lines", () => {
  const captions = [
    { startMs: 1000, endMs: 2000, text: "first" },
    { startMs: 2200, endMs: 3000, text: "second" },
    { startMs: 3600, endMs: 4400, text: "third" }
  ];
  assert.equal(visibleCaptionAt(captions, 2100)?.text, "first");
  assert.equal(visibleCaptionAt(captions, 2200)?.text, "second");
  assert.equal(visibleCaptionAt(captions, 3200), null);
  assert.equal(visibleCaptionAt(captions, 3200, 700)?.text, "second");
});

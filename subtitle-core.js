function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d{1,}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value.trim() || "missing timestamp"}.`);
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) throw new Error(`Invalid SRT timestamp: ${value.trim()}.`);
  return ((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000 + Number(milliseconds.padEnd(3, "0"));
}

function parseAssTimestamp(value) {
  const match = String(value).trim().match(/^(\d{1,}):(\d{2}):(\d{2})\.(\d{1,2})$/);
  if (!match) throw new Error(`Invalid ASS timestamp: ${value.trim() || "missing timestamp"}.`);
  const [, hours, minutes, seconds, centiseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) throw new Error(`Invalid ASS timestamp: ${value.trim()}.`);
  return ((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000 + Number(centiseconds.padEnd(2, "0")) * 10;
}

function assDisplayText(value) {
  return value.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
}

function parseAssDialogueText(value, startMs, endMs) {
  const karaoke = [];
  const tagPattern = /\{([^}]*)\}/g;
  let text = "";
  let karaokeCursorMs = startMs;
  let pendingKaraokeDurationMs = null;
  let cursor = 0;

  const appendText = (rawText) => {
    const displayText = assDisplayText(rawText);
    if (!displayText) return;
    const startIndex = text.length;
    text += displayText;
    if (pendingKaraokeDurationMs !== null) {
      karaoke.push({
        startMs: karaokeCursorMs,
        endMs: Math.min(endMs, karaokeCursorMs + pendingKaraokeDurationMs),
        startIndex,
        endIndex: text.length
      });
      karaokeCursorMs += pendingKaraokeDurationMs;
      pendingKaraokeDurationMs = null;
    }
  };

  for (const match of value.matchAll(tagPattern)) {
    appendText(value.slice(cursor, match.index));
    const karaokeTags = [...match[1].matchAll(/\\(?:[kK]|kf|ko)(\d+)/g)];
    if (karaokeTags.length) pendingKaraokeDurationMs = Number(karaokeTags.at(-1)[1]) * 10;
    cursor = match.index + match[0].length;
  }
  appendText(value.slice(cursor));

  const leadingWhitespace = text.length - text.trimStart().length;
  const trimmedText = text.trim();
  const trimmedKaraoke = karaoke
    .map((segment) => ({
      ...segment,
      startIndex: Math.max(0, segment.startIndex - leadingWhitespace),
      endIndex: Math.min(trimmedText.length, segment.endIndex - leadingWhitespace)
    }))
    .filter((segment) => segment.endIndex > segment.startIndex && segment.endMs >= segment.startMs);
  return trimmedKaraoke.length ? { text: trimmedText, karaoke: trimmedKaraoke } : { text: trimmedText };
}

export function parseSrt(source) {
  const normalized = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const cues = normalized.split(/\n[ \t]*\n/).map((block, index) => {
    const lines = block.split("\n");
    if (/^\s*\d+\s*$/.test(lines[0]) && lines.length > 1) lines.shift();
    const timing = lines.shift()?.trim();
    const match = timing?.match(/^(.+?)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
    if (!match) throw new Error(`Cue ${index + 1} needs a valid start and end timestamp.`);
    const startMs = parseTimestamp(match[1]);
    const endMs = parseTimestamp(match[2]);
    const text = lines.join("\n").trim();
    if (endMs <= startMs) throw new Error(`Cue ${index + 1} must end after it starts.`);
    if (!text) throw new Error(`Cue ${index + 1} needs caption text.`);
    return { startMs, endMs, text };
  });
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function parseAss(source) {
  const lines = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let format = null;
  const cues = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    if (/^\[Events\]$/i.test(line)) { inEvents = true; continue; }
    if (/^\[.+\]$/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      format = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    if (!format) throw new Error(`ASS dialogue on line ${index + 1} needs an Events Format line.`);

    const fields = rawLine.slice(rawLine.indexOf(":") + 1).split(",");
    const startIndex = format.indexOf("start");
    const endIndex = format.indexOf("end");
    const textIndex = format.indexOf("text");
    if (startIndex < 0 || endIndex < 0 || textIndex < 0) throw new Error("ASS Events Format must include Start, End, and Text fields.");
    if (fields.length < format.length) throw new Error(`ASS dialogue on line ${index + 1} has too few fields.`);
    const startMs = parseAssTimestamp(fields[startIndex]);
    const endMs = parseAssTimestamp(fields[endIndex]);
    const caption = parseAssDialogueText(fields.slice(textIndex).join(","), startMs, endMs);
    const { text } = caption;
    if (endMs <= startMs) throw new Error(`ASS dialogue on line ${index + 1} must end after it starts.`);
    if (!text) throw new Error(`ASS dialogue on line ${index + 1} needs caption text.`);
    cues.push({ startMs, endMs, text, ...(caption.karaoke ? { karaoke: caption.karaoke } : {}) });
  }

  if (!format) throw new Error("ASS subtitles need an [Events] section with a Format line.");
  if (!cues.length) throw new Error("ASS subtitles need at least one Dialogue cue.");
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function parseSubtitle(source, filename = "") {
  return /\.ass$/i.test(filename) ? parseAss(source) : parseSrt(source);
}

export function activeCaptionAt(captions, timeMs) {
  if (!Array.isArray(captions) || !Number.isFinite(timeMs)) return null;
  let active = null;
  for (const cue of captions) if (cue && cue.startMs <= timeMs && timeMs < cue.endMs && (!active || cue.startMs >= active.startMs)) active = cue;
  return active;
}

export function visibleCaptionAt(captions, timeMs, continuityGapMs = 400) {
  const active = activeCaptionAt(captions, timeMs);
  if (active || !Array.isArray(captions) || !Number.isFinite(timeMs)) return active;

  // Keep the current subtitle box in place when the following line is nearly
  // contiguous. This prevents the box from flashing off between lyric lines,
  // while a meaningful pause still lets the normal CSS fade-out run.
  let previous = null;
  let next = null;
  for (const cue of captions) {
    if (!cue || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) continue;
    if (cue.endMs <= timeMs && (!previous || cue.endMs > previous.endMs)) previous = cue;
    if (cue.startMs > timeMs && (!next || cue.startMs < next.startMs)) next = cue;
  }
  if (previous && next && next.startMs - previous.endMs <= continuityGapMs) return previous;
  return null;
}

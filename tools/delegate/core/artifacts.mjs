// Pure validation of a DeepSeek response and of the artifact it carries, and
// staging of every edit in memory before anything touches disk.
//
// A response is accepted only when the whole of it is valid: finish reason
// `stop`, the expected model, no tool calls, parseable JSON with the artifact
// schema, every path inside the allowlist and outside the locked set, no path
// named twice across `files`, and each `old` text matching exactly once at the
// moment it is applied. Anything else is evidence only and nothing is applied.

import { isSafeRelativePath, matchesAny } from "./paths.mjs";

const fail = (code, message) => ({ ok: false, code, message });

// Strip one surrounding ```json fence if present.
export function extractJson(content) {
  const text = String(content ?? "").trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  return fenced ? fenced[1] : text;
}

export function checkResponse(body, { expectedModel }) {
  const choice = body?.choices?.[0];
  if (!choice) return fail("NO_CHOICE", "response has no choices");
  if (expectedModel && body.model !== expectedModel) {
    return fail("MODEL_MISMATCH", `returned model ${body.model ?? "none"}, expected ${expectedModel}`);
  }
  if (choice.finish_reason === "length") return fail("LENGTH", "response hit the output limit");
  if (choice.finish_reason !== "stop") return fail("FINISH_REASON", `finish reason ${choice.finish_reason ?? "none"}`);
  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    return fail("TOOL_CALLS", "response contains tool calls");
  }
  let artifact;
  try {
    artifact = JSON.parse(extractJson(choice.message?.content));
  } catch (error) {
    return fail("JSON_INVALID", `content is not valid JSON: ${String(error.message).slice(0, 120)}`);
  }
  return { ok: true, artifact };
}

const isString = (v) => typeof v === "string";

export function checkArtifactShape(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return fail("SCHEMA", "artifact is not an object");
  if (!["done", "blocked"].includes(artifact.status)) return fail("SCHEMA", "status must be done or blocked");
  for (const key of ["files", "edits", "blockers", "notes", "case_map"]) {
    if (artifact[key] !== undefined && !Array.isArray(artifact[key])) return fail("SCHEMA", `${key} must be an array`);
  }
  for (const f of artifact.files ?? []) {
    if (!f || !isString(f.path) || !isString(f.content)) return fail("SCHEMA", "each file needs string path and content");
  }
  for (const e of artifact.edits ?? []) {
    if (!e || !isString(e.path) || !isString(e.old) || !isString(e.new)) return fail("SCHEMA", "each edit needs string path, old and new");
    if (e.old.length === 0) return fail("SCHEMA", `edit for ${e.path} has empty old text`);
  }
  if (artifact.summary !== undefined && !isString(artifact.summary)) return fail("SCHEMA", "summary must be a string");
  if (artifact.status === "done" && (artifact.files ?? []).length + (artifact.edits ?? []).length === 0) {
    return fail("EMPTY", "status done but no files or edits");
  }
  return { ok: true };
}

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
};

// readFile(path) -> current content string, or null when the file does not exist.
// Returns { ok, staged: Map(path -> newContent) } without writing anything.
export function stageArtifact(artifact, { allow = [], locked = [], readFile }) {
  const shape = checkArtifactShape(artifact);
  if (!shape.ok) return shape;
  if (artifact.status === "blocked") return fail("BLOCKED", (artifact.blockers ?? []).join("; ").slice(0, 500) || "worker reported blocked");

  const touched = [...(artifact.files ?? []).map((f) => f.path), ...(artifact.edits ?? []).map((e) => e.path)];
  for (const filePath of touched) {
    if (!isSafeRelativePath(filePath)) return fail("PATH_UNSAFE", `unsafe path ${JSON.stringify(filePath)}`);
    if (locked.includes(filePath)) return fail("PATH_LOCKED", `${filePath} is a locked acceptance file`);
    if (!matchesAny(filePath, allow)) return fail("PATH_OUTSIDE_SCOPE", `${filePath} is outside the write scope`);
  }
  const filePaths = (artifact.files ?? []).map((f) => f.path);
  const duplicate = filePaths.find((p, i) => filePaths.indexOf(p) !== i);
  if (duplicate) return fail("PATH_DUPLICATE", `${duplicate} appears twice in files`);
  const both = (artifact.edits ?? []).find((e) => filePaths.includes(e.path));
  if (both) return fail("PATH_AMBIGUOUS", `${both.path} is both replaced whole and edited`);

  const staged = new Map();
  for (const f of artifact.files ?? []) staged.set(f.path, f.content);
  for (const e of artifact.edits ?? []) {
    const current = staged.has(e.path) ? staged.get(e.path) : readFile(e.path);
    if (current === null || current === undefined) return fail("EDIT_MISSING_FILE", `${e.path} does not exist`);
    const hits = countOccurrences(current, e.old);
    if (hits !== 1) return fail("EDIT_MATCH", `old text for ${e.path} matches ${hits} times (needs exactly 1)`);
    staged.set(e.path, current.replace(e.old, () => e.new));
  }
  return { ok: true, staged };
}

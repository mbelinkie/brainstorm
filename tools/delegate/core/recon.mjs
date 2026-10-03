// Pure helpers for recon and triage: candidate-file selection for the Scout
// (which has no tools), quote verification, and validation of the Scout's
// and the Controller's JSON.

import { matchesAny, isSafeRelativePath } from "./paths.mjs";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "must", "should", "when", "then", "none", "only", "each", "issue", "test", "tests", "file", "files", "code", "work", "also", "will", "have", "does", "make", "used", "uses", "user", "after", "before", "under", "true", "false", "null",
  // Issue-template vocabulary: present in every ticket, so it matches the roadmap tooling rather than the product.
  "outcome", "scope", "exclusions", "acceptance", "automated", "producer", "covered", "including", "recorded", "through", "section", "passes", "pasted", "commit", "npm test"]);

// Words and identifiers worth searching for, from the ticket text.
export function ticketTerms(text) {
  const t = String(text ?? "");
  const terms = new Set();
  for (const m of t.matchAll(/`([^`\n]{3,80})`/g)) if (!STOP.has(m[1].trim().toLowerCase())) terms.add(m[1].trim());
  for (const m of t.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*)\b/g)) {
    const w = m[1];
    if (w.length >= 5 && !STOP.has(w.toLowerCase()) && (/[A-Z_]/.test(w.slice(1)) || /[.-]/.test(w) || w.length >= 7)) terms.add(w);
  }
  return [...terms].slice(0, 60);
}

// Exported symbol names for a repository map line.
export function exportedSymbols(source) {
  const names = new Set();
  for (const m of String(source ?? "").matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of String(source ?? "").matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return [...names].slice(0, 25);
}

export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

// Issue-template sections about process (authorization, routing, baseline,
// verification, dependencies) say nothing about the code, and their boilerplate
// matched the roadmap tooling instead of the product files (pilot, issue #44).
const PROCESS_HEADING = /^#{1,6}\s*(?:boundaries|routing|starting baseline|verification|dependencies|dispatch)/i;
export function contractText(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text ?? "").split("\n")) {
    if (/^#{1,6}\s/.test(line)) { skipping = PROCESS_HEADING.test(line); continue; } // headings are template words
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

// Tracked files a text names, by full path or by a basename only one file has.
export function referencedFiles(text, files) {
  const t = String(text ?? "");
  const found = new Set(files.filter((f) => f.includes("/") && t.includes(f)));
  const byBase = new Map();
  for (const f of files) {
    const base = f.split("/").pop();
    byBase.set(base, byBase.has(base) ? null : f);
  }
  for (const m of t.matchAll(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:md|m?js|cjs|sql|json|jsonc|html|css)\b/g)) {
    const f = byBase.get(m[0]);
    if (f) found.add(f);
  }
  return [...found];
}

// files: tracked repository-relative paths; readFile(path) -> string|null.
// Returns { map, chosen: [{path, reason}], tokens }.
// Order: files the ticket names, files those documents name (one hop), then
// files matching the ticket's distinctive terms, then direct importers.
export function selectContext({ files, ticketText, readFile, excludes = [], tokenCap = 200_000, maxFiles = 40 }) {
  const usable = files.filter((f) => isSafeRelativePath(f) && !matchesAny(f, excludes) && /\.(?:m?js|cjs|ts|json|sql|md|html|css|toml|jsonc)$/.test(f));
  const terms = ticketTerms(contractText(ticketText));
  const sources = new Map();
  const read = (f) => {
    if (!sources.has(f)) sources.set(f, readFile(f) ?? "");
    return sources.get(f);
  };
  const map = usable.map((f) => {
    const syms = /\.m?js$/.test(f) ? exportedSymbols(read(f)) : [];
    return syms.length ? `${f}: ${syms.join(", ")}` : f;
  });

  // Rarer terms weigh more; a term most files contain says nothing.
  const n = usable.length;
  const weights = new Map();
  for (const term of terms) {
    const df = usable.filter((f) => f.includes(term) || read(f).includes(term)).length;
    if (df > 0 && df <= Math.max(8, n * 0.1)) weights.set(term, Math.log(1 + n / df));
  }
  const scored = [];
  for (const f of usable) {
    const text = read(f);
    let score = 0;
    const hits = [];
    for (const [term, w] of weights) {
      if (f.includes(term)) { score += 3 * w; hits.push(term); continue; }
      if (text.includes(term)) { score += w; hits.push(term); }
    }
    if (score > 0) scored.push({ path: f, score, hits });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const chosen = [];
  let tokens = estimateTokens(map.join("\n"));
  const take = (f, reason) => {
    if (chosen.some((c) => c.path === f) || chosen.length >= maxFiles) return;
    const cost = estimateTokens(read(f));
    if (tokens + cost > tokenCap) return;
    tokens += cost;
    chosen.push({ path: f, reason });
  };
  const named = referencedFiles(ticketText, usable);
  for (const f of named) take(f, "named in the ticket");
  for (const doc of named.filter((f) => f.endsWith(".md"))) {
    // Documents and code only: fixtures and migrations a spec mentions in passing are large and rarely the subject.
    for (const f of referencedFiles(read(doc), usable).filter((p) => /\.(?:md|m?js|cjs)$/.test(p)).slice(0, 12)) take(f, `named in ${doc}`);
  }
  for (const s of scored.slice(0, Math.ceil(maxFiles / 2))) take(s.path, `matches ${s.hits.slice(0, 4).join(", ")}`);
  // Direct importers of the chosen files.
  for (const c of [...chosen]) {
    const base = c.path.replace(/\.[^.]+$/, "").split("/").pop();
    for (const f of usable) {
      if (f === c.path) continue;
      const text = read(f);
      if (new RegExp(`from\\s+["'][^"']*${base.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?:\\.m?js)?["']`).test(text)) take(f, `imports ${c.path}`);
    }
  }
  return { map: map.join("\n"), chosen, tokens, terms };
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Each claim must quote text that really appears in its file's line range.
export function verifyClaims(claims, readFile) {
  const verified = [];
  const unverified = [];
  for (const claim of claims ?? []) {
    const content = isSafeRelativePath(claim?.path) ? readFile(claim.path) : null;
    const lines = content === null || content === undefined ? null : content.split("\n");
    const start = Number(claim?.start);
    const end = Number(claim?.end);
    const ok = lines !== null && Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length + 1
      && norm(claim.quote).length > 0
      && norm(lines.slice(start - 1, end).join("\n")).includes(norm(claim.quote));
    (ok ? verified : unverified).push(claim);
  }
  return { verified, unverified, total: (claims ?? []).length };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function validateRecon(recon) {
  const problems = [];
  if (!isObj(recon)) return ["recon is not an object"];
  if (typeof recon.summary !== "string") problems.push("summary missing");
  for (const key of ["claims", "files_to_change", "callers", "proposed_cases", "open_questions", "risk_flags", "contract_drift"]) {
    if (!Array.isArray(recon[key])) problems.push(`${key} must be an array`);
  }
  if (!["coding", "design", "research", "mixed"].includes(recon.work_type)) problems.push("work_type invalid");
  if (!["yes", "no"].includes(recon.testable_done)) problems.push("testable_done must be yes or no");
  if (!["express", "standard", "protected"].includes(recon.suggested_lane)) problems.push("suggested_lane invalid");
  for (const c of recon.proposed_cases ?? []) {
    if (!isObj(c) || !/^[A-Z]\d+$/.test(c.id ?? "") || typeof c.given !== "string" || typeof c.expect !== "string") problems.push("each proposed case needs id (A1), given, expect");
  }
  for (const f of recon.files_to_change ?? []) if (!isSafeRelativePath(f)) problems.push(`unsafe path ${f}`);
  return problems;
}

const BROAD_SCOPE = /^(?:\*\*?(?:\/\*\*?)*(?:\/\*(?:\.\w+)?)?|\*\.\w+)$/;

function validateSlices(t, where) {
  const problems = [];
  if (!Array.isArray(t.slices) || t.slices.length === 0 || t.slices.length > 6) return [`${where} slices must be a list of 1-6`];
  const caseIds = new Set((t.cases ?? []).map((c) => c.id));
  const seen = new Map();
  t.slices.forEach((slice, i) => {
    const sw = `${where} slice ${i + 1}`;
    if (!isObj(slice) || !/^S\d+$/.test(slice.id ?? "")) { problems.push(`${sw} needs id S1, S2...`); return; }
    if (typeof slice.goal !== "string" || !slice.goal.trim()) problems.push(`${sw} needs a goal`);
    if (!Array.isArray(slice.scope) || slice.scope.length === 0 || slice.scope.some((g) => typeof g !== "string" || g.startsWith("/") || g.includes("..") || BROAD_SCOPE.test(g.trim()))) problems.push(`${sw} scope must be narrow relative globs`);
    if (!Array.isArray(slice.cases)) problems.push(`${sw} cases must list case ids`);
    for (const id of slice.cases ?? []) {
      if (!caseIds.has(id)) problems.push(`${sw} names unknown case ${id}`);
      if (seen.has(id)) problems.push(`case ${id} is in two slices`);
      seen.set(id, slice.id);
    }
  });
  for (const id of caseIds) if (!seen.has(id)) problems.push(`${where} case ${id} is in no slice`);
  return problems;
}

// Slices to run, in order. Without explicit slices the ticket is one slice.
export function normalizeSlices(decision) {
  if (Array.isArray(decision.slices) && decision.slices.length) {
    return decision.slices.map((s) => ({ id: s.id, goal: s.goal, scope: s.scope, allow: s.allow ?? decision.allow ?? [], caseIds: s.cases ?? [] }));
  }
  return [{ id: "S1", goal: "the whole ticket", scope: decision.scope ?? [], allow: decision.allow ?? [], caseIds: (decision.cases ?? []).map((c) => c.id) }];
}

// Controller triage decision: { tickets: [{ n, fit, lane, decisions, escalate, cases, scope, allow }] }
export function validateTriage(value, expectedNumbers) {
  const problems = [];
  if (!isObj(value) || !Array.isArray(value.tickets)) return { ok: false, problems: ["triage needs a tickets array"] };
  const byN = new Map();
  for (const t of value.tickets) {
    if (!isObj(t) || !Number.isInteger(t.n)) { problems.push("each ticket needs integer n"); continue; }
    const where = `#${t.n}`;
    if (!["ok", "flag"].includes(t.fit)) problems.push(`${where} fit must be ok or flag`);
    if (t.fit === "ok") {
      if (!["express", "standard", "protected"].includes(t.lane)) problems.push(`${where} lane invalid`);
      if (!Array.isArray(t.scope) || t.scope.length === 0 || !t.scope.every((g) => typeof g === "string" && !g.startsWith("/") && !g.includes(".."))) problems.push(`${where} scope must be non-empty relative globs`);
      // A scope must name where the work goes; a whole-repository glob is not a scope.
      else if (t.scope.some((g) => BROAD_SCOPE.test(g.trim()))) problems.push(`${where} scope is too broad (${t.scope.join(", ")})`);
      if (!Array.isArray(t.cases)) problems.push(`${where} cases must be an array`);
      else if (t.lane === "standard" && t.cases.length === 0 && !t.escalate) problems.push(`${where} standard lane needs at least one case`);
      for (const c of t.cases ?? []) if (!isObj(c) || !/^[A-Z]\d+$/.test(c.id ?? "") || typeof c.expect !== "string") problems.push(`${where} case needs id and expect`);
      if (t.allow !== undefined && (!Array.isArray(t.allow) || !t.allow.every((a) => ["deps", "config", "suppressions"].includes(a)))) problems.push(`${where} allow invalid`);
    }
    if (t.fit === "ok" && t.slices !== undefined && t.slices !== null) problems.push(...validateSlices(t, where));
    if (t.real_process_checks !== undefined && (!Array.isArray(t.real_process_checks) || !t.real_process_checks.every((c) => typeof c === "string" && c.trim()))) problems.push(`${where} real_process_checks must be strings`);
    byN.set(t.n, t);
  }
  for (const n of expectedNumbers) if (!byN.has(n)) problems.push(`#${n} missing from triage`);
  return problems.length ? { ok: false, problems } : { ok: true, byN };
}

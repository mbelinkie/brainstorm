// Pure helpers for Codex sessions launched by the harness: argument building,
// JSONL event parsing, decision parsing, budgets, credits and plan headroom.
//
// Event and rate-limit field names (thread.started/thread_id,
// turn.completed/usage.{input_tokens,cached_input_tokens,output_tokens},
// rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at}) were
// read from the codex-cli 0.160.0 binary, not from a live run. The first real
// session is the confirmation; missing fields fail closed.

// Identity variables a launched session must set for itself, never inherit.
export const IDENTITY_ENV = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

export function childEnv(env) {
  const out = { ...env };
  for (const key of IDENTITY_ENV) delete out[key];
  return out;
}

const tomlString = (value) => JSON.stringify(String(value));

export function buildExecArgs({ model, effort, sandbox = "workspace-write", extraConfig = [], cwd, outputFile, schemaFile = null, resumeId = null }) {
  const config = [`model_reasoning_effort=${tomlString(effort)}`, `sandbox_mode=${tomlString(sandbox)}`, ...extraConfig];
  const args = ["exec"];
  if (resumeId) args.push("resume");
  args.push("--json", "-m", model);
  for (const c of config) args.push("-c", c);
  if (!resumeId) {
    args.push("-s", sandbox);
    if (cwd) args.push("-C", cwd);
  }
  if (outputFile) args.push("-o", outputFile);
  if (schemaFile) args.push("--output-schema", schemaFile);
  if (resumeId) args.push(resumeId);
  args.push("-"); // prompt on stdin
  return args;
}

// Codex wraps the provider's error as a JSON string; keep the readable part.
const errorText = (raw) => {
  const text = String(raw ?? "");
  try {
    const inner = JSON.parse(text);
    const message = inner?.error?.message ?? inner?.message;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300);
};

export function parseEvents(jsonl) {
  const result = { threadId: null, usage: null, turns: 0, failed: false, errors: [], unparsed: 0 };
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { result.unparsed += 1; continue; }
    if (event.type === "thread.started" && event.thread_id) result.threadId = event.thread_id;
    if (event.type === "turn.completed") {
      result.turns += 1;
      const u = event.usage;
      if (u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)) {
        result.usage ??= { input: 0, cached: 0, output: 0 };
        result.usage.input += u.input_tokens;
        result.usage.cached += Number.isFinite(u.cached_input_tokens) ? u.cached_input_tokens : 0;
        result.usage.output += u.output_tokens;
      }
    }
    if (event.type === "turn.failed") {
      result.failed = true;
      result.errors.push(errorText(event.error?.message ?? "turn failed"));
    }
    if (event.type === "error") result.errors.push(errorText(event.message ?? "error"));
  }
  return result;
}

// The session's last message must end with exactly one fenced JSON object.
export function parseDecision(lastMessage) {
  const text = String(lastMessage ?? "");
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  const candidate = fences.length ? fences[fences.length - 1][1] : text.trim();
  try {
    const value = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "DECISION_SHAPE", message: "decision is not a JSON object" };
    return { ok: true, value };
  } catch {
    return { ok: false, code: "DECISION_UNPARSEABLE", message: "last message has no parseable JSON object" };
  }
}

export function overBudget(usage, budget) {
  if (!usage) return { over: true, reason: "usage missing (unknown is never zero)" };
  if (usage.input > budget.input) return { over: true, reason: `input ${usage.input} > ${budget.input}` };
  if (usage.output > budget.output) return { over: true, reason: `output ${usage.output} > ${budget.output}` };
  return { over: false };
}

// Codex rate card, credits per 1M tokens: [input, cached input, output].
export const CREDIT_RATES = {
  "gpt-6-luna": [2.5, 0.25, 12.5],
  "gpt-6.1-sol": [50, 2.5, 250],
  "gpt-6-sol": [50, 5, 250],
  "gpt-5.6-luna": [5, 0.5, 30],
  "gpt-5.6-sol": [100, 10, 500],
};

export function creditsFor(model, usage) {
  const rate = CREDIT_RATES[model];
  if (!rate || !usage) return null;
  const uncached = Math.max(0, usage.input - usage.cached);
  return (uncached * rate[0] + usage.cached * rate[1] + usage.output * rate[2]) / 1e6;
}

// Find the latest rate-limit snapshot anywhere in a session log.
export function parseRateLimits(jsonl) {
  let latest = null;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.rate_limits && typeof node.rate_limits === "object") latest = node.rate_limits;
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.includes("rate_limits")) continue;
    try { visit(JSON.parse(line)); } catch { /* skip */ }
  }
  if (!latest) return null;
  const win = (w) => (w && Number.isFinite(Number(w.used_percent))
    ? { usedPercent: Number(w.used_percent), windowMinutes: Number(w.window_minutes ?? NaN), resetsAt: w.resets_at ?? null }
    : null);
  const reading = { primary: win(latest.primary), secondary: win(latest.secondary) };
  return reading.primary ? reading : null;
}

// Decide whether a new Codex session may start now.
// reading: parseRateLimits result or null; firstSession: no session has run yet this batch.
export function headroom({ reading, headroomPercent, creditCap = 0, creditsSpent = 0, firstSession = false, requireReading = true, nowMs = Date.now() }) {
  if (!reading) {
    if (firstSession) return { action: "start", reason: "no usage reading yet; first session of the batch" };
    if (!requireReading) return { action: "start", reason: "plan usage unreadable; owner disabled plan.requireUsageReading" };
    return { action: "stop", code: "USAGE_UNKNOWN", reason: "plan usage could not be read; unknown counts as exhausted" };
  }
  if (reading.secondary && reading.secondary.usedPercent >= 100) {
    return { action: "stop", code: "WEEKLY_LIMIT", reason: `weekly usage ${reading.secondary.usedPercent}%` };
  }
  if (reading.primary.usedPercent < headroomPercent) return { action: "start", reason: `5-hour usage ${reading.primary.usedPercent}%` };
  if (creditsSpent < creditCap) return { action: "start", onCredits: true, reason: `5-hour usage ${reading.primary.usedPercent}%; continuing on credits (${creditsSpent.toFixed(1)}/${creditCap})` };
  const resetsAtMs = toMs(reading.primary.resetsAt);
  if (resetsAtMs === null) return { action: "stop", code: "RESET_UNKNOWN", reason: "5-hour limit reached and reset time unknown" };
  return { action: "wait", untilMs: Math.max(resetsAtMs, nowMs), reason: `5-hour usage ${reading.primary.usedPercent}%; waiting for reset` };
}

function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

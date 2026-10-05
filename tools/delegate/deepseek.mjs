// DeepSeek client for the delegation harness. Artifact-only: requests carry no
// tools, and every response (including failures) is recorded privately.
//
// The API key is read from a private file outside the repository by the caller
// and passed in; this module never prints, records or returns it.

export const DEFAULT_BASE_URL = "https://api.deepseek.com";

const redactHeaders = (headers) => ({ ...headers, Authorization: "[redacted]" });

export function createDeepSeek({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl = globalThis.fetch, recorder = () => {}, now = Date.now, timeoutMs = 600_000 } = {}) {
  if (!apiKey) throw new Error("DeepSeek API key missing");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };

  async function call(method, path, body, purpose) {
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status = 0;
    let json = null;
    let error = null;
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      status = res.status;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch { json = { _unparsed: text.slice(0, 2000) }; }
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
    } finally {
      clearTimeout(timer);
    }
    recorder({ purpose, method, path, request: body ?? null, headers: redactHeaders(headers), status, response: json, error, latencyMs: now() - started, at: new Date(started).toISOString() });
    return { status, json, error };
  }

  async function listModels() {
    const { status, json, error } = await call("GET", "/models", null, "models");
    if (status !== 200 || !Array.isArray(json?.data)) return { ok: false, code: "MODELS_UNAVAILABLE", message: error ?? `HTTP ${status}` };
    return { ok: true, ids: json.data.map((m) => m.id) };
  }

  // { ok, usd } or { ok:false, code:"BALANCE_UNRELIABLE" }
  async function balance() {
    const { status, json, error } = await call("GET", "/user/balance", null, "balance");
    const usd = Array.isArray(json?.balance_infos) ? json.balance_infos.filter((b) => b.currency === "USD") : [];
    const value = usd.length === 1 ? Number(usd[0].total_balance) : NaN;
    if (status !== 200 || !Number.isFinite(value)) return { ok: false, code: "BALANCE_UNRELIABLE", message: error ?? `HTTP ${status}` };
    return { ok: true, usd: value };
  }

  // Returns the raw response plus the facts the ledger needs. Validation of the
  // artifact itself is done by core/artifacts.mjs.
  async function chat({ model, effort, messages, maxTokens, purpose = "chat", jsonMode = false }) {
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      thinking: { type: "enabled" },
      reasoning_effort: effort,
    };
    // JSON mode is opt-in: its interaction with thinking mode is unverified here.
    if (jsonMode) body.response_format = { type: "json_object" };
    const { status, json, error } = await call("POST", "/chat/completions", body, purpose);
    const choice = json?.choices?.[0];
    const facts = {
      requestedModel: model,
      returnedModel: json?.model ?? null,
      fingerprint: json?.system_fingerprint ?? null,
      requestId: json?.id ?? null,
      effort,
      maxTokens,
      finishReason: choice?.finish_reason ?? null,
      usage: json?.usage ?? null,
    };
    if (status !== 200 || !choice) return { ok: false, code: error ? "TRANSPORT" : "HTTP_ERROR", message: error ?? `HTTP ${status}`, facts, body: json };
    return { ok: true, facts, body: json };
  }

  return { listModels, balance, chat };
}

// Stable prefix first (system), then conventions, packet and failure excerpt,
// so DeepSeek's automatic prefix cache can hit across requests.
export function buildMessages({ prefix, conventions = "", packet, failure = "" }) {
  const user = [conventions && `--- repository conventions ---\n${conventions}`, `--- packet ---\n${packet}`, failure && `--- failure excerpt ---\n${failure}`]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: prefix },
    { role: "user", content: user },
  ];
}

// A response cut off by the output limit is retried once with a larger cap; a
// second cut-off means the slice is too large and must be split.
export async function chatWithLengthRetry(client, args, { retryMaxTokens }) {
  const first = await client.chat(args);
  if (!first.ok || first.facts.finishReason !== "length") return { ...first, attempts: [first.facts] };
  const second = await client.chat({ ...args, maxTokens: retryMaxTokens, purpose: `${args.purpose ?? "chat"}-length-retry` });
  if (second.ok && second.facts.finishReason === "length") {
    return { ok: false, code: "SPLIT_NEEDED", message: "output limit hit twice; split the slice", facts: second.facts, attempts: [first.facts, second.facts] };
  }
  return { ...second, attempts: [first.facts, second.facts] };
}

// Spend stop against the batch baseline. Unreliable readings pause dispatch.
export function createSpendGuard({ baselineUsd, capUsd, readBalance }) {
  return async function check() {
    const reading = await readBalance();
    if (!reading.ok) return { ok: false, code: "BALANCE_UNRELIABLE", message: "DeepSeek balance could not be read reliably; dispatch paused" };
    const spent = Math.round((baselineUsd - reading.usd) * 100) / 100;
    if (spent >= capUsd) return { ok: false, code: "SPEND_CAP", message: `observed DeepSeek spend $${spent.toFixed(2)} reached the $${capUsd} cap`, spent };
    return { ok: true, spent, usd: reading.usd };
  };
}

// Cost estimate from usage at the published off-peak/peak prices (per 1M tokens).
export const PRICES = {
  "deepseek-flash": { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};

// Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday (Chinese holidays ignored: conservative).
export function isPeak(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function estimateUsd(model, usage, date = new Date()) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const i = isPeak(date) ? 1 : 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  const out = usage.completion_tokens ?? 0;
  return (hit * p.hit[i] + miss * p.miss[i] + out * p.out[i]) / 1e6;
}

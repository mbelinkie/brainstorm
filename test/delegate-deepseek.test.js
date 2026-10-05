import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeek, buildMessages, chatWithLengthRetry, createSpendGuard, estimateUsd, isPeak } from "../tools/delegate/deepseek.mjs";

const KEY = "test-key-not-a-real-secret";

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = await handler(url, init, calls.length);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

const completion = (finish = "stop", model = "deepseek-flash") => ({
  id: "req-1",
  model,
  system_fingerprint: "fp_x",
  choices: [{ finish_reason: finish, message: { content: "{\"status\":\"done\",\"files\":[]}" } }],
  usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 20 },
});

test("chat sends thinking, effort, json mode and no tools; records without the key", async () => {
  const records = [];
  const fetchImpl = fakeFetch(() => ({ body: completion() }));
  const ds = createDeepSeek({ apiKey: KEY, fetchImpl, recorder: (r) => records.push(r) });
  const res = await ds.chat({ model: "deepseek-flash", effort: "high", maxTokens: 65536, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.ok, true);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.thinking, { type: "enabled" });
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(sent.max_tokens, 65536);
  assert.equal(sent.tools, undefined, "no tools are ever offered");
  assert.equal(res.facts.requestId, "req-1");
  assert.equal(res.facts.fingerprint, "fp_x");
  assert.equal(res.facts.returnedModel, "deepseek-flash");
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes(KEY), "the key never reaches the record");
  assert.ok(fetchImpl.calls[0].url.endsWith("/chat/completions"));
});

test("transport and HTTP failures are recorded and returned, never thrown", async () => {
  const records = [];
  const ds = createDeepSeek({ apiKey: KEY, fetchImpl: async () => { throw new Error("ECONNRESET"); }, recorder: (r) => records.push(r) });
  const res = await ds.chat({ model: "deepseek-flash", effort: "low", maxTokens: 10, messages: [] });
  assert.equal(res.ok, false);
  assert.equal(res.code, "TRANSPORT");
  assert.equal(records[0].error, "ECONNRESET");
  const ds2 = createDeepSeek({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ status: 400, body: { error: { message: "bad" } } })) });
  assert.equal((await ds2.chat({ model: "m", effort: "low", maxTokens: 1, messages: [] })).code, "HTTP_ERROR");
});

test("models and balance; an ambiguous or missing USD balance is unreliable", async () => {
  const ds = createDeepSeek({ apiKey: KEY, fetchImpl: fakeFetch((url) => (url.endsWith("/models")
    ? { body: { data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] } }
    : { body: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "18.06" }] } })) });
  assert.deepEqual((await ds.listModels()).ids, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.deepEqual(await ds.balance(), { ok: true, usd: 18.06 });
  const cny = createDeepSeek({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ body: { balance_infos: [{ currency: "CNY", total_balance: "5" }] } })) });
  assert.equal((await cny.balance()).code, "BALANCE_UNRELIABLE");
  assert.throws(() => createDeepSeek({ apiKey: "" }));
});

test("length retry: one larger retry, then SPLIT_NEEDED", async () => {
  let n = 0;
  const client = { chat: async (args) => { n += 1; return { ok: true, facts: { finishReason: n === 1 ? "length" : "stop", maxTokens: args.maxTokens } }; } };
  const ok = await chatWithLengthRetry(client, { maxTokens: 10 }, { retryMaxTokens: 20 });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts.length, 2);
  assert.equal(ok.facts.maxTokens, 20);
  const always = { chat: async () => ({ ok: true, facts: { finishReason: "length" } }) };
  assert.equal((await chatWithLengthRetry(always, { maxTokens: 10 }, { retryMaxTokens: 20 })).code, "SPLIT_NEEDED");
  const once = { chat: async () => ({ ok: true, facts: { finishReason: "stop" } }) };
  assert.equal((await chatWithLengthRetry(once, {}, { retryMaxTokens: 20 })).attempts.length, 1);
});

test("spend guard stops at the cap and pauses on unreliable readings", async () => {
  const guard = (usd) => createSpendGuard({ baselineUsd: 18.06, capUsd: 10, readBalance: async () => usd });
  assert.equal((await guard({ ok: true, usd: 17.0 })()).ok, true);
  assert.equal((await guard({ ok: true, usd: 8.06 })()).code, "SPEND_CAP");
  assert.equal((await guard({ ok: false })()).code, "BALANCE_UNRELIABLE");
});

test("messages put the stable prefix first; cost estimate uses peak windows", () => {
  const m = buildMessages({ prefix: "P", conventions: "C", packet: "K", failure: "F" });
  assert.equal(m[0].content, "P");
  assert.ok(m[1].content.indexOf("C") < m[1].content.indexOf("K"));
  assert.ok(m[1].content.indexOf("K") < m[1].content.indexOf("F"));
  assert.equal(isPeak(new Date("2026-10-05T07:00:00Z")), true, "Monday 07:00 UTC is peak");
  assert.equal(isPeak(new Date("2026-10-05T14:00:00Z")), false);
  assert.equal(isPeak(new Date("2026-10-04T07:00:00Z")), false, "Sunday is off-peak");
  const usd = estimateUsd("deepseek-flash", completion().usage, new Date("2026-10-05T14:00:00Z"));
  assert.ok(Math.abs(usd - (60 * 0.003 + 40 * 0.15 + 20 * 0.6) / 1e6) < 1e-12);
  assert.equal(estimateUsd("unknown", {}), null);
});

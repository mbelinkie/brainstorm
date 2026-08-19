import test from "node:test";
import assert from "node:assert/strict";
import { ENGINES } from "../image-engine.js";

test("openrouter resolveAuth returns a bearer header from env and never fetches", async () => {
  const auth = await ENGINES.openrouter.resolveAuth({ OPENROUTER_API_KEY: "sk-test-key" });
  assert.deepEqual(auth, { headers: { Authorization: "Bearer sk-test-key" } });
});

test("openrouter resolveAuth rejects when the key is missing", async () => {
  await assert.rejects(() => ENGINES.openrouter.resolveAuth({}), /OPENROUTER_API_KEY/);
});

test("openrouter endpoint is the images route", () => {
  assert.equal(ENGINES.openrouter.endpoint(), "https://openrouter.ai/api/v1/images");
});

test("openrouter buildRequest shapes the provider payload and clamps variants", () => {
  const request = ENGINES.openrouter.buildRequest({
    model: "google/gemini-3.1-flash-image",
    prompt: "Depict the worst office party ever.",
    variants: 4,
    resolution: "512",
    outputFormat: "webp"
  });
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "google/gemini-3.1-flash-image",
    prompt: "Depict the worst office party ever.",
    n: 4,
    resolution: "512x512",
    aspect_ratio: "1:1",
    output_format: "webp",
    output_compression: 80
  });
});

test("openrouter buildRequest clamps variants into the provider's 1-10 range", () => {
  const tooMany = JSON.parse(ENGINES.openrouter.buildRequest({ model: "m", prompt: "p", variants: 99, resolution: "512", outputFormat: "webp" }).body);
  assert.equal(tooMany.n, 10);
  const tooFew = JSON.parse(ENGINES.openrouter.buildRequest({ model: "m", prompt: "p", variants: 0, resolution: "512", outputFormat: "webp" }).body);
  assert.equal(tooFew.n, 1);
});

test("openrouter parseResponse reads images and actual cost from a successful fixture", () => {
  const fixture = {
    data: [
      { b64_json: "AAAA", media_type: "image/webp" },
      { b64_json: "BBBB", media_type: "image/webp" }
    ],
    usage: { cost: 0.045 }
  };
  const parsed = ENGINES.openrouter.parseResponse(fixture);
  assert.deepEqual(parsed, {
    images: [
      { mimeType: "image/webp", bytesBase64: "AAAA" },
      { mimeType: "image/webp", bytesBase64: "BBBB" }
    ],
    costUsd: 0.045,
    blocked: false,
    blockReason: null
  });
});

test("openrouter parseResponse treats a moderation error as a safety block, not a crash", () => {
  const fixture = { error: { code: "content_policy_violation", message: "This request was flagged by the safety filter." }, usage: { cost: 0 } };
  const parsed = ENGINES.openrouter.parseResponse(fixture);
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.blockReason, "This request was flagged by the safety filter.");
  assert.deepEqual(parsed.images, []);
});

test("openrouter parseResponse defaults cost to 0 when usage is absent", () => {
  const parsed = ENGINES.openrouter.parseResponse({ data: [{ b64_json: "AAAA", media_type: "image/webp" }] });
  assert.equal(parsed.costUsd, 0);
});

test("vertex adapter is present but explicitly not implemented", async () => {
  assert.ok(ENGINES.vertex);
  await assert.rejects(() => ENGINES.vertex.resolveAuth(), /not implemented/);
  assert.throws(() => ENGINES.vertex.endpoint(), /not implemented/);
  assert.throws(() => ENGINES.vertex.buildRequest(), /not implemented/);
  assert.throws(() => ENGINES.vertex.parseResponse(), /not implemented/);
});

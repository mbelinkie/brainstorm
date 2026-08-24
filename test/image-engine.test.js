// image-engine.js is the pure adapter layer for Prompt Battle image
// generation: no fetching, no side effects, no randomness. Every case here
// runs from fixtures -- CLAUDE.md forbids live external calls in tests, and
// the addendum's whole point (section 2) is that the plural
// buildRequests/parseResponses contract makes that possible even for a
// provider (Workers AI) that needs N calls for N variants.
//
// Only the workers_ai adapter exists this slice
// (docs/superpowers/specs/2026-08-24-prompt-battle-free-engine-addendum.md,
// section 4). openrouter, vertex, and the Kaplan proxy are deferred, so
// there is no ENGINES.openrouter here to test against.
import test from "node:test";
import assert from "node:assert/strict";
import { ENGINES, isWorkersAiSafetyRejection } from "../image-engine.js";

const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const workersAi = ENGINES.workers_ai;

// --- buildRequests -----------------------------------------------------

test("workers_ai.buildRequests returns one binding descriptor per variant, each with its own seed", () => {
  const descriptors = workersAi.buildRequests({ model: MODEL, prompt: "A cat in a hat", variants: 2, seeds: [111, 222] });
  assert.deepEqual(descriptors, [
    { kind: "binding", binding: "AI", model: MODEL, payload: { prompt: "A cat in a hat", steps: 4, seed: 111 } },
    { kind: "binding", binding: "AI", model: MODEL, payload: { prompt: "A cat in a hat", steps: 4, seed: 222 } }
  ]);
});

test("workers_ai.buildRequests throws when the seed array length does not match variants", () => {
  assert.throws(
    () => workersAi.buildRequests({ model: MODEL, prompt: "A cat", variants: 2, seeds: [111] }),
    /one seed per variant/
  );
  assert.throws(
    () => workersAi.buildRequests({ model: MODEL, prompt: "A cat", variants: 2, seeds: undefined }),
    /one seed per variant/
  );
});

test("workers_ai.buildRequests truncates prompts over 2048 characters instead of rejecting them", () => {
  const longPrompt = "a".repeat(2100);
  const [descriptor] = workersAi.buildRequests({ model: MODEL, prompt: longPrompt, variants: 1, seeds: [7] });
  assert.equal(descriptor.payload.prompt.length, 2048);
  assert.equal(descriptor.payload.prompt, longPrompt.slice(0, 2048));
});

test("workers_ai.buildRequests defaults steps to 4 and passes through a caller-supplied value", () => {
  const [defaulted] = workersAi.buildRequests({ model: MODEL, prompt: "A cat", variants: 1, seeds: [1] });
  assert.equal(defaulted.payload.steps, 4);
  const [custom] = workersAi.buildRequests({ model: MODEL, prompt: "A cat", variants: 1, seeds: [1], steps: 2 });
  assert.equal(custom.payload.steps, 2);
});

// --- parseResponses ------------------------------------------------------

test("workers_ai.parseResponses reads body.image as base64 and labels it image/jpeg", () => {
  const parsed = workersAi.parseResponses({
    results: [{ ok: true, body: { image: "BASE64JPEGBYTES" } }],
    expectedVariants: 1
  });
  assert.deepEqual(parsed.images, [{ mimeType: "image/jpeg", bytesBase64: "BASE64JPEGBYTES" }]);
  assert.equal(parsed.costUsd, 0);
});

test("a partial batch (one fulfilled, one rejected) yields partial:true, blocked:false, and one image", () => {
  // This is the regression test for the superseded draft's Promise.all
  // defect: one flaky variant must not discard an attempt the player has
  // already spent.
  const parsed = workersAi.parseResponses({
    results: [
      { ok: true, body: { image: "GOOD_IMAGE" } },
      { ok: false, status: 500, error: new Error("upstream 500") }
    ],
    expectedVariants: 2
  });
  assert.deepEqual(parsed.images, [{ mimeType: "image/jpeg", bytesBase64: "GOOD_IMAGE" }]);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
});

test("an all-rejected batch yields zero images so the caller refunds the attempt", () => {
  const parsed = workersAi.parseResponses({
    results: [
      { ok: false, status: 500, error: new Error("upstream 500") },
      { ok: false, status: 500, error: new Error("upstream 500") }
    ],
    expectedVariants: 2
  });
  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.partial, false);
});

test("a full-success batch yields partial:false and blocked:false", () => {
  const parsed = workersAi.parseResponses({
    results: [
      { ok: true, body: { image: "IMAGE_A" } },
      { ok: true, body: { image: "IMAGE_B" } }
    ],
    expectedVariants: 2
  });
  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.partial, false);
  assert.equal(parsed.blocked, false);
});

test("parseResponses ignores a fulfilled result with a missing or empty image field", () => {
  const parsed = workersAi.parseResponses({
    results: [
      { ok: true, body: {} },
      { ok: true, body: { image: "" } },
      { ok: true, body: { image: "REAL_IMAGE" } }
    ],
    expectedVariants: 3
  });
  assert.deepEqual(parsed.images, [{ mimeType: "image/jpeg", bytesBase64: "REAL_IMAGE" }]);
  assert.equal(parsed.partial, true);
});

test("blocked is only reported when zero images came back and a failure was a safety rejection", () => {
  // isWorkersAiSafetyRejection is pinned to false until a real captured
  // fixture exists (see below), so today an all-rejected batch is never
  // reported as blocked -- it is an ordinary refund instead. This is the
  // behavior the addendum requires, not an oversight: a failure misreported
  // as a safety block tells a player to rewrite a prompt that was fine.
  const parsed = workersAi.parseResponses({
    results: [{ ok: false, status: 500, error: new Error("upstream 500") }],
    expectedVariants: 1
  });
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
});

// --- resolveAuth -----------------------------------------------------------

test("workers_ai.resolveAuth returns the AI binding when configured", async () => {
  const fakeBinding = { run: () => { throw new Error("tests must never invoke env.AI.run"); } };
  const auth = await workersAi.resolveAuth({ AI: fakeBinding });
  assert.equal(auth.binding, fakeBinding);
});

test("workers_ai.resolveAuth throws when the AI binding is not configured", async () => {
  await assert.rejects(() => workersAi.resolveAuth({}), /Workers AI binding 'AI' is not configured/);
});

// --- isWorkersAiSafetyRejection ---------------------------------------------

test("isWorkersAiSafetyRejection returns false until a real captured error fixture exists", () => {
  // Deliberately exercised against plausible-looking errors to prove the
  // function isn't guessing at a shape from memory -- addendum section 4.2.
  assert.equal(isWorkersAiSafetyRejection(new Error("blocked by moderation policy")), false);
  assert.equal(isWorkersAiSafetyRejection({ status: 400, error: { message: "content violates safety guidelines" } }), false);
  assert.equal(isWorkersAiSafetyRejection(undefined), false);
});

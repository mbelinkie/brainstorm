// POST /battle/test-image — the host-only Prompt Battle model test route
// (base spec section 7.5, corrected adapter contract in the 2026-08-24
// addendum section 2.3). Drives the real Worker module with a stubbed
// global fetch and a fake AI binding, the same pattern host-recovery.test.js
// uses for C13, so an authorization, allowlist, or dispatch regression fails
// here instead of only in production.
//
// No test in this file invokes a real Workers AI binding or a live
// endpoint. The fake AI binding's .run() returns canned fixtures.
//
// Every test uses its own room code. The per-session test-generation cap is
// process-lifetime module state keyed by room code (see cloudflare-worker.js),
// so it persists across the `test()` blocks in this file the same way it
// would persist across requests to a real Worker isolate -- a shared room
// code between tests would make them order-dependent.
import test from "node:test";
import assert from "node:assert/strict";

const { default: quizWorker } = await import("../cloudflare-worker.js");

const workerEnv = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-key" };

function fakeAiBinding(outcomes) {
  const calls = [];
  return {
    calls,
    async run(model, payload) {
      calls.push({ model, payload });
      const outcome = outcomes[calls.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  };
}

// Runs one request against the Worker with Supabase stubbed out, mirroring
// callWorker() in host-recovery.test.js but extended for POST + JSON body +
// an AI binding.
async function callWorker(path, { method = "GET", headers = {}, body, ai, routes = {}, status = {} } = {}) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    for (const [fragment, respBody] of Object.entries(routes)) {
      if (target.includes(fragment)) return Response.json(respBody, { status: status[fragment] || 200 });
    }
    throw new Error(`unstubbed upstream request: ${target}`);
  };
  try {
    const env = { ...workerEnv, ...(ai ? { AI: ai } : {}) };
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await quizWorker.fetch(new Request(`https://worker.test${path}`, init), env);
    return { response, body: await response.json().catch(() => null), requested };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const authorizedRoom = { "/rpc/get_host_live_room_state": { phase: "lobby" } };
const rejectedRoom = { "/rpc/get_host_live_room_state": { error: "denied" } };
const ALLOWED_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const hostHeadersFor = (roomCode) => ({ "x-quiz-room": roomCode, "x-quiz-host-secret": "host-secret" });

test("/battle/test-image refuses a request without host credentials and never reaches Supabase or the AI binding", async () => {
  const ai = fakeAiBinding([{ image: "IMG" }, { image: "IMG" }]);
  const missingSecret = await callWorker("/battle/test-image", { method: "POST", headers: { "x-quiz-room": "room-cred-1" }, body: { model: ALLOWED_MODEL }, ai });
  assert.equal(missingSecret.response.status, 401);
  assert.equal(missingSecret.requested.length, 0);
  assert.equal(ai.calls.length, 0);

  const missingRoom = await callWorker("/battle/test-image", { method: "POST", headers: { "x-quiz-host-secret": "host-secret" }, body: { model: ALLOWED_MODEL }, ai });
  assert.equal(missingRoom.response.status, 401);
  assert.equal(ai.calls.length, 0);
});

test("/battle/test-image returns 403 when the host secret is rejected and never calls the AI binding", async () => {
  const ai = fakeAiBinding([{ image: "IMG" }, { image: "IMG" }]);
  const { response, requested } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-secret-1"),
    body: { model: ALLOWED_MODEL },
    routes: rejectedRoom,
    status: { "/rpc/get_host_live_room_state": 403 },
    ai
  });
  assert.equal(response.status, 403);
  assert.equal(ai.calls.length, 0);
  assert.ok(requested[0].includes("/rpc/get_host_live_room_state"), "host secret must be verified before anything else runs");
});

test("/battle/test-image rejects a model that is not on the deployment allowlist", async () => {
  const ai = fakeAiBinding([{ image: "IMG" }, { image: "IMG" }]);
  const { response, body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-model-1"),
    body: { model: "some/unapproved-model" },
    routes: authorizedRoom,
    ai
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /model/i);
  assert.equal(ai.calls.length, 0, "an unapproved model string must never reach the provider — this is the allowlist that a client-supplied model name would otherwise defeat");
});

test("/battle/test-image generates through the AI binding, returns images inline, and persists nothing", async () => {
  const ai = fakeAiBinding([{ image: "AAAA" }, { image: "BBBB" }]);
  const { response, body, requested } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-generate-1"),
    body: { model: ALLOWED_MODEL },
    routes: authorizedRoom,
    ai
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.images, [
    { mimeType: "image/jpeg", bytesBase64: "AAAA" },
    { mimeType: "image/jpeg", bytesBase64: "BBBB" }
  ]);
  assert.equal(body.costUsd, 0);
  assert.equal(body.partial, false);
  assert.equal(body.blocked, false);
  assert.equal(body.model, ALLOWED_MODEL);
  // Only the host-auth RPC talks to Supabase -- no media_assets insert, no
  // storage upload. The test path is documented as never persisting.
  assert.deepEqual(requested, requested.filter((url) => url.includes("/rpc/get_host_live_room_state")));
  // Each call gets its own seed, which is what produces variety between
  // variants of the same prompt.
  assert.equal(ai.calls.length, 2);
  assert.notEqual(ai.calls[0].payload.seed, ai.calls[1].payload.seed);
  assert.equal(ai.calls[0].model, ALLOWED_MODEL);
});

test("/battle/test-image: a partial AI-binding failure still returns the successful image and reports partial:true", async () => {
  const ai = fakeAiBinding([{ image: "GOOD" }, new Error("binding hiccup")]);
  const { response, body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-partial-1"),
    body: { model: ALLOWED_MODEL },
    routes: authorizedRoom,
    ai
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.images, [{ mimeType: "image/jpeg", bytesBase64: "GOOD" }]);
  assert.equal(body.partial, true);
  assert.equal(body.blocked, false);
});

test("/battle/test-image enforces a hard cap of 10 test generations per session", async () => {
  const ai = fakeAiBinding(Array.from({ length: 22 }, () => ({ image: "IMG" })));
  const headers = hostHeadersFor("room-cap-1");
  for (let i = 0; i < 10; i++) {
    const { response } = await callWorker("/battle/test-image", { method: "POST", headers, body: { model: ALLOWED_MODEL }, routes: authorizedRoom, ai });
    assert.equal(response.status, 200, `generation ${i + 1} of 10 should be allowed`);
  }
  const eleventh = await callWorker("/battle/test-image", { method: "POST", headers, body: { model: ALLOWED_MODEL }, routes: authorizedRoom, ai });
  assert.equal(eleventh.response.status, 429);
  assert.equal(ai.calls.length, 20, "the 11th request must not reach the AI binding at all");
});

test("/battle/test-image caps each room independently", async () => {
  const ai = fakeAiBinding(Array.from({ length: 2 }, () => ({ image: "IMG" })));
  // room-cap-1 above already exhausted its cap; a different room code must
  // still be allowed, proving the cap is keyed per room, not global.
  const { response } = await callWorker("/battle/test-image", { method: "POST", headers: hostHeadersFor("room-cap-2"), body: { model: ALLOWED_MODEL }, routes: authorizedRoom, ai });
  assert.equal(response.status, 200);
});

test("/battle/test-image OPTIONS preflight allows the room/host-secret headers", async () => {
  const { response } = await callWorker("/battle/test-image", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") || "", /x-quiz-room/);
  assert.match(response.headers.get("access-control-allow-headers") || "", /x-quiz-host-secret/);
  assert.match(response.headers.get("access-control-allow-methods") || "", /POST/);
});

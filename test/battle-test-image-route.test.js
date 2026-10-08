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
async function callWorker(path, { method = "GET", headers = {}, body, ai, env = {}, routes = {}, status = {} } = {}) {
  const requested = [];
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    requested.push(target);
    outbound.push({ url: target, ...init });
    for (const [fragment, respBody] of Object.entries(routes)) {
      if (!target.includes(fragment)) continue;
      if (typeof respBody === "function") {
        const response = await respBody(target, init);
        return response instanceof Response ? response.clone() : Response.json(response ?? {}, { status: status[fragment] || 200 });
      }
      if (respBody instanceof Response) return respBody.clone();
      return Response.json(respBody, { status: status[fragment] || 200 });
    }
    throw new Error(`unstubbed upstream request: ${target}`);
  };
  try {
    const fullEnv = { ...workerEnv, ...env, ...(ai ? { AI: ai } : {}) };
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await quizWorker.fetch(new Request(`https://worker.test${path}`, init), fullEnv);
    return { response, body: await response.json().catch(() => null), requested, outbound };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const authorizedRoom = { "/rpc/get_host_live_room_state": { phase: "lobby" } };
const rejectedRoom = { "/rpc/get_host_live_room_state": { error: "denied" } };
const ALLOWED_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const KAPLAN_MODEL = "gemini-3.1-flash-image";
const OPENROUTER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
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

test("/battle/test-image forwards a host-supplied prompt to the AI binding instead of the default", async () => {
  const ai = fakeAiBinding([{ image: "A" }, { image: "B" }]);
  const { response, body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-custom-prompt-1"),
    body: { model: ALLOWED_MODEL, prompt: "A raccoon wearing a tiny crown" },
    routes: authorizedRoom,
    ai
  });
  assert.equal(response.status, 200);
  assert.equal(body.prompt, "A raccoon wearing a tiny crown");
  assert.equal(ai.calls[0].payload.prompt, "A raccoon wearing a tiny crown");
  assert.equal(ai.calls[1].payload.prompt, "A raccoon wearing a tiny crown");
});

test("/battle/test-image falls back to the default prompt when none is supplied or it is blank", async () => {
  const ai = fakeAiBinding([{ image: "A" }, { image: "B" }]);
  const { body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-default-prompt-1"),
    body: { model: ALLOWED_MODEL, prompt: "   " },
    routes: authorizedRoom,
    ai
  });
  assert.ok(body.prompt && body.prompt.length > 0);
  assert.equal(ai.calls[0].payload.prompt, body.prompt);
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
  // One AI-binding call per variant. No `seed` field -- the real API
  // rejects it ("Additional or unevaluated properties '/seed' at '/' not
  // allowed"), verified live on 2026-08-24. See image-engine.js.
  assert.equal(ai.calls.length, 2);
  assert.deepEqual(Object.keys(ai.calls[0].payload).sort(), ["prompt", "steps"]);
  assert.equal(ai.calls[0].payload.steps, 4);
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

test("/battle/test-image: an all-failed AI-binding batch still returns 200 with zero images and the raw provider errors", async () => {
  // A zero-image, non-blocked, non-erroring 200 is otherwise indistinguishable
  // from "nothing happened" -- providerErrors is what makes a real provider
  // failure (as opposed to a safety block) legible to the host without
  // opening devtools.
  const ai = fakeAiBinding([Object.assign(new Error("binding rejected the request"), { status: 400 }), new Error("binding hiccup")]);
  const { response, body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-provider-errors-1"),
    body: { model: ALLOWED_MODEL },
    routes: authorizedRoom,
    ai
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.images, []);
  assert.equal(body.providerErrors.length, 2);
  assert.deepEqual(body.providerErrors[0], { status: 400, message: "binding rejected the request" });
  assert.equal(body.providerErrors[1].message, "binding hiccup");
});

test("/battle/test-image omits providerErrors entirely on full success", async () => {
  const ai = fakeAiBinding([{ image: "A" }, { image: "B" }]);
  const { body } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-no-provider-errors-1"),
    body: { model: ALLOWED_MODEL },
    routes: authorizedRoom,
    ai
  });
  assert.equal("providerErrors" in body, false);
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

test("/battle/models returns only available allowlisted models after host authorization", async () => {
  const unauthorized = await callWorker("/battle/models", { method: "GET" });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.requested.length, 0);

  const rejected = await callWorker("/battle/models", {
    method: "GET",
    headers: hostHeadersFor("catalog-rejected"),
    routes: rejectedRoom,
    status: { "/rpc/get_host_live_room_state": 403 },
    env: { OPENROUTER_API_KEY: "synthetic-openrouter-key" },
    ai: fakeAiBinding([])
  });
  assert.equal(rejected.response.status, 403);
  assert.equal("models" in rejected.body, false);

  const keyless = await callWorker("/battle/models", {
    method: "GET",
    headers: hostHeadersFor("catalog-keyless"),
    routes: authorizedRoom,
    ai: fakeAiBinding([])
  });
  assert.equal(keyless.response.status, 200);
  assert.equal(keyless.body.models.length, 4);
  assert.ok(keyless.body.models.every((model) => model.provider === "workers_ai"));
  assert.ok(!keyless.body.models.some((model) => model.provider === "kaplan_proxy"));

  for (const env of [
    { KAPLAN_PROXY_URL: "https://proxy.example" },
    { KAPLAN_PROXY_URL: "http://proxy.example", KAPLAN_PROXY_SECRET: "synthetic-kaplan-secret" }
  ]) {
    const unready = await callWorker("/battle/models", {
      method: "GET",
      headers: hostHeadersFor("catalog-kaplan-unready"),
      routes: authorizedRoom,
      env,
      ai: fakeAiBinding([])
    });
    assert.equal(unready.response.status, 200);
    assert.ok(!unready.body.models.some((model) => model.provider === "kaplan_proxy"));
  }

  const { response, body, outbound } = await callWorker("/battle/models", {
    method: "GET",
    headers: hostHeadersFor("catalog-ready"),
    routes: authorizedRoom,
    env: {
      OPENROUTER_API_KEY: "synthetic-openrouter-key",
      KAPLAN_PROXY_URL: "https://proxy.example",
      KAPLAN_PROXY_SECRET: "synthetic-kaplan-secret"
    },
    ai: fakeAiBinding([])
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const openrouterModels = body.models.filter((model) => model.provider === "openrouter");
  assert.deepEqual(openrouterModels.map((model) => model.id), [
    "x-ai/grok-imagine-image-quality",
    "google/gemini-3.1-flash-image",
    "black-forest-labs/flux-3-image"
  ]);
  assert.equal(openrouterModels[0].default, true);
  assert.ok(openrouterModels.slice(1).every((model) => model.default === false));
  assert.deepEqual(body.models.filter((model) => model.provider === "kaplan_proxy"), [
    { id: KAPLAN_MODEL, provider: "kaplan_proxy", label: "Gemini 3.1 Flash Image (Kaplan proxy)", default: false }
  ]);
  assert.ok(body.models.every((model) => Object.keys(model).sort().join(",") === "default,id,label,provider"));
  assert.doesNotMatch(JSON.stringify(body), /synthetic-openrouter-key|synthetic-kaplan-secret/);
  assert.ok(outbound[0].url.endsWith("/rpc/get_host_live_room_state"));

  const preflight = await callWorker("/battle/models", { method: "OPTIONS" });
  assert.equal(preflight.response.status, 204);
  assert.match(preflight.response.headers.get("access-control-allow-methods") || "", /GET/);
  assert.equal(preflight.response.headers.get("cache-control"), "no-store");
});

test("Kaplan host test stays unavailable until the proxy URL and secret are configured", async () => {
  const { response, body, requested } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-kaplan-unconfigured"),
    body: { model: KAPLAN_MODEL },
    routes: authorizedRoom
  });
  assert.equal(response.status, 503);
  assert.match(body.error, /not configured/i);
  assert.equal(requested.some((url) => url.includes("/generate")), false);
});

test("Kaplan host test sends two variants through the bearer proxy and reports its cost", async () => {
  const { response, body, requested, outbound } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-kaplan-test"),
    body: { model: KAPLAN_MODEL, prompt: "A raccoon wearing a tiny crown" },
    env: {
      KAPLAN_PROXY_URL: "https://proxy.example",
      KAPLAN_PROXY_SECRET: "synthetic-kaplan-secret"
    },
    routes: {
      ...authorizedRoom,
      "/generate": Response.json({
        images: [
          { mimeType: "image/png", bytesBase64: OPENROUTER_PNG },
          { mimeType: "image/png", bytesBase64: OPENROUTER_PNG }
        ],
        costUsd: 0.09
      })
    }
  });

  assert.equal(response.status, 200);
  assert.equal(body.model, KAPLAN_MODEL);
  assert.equal(body.prompt, "A raccoon wearing a tiny crown");
  assert.equal(body.images.length, 2);
  assert.equal(body.costUsd, 0.09);
  assert.equal(body.partial, false);
  assert.equal(body.blocked, false);
  assert.equal("providerErrors" in body, false);
  assert.deepEqual(requested.filter((url) => url.includes("/generate")), ["https://proxy.example/generate"]);

  const proxyCall = outbound.find((request) => request.url === "https://proxy.example/generate");
  assert.ok(proxyCall);
  assert.equal(proxyCall.method, "POST");
  assert.equal(new Headers(proxyCall.headers).get("authorization"), "Bearer synthetic-kaplan-secret");
  assert.deepEqual(JSON.parse(proxyCall.body), {
    prompt: "A raccoon wearing a tiny crown",
    model: KAPLAN_MODEL,
    variants: 2
  });
  assert.doesNotMatch(proxyCall.body, /synthetic-kaplan-secret/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-kaplan-secret/);
});

test("Kaplan host test rejects prompts over 2000 UTF-16 code units before reserving a slot", async () => {
  const roomCode = "room-kaplan-prompt-limit";
  const headers = hostHeadersFor(roomCode);
  const env = {
    KAPLAN_PROXY_URL: "https://proxy.example",
    KAPLAN_PROXY_SECRET: "synthetic-kaplan-secret"
  };
  const routes = {
    ...authorizedRoom,
    "/generate": Response.json({
      images: [
        { mimeType: "image/png", bytesBase64: OPENROUTER_PNG },
        { mimeType: "image/png", bytesBase64: OPENROUTER_PNG }
      ],
      costUsd: 0.09
    })
  };

  const overlong = await callWorker("/battle/test-image", {
    method: "POST",
    headers,
    body: { model: KAPLAN_MODEL, prompt: `${"😀".repeat(1000)}x` },
    routes,
    env
  });
  assert.equal(overlong.response.status, 400);
  assert.match(overlong.body.error, /prompt.*2000|2000.*prompt/i);
  assert.equal(overlong.requested.some((url) => url.includes("/generate")), false);

  const boundary = await callWorker("/battle/test-image", {
    method: "POST",
    headers,
    body: { model: KAPLAN_MODEL, prompt: "😀".repeat(1000) },
    routes,
    env
  });
  assert.equal(boundary.response.status, 200);
  assert.equal(boundary.body.prompt.length, 2000);
  const boundaryProxyCall = boundary.outbound.find((request) => request.url === "https://proxy.example/generate");
  assert.ok(boundaryProxyCall);
  assert.equal(JSON.parse(boundaryProxyCall.body).prompt.length, 2000);

  let successfulGenerations = 1;
  for (let index = 1; index < 10; index += 1) {
    const { response } = await callWorker("/battle/test-image", {
      method: "POST",
      headers,
      body: { model: KAPLAN_MODEL, prompt: "A bounded test prompt" },
      routes,
      env
    });
    assert.equal(response.status, 200);
    successfulGenerations += 1;
  }

  const capped = await callWorker("/battle/test-image", {
    method: "POST",
    headers,
    body: { model: KAPLAN_MODEL, prompt: "A bounded test prompt" },
    routes,
    env
  });
  assert.equal(capped.response.status, 429);
  assert.equal(capped.requested.some((url) => url.includes("/generate")), false);
  assert.equal(successfulGenerations, 10);
});

test("OpenRouter host test pins all approved models to their tested endpoint and fixed profile", async () => {
  const profiles=[
    ["x-ai/grok-imagine-image-quality","xai"],
    ["google/gemini-3.1-flash-image","google-ai-studio"],
    ["black-forest-labs/flux-3-image","black-forest-labs"]
  ];
  for (const [index,[model,endpointTag]] of profiles.entries()) {
    const providerBody = { data: [{ b64_json: OPENROUTER_PNG, media_type: "image/png" }], usage: { cost: 0.05 } };
    const { response, body, requested, outbound } = await callWorker("/battle/test-image", {
      method: "POST",
      headers: hostHeadersFor(`room-openrouter-test-${index}`),
      body: { model, prompt: "A raccoon wearing a crown", resolution: "4K", aspectRatio: "16:9", outputFormat: "webp" },
      env: { OPENROUTER_API_KEY: "synthetic-openrouter-key" },
      routes: {
        ...authorizedRoom,
        "/api/v1/images": Response.json(providerBody)
      }
    });
    assert.equal(response.status, 200, model);
    assert.equal(body.model, model);
    assert.equal(body.costUsd, 0.05);
    assert.equal(body.images.length, 1);
    assert.equal(body.partial, false);
    const call = outbound.find((request) => request.url === "https://openrouter.ai/api/v1/images");
    assert.ok(call, model);
    assert.equal(call.method, "POST");
    assert.equal(new Headers(call.headers).get("authorization"), "Bearer synthetic-openrouter-key");
    assert.deepEqual(JSON.parse(call.body), {
      model,
      prompt: "A raccoon wearing a crown",
      n: 1,
      aspect_ratio: "1:1",
      resolution: "1K",
      provider: { only: [endpointTag], allow_fallbacks: false }
    });
    assert.equal(requested.filter((url) => url === "https://openrouter.ai/api/v1/images").length, 1);
    assert.equal(JSON.stringify(body).includes("synthetic-openrouter-key"), false);
  }
});

test("OpenRouter host test with missing Worker key fails before provider dispatch", async () => {
  const { response, body, requested } = await callWorker("/battle/test-image", {
    method: "POST",
    headers: hostHeadersFor("room-openrouter-no-key"),
    body: { model: "x-ai/grok-imagine-image-quality" },
    routes: authorizedRoom
  });
  assert.equal(response.status, 503);
  assert.match(body.error, /not configured/i);
  assert.equal(requested.some((url) => url.includes("openrouter.ai/api/v1/images")), false);
});

test("OpenRouter host test sanitizes confirmed errors and reports contradictory outcomes generically", async () => {
  const model="google/gemini-3.1-flash-image";
  const common={method:"POST",headers:hostHeadersFor("room-openrouter-errors"),body:{model},env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},routes:authorizedRoom};
  const confirmed=await callWorker("/battle/test-image",{
    ...common,
    routes:{...authorizedRoom,"/api/v1/images":Response.json({error:{code:429,message:"raw-provider-diagnostic"}},{status:429})}
  });
  assert.equal(confirmed.response.status,200);
  assert.deepEqual(confirmed.body.images,[]);
  assert.equal(confirmed.body.costUsd,0);
  assert.match(confirmed.body.providerErrors[0].message,/OpenRouter request failed/);
  assert.doesNotMatch(JSON.stringify(confirmed.body),/raw-provider-diagnostic/);

  const unknown=await callWorker("/battle/test-image",{
    ...common,
    headers:hostHeadersFor("room-openrouter-unknown"),
    routes:{...authorizedRoom,"/api/v1/images":Response.json({error:{code:502,message:"private diagnostic"},usage:{cost:0.05}},{status:502})}
  });
  assert.equal(unknown.response.status,502);
  assert.match(unknown.body.error,/could not be accounted/i);
  assert.doesNotMatch(JSON.stringify(unknown.body),/private diagnostic|synthetic-openrouter-key/);
});

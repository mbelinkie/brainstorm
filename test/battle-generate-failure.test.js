import test from "node:test";
import assert from "node:assert/strict";
const { default: quizWorker } = await import("../cloudflare-worker.js");
const BASE_ENV = { SUPABASE_URL:"https://db.test", SUPABASE_SERVICE_ROLE_KEY:"service-key", ASSETS:{fetch:async()=>Response.json({}, {status:404})} };
const UUID = { gen:"11111111-1111-4111-8111-111111111111", player:"22222222-2222-4222-8222-222222222222" };
const IMG = label => Buffer.from(`fake-${label}`).toString("base64");
const authPayload = (o={}) => ({ generationId:UUID.gen, attemptIndex:0, promptText:"Original prompt", playerPrompt:"A raccoon", provider:"workers_ai", model:"@cf/black-forest-labs/flux-1-schnell", variants:2, resolution:null, outputFormat:null, steps:4, attemptsRemaining:2, ...o });
const reqHeaders = (room,token) => ({"x-quiz-room":room,"x-quiz-player-token":token});
const fakeBinding = outcomes => { const calls=[]; return { calls, async run(model,payload){ calls.push({model,payload}); const o=outcomes[calls.length-1]; if(o instanceof Error) throw o; return o; } }; };
async function callWorker(path, {method="GET",headers={},body,env={},routes={},binding}={}) {
  const requested=[]; const realFetch=globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input, "https://db.test");
    const target = url.href;
    const req = { url:target, method:init?.method||"GET", headers:init?.headers||{}, body:init?.body };
    requested.push(req);
    for (const [fragment, handler] of Object.entries(routes)) {
      if (target.includes(fragment)) {
        if (typeof handler === "function") {
          const result = await handler(req, url, init);
          return result instanceof Response ? result.clone() : Response.json(result ?? {}, {status:200});
        }
        const response = handler instanceof Response ? handler.clone() : Response.json(handler.body ?? handler, {status:handler.status ?? 200});
        return response;
      }
    }
    return (env.ASSETS || BASE_ENV.ASSETS).fetch(input, init);
  };
  try {
    const fullEnv = { ...BASE_ENV, ...env, ...(binding ? {AI:binding} : {}) };
    const init = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const response = await quizWorker.fetch(new Request(`https://worker.test${path}`, init), fullEnv);
    const text = await response.clone().text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { response, requested, json, text };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("A12 network failures no false success/refund and no secrets", async () => {
  const sentinel = "PRIVATE_SENTINEL_12";
  const okOwner = [{entry:{player_id:UUID.player}}];
  const okMedia = async req => Response.json([{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}], {status:201});
  const cases = [
    { name:"authorize", binding:fakeBinding([]), routes:{ "/rpc/authorize_battle_generation": async()=>{ throw new Error(sentinel); } }, providerCalls:0, noRefund:true, storageCalls:0, mediaCalls:0, recordCalls:0 },
    { name:"owner", binding:fakeBinding([]), routes:{ "/rpc/authorize_battle_generation": authPayload(), "/rest/v1/session_battle_generations": async()=>{ throw new Error(sentinel); } }, providerCalls:0, noRefund:false, storageCalls:0, mediaCalls:0, recordCalls:0 },
    { name:"upload", binding:fakeBinding([{image:IMG("a")},{image:IMG("b")}]), routes:{ "/rpc/authorize_battle_generation": authPayload(), "/rest/v1/session_battle_generations": okOwner, "/storage/v1/object/quiz-media/": async()=>{ throw new Error(sentinel); } }, providerCalls:2, noRefund:true, storageCalls:1, mediaCalls:0, recordCalls:0 },
    { name:"metadata", binding:fakeBinding([{image:IMG("a")},{image:IMG("b")}]), routes:{ "/rpc/authorize_battle_generation": authPayload(), "/rest/v1/session_battle_generations": okOwner, "/storage/v1/object/quiz-media/": new Response(null,{status:200}), "/rest/v1/media_assets": async()=>{ throw new Error(sentinel); } }, providerCalls:2, noRefund:true, storageCalls:2, mediaCalls:1, recordCalls:0 },
    { name:"record", binding:fakeBinding([{image:IMG("a")},{image:IMG("b")}]), routes:{ "/rpc/authorize_battle_generation": authPayload(), "/rest/v1/session_battle_generations": okOwner, "/storage/v1/object/quiz-media/": new Response(null,{status:200}), "/rest/v1/media_assets": okMedia, "/rpc/record_battle_generation": async()=>{ throw new Error(sentinel); } }, providerCalls:2, noRefund:true, storageCalls:2, mediaCalls:1, recordCalls:1 }
  ];
  for (const c of cases) {
    let refundCalls = 0;
    const routes = { ...c.routes, "/rpc/refund_battle_attempt": async()=>{ refundCalls++; return Response.json({refunded:true}); } };
    const { response, requested, json, text } = await callWorker("/battle/generate", {
      method:"POST", headers:reqHeaders("ROOM_A12","player-token-12"), body:{prompt:"A raccoon"}, binding:c.binding, routes
    });
    assert.equal(response.status, 502, `${c.name} status`);
    assert.ok(!text.includes(sentinel), `${c.name} no sentinel`);
    assert.ok(!("assetIds" in json), `${c.name} no assetIds success`);
    assert.equal(c.binding.calls.length, c.providerCalls, `${c.name} provider calls`);
    if (c.noRefund) assert.equal(refundCalls, 0, `${c.name} no refund`);
    else assert.ok(refundCalls <= 1, `${c.name} owner refund at most once`);
    const storageN = requested.filter(r=>r.url.includes("/storage/v1/object/quiz-media/")).length;
    const mediaN = requested.filter(r=>r.url.includes("/rest/v1/media_assets")).length;
    const recordN = requested.filter(r=>r.url.includes("/rpc/record_battle_generation")).length;
    assert.equal(storageN, c.storageCalls, `${c.name} storage calls`);
    assert.equal(mediaN, c.mediaCalls, `${c.name} media calls`);
    assert.equal(recordN, c.recordCalls, `${c.name} record calls`);
    assert.ok(!requested.some(r=>r.method==="DELETE" && r.url.includes("/rest/v1/media_assets")), `${c.name} no DELETE`);
  }
});

test("A13 failed refund confirmation generic error no false promises", async () => {
  const cases = [
    ["non2xx", async()=> Response.json({refunded:false},{status:400})],
    ["transport", async()=>{ throw new Error("refund transport sentinel"); }],
    ["malformed", async()=> Response.json({}, {status:200})]
  ];
  for (const [name, refundHandler] of cases) {
    let refundCalls = 0;
    const binding = fakeBinding([new Error("provider raw"), new Error("provider raw")]);
    const routes = {
      "/rpc/authorize_battle_generation": authPayload(),
      "/rest/v1/session_battle_generations": [{entry:{player_id:UUID.player}}],
      "/rpc/refund_battle_attempt": async()=>{ refundCalls++; return await refundHandler(); }
    };
    const { response, requested, json, text } = await callWorker("/battle/generate", {
      method:"POST", headers:reqHeaders("ROOM_A13","player-token-13"), body:{prompt:"A raccoon"}, binding, routes
    });
    assert.equal(response.status, 502, `${name} status`);
    assert.equal(refundCalls, 1, `${name} exactly one refund attempt`);
    const msg = json.error || text;
    assert.ok(!/refunded|try again|retry-safe/i.test(msg), `${name} no misleading message`);
    assert.ok(/check|refresh/i.test(msg), `${name} generic check/refresh allowed`);
    assert.ok(!text.includes("provider raw"), "no provider raw error");
    assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")), `${name} no persistence`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
const { default: quizWorker } = await import("../cloudflare-worker.js");
const BASE_ENV = { SUPABASE_URL:"https://db.test", SUPABASE_SERVICE_ROLE_KEY:"service-key", ASSETS:{fetch:async()=>Response.json({}, {status:404})} };
const UUID = { gen:"11111111-1111-4111-8111-111111111111", player:"22222222-2222-4222-8222-222222222222", entry:"33333333-3333-4333-8333-333333333333" };
const IMG = label => Buffer.from(`fake-${label}`).toString("base64");
const OPENROUTER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const authPayload = (o={}) => ({ generationId:UUID.gen, attemptIndex:0, promptText:"Original prompt", playerPrompt:"A raccoon in a crown", provider:"workers_ai", model:"@cf/black-forest-labs/flux-1-schnell", variants:2, resolution:null, outputFormat:null, steps:4, attemptsRemaining:2, ...o });
const fakeBinding = outcomes => { const calls=[]; return { calls, async run(model,payload){ calls.push({model,payload}); const o=outcomes[calls.length-1]; if(o instanceof Error) throw o; return o; } }; };
const reqHeaders = (room,token) => ({"x-quiz-room":room,"x-quiz-player-token":token});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const mockStorage = async (req,url,arr=[],expectedMime="image/jpeg") => { assert.equal(req.method,"POST"); assert.equal(new Headers(req.headers).get("apikey"), "service-key"); assert.equal(new Headers(req.headers).get("content-type"), expectedMime); assert.equal(new Headers(req.headers).get("x-upsert"), "false"); const body=req.body; assert.ok(body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob, "binary upload required"); const len=body?.size ?? body?.byteLength ?? body?.length; arr.push({url,len}); return new Response(null,{status:200}); };
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

test("A1 success server provider/model/playerPrompt, persists variants, ownership, ids, expiry", async () => {
  const binding=fakeBinding([{image:IMG("a")},{image:IMG("b")}]);
  const ids=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const inserted=ids.map(id=>({id}));
  const storageBodies=[]; let authorizeBody, recordBody, mediaBody;
  const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM1","player-token-1"), body:{prompt:"A raccoon in a crown",provider:"malicious",model:"malicious",playerId:"other"}, binding, routes:{"/rpc/authorize_battle_generation":async req=>{authorizeBody=JSON.parse(req.body);return Response.json(authPayload());},"/rest/v1/session_battle_generations":async()=>Response.json([{entry:{player_id:UUID.player}}]),"/storage/v1/object/quiz-media/":async(req,url)=>mockStorage(req,url,storageBodies),"/rest/v1/media_assets":async req=>{mediaBody=JSON.parse(req.body);return Response.json(inserted,{status:201});},"/rpc/record_battle_generation":async req=>{recordBody=JSON.parse(req.body);return Response.json({generationId:UUID.gen,status:"complete",assetIds:ids,costUsd:0,partial:false,recorded:true});}}});
  assert.equal(response.status,200);
  assert.ok(Array.isArray(json.assetIds), "assetIds must be array");
  assert.equal(typeof json.partial, "boolean");
  for (const key of Object.keys(json)) {
    assert.ok(["assetIds","partial","generationId","attemptsRemaining"].includes(key), `unexpected field ${key}`);
  }
  assert.deepEqual(json.assetIds, ids);
  assert.equal(json.partial, false);
  assert.deepEqual(authorizeBody, {p_room_code:"ROOM1",p_player_token:"player-token-1",p_player_prompt:"A raccoon in a crown"});
  assert.equal(binding.calls.length, 2);
  assert.deepEqual(binding.calls[0].payload.prompt, "A raccoon in a crown");
  assert.equal(binding.calls[0].model, "@cf/black-forest-labs/flux-1-schnell");
  const ownerReq = requested.find(r=>r.url.includes("/rest/v1/session_battle_generations"));
  assert.ok(ownerReq, "owner lookup required");
  assert.ok(new URL(ownerReq.url).search.includes(UUID.gen), "owner lookup filter by generation id");
  assert.ok(mediaBody.every(r=>r.source==="battle"&&r.generated_by_player_id===UUID.player&&(r.uploaded_by===null||r.uploaded_by===undefined)&&r.expires_at), "ownership/source metadata");
  const now=Date.now(); mediaBody.forEach(r=>{const exp=new Date(r.expires_at).getTime();assert.ok(exp>=now+29*DAY&&exp<=now+31*DAY,`expiry ${r.expires_at}`);assert.equal(r.kind,"image");assert.equal(r.mime_type,"image/jpeg");assert.ok(Number.isInteger(r.byte_size)&&r.byte_size>0);});
  assert.equal(storageBodies.length, mediaBody.length); mediaBody.forEach((r,i)=>assert.equal(r.byte_size, storageBodies[i].len));
  storageBodies.forEach(s=>{const bn=new URL(s.url).pathname.split("/").pop();assert.ok(!/raccoon|crown|player|ROOM1/i.test(bn),`opaque path ${bn}`);});
  assert.ok(ids.every(id=>UUID_RE.test(id)));
  assert.deepEqual(recordBody, {p_generation_id:UUID.gen,p_asset_ids:ids,p_cost_usd:0});
  assert.ok(!requested.some(r=>r.url.includes("/rpc/refund_battle_attempt")));
  const s=JSON.stringify(json); assert.ok(!s.includes("A raccoon")&&!s.includes("service-key")&&!s.includes("base64"));
});

test("A2 partial one variant rejects, saved partial true no refund", async () => {
  const binding=fakeBinding([{image:IMG("g")},new Error("x")]);
  const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc"; let recordBody;
  const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM2","player-token-2"), body:{prompt:"A raccoon in a crown"}, binding, routes:{"/rpc/authorize_battle_generation":authPayload(),"/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],"/storage/v1/object/quiz-media/":new Response(null,{status:200}),"/rest/v1/media_assets":[{id}],"/rpc/record_battle_generation":req=>{recordBody=JSON.parse(req.body);return Response.json({generationId:UUID.gen,status:"complete",assetIds:[id],costUsd:0,partial:true,recorded:true});}}});
  assert.equal(response.status,200);
  assert.ok(Array.isArray(json.assetIds), "assetIds must be array");
  assert.equal(typeof json.partial, "boolean");
  for (const key of Object.keys(json)) {
    assert.ok(["assetIds","partial","generationId","attemptsRemaining"].includes(key), `unexpected field ${key}`);
  }
  assert.deepEqual(json.assetIds, [id]);
  assert.equal(json.partial, true);
  assert.equal(binding.calls.length, 2);
  assert.equal(recordBody.p_asset_ids.length, 1);
  assert.ok(!requested.some(r=>r.url.includes("/rpc/refund_battle_attempt")));
});

test("A3 all provider errors 502 generic refund provider_error no persistence", async () => {
  const binding=fakeBinding([new Error("raw sentinel secret"),new Error("raw sentinel secret")]);
  let refundBody;
  const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM3","player-token-3"), body:{prompt:"A raccoon in a crown"}, binding, routes:{"/rpc/authorize_battle_generation":authPayload(),"/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],"/rpc/refund_battle_attempt":req=>{refundBody=JSON.parse(req.body);return Response.json({refunded:true});}}});
  assert.equal(response.status,502);
  assert.ok(json.error&&!/sentinel/.test(json.error));
  assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")));
  assert.ok(!requested.some(r=>r.url.includes("/rest/v1/media_assets")));
  assert.ok(!requested.some(r=>r.url.includes("/rpc/record_battle_generation")));
  assert.equal(refundBody.p_reason_kind, "provider_error");
});

test("A4 Kaplan safety block friendly reason refund safety_block no persistence", async () => {
  let refundBody;
  const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM4","player-token-4"), body:{prompt:"A raccoon in a crown"}, env:{KAPLAN_PROXY_URL:"https://kaplan.test",KAPLAN_PROXY_SECRET:"kaplan-secret"}, routes:{"/rpc/authorize_battle_generation":authPayload({provider:"kaplan_proxy",model:"some-model"}),"/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],"/generate":Response.json({images:[],blocked:true,blockReason:"Try a different description",costUsd:0}),"/rpc/refund_battle_attempt":req=>{refundBody=JSON.parse(req.body);return Response.json({refunded:true});}}});
  assert.ok([400,422].includes(response.status));
  assert.ok(json.error&&/Try a different description/.test(json.error));
  assert.equal(refundBody.p_reason_kind, "safety_block");
  assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")));
});

test("A5 authorize rejection wrong phase/exhausted/spend no provider/refund/persistence", async () => {
  const cases=[
    ["wrong phase",{status:403,body:{error:"Player is not in this room"}}],
    ["exhausted attempts",{status:409,body:{error:"No attempts remaining"}}],
    ["session spend",{status:402,body:{error:"Spend cap reached"}}]
  ];
  for (const [name,auth] of cases) {
    const binding=fakeBinding([]);
    const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders(`ROOM5-${name}`,"player-token-5"), body:{prompt:"A raccoon in a crown"}, binding, routes:{"/rpc/authorize_battle_generation":Response.json(auth.body,{status:auth.status})}});
    assert.equal(response.status, auth.status);
    assert.ok(!json.error.includes(auth.body.error), "raw db error leaked");
    assert.equal(binding.calls.length, 0);
    assert.ok(!requested.some(r=>r.url.includes("/rest/v1/session_battle_generations")||r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")||r.url.includes("/rpc/refund_battle_attempt")), `no persistence/refund for ${name}`);
  }
});

test("A6 missing player token 401 no calls", async () => {
  const binding=fakeBinding([{image:IMG("x")}]);
  const {response,requested}=await callWorker("/battle/generate", {method:"POST", headers:{"x-quiz-room":"ROOM6"}, body:{prompt:"A raccoon in a crown"}, binding});
  assert.equal(response.status,401);
  assert.equal(requested.length,0);
  assert.equal(binding.calls.length,0);
});

test("A7 concurrent second reservation rejected after first provider-start", async () => {
  const gen1="aaaa1111-1111-4111-8111-111111111111";
  let providerStartedResolve; const providerStarted=new Promise(r=>providerStartedResolve=r);
  let releaseProvider; const providerGate=new Promise(r=>releaseProvider=r);
  const binding={calls:[],async run(model,payload){this.calls.push({model,payload});if(this.calls.length===1){providerStartedResolve();await providerGate;return {image:IMG("a")};}return {image:IMG("b")};}};
  let authorizeCalls=0;
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=new URL(input,"https://db.test");const target=url.href;if(target.includes("/rpc/authorize_battle_generation")){authorizeCalls++;return authorizeCalls===1?Response.json({...authPayload(),generationId:gen1}):Response.json({error:"already pending"},{status:409});}if(target.includes("/rest/v1/session_battle_generations"))return Response.json([{entry:{player_id:UUID.player}}]);if(target.includes("/storage/v1/object/quiz-media/"))return new Response(null,{status:200});if(target.includes("/rest/v1/media_assets"))return Response.json([{id:"dddd3333-3333-4333-8333-333333333333"},{id:"eeee4444-4444-4444-8444-444444444444"}],{status:201});if(target.includes("/rpc/record_battle_generation"))return Response.json({generationId:gen1,status:"complete",assetIds:["dddd3333-3333-4333-8333-333333333333","eeee4444-4444-4444-8444-444444444444"],costUsd:0,partial:false,recorded:true});return BASE_ENV.ASSETS.fetch(input,init);};
  try {
    const env={...BASE_ENV,AI:binding};
    const makeReq=()=>quizWorker.fetch(new Request("https://worker.test/battle/generate",{method:"POST",headers:{"x-quiz-room":"ROOM7","x-quiz-player-token":"player-token-7","content-type":"application/json"},body:JSON.stringify({prompt:"A raccoon in a crown"})}),env);
    const first=makeReq();
    const reachedProvider=await Promise.race([providerStarted.then(()=>true), first.then(()=>false)]);
    assert.equal(reachedProvider,true,"first request must reach provider before second");
    const second=makeReq();
    releaseProvider();
    const [firstRes,secondRes]=await Promise.all([first,second]);
    assert.equal(firstRes.status,200);
    assert.equal(secondRes.status,409);
    assert.equal(binding.calls.length,2);
  } finally {
    if (releaseProvider) releaseProvider();
    globalThis.fetch=realFetch;
  }
});

test("A8 Kaplan uncertain failure 502 no refund/record no secrets", async () => {
  const cases=[
    ["http",new Response(null,{status:500})],
    ["malformed",Response.json({images:[],costUsd:"invalid"})],
    ["missing",Response.json({images:[]})],
    ["nonfinite",Response.json({images:[],costUsd:null})]
  ];
  for (const [name,handler] of cases) {
    let refundCalled=false;
    const {response,requested,json}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM8","player-token-8"), body:{prompt:"A raccoon in a crown"}, env:{KAPLAN_PROXY_URL:"https://kaplan.test",KAPLAN_PROXY_SECRET:"kaplan-secret"}, routes:{"/rpc/authorize_battle_generation":authPayload({provider:"kaplan_proxy",model:"some-model"}),"/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],"/generate":handler,"/rpc/refund_battle_attempt":()=>{refundCalled=true;return Response.json({refunded:true});}}});
    assert.equal(response.status,502);
    assert.ok(json.error&&!/kaplan-secret/.test(json.error));
    assert.equal(refundCalled,false);
    assert.ok(!requested.some(r=>r.url.includes("/rpc/record_battle_generation")));
  }
});

test("A9 storage/metadata/record failure after provider no success/no refund/no DELETE", async () => {
  const assetId1="dddd4444-4444-4444-8444-444444444444";
  const assetId2="eeee5555-5555-4555-8555-555555555555";
  const cases=[
    ["storage",new Response(null,{status:500}),[{id:assetId1},{id:assetId2}],Response.json({generationId:UUID.gen,status:"complete",assetIds:[assetId1,assetId2],costUsd:0,partial:false,recorded:true})],
    ["metadata",new Response(null,{status:200}),new Response(null,{status:500}),Response.json({generationId:UUID.gen,status:"complete",assetIds:[assetId1,assetId2],costUsd:0,partial:false,recorded:true})],
    ["record",new Response(null,{status:200}),[{id:assetId1},{id:assetId2}],Response.json({error:"Generation not found"},{status:404})]
  ];
  for (const [name,storage,media,record] of cases) {
    const binding=fakeBinding([{image:IMG("a")},{image:IMG("b")}]);
    let refundCalled=false;
    const {response,json,requested}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM9","player-token-9"), body:{prompt:"A raccoon in a crown"}, binding, routes:{"/rpc/authorize_battle_generation":authPayload(),"/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],"/storage/v1/object/quiz-media/":storage,"/rest/v1/media_assets":media,"/rpc/record_battle_generation":record,"/rpc/refund_battle_attempt":()=>{refundCalled=true;return Response.json({refunded:true});}}});
    assert.equal(response.status,502);
    assert.ok(!("assetIds" in json));
    assert.equal(refundCalled,false);
    if(name==="record") assert.ok(requested.some(r=>r.url.includes("/rpc/record_battle_generation")), "record_battle_generation should be reached for record failure");
    assert.ok(!requested.some(r=>r.method==="DELETE"&&r.url.includes("/rest/v1/media_assets")));
  }
});

test("A10 input validation/CORS", async () => {
  const binding=fakeBinding([]);
  const bad=[
    ["malformed",{...reqHeaders("ROOM10","player-token-10"),"content-type":"application/json"},"{not json"],
    ["empty",reqHeaders("ROOM10","player-token-10"),{prompt:""}],
    ["oversize",reqHeaders("ROOM10","player-token-10"),{prompt:"a".repeat(2049)}]
  ];
  for (const [name,headers,body] of bad) {
    const {response,requested}=await callWorker("/battle/generate", {method:"POST", headers, body, binding});
    assert.equal(response.status,400);
    assert.equal(requested.length,0);
  }
  const preflight=await callWorker("/battle/generate", {method:"OPTIONS"});
  assert.equal(preflight.response.status,204);
  const allowHeaders=preflight.response.headers.get("access-control-allow-headers")||"";
  assert.match(allowHeaders,/x-quiz-room/); assert.match(allowHeaders,/x-quiz-player-token/); assert.match(allowHeaders,/content-type/);
  assert.equal(preflight.response.headers.get("cache-control"),"no-store");
  const get=await callWorker("/battle/generate", {method:"GET"});
  assert.equal(get.response.status,405);
  assert.equal(binding.calls.length,0);
});

test("A11 unsupported provider/invalid variants/missing owner refund provider_error no provider", async () => {
  const cases=[
    ["unsupported provider",{provider:"openrouter",model:"some-model"},[{entry:{player_id:UUID.player}}]],
    ["invalid variants",{provider:"workers_ai",model:"@cf/black-forest-labs/flux-1-schnell",variants:0},[{entry:{player_id:UUID.player}}]],
    ["missing owner",{},[]]
  ];
  for (const [name,overrides,ownerRows] of cases) {
    const binding=fakeBinding([{image:IMG("a")},{image:IMG("b")}]);
    let refundBody;
    const {response,requested}=await callWorker("/battle/generate", {method:"POST", headers:reqHeaders("ROOM11","player-token-11"), body:{prompt:"A raccoon in a crown",provider:"workers_ai",model:"@cf/black-forest-labs/flux-1-schnell",playerId:"other"}, binding, routes:{"/rpc/authorize_battle_generation":authPayload(overrides),"/rest/v1/session_battle_generations":ownerRows,"/rpc/refund_battle_attempt":req=>{refundBody=JSON.parse(req.body);return Response.json({refunded:true});}}});
    assert.equal(response.status,502);
    assert.equal(binding.calls.length,0);
    assert.equal(refundBody.p_reason_kind,"provider_error");
    assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")));
  }
});

test("OpenRouter generation pins each approved model to its tested endpoint and server profile", async () => {
  const profiles=[
    ["x-ai/grok-imagine-image-quality","xai"],
    ["google/gemini-3.1-flash-image","google-ai-studio"],
    ["black-forest-labs/flux-3-image","black-forest-labs"]
  ];
  const ids=["12121212-1212-4121-8121-121212121212","34343434-3434-4343-8343-343434343434"];
  for (const [index,[model,endpointTag]] of profiles.entries()) {
    const providerCalls=[]; const stored=[]; let recordBody;
    const {response,requested,json}=await callWorker("/battle/generate", {
      method:"POST",
      headers:reqHeaders(`ROOM12-${index}`,"player-token-12"),
      body:{prompt:"A raccoon in a crown",provider:"kaplan_proxy",model:"untrusted/client-model",aspectRatio:"16:9",resolution:"4K",outputFormat:"webp"},
      env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
      routes:{
        "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model,resolution:null,outputFormat:null}),
        "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
        "/api/v1/images":req=>{
          providerCalls.push({body:JSON.parse(req.body),headers:new Headers(req.headers)});
          return Response.json({data:[{b64_json:OPENROUTER_PNG,media_type:"image/png"}],usage:{cost:0.04}});
        },
        "/storage/v1/object/quiz-media/":req=>mockStorage(req,null,stored,"image/png"),
        "/rest/v1/media_assets":ids.map(id=>({id})),
        "/rpc/record_battle_generation":req=>{recordBody=JSON.parse(req.body);return Response.json({generationId:UUID.gen,status:"complete",assetIds:ids});}
      }
    });
    assert.equal(response.status,200,model);
    assert.deepEqual(json.assetIds,ids,model);
    assert.equal(json.partial,false,model);
    assert.equal(providerCalls.length,2,model);
    assert.ok(providerCalls.every(call=>call.headers.get("authorization")==="Bearer synthetic-openrouter-key"),model);
    for (const call of providerCalls) assert.deepEqual(call.body,{model,prompt:"A raccoon in a crown",n:1,aspect_ratio:"1:1",resolution:"1K",provider:{only:[endpointTag],allow_fallbacks:false}},model);
    assert.equal(stored.length,2,model);
    assert.equal(recordBody.p_cost_usd,0.08,model);
    assert.deepEqual(recordBody.p_asset_ids,ids,model);
    assert.ok(!requested.some(r=>r.url.includes("/rpc/refund_battle_attempt")),model);
    assert.ok(!JSON.stringify(json).includes("synthetic-openrouter-key"),model);
  }
});

test("OpenRouter invalid raster bytes keep a successful reservation pending without refund or storage", async () => {
  const cases=[
    ["PNG declaration with SVG bytes","image/png",Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64")],
    ["JPEG declaration with PNG bytes","image/jpeg",OPENROUTER_PNG]
  ];
  for (const [name,mediaType,bytes] of cases) {
    let refundCalled=false; let storageCalled=false; let recordCalled=false;
    const {response,requested,json}=await callWorker("/battle/generate", {
      method:"POST",
      headers:reqHeaders(`ROOM12-INVALID-${name}`,"player-token-12"),
      body:{prompt:"A raccoon in a crown"},
      env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
      routes:{
        "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model:"x-ai/grok-imagine-image-quality",variants:1}),
        "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
        "/api/v1/images":Response.json({data:[{b64_json:bytes,media_type:mediaType}],usage:{cost:0}}),
        "/storage/v1/object/quiz-media/":()=>{storageCalled=true;return new Response(null,{status:200});},
        "/rest/v1/media_assets":()=>{recordCalled=true;return [{id:"12121212-1212-4121-8121-121212121212"}];},
        "/rpc/record_battle_generation":()=>{recordCalled=true;return Response.json({});},
        "/rpc/refund_battle_attempt":()=>{refundCalled=true;return Response.json({refunded:true});}
      }
    });
    assert.equal(response.status,502,name);
    assert.match(json.error,/refresh/i,name);
    assert.equal(refundCalled,false,name);
    assert.equal(storageCalled,false,name);
    assert.equal(recordCalled,false,name);
    assert.ok(!requested.some(r=>r.url.includes("/rpc/refund_battle_attempt")),name);
  }
});

test("Kaplan aggregate response still stores both authorized logical variants", async () => {
  const ids=["45454545-4545-4454-8454-454545454545","67676767-6767-4676-8676-676767676767"];
  let recordBody;
  const {response,json}=await callWorker("/battle/generate", {
    method:"POST",
    headers:reqHeaders("ROOM12-KAPLAN","player-token-12"),
    body:{prompt:"A raccoon in a crown"},
    env:{KAPLAN_PROXY_URL:"https://kaplan.test",KAPLAN_PROXY_SECRET:"synthetic-kaplan-secret"},
    routes:{
      "/rpc/authorize_battle_generation":authPayload({provider:"kaplan_proxy",model:"some-model"}),
      "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
      "/generate":Response.json({images:[{mimeType:"image/jpeg",bytesBase64:IMG("one")},{mimeType:"image/jpeg",bytesBase64:IMG("two")}],costUsd:0.12}),
      "/storage/v1/object/quiz-media/":req=>mockStorage(req),
      "/rest/v1/media_assets":ids.map(id=>({id})),
      "/rpc/record_battle_generation":req=>{recordBody=JSON.parse(req.body);return Response.json({generationId:UUID.gen,status:"complete",assetIds:ids});}
    }
  });
  assert.equal(response.status,200);
  assert.deepEqual(json.assetIds,ids);
  assert.equal(json.partial,false);
  assert.equal(recordBody.p_cost_usd,0.12);
});

test("OpenRouter known-unbilled variant error stores the successful partial image and reported cost", async () => {
  const id="56565656-5656-4565-8565-565656565656";
  const image=OPENROUTER_PNG;
  let recordBody; let refundCalled=false; let calls=0;
  const {response,requested,json}=await callWorker("/battle/generate", {
    method:"POST",
    headers:reqHeaders("ROOM13","player-token-13"),
    body:{prompt:"A raccoon in a crown"},
    env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
    routes:{
      "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model:"google/gemini-3.1-flash-image",resolution:"1K"}),
      "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
      "/api/v1/images":()=>++calls===1
        ? Response.json({data:[{b64_json:image,media_type:"image/png"}],usage:{cost:0.068}})
        : Response.json({error:{code:429,message:"raw-provider-diagnostic"}},{status:429}),
      "/storage/v1/object/quiz-media/":req=>mockStorage(req,null,[],"image/png"),
      "/rest/v1/media_assets":[{id}],
      "/rpc/record_battle_generation":req=>{recordBody=JSON.parse(req.body);return Response.json({generationId:UUID.gen,status:"complete",assetIds:[id]});},
      "/rpc/refund_battle_attempt":()=>{refundCalled=true;return Response.json({refunded:true});}
    }
  });
  assert.equal(response.status,200);
  assert.deepEqual(json.assetIds,[id]);
  assert.equal(json.partial,true);
  assert.equal(recordBody.p_cost_usd,0.068);
  assert.equal(refundCalled,false);
  assert.ok(!requested.some(r=>r.url.includes("/rpc/refund_battle_attempt")));
});

test("OpenRouter refusal returns a generic reason and refunds only after confirmation", async () => {
  let refundBody;
  const {response,requested,json}=await callWorker("/battle/generate", {
    method:"POST",
    headers:reqHeaders("ROOM14","player-token-14"),
    body:{prompt:"A raccoon in a crown"},
    env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
    routes:{
      "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model:"black-forest-labs/flux-3-image"}),
      "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
      "/api/v1/images":Response.json({error:{code:"content_policy_violation",message:"raw-provider-secret-diagnostic"}},{status:400}),
      "/rpc/refund_battle_attempt":req=>{refundBody=JSON.parse(req.body);return Response.json({refunded:true});}
    }
  });
  assert.equal(response.status,422);
  assert.equal(refundBody.p_reason_kind,"safety_block");
  assert.match(json.error,/The image model declined that prompt/);
  assert.doesNotMatch(JSON.stringify(json),/raw-provider-secret-diagnostic/);
  assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")));
});

test("OpenRouter malformed, positively billed, or image-bearing errors keep the attempt pending", async () => {
  const cases=[
    ["malformed",new Response("not json",{status:502})],
    ["positive cost",Response.json({error:{code:502,message:"bad"},usage:{cost:0.02}},{status:502})],
    ["image evidence",Response.json({error:{code:502,message:"bad"},data:[{b64_json:"secret-image"}]},{status:502})]
  ];
  for(const [name,outcome] of cases){
    let refundCalled=false; let storageCalled=false; let recordCalled=false;
    const {response,requested,json}=await callWorker("/battle/generate", {
      method:"POST",
      headers:reqHeaders(`ROOM15-${name}`,"player-token-15"),
      body:{prompt:"A raccoon in a crown"},
      env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
      routes:{
        "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model:"x-ai/grok-imagine-image-quality",variants:1}),
        "/rest/v1/session_battle_generations":[{entry:{player_id:UUID.player}}],
        "/api/v1/images":outcome,
        "/storage/v1/object/quiz-media/":()=>{storageCalled=true;return new Response(null,{status:200});},
        "/rpc/record_battle_generation":()=>{recordCalled=true;return Response.json({});},
        "/rpc/refund_battle_attempt":()=>{refundCalled=true;return Response.json({refunded:true});}
      }
    });
    assert.equal(response.status,502,name);
    assert.match(json.error,/refresh/i);
    assert.equal(refundCalled,false,name);
    assert.equal(storageCalled,false,name);
    assert.equal(recordCalled,false,name);
    assert.ok(!JSON.stringify(json).includes("synthetic-openrouter-key"));
    assert.ok(requested.some(r=>r.url.includes("/api/v1/images")));
  }
});

test("OpenRouter server profile mismatches refund before owner lookup or provider call", async () => {
  const mismatches=[
    ["resolution",{resolution:"2K"}],
    ["aspect ratio",{aspectRatio:"16:9"}],
    ["n",{n:2}],
    ["output format",{outputFormat:"webp"}]
  ];
  for(const [name,override] of mismatches){
    let refundBody; let providerCalled=false; let ownerCalled=false;
    const {response,requested}=await callWorker("/battle/generate", {
      method:"POST",
      headers:reqHeaders(`ROOM16-${name}`,"player-token-16"),
      body:{prompt:"A raccoon in a crown",resolution:"1K",aspectRatio:"1:1",n:1},
      env:{OPENROUTER_API_KEY:"synthetic-openrouter-key"},
      routes:{
        "/rpc/authorize_battle_generation":authPayload({provider:"openrouter",model:"x-ai/grok-imagine-image-quality",...override}),
        "/rest/v1/session_battle_generations":()=>{ownerCalled=true;return [{entry:{player_id:UUID.player}}];},
        "/api/v1/images":()=>{providerCalled=true;return Response.json({});},
        "/rpc/refund_battle_attempt":req=>{refundBody=JSON.parse(req.body);return Response.json({refunded:true});}
      }
    });
    assert.equal(response.status,502,name);
    assert.equal(refundBody.p_reason_kind,"provider_error",name);
    assert.equal(ownerCalled,false,name);
    assert.equal(providerCalled,false,name);
    assert.ok(!requested.some(r=>r.url.includes("/storage/v1/object")||r.url.includes("/rest/v1/media_assets")||r.url.includes("/rpc/record_battle_generation")));
  }
});

test("Worker AI and OpenRouter require an exact allowed model/provider pair before dispatch", async () => {
  const cases=[
    ["unlisted Workers AI model","workers_ai","@cf/example/unlisted"],
    ["OpenRouter model claimed by Workers AI","workers_ai","x-ai/grok-imagine-image-quality"],
    ["Workers AI model claimed by OpenRouter","openrouter","@cf/black-forest-labs/flux-1-schnell"],
    ["OpenRouter model claimed by Kaplan","kaplan_proxy","google/gemini-3.1-flash-image"]
  ];
  for (const [name,provider,model] of cases) {
    let refundKind; let ownerCalled=false; let providerCalled=false;
    const binding=fakeBinding([]);
    const {response,requested}=await callWorker("/battle/generate", {
      method:"POST",
      headers:reqHeaders(`ROOM17-${name}`,"player-token-17"),
      body:{prompt:"A raccoon in a crown"},
      binding,
      routes:{
        "/rpc/authorize_battle_generation":authPayload({provider,model,variants:1}),
        "/rest/v1/session_battle_generations":()=>{ownerCalled=true;return [{entry:{player_id:UUID.player}}];},
        "/api/v1/images":()=>{providerCalled=true;return Response.json({});},
        "/generate":()=>{providerCalled=true;return Response.json({});},
        "/rpc/refund_battle_attempt":req=>{refundKind=JSON.parse(req.body).p_reason_kind;return Response.json({refunded:true});}
      }
    });
    assert.equal(response.status,502,name);
    assert.equal(refundKind,"provider_error",name);
    assert.equal(ownerCalled,false,name);
    assert.equal(providerCalled,false,name);
    assert.equal(binding.calls.length,0,name);
    assert.ok(!requested.some(r=>r.url.includes("/api/v1/images")||r.url.endsWith("/generate")),name);
  }
});

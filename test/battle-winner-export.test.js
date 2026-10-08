import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const { default: quizWorker } = await import("../cloudflare-worker.js");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER_A = "22222222-2222-4222-8222-222222222222";
const PLAYER_B = "33333333-3333-4333-8333-333333333333";
const PLAYER_C = "44444444-4444-4444-8444-444444444444";
const ENTRY_A = "55555555-5555-4555-8555-555555555555";
const ENTRY_B = "66666666-6666-4666-8666-666666666666";
const ENTRY_C = "77777777-7777-4777-8777-777777777777";
const ENTRY_D = "88888888-8888-4888-8888-888888888888";
const ENTRY_E = "99999999-9999-4999-8999-999999999999";
const ASSET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSET_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASSET_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HEADERS = { "x-quiz-room": "ROOM1", "x-quiz-host-secret": "host-secret" };
const BASE_ENV = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ASSETS: { fetch: async () => Response.json({ error: "not found" }, { status: 404 }) }
};

test("Wrangler routes the host winner endpoints through the Worker before static assets", () => {
  const source = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  assert.ok(config.assets.run_worker_first.includes("/battle/winners*"));
});

function battleFixture() {
  const entries = [
    { entryId: ENTRY_A, playerId: PLAYER_A, playerName: "Ada", assetId: ASSET_A, winner: true, viable: true, vetoed: false, forfeited: false },
    { entryId: ENTRY_B, playerId: PLAYER_B, playerName: "Bela", assetId: ASSET_B, winner: true, viable: true, vetoed: false, forfeited: false },
    { entryId: ENTRY_C, playerId: PLAYER_C, playerName: "Vetoed loser", assetId: ASSET_C, winner: false, viable: false, vetoed: true, forfeited: false },
    { entryId: ENTRY_D, playerId: PLAYER_A, playerName: "Ada", assetId: ASSET_D, winner: true, viable: true, vetoed: false, forfeited: false },
    { entryId: ENTRY_E, playerId: PLAYER_B, playerName: "Forfeited loser", assetId: ASSET_E, winner: false, viable: false, vetoed: false, forfeited: true }
  ];
  return {
    matchups: [
      { round_index: 0, matchup_index: 0, prompt_text: "Stored tie prompt", resolved_at: "2026-10-01T00:00:00Z", result: { outcome: "tie", promptText: "Stored tie prompt", entries: entries.slice(0, 3) } },
      { round_index: 0, matchup_index: 1, prompt_text: "Default prompt", resolved_at: "2026-10-01T00:00:00Z", result: { outcome: "default", promptText: "Default prompt", entries: entries.slice(3) } },
      { round_index: 0, matchup_index: 2, prompt_text: "Skipped prompt", resolved_at: "2026-10-01T00:00:00Z", result: { outcome: "skipped", promptText: "Skipped prompt", entries: [{ ...entries[0], winner: false }] } }
    ],
    generations: [
      { entry_id: ENTRY_A, asset_ids: [ASSET_A], player_prompt: "Ada's player prompt" },
      { entry_id: ENTRY_B, asset_ids: [ASSET_B], player_prompt: "Bela's player prompt" },
      { entry_id: ENTRY_D, asset_ids: [ASSET_D], player_prompt: "Ada's second prompt" }
    ],
    assets: [
      { id: ASSET_A, source: "battle", generated_by_player_id: PLAYER_A, expires_at: "2999-01-01T00:00:00Z", mime_type: "image/png", storage_path: `battle/generation/${ASSET_A}.png` },
      { id: ASSET_B, source: "battle", generated_by_player_id: PLAYER_B, expires_at: "2999-01-01T00:00:00Z", mime_type: "image/webp", storage_path: `battle/generation/${ASSET_B}.webp` },
      { id: ASSET_D, source: "battle", generated_by_player_id: PLAYER_A, expires_at: "2999-01-01T00:00:00Z", mime_type: "image/jpeg", storage_path: `battle/generation/${ASSET_D}.jpg` }
    ]
  };
}

async function callWorker(path, { headers = HEADERS, routes = {}, ctx = { waitUntil() {} } } = {}) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, "https://db.test");
    requested.push({ url: url.href, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    for (const [fragment, handler] of Object.entries(routes)) {
      if (!url.href.includes(fragment)) continue;
      const result = typeof handler === "function" ? await handler(url, init) : handler;
      return result instanceof Response ? result.clone() : Response.json(result);
    }
    return Response.json({ error: "unmocked request" }, { status: 404 });
  };
  try {
    const response = await quizWorker.fetch(new Request(`https://worker.test${path}`, { headers }), BASE_ENV, ctx);
    return { response, requested, body: await response.clone().json().catch(() => null) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("host winner export uses stored resolved results across rounds and preserves winner metadata", async () => {
  const fixture = battleFixture();
  const { response, requested, body } = await callWorker("/battle/winners", {
    routes: {
      "/rpc/get_host_live_room_state": {},
      "/rest/v1/sessions?": [{ id: SESSION_ID }],
      "/rest/v1/session_battle_matchups?": fixture.matchups,
      "/rest/v1/session_battle_generations?": fixture.generations,
      "/rest/v1/media_assets?": fixture.assets
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(body.winners.map(({ assetId, playerName, promptText, playerPrompt, roundIndex, matchupIndex, mimeType, available }) => ({
    assetId, playerName, promptText, playerPrompt, roundIndex, matchupIndex, mimeType, available
  })), [
    { assetId: ASSET_A, playerName: "Ada", promptText: "Stored tie prompt", playerPrompt: "Ada's player prompt", roundIndex: 0, matchupIndex: 0, mimeType: "image/png", available: true },
    { assetId: ASSET_B, playerName: "Bela", promptText: "Stored tie prompt", playerPrompt: "Bela's player prompt", roundIndex: 0, matchupIndex: 0, mimeType: "image/webp", available: true },
    { assetId: ASSET_D, playerName: "Ada", promptText: "Default prompt", playerPrompt: "Ada's second prompt", roundIndex: 0, matchupIndex: 1, mimeType: "image/jpeg", available: true }
  ]);
  assert.ok(body.winners.every((winner) => !["storagePath", "playerId", "entryId"].some((key) => Object.hasOwn(winner, key))), "the host manifest omits internal Storage paths and database IDs");
  assert.ok(!body.winners.some(({ assetId }) => [ASSET_C, ASSET_E].includes(assetId)), "vetoed and forfeited entries are not exported");
  assert.ok(!body.winners.some(({ promptText }) => promptText === "Skipped prompt"), "skipped matchups have no export winners");
  const authIndex = requested.findIndex(({ url }) => url.includes("/rpc/get_host_live_room_state"));
  const matchupsIndex = requested.findIndex(({ url }) => url.includes("/rest/v1/session_battle_matchups"));
  assert.ok(authIndex >= 0 && authIndex < matchupsIndex, "host authorization precedes private result reads");
  assert.match(requested[matchupsIndex].url, new RegExp(`session_id=eq\\.${SESSION_ID}`), "results are scoped to the host room's session");
  assert.match(requested[matchupsIndex].url, /resolved_at=not\.is\.null/, "only persisted resolved matchups are read");
});

test("host winner image route streams exact bytes only before expiry", async () => {
  const fixture = battleFixture();
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 3]);
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  try {
    const { response, requested } = await callWorker(`/battle/winners/${ASSET_A}`, {
      routes: {
        "/rpc/get_host_live_room_state": {},
        "/rest/v1/sessions?": [{ id: SESSION_ID }],
        "/rest/v1/session_battle_matchups?": fixture.matchups,
        "/rest/v1/session_battle_generations?": fixture.generations,
        "/rest/v1/media_assets?": fixture.assets,
        "/storage/v1/object/authenticated/quiz-media/": new Response(bytes, { headers: { "content-type": "image/png" } })
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.ok(requested.some(({ url }) => url.includes("/storage/v1/object/authenticated/quiz-media/")));
    assert.match(requested.find(({ url }) => url.includes("/rest/v1/session_battle_generations?"))?.url || "", new RegExp(`entry_id=in\\.\\(${ENTRY_A}\\)`), "an image download reads only its winner's player prompt");
    assert.match(requested.find(({ url }) => url.includes("/rest/v1/media_assets?"))?.url || "", new RegExp(`id=in\\.\\(${ASSET_A}\\)`), "an image download rechecks only its target asset's expiry");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("host winner image route rejects unauthorized, expired and purged assets before storage", async () => {
  const fixture = battleFixture();
  const noHost = await callWorker("/battle/winners", { headers: {}, routes: {} });
  assert.equal(noHost.response.status, 401);
  assert.equal(noHost.requested.length, 0, "a missing host credential stops before Supabase access");

  const unauthorized = await callWorker("/battle/winners", {
    headers: { "x-quiz-room": "ROOM1", "x-quiz-host-secret": "wrong" },
    routes: { "/rpc/get_host_live_room_state": new Response("no", { status: 403 }) }
  });
  assert.equal(unauthorized.response.status, 403);
  assert.equal(unauthorized.requested.length, 1, "failed host authorization prevents every metadata lookup");

  const originalNow = Date.now;
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  Date.now = () => now;
  try {
    const expired = await callWorker(`/battle/winners/${ASSET_A}`, {
      routes: {
        "/rpc/get_host_live_room_state": {},
        "/rest/v1/sessions?": [{ id: SESSION_ID }],
        "/rest/v1/session_battle_matchups?": fixture.matchups,
        "/rest/v1/session_battle_generations?": fixture.generations,
        "/rest/v1/media_assets?": fixture.assets.map((asset) => asset.id === ASSET_A ? { ...asset, expires_at: new Date(now).toISOString() } : asset),
        "/storage/v1/object/authenticated/quiz-media/": new Response("still here")
      }
    });
    assert.equal(expired.response.status, 410, "expiry equality is expired even if Storage still has the bytes");
    assert.ok(!expired.requested.some(({ url }) => url.includes("/storage/v1/object")));

    const malformed = await callWorker(`/battle/winners/${ASSET_A}`, {
      routes: {
        "/rpc/get_host_live_room_state": {},
        "/rest/v1/sessions?": [{ id: SESSION_ID }],
        "/rest/v1/session_battle_matchups?": fixture.matchups,
        "/rest/v1/session_battle_generations?": fixture.generations,
        "/rest/v1/media_assets?": fixture.assets.map((asset) => asset.id === ASSET_A ? { ...asset, expires_at: "not-a-date" } : asset),
        "/storage/v1/object/authenticated/quiz-media/": new Response("still here")
      }
    });
    assert.equal(malformed.response.status, 410, "malformed expiry fails closed like an expired image");
    assert.ok(!malformed.requested.some(({ url }) => url.includes("/storage/v1/object")));

    const overdue = await callWorker(`/battle/winners/${ASSET_A}`, {
      routes: {
        "/rpc/get_host_live_room_state": {},
        "/rest/v1/sessions?": [{ id: SESSION_ID }],
        "/rest/v1/session_battle_matchups?": fixture.matchups,
        "/rest/v1/session_battle_generations?": fixture.generations,
        "/rest/v1/media_assets?": fixture.assets.map((asset) => asset.id === ASSET_A ? { ...asset, expires_at: new Date(now - 1).toISOString() } : asset),
        "/storage/v1/object/authenticated/quiz-media/": new Response("still here")
      }
    });
    assert.equal(overdue.response.status, 410, "an overdue image is not served while its object remains present");
    assert.ok(!overdue.requested.some(({ url }) => url.includes("/storage/v1/object")));

    const purged = await callWorker(`/battle/winners/${ASSET_A}`, {
      routes: {
        "/rpc/get_host_live_room_state": {},
        "/rest/v1/sessions?": [{ id: SESSION_ID }],
        "/rest/v1/session_battle_matchups?": fixture.matchups,
        "/rest/v1/session_battle_generations?": fixture.generations,
        "/rest/v1/media_assets?": []
      }
    });
    assert.equal(purged.response.status, 404);
    assert.ok(!purged.requested.some(({ url }) => url.includes("/storage/v1/object")));
  } finally {
    Date.now = originalNow;
  }
});

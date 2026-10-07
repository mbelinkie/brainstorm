import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { default: quizWorker } = await import("../cloudflare-worker.js");
const ENV = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";
const asset = (assetId, storagePath) => ({ assetId, storagePath });

async function runScheduled(handler) {
  const requests = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = {
      url: url.href,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: init.body,
    };
    requests.push(request);
    return handler(request);
  };
  console.error = (...args) => logs.push(args);
  let error;
  try {
    await quizWorker.scheduled({ cron: "0 3 * * *", scheduledTime: 0 }, ENV, {});
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  }
  return { requests, logs, error };
}

const rpc = (name) => `/rest/v1/rpc/${name}`;
const storageUrl = "/storage/v1/object/quiz-media";
const json = (request) => JSON.parse(request.body);

test("Wrangler schedules the battle purge daily at 03:00 UTC", () => {
  const source = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  assert.deepEqual(config.triggers.crons, ["0 3 * * *"]);
});

test("scheduled purge removes objects before finalizing their metadata", async () => {
  const order = [];
  let finalized;
  const { requests, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      order.push("list");
      return Response.json([asset(ASSET_A, "battle/generation-a/a.webp")]);
    }
    if (request.url.endsWith(storageUrl)) {
      order.push("remove");
      return new Response(null, { status: 204 });
    }
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      order.push("finalize");
      finalized = json(request);
      return Response.json({ deleted: [ASSET_A], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  });

  assert.equal(error, undefined);
  assert.deepEqual(order, ["list", "remove", "finalize"]);
  assert.deepEqual(json(requests[0]), { p_limit: 100 });
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.get("apikey"), ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(requests[0].headers.get("content-type"), "application/json");
  assert.equal(requests[1].method, "DELETE");
  assert.equal(requests[1].headers.get("apikey"), ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(json(requests[1]), { prefixes: ["battle/generation-a/a.webp"] });
  assert.deepEqual(finalized, { p_asset_ids: [ASSET_A] });
});

test("a storage failure is excluded from finalization while successful deletes proceed", async () => {
  const finalized = [];
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([
        asset(ASSET_A, "battle/generation-a/a.webp"),
        asset(ASSET_B, "battle/generation-b/b.webp"),
      ]);
    }
    if (request.url.endsWith(storageUrl)) {
      if (json(request).prefixes[0].endsWith("a.webp")) return new Response(null, { status: 503 });
      return new Response(null, { status: 204 });
    }
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalized.push(...json(request).p_asset_ids);
      return Response.json({ deleted: [ASSET_B], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /left objects for retry/i);
  assert.equal(requests.filter((request) => request.url.endsWith(storageUrl)).length, 2);
  assert.match(JSON.stringify(logs), /storage delete/i);
  assert.deepEqual(finalized, [ASSET_B]);
  assert.ok(!json(requests.at(-1)).p_asset_ids.includes(ASSET_A));
});

test("a thrown Storage request leaves its row for a later run and does not stop other assets", async () => {
  const finalized = [];
  const sentinel = "private-storage-error-detail";
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([
        asset(ASSET_A, "battle/generation-a/a.webp"),
        asset(ASSET_B, "battle/generation-b/b.webp"),
      ]);
    }
    if (request.url.endsWith(storageUrl)) {
      if (json(request).prefixes[0].endsWith("a.webp")) throw new Error(sentinel);
      return new Response(null, { status: 204 });
    }
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalized.push(...json(request).p_asset_ids);
      return Response.json({ deleted: [ASSET_B], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /left objects for retry/i);
  assert.deepEqual(finalized, [ASSET_B]);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(logs), /battle\/generation-/);
});

test("a finalization failure leaves metadata available for the next scheduled retry", async () => {
  let finalizationAttempts = 0;
  let deletionAttempts = 0;
  const handle = async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([asset(ASSET_A, "battle/generation-a/a.webp")]);
    }
    if (request.url.endsWith(storageUrl)) {
      deletionAttempts += 1;
      return new Response(null, { status: 204 });
    }
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalizationAttempts += 1;
      if (finalizationAttempts === 1) return new Response(null, { status: 503 });
      return Response.json({ deleted: [ASSET_A], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  };

  const firstRun = await runScheduled(handle);
  assert.match(String(firstRun.error), /finaliz/i);
  const retry = await runScheduled(handle);
  assert.equal(retry.error, undefined);
  assert.equal(deletionAttempts, 2);
  assert.equal(finalizationAttempts, 2);
});

test("an empty purge list does not call Storage or finalization", async () => {
  const { requests, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) return Response.json([]);
    return new Response(null, { status: 500 });
  });

  assert.equal(error, undefined);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith(rpc("purge_expired_battle_media")));
});

test("a non-battle storage path is never sent to the privileged delete API", async () => {
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([asset(ASSET_A, "author/author-id/image.webp")]);
    }
    return new Response(null, { status: 500 });
  });

  assert.match(String(error), /left objects for retry/i);
  assert.match(JSON.stringify(logs), /storage delete validation/i);
  assert.match(JSON.stringify(requests), /purge_expired_battle_media/);
  assert.equal(requests.length, 1);
});

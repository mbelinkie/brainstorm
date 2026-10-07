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
  assert.deepEqual(json(requests[0]), { p_limit: 1000 });
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.get("apikey"), ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(requests[0].headers.get("content-type"), "application/json");
  assert.equal(requests[1].method, "DELETE");
  assert.equal(requests[1].headers.get("apikey"), ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(json(requests[1]), { prefixes: ["battle/generation-a/a.webp"] });
  assert.deepEqual(finalized, { p_asset_ids: [ASSET_A] });
});

test("one scheduled run batches up to 1000 assets in at most three subrequests", async () => {
  const assets = Array.from({ length: 1000 }, (_, index) => {
    const id = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    return asset(id, `battle/generation-${index}/image.webp`);
  });
  let finalized;
  const { requests, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) return Response.json(assets);
    if (request.url.endsWith(storageUrl)) return new Response(null, { status: 204 });
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalized = json(request);
      return Response.json({ deleted: assets.map(({ assetId }) => assetId), keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  });

  assert.equal(error, undefined);
  assert.equal(requests.length, 3);
  assert.equal(requests.filter((request) => request.url.endsWith(storageUrl)).length, 1);
  assert.equal(json(requests[1]).prefixes.length, 1000);
  assert.deepEqual(finalized.p_asset_ids, assets.map(({ assetId }) => assetId));
});

test("a failed Storage batch is not finalized and leaves every row retryable", async () => {
  const sentinel = "private-storage-error-detail";
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([
        asset(ASSET_A, "battle/generation-a/a.webp"),
        asset(ASSET_B, "battle/generation-b/b.webp"),
      ]);
    }
    if (request.url.endsWith(storageUrl)) return new Response(sentinel, { status: 503 });
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /storage delete failed/i);
  assert.equal(requests.length, 2);
  assert.deepEqual(json(requests[1]).prefixes, ["battle/generation-a/a.webp", "battle/generation-b/b.webp"]);
  assert.match(JSON.stringify(logs), /storage delete/i);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(logs), /battle\/generation-/);
});

test("a thrown Storage batch is not finalized and does not expose error details", async () => {
  const sentinel = "private-storage-error-detail";
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) return Response.json([asset(ASSET_A, "battle/generation-a/a.webp")]);
    if (request.url.endsWith(storageUrl)) throw new Error(sentinel);
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /storage delete failed/i);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(logs), /battle\/generation-/);
});

test("a kept object in a partial finalization fails the run and remains listed for retry", async () => {
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([asset(ASSET_A, "battle/generation-a/a.webp"), asset(ASSET_B, "battle/generation-b/b.webp")]);
    }
    if (request.url.endsWith(storageUrl)) return new Response(null, { status: 204 });
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      return Response.json({ deleted: [ASSET_A], keptObjectStillPresent: [ASSET_B] });
    }
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /left objects for retry/i);
  assert.deepEqual(json(requests[2]), { p_asset_ids: [ASSET_A, ASSET_B] });
  assert.match(JSON.stringify(logs), /finalize objects still present/);
  assert.doesNotMatch(JSON.stringify(logs), /battle\/generation-/);
});

test("a failed batch is retried on the next scheduled run", async () => {
  let storageAttempts = 0;
  let finalized = 0;
  const handle = async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) return Response.json([asset(ASSET_A, "battle/generation-a/a.webp")]);
    if (request.url.endsWith(storageUrl)) {
      storageAttempts += 1;
      return new Response(null, { status: storageAttempts === 1 ? 503 : 204 });
    }
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalized += 1;
      return Response.json({ deleted: [ASSET_A], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  };

  const first = await runScheduled(handle);
  const retry = await runScheduled(handle);
  assert.match(String(first.error), /storage delete failed/i);
  assert.equal(retry.error, undefined);
  assert.equal(storageAttempts, 2);
  assert.equal(finalized, 1);
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
  let finalized;
  const { requests, logs, error } = await runScheduled(async (request) => {
    if (request.url.endsWith(rpc("purge_expired_battle_media"))) {
      return Response.json([
        asset(ASSET_A, "author/author-id/image.webp"),
        asset(ASSET_B, "battle/generation-b/b.webp"),
      ]);
    }
    if (request.url.endsWith(storageUrl)) return new Response(null, { status: 204 });
    if (request.url.endsWith(rpc("finalize_battle_media_purge"))) {
      finalized = json(request);
      return Response.json({ deleted: [ASSET_B], keptObjectStillPresent: [] });
    }
    return new Response(null, { status: 404 });
  });

  assert.match(String(error), /left objects for retry/i);
  assert.match(JSON.stringify(logs), /storage delete validation/i);
  assert.deepEqual(json(requests[1]), { prefixes: ["battle/generation-b/b.webp"] });
  assert.deepEqual(finalized, { p_asset_ids: [ASSET_B] });
  assert.doesNotMatch(JSON.stringify(logs), /author-id/);
});

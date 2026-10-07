import { ENGINES } from "./image-engine.js";

function supabaseAdminHeaders(secret, { json = false } = {}) {
  // Modern Supabase server keys are opaque API keys, not user-session JWTs.
  // The hosted gateway translates those credentials to the service_role role.
  // Legacy service-role keys are JWTs and must also be the bearer token for
  // direct table reads to run as service_role instead of the anonymous role.
  const headers = {
    apikey: secret,
    ...(String(secret).split(".").length === 3 ? { Authorization: `Bearer ${secret}` } : {})
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

// Media bytes (audio clips, images) were being re-fetched from Supabase
// Storage on every single request -- including every player in a live room
// pulling the same clip within seconds of each other -- which is what blew
// through the Supabase org's Cached Egress quota. The DB-backed authorization
// check (can_access_live_media / author-token verification) must still run
// on every request, but the actual object bytes for a given storage_path are
// identical for anyone who's allowed to see them, so they're safe to cache at
// Cloudflare's edge keyed by storage_path. One caveat: author.js can update a
// clip in place (same storage_path, new bytes) when a host re-trims audio, so
// this is a bounded-staleness cache, not an immutable one -- edits made less
// than MEDIA_CACHE_TTL_SECONDS before a live session could still serve the
// old clip for up to that long. Keep this TTL short enough that "edit, then
// go live" workflows stay safe.
const MEDIA_CACHE_TTL_SECONDS = 900; // 15 minutes

function mediaCacheKey(storagePath) {
  // Synthetic same-shape URL used only as a cache key -- never fetched.
  // Keyed by storage_path (the actual object identity in the bucket), not by
  // assetId or by anything request-specific like room/token, so every caller
  // asking for the same bytes shares one cache entry.
  return new Request(`https://media-cache.internal/quiz-media/${storagePath.split("/").map(encodeURIComponent).join("/")}`);
}

// Cloudflare's edge Cache API (caches.default) only stores responses it
// considers cacheable, and "instructs not to cache" isn't fully spelled out
// for every Cache-Control directive -- so the copy we hand to cache.put() is
// always unambiguously `public`, guaranteeing it gets stored. The copy we
// hand back to the actual browser is a separately-built `private` response,
// so no shared/corporate proxy between the player and Cloudflare ever caches
// it -- only that one browser's own local cache may. This split costs
// nothing (both come from the same tee'd body) and keeps the access-control
// story identical to before: the room/author authorization check above still
// runs on every single request, cache hit or not, so a private copy sitting
// in Cloudflare's edge is never handed out to anyone who fails that check.
function toPrivateClientResponse(response, extraHeaders) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `private, max-age=${MEDIA_CACHE_TTL_SECONDS}`);
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  return new Response(response.body, { headers });
}

async function deliverMediaObject(env, storagePath, mimeType, headers, extraHeaders, ctx) {
  const cacheKey = mediaCacheKey(storagePath);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { ok: true, response: toPrivateClientResponse(cached, extraHeaders) };

  const objectResponse = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/quiz-media/${storagePath.split("/").map(encodeURIComponent).join("/")}`, { headers });
  if (!objectResponse.ok) return { ok: false, status: objectResponse.status };

  const cacheableResponse = new Response(objectResponse.body, {
    headers: { "content-type": mimeType, "cache-control": `public, max-age=${MEDIA_CACHE_TTL_SECONDS}` }
  });
  ctx.waitUntil(cache.put(cacheKey, cacheableResponse.clone()));
  return { ok: true, response: toPrivateClientResponse(cacheableResponse, extraHeaders) };
}

function mediaFailure(stage, upstreamStatus = 0) {
  console.error("Private media delivery failed", { stage, upstreamStatus });
  return new Response("Not found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-quiz-media-stage,x-quiz-upstream-status",
      "x-quiz-media-stage": stage,
      ...(upstreamStatus ? { "x-quiz-upstream-status": String(upstreamStatus) } : {})
    }
  });
}

const hostTextAnswersCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "x-quiz-room, x-quiz-host-secret",
  "access-control-max-age": "86400"
};

const hostClosestNumberCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "x-quiz-room, x-quiz-host-secret",
  "access-control-max-age": "86400"
};

function hostTextAnswersResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...hostTextAnswersCorsHeaders, ...(init.headers || {}) }
  });
}

function hostClosestNumberResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...hostClosestNumberCorsHeaders, ...(init.headers || {}) }
  });
}

const hostSubmissionsCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "x-quiz-room, x-quiz-host-secret",
  "access-control-max-age": "86400"
};

function hostSubmissionsResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...hostSubmissionsCorsHeaders, ...(init.headers || {}) }
  });
}

// --- Prompt Battle: host model test route -----------------------------
//
// POST /battle/test-image (base spec section 7.5; dispatch corrected by
// docs/superpowers/specs/2026-08-24-prompt-battle-free-engine-addendum.md
// section 2.3). Lets the host preview the effective model from the title
// screen before a round starts. Runs one generation outside any battle
// round: it never touches player budgets, never creates matchup entries,
// and never persists -- images return inline as base64 to the host, who is
// already trusted with all quiz media.
//
// This route is the single dispatch path the addendum requires: it builds
// descriptors via the pure image-engine.js adapter, executes every one of
// them through runBattleDescriptor() with Promise.allSettled (never
// Promise.all -- one flaky variant must not discard the others), and folds
// the results back through the adapter's parseResponses(). image-engine.js
// itself performs no I/O, which is what lets it be tested from fixtures.
const BATTLE_TEST_IMAGE_PROMPT = "A colorful, family-friendly illustration of a game show host holding an oversized novelty question mark.";
const BATTLE_TEST_IMAGE_VARIANTS = 2;
const BATTLE_TEST_IMAGE_MAX_PER_SESSION = 10;

// Deployment allowlist (base spec section 7.5): the host's model menu is
// validated against this on the Worker, never against a model string taken
// from the request body -- a client-supplied model name is the allowlist
// defeated. In a later slice this is intersected with the quiz's own
// `permittedModels`. Only workers_ai is implemented this slice (see
// image-engine.js), so every entry names that provider rather than stubbing
// openrouter/vertex/the Kaplan proxy.
//
// This list is deployment POLICY -- which models a host may select. How to
// actually call each one (payload shape, parameter names, step counts) lives
// with the provider knowledge in image-engine.js's WORKERS_AI_PROFILES,
// because these models do not share an input schema. Keeping the two
// separate means adding a model here is a policy decision, not a protocol
// change.
const BATTLE_MODEL_ALLOWLIST = {
  "@cf/black-forest-labs/flux-1-schnell": { provider: "workers_ai" },
  "@cf/black-forest-labs/flux-2-klein-4b": { provider: "workers_ai" },
  "@cf/black-forest-labs/flux-2-klein-9b": { provider: "workers_ai" },
  "@cf/leonardo/lucid-origin": { provider: "workers_ai" }
};

// Best-effort only, not durable: an in-memory Map does not survive an
// isolate restart or redeploy, and is not shared between concurrently
// running isolates, so a determined host could exceed 10 across isolates.
// A durable per-session cap needs the session_battle_generations table from
// a later slice's migration -- out of scope here (no migrations this
// slice). This is the honest interim version rather than a pretended-
// durable one. Keyed by room code.
const battleTestImageCounts = new Map();

const battleTestImageCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "x-quiz-room, x-quiz-host-secret, content-type",
  "access-control-max-age": "86400"
};

function battleTestImageResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...battleTestImageCorsHeaders, ...(init.headers || {}) }
  });
}

// --- Prompt Battle: player generation route ----------------------------
//
// POST /battle/generate. authorize_battle_generation() reserves one attempt
// and returns the session's effective engine, so this route only calls the
// provider, stores what came back as battle media, and records the cost.
// Engine, model, variants, owner and budget all come from that authorizer:
// a request body is a suggestion, not a configuration source.
//
// Attempts are refunded only when the call was provably unbilled (no provider
// call at all, Workers AI, or a zero-cost Kaplan block). Anything unknown
// after a paid call keeps its reservation pending for reconciliation.
const battleGenerateCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "x-quiz-room, x-quiz-player-token, content-type",
  "access-control-max-age": "86400"
};

const BATTLE_GENERATE_MAX_BODY_BYTES = 8192;
const BATTLE_GENERATE_MAX_PROMPT_CHARS = 2048;
const BATTLE_GENERATE_MAX_VARIANTS = 4;
const BATTLE_GENERATE_MAX_IMAGE_BYTES = 26214400;
const BATTLE_ASSET_EXPIRY_DAYS = 30;
const BATTLE_PURGE_BATCH_SIZE = 100;
const BATTLE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The only three types the private quiz-media bucket may hold.
const BATTLE_IMAGE_EXTENSION_BY_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const BATTLE_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// Said whenever a refund could not be confirmed: it never claims the attempt
// came back, and never invites a retry the player cannot afford.
const BATTLE_UNCONFIRMED_ERROR = "Image generation failed. Refresh to check your attempt.";
const BATTLE_UNAVAILABLE_ERROR = "Image generation is not available for this game.";

function battlePurgeFailure(stage, upstreamStatus) {
  console.error("Prompt Battle media purge failed", {
    stage,
    ...(upstreamStatus ? { upstreamStatus } : {})
  });
  return new Error(`Prompt Battle media purge ${stage} failed.`);
}

function isBattleStoragePath(storagePath) {
  if (typeof storagePath !== "string" || !storagePath.startsWith("battle/")) return false;
  const segments = storagePath.split("/");
  return segments.length >= 3 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

async function purgeExpiredBattleMedia(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw battlePurgeFailure("configuration");

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
  let listResponse;
  try {
    listResponse = await fetch(`${baseUrl}/rest/v1/rpc/purge_expired_battle_media`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_limit: BATTLE_PURGE_BATCH_SIZE })
    });
  } catch {
    throw battlePurgeFailure("list");
  }
  if (!listResponse.ok) throw battlePurgeFailure("list", listResponse.status);

  const assets = await listResponse.json().catch(() => null);
  if (!Array.isArray(assets)) throw battlePurgeFailure("list response", listResponse.status);
  if (assets.length === 0) return;

  const removedAssetIds = [];
  let failedDeletes = 0;
  for (const asset of assets) {
    if (!BATTLE_UUID_PATTERN.test(asset?.assetId || "") || !isBattleStoragePath(asset?.storagePath)) {
      failedDeletes += 1;
      console.error("Prompt Battle media purge failed", { stage: "storage delete validation" });
      continue;
    }

    let deleteResponse;
    try {
      deleteResponse = await fetch(`${baseUrl}/storage/v1/object/quiz-media`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ prefixes: [asset.storagePath] })
      });
    } catch {
      failedDeletes += 1;
      console.error("Prompt Battle media purge failed", { stage: "storage delete" });
      continue;
    }
    if (!deleteResponse.ok) {
      failedDeletes += 1;
      console.error("Prompt Battle media purge failed", { stage: "storage delete", upstreamStatus: deleteResponse.status });
      continue;
    }
    removedAssetIds.push(asset.assetId);
  }

  if (removedAssetIds.length > 0) {
    let finalizeResponse;
    try {
      finalizeResponse = await fetch(`${baseUrl}/rest/v1/rpc/finalize_battle_media_purge`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_asset_ids: removedAssetIds })
      });
    } catch {
      throw battlePurgeFailure("finalize");
    }
    if (!finalizeResponse.ok) throw battlePurgeFailure("finalize", finalizeResponse.status);

    const finalization = await finalizeResponse.json().catch(() => null);
    if (!finalization || !Array.isArray(finalization.deleted) || !Array.isArray(finalization.keptObjectStillPresent)) {
      throw battlePurgeFailure("finalize response", finalizeResponse.status);
    }
    if (finalization.keptObjectStillPresent.length > 0) {
      failedDeletes += finalization.keptObjectStillPresent.length;
      console.error("Prompt Battle media purge failed", { stage: "finalize objects still present", count: finalization.keptObjectStillPresent.length });
    }
  }

  if (failedDeletes > 0) throw new Error("Prompt Battle media purge left objects for retry.");
}

function battleGenerateResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...battleGenerateCorsHeaders, ...(init.headers || {}) }
  });
}

// Null means "not usable base64": a malformed, empty or oversize payload fails
// before an upload instead of storing an object nothing can render. The encoded
// length is bounded before atob, so an oversize payload cannot make the isolate
// allocate a huge binary only to throw it away afterwards.
function decodeBattleImageBytes(encoded) {
  if (typeof encoded !== "string") return null;
  const text = encoded.trim();
  if (text === "" || text.length > Math.ceil(BATTLE_GENERATE_MAX_IMAGE_BYTES / 3) * 4 || !BATTLE_BASE64_PATTERN.test(text)) return null;
  let binary;
  try { binary = atob(text); } catch { return null; }
  if (binary.length === 0 || binary.length > BATTLE_GENERATE_MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// True only when a reserved attempt is provably back: a 2xx reply saying
// refunded, or the stored failed/blocked status an idempotent replay answers
// with. A non-2xx, a network failure, unparseable JSON or an empty object is
// false, so no caller can report a refund it cannot see.
async function refundBattleAttempt(env, generationId, reasonKind, reason) {
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/refund_battle_attempt`, {
      method: "POST",
      headers: supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true }),
      body: JSON.stringify({ p_generation_id: generationId, p_reason_kind: reasonKind, p_reason: reason })
    });
  } catch { return false; }
  const reply = response.ok ? await response.json().catch(() => null) : null;
  if (reply === null || typeof reply !== "object") return false;
  return reply.refunded === true || reply.status === "failed" || reply.status === "blocked";
}

// A failure that depends on whether the attempt was actually handed back: a
// confirmed give-back names the ordinary unavailable text, and anything else
// says only to refresh.
function battleGenerateFailure(refunded, message) {
  return battleGenerateResponse({ error: refunded ? message : BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
}

async function battleUnavailable(env, generationId, reason) {
  return battleGenerateFailure(await refundBattleAttempt(env, generationId, "provider_error", reason), BATTLE_UNAVAILABLE_ERROR);
}

// Everything after the cheap request checks. One outer catch covers every
// upstream transport, so a rejected fetch becomes a controlled generic reply;
// the tracked state decides whether a reservation may be handed back at all.
async function battleGenerateFlow(env, roomCode, playerToken, playerPrompt) {
  const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
  const state = { generationId: null, providerCalled: false };
  try {
    const authorizeResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/authorize_battle_generation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_room_code: roomCode, p_player_token: playerToken, p_player_prompt: playerPrompt })
    });
    // A refusal reserved nothing: nothing to refund, no provider call, and no
    // budget detail leaves the server.
    if (!authorizeResponse.ok) {
      const refusalStatus = authorizeResponse.status >= 400 && authorizeResponse.status < 500 ? authorizeResponse.status : 502;
      return battleGenerateResponse({ error: "You cannot generate an image right now." }, { status: refusalStatus });
    }
    const authorized = await authorizeResponse.json().catch(() => null);
    const generationId = typeof authorized?.generationId === "string" && BATTLE_UUID_PATTERN.test(authorized.generationId) ? authorized.generationId : null;
    // No trustworthy id means nothing can be identified for a refund, and none
    // is invented.
    if (!generationId) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
    state.generationId = generationId;
    const serverProvider = typeof authorized.provider === "string" ? authorized.provider : "";
    const serverModel = typeof authorized.model === "string" ? authorized.model.trim() : "";
    const serverPrompt = typeof authorized.playerPrompt === "string" ? authorized.playerPrompt.trim() : "";
    const variantCount = authorized.variants;
    const adapter = serverProvider === "workers_ai" || serverProvider === "kaplan_proxy" ? ENGINES[serverProvider] : null;
    // The effective engine configuration is refused before the owner lookup and
    // long before the provider, so an unusable round costs neither.
    if (!adapter || serverModel === "" || serverPrompt === "" || !Number.isInteger(variantCount) || variantCount < 1 || variantCount > BATTLE_GENERATE_MAX_VARIANTS) {
      return battleUnavailable(env, generationId, "Unsupported generation configuration");
    }
    let auth;
    try {
      auth = await adapter.resolveAuth(env);
    } catch {
      return battleUnavailable(env, generationId, "Image engine credentials are unavailable");
    }
    // The authorizer returns no playerId, so the owner it stamped on the
    // generation is read back and used instead of any client claim.
    const ownerResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/session_battle_generations?select=entry:session_battle_entries(player_id)&id=eq.${encodeURIComponent(generationId)}&limit=1`, { headers });
    const ownerRows = ownerResponse.ok ? await ownerResponse.json().catch(() => null) : null;
    const ownerRow = Array.isArray(ownerRows) && ownerRows.length === 1 ? ownerRows[0] : null;
    const playerId = typeof ownerRow?.entry?.player_id === "string" && BATTLE_UUID_PATTERN.test(ownerRow.entry.player_id) ? ownerRow.entry.player_id : null;
    if (playerId === null) return battleUnavailable(env, generationId, "Generation owner could not be resolved");
    // Seeds are made here, never inside image-engine.js, so buildRequests()
    // stays deterministic for its fixtures.
    const seeds = Array.from({ length: variantCount }, () => crypto.getRandomValues(new Uint32Array(1))[0]);
    const requestConfig = { model: serverModel, prompt: serverPrompt, variants: variantCount, seeds, auth };
    if (Number.isInteger(authorized.steps)) requestConfig.steps = authorized.steps;
    if (typeof authorized.resolution === "string") requestConfig.resolution = authorized.resolution;
    if (typeof authorized.outputFormat === "string") requestConfig.outputFormat = authorized.outputFormat;
    let descriptors;
    try {
      descriptors = adapter.buildRequests(requestConfig);
    } catch {
      return battleUnavailable(env, generationId, "Unsupported generation configuration");
    }
    // One dispatch path for every descriptor with allSettled, so one flaky
    // variant cannot discard the others. From here the provider may have been
    // paid, so no later failure may invent a refund.
    state.providerCalled = true;
    const settled = await Promise.allSettled(descriptors.map((descriptor) => runBattleDescriptor(descriptor, auth)));
    const results = settled.map((entry) => entry.status === "fulfilled" ? { ok: true, body: entry.value } : { ok: false, status: entry.reason?.status ?? 0, error: entry.reason });
    let parsed;
    try {
      parsed = adapter.parseResponses({ results, expectedVariants: variantCount });
    } catch {
      // An unreadable outcome is an unknown charge: never zero, never recorded.
      return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
    }
    // A provider that answers with more images than the round asked for cannot
    // widen the round.
    const images = (Array.isArray(parsed?.images) ? parsed.images : []).slice(0, variantCount);
    const costUsd = parsed?.costUsd;
    const costKnown = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0;
    if (images.length === 0) {
      // Only a provably unbilled attempt comes back: Workers AI is free, and a
      // zero-cost Kaplan block or failure was never charged. A billed no-image
      // response keeps its reservation -- the money is spent.
      if (!costKnown || costUsd > 0) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
      if (parsed.blocked === true) {
        const blockReason = String(parsed.blockReason || "The image model declined that prompt.").slice(0, 500);
        // The prompt is named back, with the fact that nothing was spent, but
        // only once the give-back is confirmed.
        if (await refundBattleAttempt(env, generationId, "safety_block", blockReason)) {
          return battleGenerateResponse({ error: `That prompt was declined and did not use an attempt. ${blockReason}`, blockReason }, { status: 422 });
        }
        return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
      }
      return battleUnavailable(env, generationId, "The image provider returned no image");
    }
    // Images came back but the charge is unreadable, so nothing is stored and
    // nothing is recorded: a zero here would be a lie.
    if (!costKnown) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
    // Every image is checked before anything is written, and nothing is reported
    // until every upload and both database writes have landed. A failure
    // part-way leaves the reservation pending and deletes nothing, because a
    // record call that timed out may still have committed.
    const uploads = [];
    for (const image of images) {
      const mimeType = typeof image?.mimeType === "string" ? image.mimeType : "";
      const extension = BATTLE_IMAGE_EXTENSION_BY_MIME[mimeType];
      const bytes = extension ? decodeBattleImageBytes(image?.bytesBase64) : null;
      if (!bytes) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
      // Object writes go to /object/quiz-media/<path>; /object/authenticated is
      // download-only, and x-upsert:false keeps a fresh random path from ever
      // replacing an existing object.
      const storagePath = `battle/${generationId}/${crypto.randomUUID()}.${extension}`;
      const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
      const uploadResponse = await fetch(`${env.SUPABASE_URL}/storage/v1/object/quiz-media/${encodedPath}`, {
        method: "POST",
        headers: { ...supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY), "content-type": mimeType, "x-upsert": "false" },
        body: bytes
      });
      if (!uploadResponse.ok) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
      uploads.push({ storagePath, mimeType, byteSize: bytes.byteLength });
    }
    // One batch, and the database supplies the ids: what the player receives is
    // what Storage and Postgres hold, never a provider body or a client echo.
    const expiresAt = new Date(Date.now() + BATTLE_ASSET_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const insertResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/media_assets`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(uploads.map((upload) => ({
        storage_path: upload.storagePath, kind: "image", mime_type: upload.mimeType,
        byte_size: upload.byteSize, uploaded_by: null, source: "battle",
        generated_by_player_id: playerId, expires_at: expiresAt
      })))
    });
    const insertedRows = insertResponse.ok ? await insertResponse.json().catch(() => null) : null;
    const assetIds = Array.isArray(insertedRows) && insertedRows.length === uploads.length
      ? insertedRows.map((row) => typeof row?.id === "string" && BATTLE_UUID_PATTERN.test(row.id) ? row.id : null)
      : null;
    if (!assetIds || assetIds.some((id) => id === null) || assetIds.some((id, index) => assetIds.indexOf(id) !== index)) {
      return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
    }
    const recordResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_battle_generation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_generation_id: generationId, p_asset_ids: assetIds, p_cost_usd: costUsd })
    });
    const record = recordResponse.ok ? await recordResponse.json().catch(() => null) : null;
    const recordedIds = record && typeof record === "object" && Array.isArray(record.assetIds) ? record.assetIds : null;
    // The record must name exactly the rows just inserted and report the
    // generation complete; a replay of an already-complete generation answers
    // recorded:false with the stored ids, which still agrees.
    const recorded = record !== null && typeof record === "object" && record.status === "complete" && recordedIds !== null
      && recordedIds.length === assetIds.length
      && recordedIds.every((id, index) => typeof id === "string" && recordedIds.indexOf(id) === index && assetIds.includes(id));
    if (!recorded) return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
    return battleGenerateResponse({
      assetIds,
      partial: assetIds.length < variantCount,
      generationId,
      ...(Number.isInteger(authorized.attemptsRemaining) ? { attemptsRemaining: authorized.attemptsRemaining } : {})
    });
  } catch {
    // Any transport throw becomes a controlled generic reply; raw provider URLs,
    // bodies and errors never reach the player. A reservation is handed back
    // only when a valid id is known and the provider was never called -- after
    // that the charge is unknown and stays pending.
    if (state.generationId !== null && !state.providerCalled) return battleUnavailable(env, state.generationId, "Generation setup failed");
    return battleGenerateResponse({ error: BATTLE_UNCONFIRMED_ERROR }, { status: 502 });
  }
}

// The one dispatch path every adapter's descriptors run through, per
// addendum section 2.3. A "binding" descriptor calls the named Workers
// binding directly; an "http" descriptor (openrouter, openai, the Kaplan
// proxy -- none implemented yet) would fetch a provider URL. Errors carry a
// status where one is known so parseResponses can distinguish provider
// failure shapes later.
async function runBattleDescriptor(descriptor, auth) {
  if (descriptor.kind === "binding") {
    // image-engine.js emits inert data only, so the multipart encoding is
    // assembled here: FormData -> Response gives both the body stream and a
    // content-type header carrying the MIME boundary, which is what the
    // model's validator requires and what no plain object can express. The
    // stream is single-use, so it is built per descriptor rather than shared
    // across variants.
    if (descriptor.encoding === "multipart") {
      const form = new FormData();
      for (const [name, value] of Object.entries(descriptor.payload)) {
        form.append(name, String(value));
      }
      const encoded = new Response(form);
      return auth.binding.run(descriptor.model, {
        multipart: { body: encoded.body, contentType: encoded.headers.get("content-type") }
      });
    }
    return auth.binding.run(descriptor.model, descriptor.payload);
  }
  const response = await fetch(descriptor.url, {
    method: "POST",
    headers: { ...descriptor.headers, ...(auth.headers || {}) },
    body: JSON.stringify(descriptor.body)
  });
  if (!response.ok) {
    const error = new Error(`${descriptor.url} returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function verifyQuizAuthor(env, token) {
  const headers = { ...supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true }), Authorization: `Bearer ${token}` };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_quiz_author`, { method: "POST", headers, body: "{}" });
  return { ok: response.ok && await response.json().catch(() => false) === true, status: response.status };
}

export default {
  async scheduled(_controller, env) {
    await purgeExpiredBattleMedia(env);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
if (request.method === "GET" && url.pathname === "/__version") {
      const metadata = env.CF_VERSION_METADATA || {};

      return Response.json(
        {
          commit: metadata.tag || null,
          versionId: metadata.id || null,
          deployedAt: metadata.timestamp || null
        },
        {
          headers: {
            "cache-control": "no-store"
          }
        }
      );
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/author-media/")) return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "authorization", "access-control-max-age": "86400" } });
    // This endpoint is called by the presentation hosted on the custom site,
    // while the API runs on workers.dev. Its custom host credential headers
    // require a successful CORS preflight before the browser will issue GET.
    if (request.method === "OPTIONS" && url.pathname === "/host-text-answers") return new Response(null, { status: 204, headers: hostTextAnswersCorsHeaders });
    if (request.method === "OPTIONS" && url.pathname === "/host-closest-number-guesses") return new Response(null, { status: 204, headers: hostClosestNumberCorsHeaders });
    if (request.method === "OPTIONS" && url.pathname === "/host-submissions") return new Response(null, { status: 204, headers: hostSubmissionsCorsHeaders });
    if (request.method === "OPTIONS" && url.pathname === "/battle/test-image") return new Response(null, { status: 204, headers: battleTestImageCorsHeaders });
    if (request.method === "GET" && url.pathname === "/media-health") {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ ok: false, stage: "configuration" }, { status: 503 });
      const check = await fetch(`${env.SUPABASE_URL}/rest/v1/media_assets?select=id&limit=1`, { headers: supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY) });
      const failure = check.ok ? null : await check.json().catch(() => ({}));
      return Response.json({ ok: check.ok, stage: check.ok ? "ready" : "supabase-auth", upstreamStatus: check.status, upstreamCode: String(failure?.code || "").slice(0, 40), upstreamMessage: String(failure?.message || "").slice(0, 160) }, { status: check.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/host-text-answers") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return hostTextAnswersResponse({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return hostTextAnswersResponse({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });
      const roomState = await stateResponse.json();
      if (!['question_locked', 'answer_reveal'].includes(roomState.phase)) return hostTextAnswersResponse({ answers: [] }, { headers: { "cache-control": "private, no-store" } });
      const question = roomState.state?.question || {};
      if (!['short_answer', 'fill_in_the_blank'].includes(question.type) || !roomState.state?.questionId) return hostTextAnswersResponse({ answers: [] }, { headers: { "cache-control": "private, no-store" } });
      // The preceding RPC has verified the host secret. Query the active
      // session and its submissions with the Worker's service credential so
      // this wall cannot be empty because an optional display-only RPC is out
      // of date or has a stricter state filter than the live room itself.
      const sessionResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/sessions?room_code=eq.${encodeURIComponent(roomCode.trim().toUpperCase())}&select=id`, { headers });
      if (!sessionResponse.ok) {
        const failure = await sessionResponse.json().catch(() => ({}));
        console.error("Answer wall session lookup failed", { upstreamStatus: sessionResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostTextAnswersResponse({ error: "Could not load the active room.", stage: "session-lookup", upstreamStatus: sessionResponse.status, upstreamCode: String(failure?.code || "").slice(0, 40), upstreamMessage: String(failure?.message || "").slice(0, 160) }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const [session] = await sessionResponse.json();
      if (!session?.id) return hostTextAnswersResponse({ answers: [] }, { headers: { "cache-control": "private, no-store" } });
      const answersResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/submissions?session_id=eq.${encodeURIComponent(session.id)}&question_id=eq.${encodeURIComponent(roomState.state.questionId)}&select=answer,submitted_at&order=submitted_at.asc`, { headers });
      if (!answersResponse.ok) {
        const failure = await answersResponse.json().catch(() => ({}));
        console.error("Answer wall submission lookup failed", { upstreamStatus: answersResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostTextAnswersResponse({ error: "Could not load answers.", stage: "submission-lookup", upstreamStatus: answersResponse.status, upstreamCode: String(failure?.code || "").slice(0, 40), upstreamMessage: String(failure?.message || "").slice(0, 160) }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const answerData = await answersResponse.json();
      const answers = Array.isArray(answerData) ? answerData.map((submission) => typeof submission?.answer === "string" ? submission.answer.trim().slice(0, 180) : "").filter(Boolean) : [];
      return hostTextAnswersResponse({ answers }, { headers: { "cache-control": "private, no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/host-closest-number-guesses") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return hostClosestNumberResponse({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return hostClosestNumberResponse({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });
      const roomState = await stateResponse.json();
      const question = roomState.state?.question || {};
      if (roomState.phase !== "answer_reveal" || question.type !== "closest_number" || !roomState.state?.questionId) return hostClosestNumberResponse({ guesses: [] }, { headers: { "cache-control": "private, no-store" } });

      // The host credential above authorizes this display-only lookup. Names
      // and guesses deliberately stay out of the public room state, which is
      // broadcast to every player phone.
      const sessionResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/sessions?room_code=eq.${encodeURIComponent(roomCode.trim().toUpperCase())}&select=id`, { headers });
      if (!sessionResponse.ok) {
        const failure = await sessionResponse.json().catch(() => ({}));
        console.error("Closest-number session lookup failed", { upstreamStatus: sessionResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostClosestNumberResponse({ error: "Could not load the active room." }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const [session] = await sessionResponse.json();
      if (!session?.id) return hostClosestNumberResponse({ guesses: [] }, { headers: { "cache-control": "private, no-store" } });
      const guessesResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/submissions?session_id=eq.${encodeURIComponent(session.id)}&question_id=eq.${encodeURIComponent(roomState.state.questionId)}&select=answer,player:session_players(display_name,logo_key)&order=submitted_at.asc`, { headers });
      if (!guessesResponse.ok) {
        const failure = await guessesResponse.json().catch(() => ({}));
        console.error("Closest-number submission lookup failed", { upstreamStatus: guessesResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostClosestNumberResponse({ error: "Could not load guesses." }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const guessData = await guessesResponse.json();
      const guesses = Array.isArray(guessData)
        ? guessData.map((submission) => ({
          playerName: String(submission?.player?.display_name || "Guest").trim().slice(0, 32),
          logoKey: String(submission?.player?.logo_key || "").trim().slice(0, 40),
          guess: typeof submission?.answer === "string" ? submission.answer.trim().slice(0, 80) : ""
        })).filter((guess) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(guess.guess))
        : [];
      return hostClosestNumberResponse({ guesses }, { headers: { "cache-control": "private, no-store" } });
    }
    // Host-refresh recovery. The public room state deliberately publishes
    // `submitted: {}` -- a phone must never receive another player's answer --
    // so a reloaded Host had no way to rebuild its own received-answer count
    // or its "Who got it right" summary. Same shape as /host-text-answers: the
    // RPC verifies the host secret, then the already-granted `sessions` and
    // `submissions` reads run on the Worker's service credential. Host only;
    // nothing here is ever served to a player token.
    if (request.method === "GET" && url.pathname === "/host-submissions") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return hostSubmissionsResponse({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return hostSubmissionsResponse({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });
      const roomState = await stateResponse.json();
      const questionId = roomState.state?.questionId;
      // The question id is echoed back so a Host that has already moved on can
      // discard a late answer set instead of merging it into a new question.
      if (!questionId) return hostSubmissionsResponse({ questionId: null, submissions: [] }, { headers: { "cache-control": "private, no-store" } });
      const sessionResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/sessions?room_code=eq.${encodeURIComponent(roomCode.trim().toUpperCase())}&select=id`, { headers });
      if (!sessionResponse.ok) {
        const failure = await sessionResponse.json().catch(() => ({}));
        console.error("Host submission session lookup failed", { upstreamStatus: sessionResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostSubmissionsResponse({ error: "Could not load the active room.", stage: "session-lookup", upstreamStatus: sessionResponse.status }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const [session] = await sessionResponse.json();
      if (!session?.id) return hostSubmissionsResponse({ questionId, submissions: [] }, { headers: { "cache-control": "private, no-store" } });
      const submissionsResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/submissions?session_id=eq.${encodeURIComponent(session.id)}&question_id=eq.${encodeURIComponent(questionId)}&select=player_id,answer&order=submitted_at.asc`, { headers });
      if (!submissionsResponse.ok) {
        const failure = await submissionsResponse.json().catch(() => ({}));
        console.error("Host submission lookup failed", { upstreamStatus: submissionsResponse.status, upstreamCode: failure?.code, upstreamMessage: failure?.message });
        return hostSubmissionsResponse({ error: "Could not load submissions.", stage: "submission-lookup", upstreamStatus: submissionsResponse.status }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      const submissionData = await submissionsResponse.json();
      // player_id is session_players.id -- the same identity get_live_leaderboard()
      // keys the roster by, and the one sendSubmission() broadcasts.
      const submissions = Array.isArray(submissionData)
        ? submissionData.filter((row) => typeof row?.player_id === "string" && row.answer !== null && row.answer !== undefined).map((row) => ({ playerId: row.player_id, answer: row.answer }))
        : [];
      return hostSubmissionsResponse({ questionId, submissions }, { headers: { "cache-control": "private, no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/battle/test-image") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return battleTestImageResponse({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return battleTestImageResponse({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });

      let payload;
      try { payload = await request.json(); } catch { payload = null; }
      const model = typeof payload?.model === "string" ? payload.model : "";
      const allowed = BATTLE_MODEL_ALLOWLIST[model];
      const provider = allowed?.provider;
      // The host picks from a menu; the host never types a model string. A
      // model this Worker does not recognize is refused here regardless of
      // what the client believes it offered, which is what makes the
      // allowlist a Worker-side guarantee rather than a UI courtesy.
      if (!provider) return battleTestImageResponse({ error: "Unknown or disallowed model." }, { status: 400, headers: { "cache-control": "no-store" } });
      // Unlike the model, the prompt is host-typed free text -- that's the
      // point of this panel, and image-engine.js's own truncation (2048
      // chars for workers_ai) bounds what actually reaches the provider.
      const requestedPrompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      const prompt = requestedPrompt || BATTLE_TEST_IMAGE_PROMPT;

      const sessionKey = roomCode.trim().toUpperCase();
      const usedCount = battleTestImageCounts.get(sessionKey) || 0;
      if (usedCount >= BATTLE_TEST_IMAGE_MAX_PER_SESSION) return battleTestImageResponse({ error: "Test-generation limit reached for this session." }, { status: 429, headers: { "cache-control": "no-store" } });
      // Consumed synchronously, before any await, so two requests racing
      // within the same isolate cannot both read the same usedCount.
      battleTestImageCounts.set(sessionKey, usedCount + 1);

      const adapter = ENGINES[provider];
      let auth;
      try {
        auth = await adapter.resolveAuth(env);
      } catch (error) {
        console.error("Battle test-image auth resolution failed", { provider, message: error?.message });
        return battleTestImageResponse({ error: "Image generation is not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }

      // Seeds are generated here, never inside image-engine.js, so
      // buildRequests() stays deterministic and testable with fixed seeds.
      const seeds = Array.from({ length: BATTLE_TEST_IMAGE_VARIANTS }, () => crypto.getRandomValues(new Uint32Array(1))[0]);
      const descriptors = adapter.buildRequests({ model, prompt, variants: BATTLE_TEST_IMAGE_VARIANTS, seeds });

      const settled = await Promise.allSettled(descriptors.map((descriptor) => runBattleDescriptor(descriptor, auth)));
      const results = settled.map((entry) =>
        entry.status === "fulfilled"
          ? { ok: true, body: entry.value }
          : { ok: false, status: entry.reason?.status ?? 0, error: entry.reason }
      );
      const parsed = adapter.parseResponses({ results, expectedVariants: BATTLE_TEST_IMAGE_VARIANTS });

      // Diagnostic only, host-only: this route is explicitly for the host to
      // learn what a model/provider actually does, so a zero-image response
      // that would otherwise look like a silent no-op carries the raw
      // per-descriptor failure reasons. Never sent to a player -- there is
      // no player-facing caller of this route.
      const providerErrors = results
        .filter((result) => !result.ok)
        .map((result) => ({ status: result.status || null, message: String(result.error?.message || result.error || "unknown error") }));
      if (providerErrors.length) console.error("Battle test-image: provider call(s) failed", { provider, model, providerErrors });

      return battleTestImageResponse({ model, prompt, ...parsed, ...(providerErrors.length ? { providerErrors } : {}) }, { headers: { "cache-control": "no-store" } });
    }
    // Player image generation. Everything the client could lie about --
    // engine, model, variants, owner, budget -- comes from the authorizer
    // inside battleGenerateFlow(); only the prompt is read out of the body.
    if (url.pathname === "/battle/generate") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...battleGenerateCorsHeaders } });
      if (request.method !== "POST") return battleGenerateResponse({ error: "Method not allowed." }, { status: 405, headers: { allow: "POST, OPTIONS" } });

      const roomCode = request.headers.get("x-quiz-room");
      const playerToken = request.headers.get("x-quiz-player-token");
      if (!roomCode || !playerToken) return battleGenerateResponse({ error: "Player authorization is required." }, { status: 401 });
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return battleGenerateResponse({ error: "Image generation is not available." }, { status: 503 });

      // The body is bounded and read for its prompt alone, before anything is
      // reserved: a request that cannot be accepted must never cost an
      // attempt or reach a provider.
      const declaredBytes = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > BATTLE_GENERATE_MAX_BODY_BYTES) return battleGenerateResponse({ error: "Invalid request body." }, { status: 400 });
      let payload = null;
      try {
        const raw = await request.text();
        payload = raw.length > BATTLE_GENERATE_MAX_BODY_BYTES ? null : JSON.parse(raw);
      } catch { payload = null; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return battleGenerateResponse({ error: "Invalid request body." }, { status: 400 });
      const requestedPrompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      // Counted in code points, which is how the RPC's char_length counts.
      const promptLength = Array.from(requestedPrompt).length;
      if (promptLength === 0 || promptLength > BATTLE_GENERATE_MAX_PROMPT_CHARS) return battleGenerateResponse({ error: "Describe your image in 2048 characters or fewer." }, { status: 400 });

      return battleGenerateFlow(env, roomCode, playerToken, requestedPrompt);
    }
    if (request.method === "GET" && url.pathname.startsWith("/author-media/")) {
      const assetId = decodeURIComponent(url.pathname.slice("/author-media/".length));
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId) || !token || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return mediaFailure("author-invalid-request");
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
      const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
      if (!userResponse.ok) return mediaFailure("author-session", userResponse.status);
      const author = await verifyQuizAuthor(env, token);
      if (!author.ok) return mediaFailure("author-denied", author.status);
      const assetResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/media_assets?id=eq.${encodeURIComponent(assetId)}&select=storage_path,mime_type`, { headers });
      if (!assetResponse.ok) return mediaFailure("author-asset-record", assetResponse.status);
      const [asset] = await assetResponse.json();
      if (!asset?.storage_path) return mediaFailure("author-asset-missing");
      const delivery = await deliverMediaObject(env, asset.storage_path, asset.mime_type, headers, { "x-content-type-options": "nosniff", "access-control-allow-origin": "*", "access-control-expose-headers": "x-quiz-media-stage,x-quiz-upstream-status" }, ctx);
      if (!delivery.ok) return mediaFailure("author-storage-download", delivery.status);
      return delivery.response;
    }
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      const assetId = decodeURIComponent(url.pathname.slice("/media/".length));
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      const playerToken = request.headers.get("x-quiz-player-token");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId) || !roomCode || (!hostSecret && !playerToken) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return mediaFailure("invalid-request");

      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const authorization = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/can_access_live_media`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_asset_id: assetId, p_host_secret: hostSecret, p_player_token: playerToken }) });
      if (!authorization.ok) return mediaFailure("authorization-request", authorization.status);
      const authorized = await authorization.json() === true;
      if (!authorized) return mediaFailure("authorization-denied");

      const assetResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/media_assets?id=eq.${encodeURIComponent(assetId)}&select=storage_path,mime_type`, { headers });
      if (!assetResponse.ok) return mediaFailure("asset-record", assetResponse.status);
      const [asset] = await assetResponse.json();
      if (!asset?.storage_path) return mediaFailure("asset-missing");

      const delivery = await deliverMediaObject(env, asset.storage_path, asset.mime_type, headers, { "x-content-type-options": "nosniff" }, ctx);
      if (!delivery.ok) return mediaFailure("storage-download", delivery.status);
      return delivery.response;
    }
    return env.ASSETS.fetch(request);
  }
};

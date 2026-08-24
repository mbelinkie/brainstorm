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
const BATTLE_TEST_IMAGE_STEPS = 4;
const BATTLE_TEST_IMAGE_MAX_PER_SESSION = 10;

// Deployment allowlist (base spec section 7.5): the host's model menu is
// validated against this on the Worker, never against a model string taken
// from the request body -- a client-supplied model name is the allowlist
// defeated. In a later slice this is intersected with the quiz's own
// `permittedModels`. Only workers_ai is implemented this slice (see
// image-engine.js), so this deliberately has one entry rather than stub
// entries for openrouter/vertex/the Kaplan proxy.
const BATTLE_MODEL_ALLOWLIST = {
  "@cf/black-forest-labs/flux-1-schnell": "workers_ai"
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

// The one dispatch path every adapter's descriptors run through, per
// addendum section 2.3. A "binding" descriptor calls the named Workers
// binding directly; an "http" descriptor (openrouter, openai, the Kaplan
// proxy -- none implemented yet) would fetch a provider URL. Errors carry a
// status where one is known so parseResponses can distinguish provider
// failure shapes later.
async function runBattleDescriptor(descriptor, auth) {
  if (descriptor.kind === "binding") {
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
  async fetch(request, env) {
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
      const provider = BATTLE_MODEL_ALLOWLIST[model];
      // The host picks from a menu; the host never types a model string. A
      // model this Worker does not recognize is refused here regardless of
      // what the client believes it offered, which is what makes the
      // allowlist a Worker-side guarantee rather than a UI courtesy.
      if (!provider) return battleTestImageResponse({ error: "Unknown or disallowed model." }, { status: 400, headers: { "cache-control": "no-store" } });

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
      const descriptors = adapter.buildRequests({ model, prompt: BATTLE_TEST_IMAGE_PROMPT, variants: BATTLE_TEST_IMAGE_VARIANTS, steps: BATTLE_TEST_IMAGE_STEPS, seeds });

      const settled = await Promise.allSettled(descriptors.map((descriptor) => runBattleDescriptor(descriptor, auth)));
      const results = settled.map((entry) =>
        entry.status === "fulfilled"
          ? { ok: true, body: entry.value }
          : { ok: false, status: entry.reason?.status ?? 0, error: entry.reason }
      );
      const parsed = adapter.parseResponses({ results, expectedVariants: BATTLE_TEST_IMAGE_VARIANTS });

      return battleTestImageResponse({ model, ...parsed }, { headers: { "cache-control": "no-store" } });
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
      const objectResponse = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/quiz-media/${asset.storage_path.split("/").map(encodeURIComponent).join("/")}`, { headers });
      if (!objectResponse.ok) return mediaFailure("author-storage-download", objectResponse.status);
      return new Response(objectResponse.body, { headers: { "content-type": asset.mime_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*", "access-control-expose-headers": "x-quiz-media-stage,x-quiz-upstream-status" } });
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

      const objectResponse = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/quiz-media/${asset.storage_path.split("/").map(encodeURIComponent).join("/")}`, { headers });
      if (!objectResponse.ok) return mediaFailure("storage-download", objectResponse.status);
      return new Response(objectResponse.body, { headers: { "content-type": asset.mime_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    return env.ASSETS.fetch(request);
  }
};

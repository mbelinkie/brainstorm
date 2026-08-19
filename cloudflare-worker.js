import { ENGINES } from "./image-engine.js";

// Deployment allowlist for Prompt Battle image generation (design doc §7.5).
// The Worker is the enforcement point: "the Worker reads the effective model
// from session state, never from the request body" is the target design for
// live rounds, but /battle/test-image runs outside any round and has no
// session-state model to read, so this list is the sole gate for it. Keep it
// in sync with the `permittedModels` example in
// docs/superpowers/specs/2026-08-17-prompt-battle-design.md §4 until a later
// slice adds `set_battle_engine` and the deployment-allowlist ∩ round
// intersection described there.
const BATTLE_IMAGE_MODEL_ALLOWLIST = [
  "google/gemini-3.1-flash-image",
  "google/gemini-3.1-flash-lite-image",
  "black-forest-labs/flux.2-klein-4b"
];

// A fixed, harmless prompt for calibrating a model choice — deliberately not
// one of the quiz's actual round prompts, and deliberately not a free-text
// field the host can type into (host-only trust does not extend to arbitrary
// unmoderated text going straight to a billed provider call from this repo's
// UI).
const BATTLE_TEST_IMAGE_PROMPT = "A cheerful test pattern for calibrating an AI image generator: a small robot painting a rainbow.";

// Per-room cap on test generations (design doc §7.5: "a hard per-session cap
// of 10 test generations... the button costs real money per press").
// Tracked in-memory for this Worker instance only. This is a slice-1
// stopgap: it is not durable across isolate restarts and is not shared
// across concurrently-running isolates, so a determined host could exceed 10
// by getting routed to a fresh isolate. Migration 0033 and session state are
// out of scope for this slice; a later slice should move this counter into
// `sessions.state` (or a dedicated column) behind a proper RPC so it is
// durable and race-free. Until then this is still a meaningful backstop
// against the ordinary case of a host repeatedly clicking one button.
const BATTLE_TEST_IMAGE_SESSION_CAP = 10;
const battleTestImageCounts = new Map();

const battleTestImageCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-quiz-room, x-quiz-host-secret",
  "access-control-max-age": "86400"
};

function battleTestImageResponse(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...battleTestImageCorsHeaders, ...(init.headers || {}) }
  });
}

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
    if (request.method === "POST" && url.pathname === "/battle/test-image") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return battleTestImageResponse({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });

      // Same authorization pattern as /host-text-answers and
      // /host-closest-number-guesses: the RPC verifies the room code and
      // host secret pair server-side before this request does anything
      // that costs money. The room's live phase/state is not otherwise
      // needed — a test generation happens outside any battle round.
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return battleTestImageResponse({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });
      await stateResponse.json().catch(() => null);

      const normalizedRoom = roomCode.trim().toUpperCase();
      const usedCount = battleTestImageCounts.get(normalizedRoom) || 0;
      if (usedCount >= BATTLE_TEST_IMAGE_SESSION_CAP) return battleTestImageResponse({ error: `This room has used all ${BATTLE_TEST_IMAGE_SESSION_CAP} test generations for this session.` }, { status: 429, headers: { "cache-control": "no-store" } });

      const body = await request.json().catch(() => ({}));
      const model = String(body.model || "");
      // The host picks from a menu; the client never sends free text here.
      // A model name accepted from a client body is the allowlist defeated,
      // so this check is not optional.
      if (!BATTLE_IMAGE_MODEL_ALLOWLIST.includes(model)) return battleTestImageResponse({ error: "That model is not on the deployment allowlist." }, { status: 400, headers: { "cache-control": "no-store" } });
      if (!env.OPENROUTER_API_KEY) return battleTestImageResponse({ error: "OpenRouter is not configured on this deployment." }, { status: 503, headers: { "cache-control": "no-store" } });

      const engine = ENGINES.openrouter;
      let auth;
      try {
        auth = await engine.resolveAuth(env);
      } catch (error) {
        console.error("Battle test-image auth failed", { message: error.message });
        return battleTestImageResponse({ error: "Image provider is not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
      }

      const providerRequest = engine.buildRequest({ model, prompt: BATTLE_TEST_IMAGE_PROMPT, variants: 1, resolution: "512", outputFormat: "webp" });
      let providerResponse;
      try {
        providerResponse = await fetch(engine.endpoint(), { method: providerRequest.method, headers: { ...providerRequest.headers, ...auth.headers }, body: providerRequest.body });
      } catch (error) {
        console.error("Battle test-image provider fetch failed", { message: error.message });
        return battleTestImageResponse({ error: "The image provider could not be reached." }, { status: 502, headers: { "cache-control": "no-store" } });
      }

      // The cap counts attempts that reached the provider, whether they
      // succeed, fail, or are blocked — it exists to cap button presses
      // against real spend, not to cap only successful generations.
      battleTestImageCounts.set(normalizedRoom, usedCount + 1);
      const remaining = BATTLE_TEST_IMAGE_SESSION_CAP - (usedCount + 1);

      if (!providerResponse.ok) {
        const failureText = await providerResponse.text().catch(() => "");
        console.error("Battle test-image provider error", { upstreamStatus: providerResponse.status, body: failureText.slice(0, 500) });
        return battleTestImageResponse({ error: "The image provider returned an error.", upstreamStatus: providerResponse.status, remaining }, { status: 502, headers: { "cache-control": "no-store" } });
      }

      const json = await providerResponse.json().catch(() => ({}));
      const parsed = engine.parseResponse(json);
      if (parsed.blocked) return battleTestImageResponse({ blocked: true, blockReason: parsed.blockReason, costUsd: parsed.costUsd, remaining }, { headers: { "cache-control": "no-store" } });

      const [image] = parsed.images;
      if (!image) return battleTestImageResponse({ error: "The provider returned no image.", remaining }, { status: 502, headers: { "cache-control": "no-store" } });

      // Inline base64 to the host only, and nothing is persisted — no
      // storage upload, no media_assets row. This sidesteps the
      // uploaded_by/ownership question for battle media entirely for the
      // test path, per §7.5.
      return battleTestImageResponse({ mimeType: image.mimeType, bytesBase64: image.bytesBase64, costUsd: parsed.costUsd, remaining }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/media-assistant/search") {
      const openAiKey = env.OPENAI_QUIZ || env.OPENAI_API_KEY;
      if (!openAiKey || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: "Media assistant is not configured yet." }, { status: 503 });
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!token) return Response.json({ error: "Sign in as an authorized quiz author first." }, { status: 401 });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
      const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
      if (!userResponse.ok) return Response.json({ error: "Sign in as an authorized quiz author first." }, { status: 401 });
      const author = await verifyQuizAuthor(env, token);
      if (!author.ok) return Response.json({ error: "This account is not allowed to use the media assistant." }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      const prompt = String(body.prompt || "").slice(0, 500);
      const options = Array.isArray(body.options) ? body.options.map((option) => String(option?.label || "").slice(0, 140)).filter(Boolean).slice(0, 8) : [];
      const targetLabel = String(body.targetLabel || "").slice(0, 180);
      const imageRequest = String(body.imageRequest || "").slice(0, 300);
      if (!prompt) return Response.json({ error: "Add a question prompt before requesting image suggestions." }, { status: 400 });
      const query = `You are helping an author find an educational quiz image. Question: ${prompt}\nQuestion options: ${options.join(" | ")}\nImage target: ${targetLabel || "the question"}\nAuthor request: ${imageRequest || "Find the most useful supporting image."}\nResolve pronouns and shorthand from the question and target. For example, if the author asks for an image from a movie, identify the movie target before searching. Return JSON only: {"queries":["three concise Wikimedia Commons image-search queries"],"guidance":"one concise note about the best image choice and rights"}. Prefer identifiable people, public-domain or freely licensed artwork, and official sources. Do not claim a license you cannot verify.`;
      const aiResponse = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-terra", input: query, tools: [{ type: "web_search" }], store: false }) });
      if (!aiResponse.ok) return Response.json({ error: "The media assistant could not prepare suggestions." }, { status: 502 });
      const ai = await aiResponse.json();
      const text = ai.output_text || ai.output?.flatMap((entry) => entry.content || []).map((content) => content.text || "").join("") || "";
      const match = text.match(/\{[\s\S]*\}/);
      let suggestion = { queries: [prompt], guidance: "Review the source and license before approval." };
      try { suggestion = { ...suggestion, ...JSON.parse(match?.[0] || text) }; } catch { /* Use the original prompt if the model returns prose. */ }
      const commonsQuery = String(suggestion.queries?.[0] || prompt).slice(0, 250);
      const commons = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(commonsQuery)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=360&format=json&origin=*`);
      const commonsData = commons.ok ? await commons.json() : {};
      const candidates = Object.values(commonsData.query?.pages || {}).map((page) => ({ title: page.title?.replace(/^File:/, "") || "Untitled image", thumbnailUrl: page.imageinfo?.[0]?.thumburl, originalUrl: page.imageinfo?.[0]?.url, pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || "")}`, license: page.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value || "Check source page" })).filter((item) => item.thumbnailUrl && item.originalUrl).slice(0, 6);
      return Response.json({ queries: Array.isArray(suggestion.queries) ? suggestion.queries.slice(0, 3) : [commonsQuery], guidance: String(suggestion.guidance || "Review the source and license before approval."), candidates });
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

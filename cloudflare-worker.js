function supabaseAdminHeaders(secret, { json = false } = {}) {
  // Modern Supabase server keys are opaque API keys, not user-session JWTs.
  // The hosted gateway translates this credential to the service_role role.
  const headers = { apikey: secret };
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

async function verifyQuizAuthor(env, token) {
  const headers = { ...supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true }), Authorization: `Bearer ${token}` };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_quiz_author`, { method: "POST", headers, body: "{}" });
  return { ok: response.ok && await response.json().catch(() => false) === true, status: response.status };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/author-media/")) return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "authorization", "access-control-max-age": "86400" } });
    if (request.method === "GET" && url.pathname === "/media-health") {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ ok: false, stage: "configuration" }, { status: 503 });
      const check = await fetch(`${env.SUPABASE_URL}/rest/v1/media_assets?select=id&limit=1`, { headers: supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY) });
      const failure = check.ok ? null : await check.json().catch(() => ({}));
      return Response.json({ ok: check.ok, stage: check.ok ? "ready" : "supabase-auth", upstreamStatus: check.status, upstreamCode: String(failure?.code || "").slice(0, 40), upstreamMessage: String(failure?.message || "").slice(0, 160) }, { status: check.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/host-text-answers") {
      const roomCode = request.headers.get("x-quiz-room");
      const hostSecret = request.headers.get("x-quiz-host-secret");
      if (!roomCode || !hostSecret || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: "Host authorization is required." }, { status: 401, headers: { "cache-control": "no-store" } });
      const headers = supabaseAdminHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { json: true });
      const stateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!stateResponse.ok) return Response.json({ error: "Host authorization failed." }, { status: 403, headers: { "cache-control": "no-store" } });
      const roomState = await stateResponse.json();
      if (!['question_locked', 'answer_reveal'].includes(roomState.phase)) return Response.json({ answers: [] }, { headers: { "cache-control": "private, no-store" } });
      const question = roomState.state?.question || {};
      if (!['short_answer', 'fill_in_the_blank'].includes(question.type) || !roomState.state?.questionId) return Response.json({ answers: [] }, { headers: { "cache-control": "private, no-store" } });
      // Keep the session lookup and answer read inside one database function.
      // The prior two direct REST table queries could fail independently and
      // surfaced as a generic 502 to the presenter.
      const answersResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_host_text_answers`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_host_secret: hostSecret }) });
      if (!answersResponse.ok) return Response.json({ error: "Could not load answers." }, { status: 502, headers: { "cache-control": "no-store" } });
      const answerData = await answersResponse.json();
      const answers = Array.isArray(answerData) ? answerData.map((answer) => String(answer).trim().slice(0, 180)).filter(Boolean) : [];
      return Response.json({ answers }, { headers: { "cache-control": "private, no-store" } });
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
      let authorized = await authorization.json() === true;
      // Older deployed database functions do not yet recognize the new
      // questionImageAssetId field. Authenticate the player through the
      // existing room-state RPC and allow only the current question's image.
      if (!authorized && playerToken) {
        const roomStateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_live_room_state`, { method: "POST", headers, body: JSON.stringify({ p_room_code: roomCode, p_player_token: playerToken }) });
        if (roomStateResponse.ok) {
          const roomState = await roomStateResponse.json();
          authorized = roomState?.state?.question?.questionImageAssetId === assetId;
        }
      }
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

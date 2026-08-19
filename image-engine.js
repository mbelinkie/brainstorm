// Pure adapters for AI image-generation providers used by Prompt Battle.
// No fetching and no side effects here — cloudflare-worker.js owns every
// network call and every trust boundary. This module only knows how to
// resolve credentials, build a request, and read a provider's response
// shape, so it can be exercised entirely from recorded fixtures per
// CLAUDE.md's "no live external calls in tests" rule.
//
// See docs/superpowers/specs/2026-08-17-prompt-battle-design.md §7.3-7.4.

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

export const ENGINES = {
  openrouter: {
    // Deliberately async and cacheable, even though OpenRouter's credential
    // is a static bearer token today. Vertex's credential is a token
    // *lifecycle* (RS256 JWT exchange, ~55 minute TTL) and must fit this
    // same seam without changing the adapter interface — see §7.3.
    async resolveAuth(env) {
      const apiKey = env?.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
      return { headers: { Authorization: `Bearer ${apiKey}` } };
    },

    endpoint() {
      return OPENROUTER_IMAGES_URL;
    },

    buildRequest({ model, prompt, variants, resolution, outputFormat }) {
      // OpenRouter docs note some single-image providers reject n > 1; the
      // host test button (§7.5) is how that gets verified per model before
      // an event, not this module.
      const n = Math.min(10, Math.max(1, Number(variants) || 1));
      const size = Number(resolution) || 512;
      return {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          n,
          resolution: `${size}x${size}`,
          aspect_ratio: "1:1",
          output_format: outputFormat || "webp",
          output_compression: 80
        })
      };
    },

    // Assumes providerResponse.ok was already true — HTTP-level failures
    // are the Worker's concern and never reach this function. OpenRouter's
    // exact moderation/safety-block shape isn't nailed down by the design
    // doc, so this treats a top-level `error` whose code/type/message
    // mentions safety or policy as a block rather than a hard failure.
    // Revisit against real API responses before this ships to a live event.
    parseResponse(json) {
      const blockReason = openRouterBlockReason(json);
      if (blockReason) {
        return { images: [], costUsd: numericCost(json), blocked: true, blockReason };
      }
      const data = Array.isArray(json?.data) ? json.data : [];
      const images = data
        .filter((entry) => entry && typeof entry.b64_json === "string")
        .map((entry) => ({ mimeType: entry.media_type || "image/webp", bytesBase64: entry.b64_json }));
      return { images, costUsd: numericCost(json), blocked: false, blockReason: null };
    }
  },

  // Vertex AI is the target provider (§7.4) but is out of scope for this
  // slice. Stubbed with the same method shape — rather than omitted — so
  // ENGINES.vertex exists for callers to detect "not implemented yet"
  // cleanly instead of a missing-key error, and so adding it later is a
  // drop-in rather than a re-cut of this interface.
  //
  // When it is built: resolveAuth must sign an RS256 JWT with
  // crypto.subtle, exchange it at oauth2.googleapis.com/token, and cache
  // the access token for ~55 minutes. Vertex has no cost field in its
  // response, so parseResponse's costUsd will need a maintained per-model
  // price table maintained alongside this adapter.
  vertex: {
    async resolveAuth() {
      throw new Error("Vertex adapter is not implemented yet.");
    },
    endpoint() {
      throw new Error("Vertex adapter is not implemented yet.");
    },
    buildRequest() {
      throw new Error("Vertex adapter is not implemented yet.");
    },
    parseResponse() {
      throw new Error("Vertex adapter is not implemented yet.");
    }
  }
};

function numericCost(json) {
  const cost = Number(json?.usage?.cost);
  return Number.isFinite(cost) ? cost : 0;
}

function openRouterBlockReason(json) {
  const err = json?.error;
  if (!err) return null;
  const signal = `${err.code || ""} ${err.type || ""} ${err.message || ""}`.toLowerCase();
  if (/safety|moderat|policy|blocked|flagged/.test(signal)) {
    return String(err.message || "This request was blocked by the provider's safety filter.").slice(0, 300);
  }
  return null;
}

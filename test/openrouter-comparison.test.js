import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS, PROMPTS, checkKey, requestProfile, renderHtml, runComparison, totals } from "../tools/openrouter-comparison.mjs";

// One offline check of the paid-call boundary; every HTTP response is synthetic.
test("comparison preserves costs, limits retries, stops unknown/budget outcomes, and decodes rasters", async () => {
  const launcher = await readFile(new URL("../scripts/setup-openrouter-comparison.command", import.meta.url), "utf8");
  const instructions = launcher.split("\n").filter((line) => /^(stage|step|say|note) /.test(line)).join("\n");
  const displayed = execFileSync("/bin/bash", ["-uc", `stage() { printf '%s\\n' "$1"; }; step() { stage "$1"; }; say() { stage "$1"; }; note() { stage "$1"; }; ${instructions}`], { encoding: "utf8" });
  assert.match(displayed, /dedicated \$5 test key/);
  assert.match(displayed, /\$20 balance.*\$5 limit/);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const endpoint = { provider_tag: "openai", supported_parameters: { aspect_ratio: { values: ["1:1"] }, quality: { values: ["high"] }, n: { min: 1, max: 10 } } };
  const request = requestProfile(MODELS[0], endpoint);
  assert.equal(request.quality, "high");
  assert.equal(request.resolution, undefined);
  assert.equal(request.provider.allow_fallbacks, false);
  assert.throws(() => requestProfile(MODELS[0], { ...endpoint, supported_parameters: {} }));
  assert.throws(() => checkKey({ limit: 20, limit_remaining: 20, limit_reset: null, usage: 0 }));
  assert.throws(() => checkKey({ limit: 5, limit_remaining: 5, usage: 0 }));
  assert.deepEqual(totals([{ costUsd: 0.125 }, { costUsd: null }, { costUsd: 0 }]), { costUsd: 0.125, unknown: 1, requests: 3, images: 0 });
  const metadata = { retrievedAt: "synthetic fixture", models: [{ model: MODELS[0], request }] };
  const good = (cost = 0.125) => Response.json({ data: [{ b64_json: png, media_type: "image/png" }], usage: { cost } });
  const failed = (status = 502) => Response.json({ error: { code: "server_error", message: "sk-or-synthetic-fixture must never be stored" } }, { status });
  const directory = await mkdtemp(join(tmpdir(), "openrouter-comparison-"));
  const exercise = async (name, reply, remaining = 5) => {
    let calls = 0;
    const out = join(directory, name);
    const fetcher = async (url) => url.endsWith("/key")
      ? Response.json({ data: { limit: 5, limit_reset: null, limit_remaining: remaining, usage: 5 - remaining, label: "private key label" } })
      : reply(++calls);
    const config = { key: "sk-or-synthetic-fixture", out, metadata, fetcher, wait: async () => {}, progress: () => {}, ...(process.platform !== "darwin" ? { verify: async (_file, bytes) => { assert.equal(bytes.toString("base64"), png); return { mimeType: "image/png", width: 1, height: 1 }; } } : {}) };
    const result = await runComparison(config);
    const ledger = JSON.parse(await readFile(join(out, "ledger.json"), "utf8"));
    const html = await readFile(join(out, "index.html"), "utf8");
    assert.ok(!JSON.stringify(ledger).includes(config.key));
    assert.ok(!html.includes(config.key));
    return { result, ledger, html, calls, config };
  };
  try {
    const recovered = await exercise("recovered", (i) => i <= 2 ? failed() : good());
    assert.equal(recovered.calls, 5);
    assert.equal(recovered.result.costUsd, 0.375);
    assert.equal(recovered.result.images, 3);
    assert.equal(recovered.ledger[2].image.width, 1);
    assert.equal(recovered.ledger[2].image.height, 1);
    assert.match(recovered.html, /1 × 1/);
    assert.match(recovered.html, /5 provider requests/);
    assert.equal((recovered.html.match(/<img /g) || []).length, 3);
    const repeats = await runComparison(recovered.config);
    assert.equal(repeats.requests, 5); // No reroll on a second run.
    const exhausted = await exercise("retry-limit", () => failed());
    assert.equal(exhausted.calls, 9); // Three initial cells, each capped at two retries.
    assert.equal(exhausted.result.costUsd, 0);
    const invalid = await exercise("invalid-request", () => failed(400));
    assert.equal(invalid.calls, 3);
    const missingCost = await exercise("missing-cost", () => Response.json({ data: [{ b64_json: png }] }));
    assert.equal(missingCost.calls, 1);
    assert.equal(missingCost.result.unknown, 1);
    assert.equal(missingCost.result.images, 1);
    assert.match(missingCost.html, /Cost unknown/);
    await runComparison({ ...missingCost.config, fetcher: async () => assert.fail("Unknown ledger must prevent any paid request") });
    const network = await exercise("network", () => { throw new Error("private transport diagnostics"); });
    assert.equal(network.calls, 1);
    assert.equal(network.result.unknown, 1);
    const malformed = await exercise("malformed", () => new Response("upstream gateway page", { status: 502 }));
    assert.equal(malformed.result.unknown, 1);
    const badImage = await exercise("invalid-image", () => Response.json({ data: [{ b64_json: "PHN2Zz48L3N2Zz4=", media_type: "image/svg+xml" }], usage: { cost: 0.2 } }));
    assert.equal(badImage.calls, 3);
    assert.ok(Math.abs(badImage.result.costUsd - 0.6) < 1e-9);
    assert.equal(badImage.result.images, 0);
    const budget = await exercise("budget", () => assert.fail("No paid request after exhausted key"), 0);
    assert.equal(budget.calls, 0);
    const totalLimit = await exercise("ledger-budget", () => good(5));
    assert.equal(totalLimit.calls, 1);
    assert.equal(totalLimit.result.costUsd, 5);
    const credits = await exercise("credits", () => failed(402));
    assert.equal(credits.calls, 1);
    assert.match(credits.result.stopped, /credits/);
    await exercise("secret-code", () => Response.json({ error: { code: "sk-or-synthetic-fixture" } }, { status: 400 }));
    assert.match(renderHtml({ ...metadata, models: [{ model: "<script>bad</script>", unavailable: "Not compatible" }] }), /&lt;script&gt;/);
    const ordered = renderHtml({ ...metadata, models: ["expensive", "failed", "cheap"].map((model) => ({ model })) }, [
      { model: "expensive", promptId: "faces", costUsd: 0.2, image: {} },
      { model: "failed", promptId: "faces", costUsd: 0 },
      { model: "cheap", promptId: "faces", costUsd: 0.01, image: {} },
    ]);
    assert.ok(ordered.indexOf('scope="row">cheap') < ordered.indexOf('scope="row">expensive'));
    assert.ok(ordered.indexOf('scope="row">expensive') < ordered.indexOf('scope="row">failed'));
    assert.equal(PROMPTS.length * MODELS.length, 30);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

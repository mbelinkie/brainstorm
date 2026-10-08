// Local, sequential paid probe. No production API, browser key, or new dependency.
import { readFile, writeFile, mkdir, rename, rm, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(ROOT, ".local/openrouter-comparison");
export const BUDGET = 5;
const API = "https://openrouter.ai/api/v1";
export const MODELS = [
  "openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare",
  "google/gemini-nano-banana-2.1", "google/gemini-3.1-flash-image", "google/gemini-3-pro-image",
  "bytedance-seed/seedream-5-0-pro", "black-forest-labs/flux-3-image",
  "qwen/qwen-image-3-pro", "x-ai/grok-imagine-image-quality", "sourceful/riverflow-v2.5-pro"
];
export const PROMPTS = [
  { id: "faces", title: "Faces", text: "Photorealistic office award ceremony. Three adults stand shoulder to shoulder: on the left, a red-haired woman laughs with her eyes closed; in the center, a bald man with round glasses looks shocked while holding a tiny gold trophy; on the right, an older Black woman gives him a skeptical side-eye. Natural faces, clearly different expressions, realistic hands, waist-up framing. No text." },
  { id: "text", title: "Text", text: "A cheerful illustrated poster for the world’s worst office party. Large headline exactly: ‘MANDATORY FUN’. Under it exactly: ‘FRIDAY • 5 PM’. Three clearly readable lines: ‘Cold pizza’, ‘Awkward karaoke’, ‘One sad balloon’. Bottom line exactly: ‘Attendance is technically optional.’ Include a drooping balloon and a slice of pizza." },
  { id: "action", title: "Action", text: "A lively cartoon of a disastrous office picnic. A corgi wearing a tiny red cape leaps from the left to catch a flying sandwich in midair. On the right, a startled man in a blue shirt drops a plate. Behind him, a woman in a yellow raincoat catches a tipping lemonade pitcher. Exactly one corgi and two people. Clear action, readable poses, no text." }
];
const finiteCost = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const dollars = (value) => finiteCost(value) ? `$${value.toFixed(6)}` : "Cost unknown";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function totals(ledger) {
  return { costUsd: ledger.reduce((sum, row) => sum + (finiteCost(row.costUsd) ? row.costUsd : 0), 0), unknown: ledger.filter((row) => !finiteCost(row.costUsd)).length, requests: ledger.length, images: ledger.filter((row) => row.image).length };
}

export function checkKey(data) {
  if (!data || !finiteCost(data.limit) || data.limit <= 0 || data.limit > BUDGET || data.limit_reset !== null || !finiteCost(data.limit_remaining) || data.limit_remaining > data.limit || !finiteCost(data.usage) || data.is_management_key === true || data.is_provisioning_key === true) {
    throw new Error("Use a dedicated generation key with a limit of $5 or less, no reset, and readable remaining usage.");
  }
  // Intentionally omit label/hash/account identity from the receipt.
  return { limit: data.limit, remaining: data.limit_remaining, usage: data.usage, checkedAt: new Date().toISOString() };
}

export function requestProfile(model, endpoint) {
  const params = endpoint.supported_parameters || {};
  const accepts = (key, value) => params[key]?.values?.includes(value);
  if (!accepts("aspect_ratio", "1:1") || !endpoint.provider_tag || !params.n || params.n.min > 1 || params.n.max < 1 || params.input_references?.min > 0) throw new Error("No square text-to-image endpoint.");
  const body = { model, n: 1, aspect_ratio: "1:1", provider: { only: [endpoint.provider_tag], allow_fallbacks: false } };
  if (accepts("resolution", "1K")) body.resolution = "1K";
  if (model.startsWith("openai/")) {
    if (!accepts("quality", "high")) throw new Error("Required high quality unavailable.");
    body.quality = "high";
  }
  if (accepts("output_format", "png")) body.output_format = "png";
  return body;
}

async function jsonGet(url, fetcher, key) {
  const response = await fetcher(url, { ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Metadata request failed (${response.status}).`);
  return response.json();
}

async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function prepare(out = OUTPUT, fetcher = fetch) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const catalogue = await jsonGet(`${API}/images/models`, fetcher);
  if (!Array.isArray(catalogue.data)) throw new Error("Invalid image catalogue.");
  const retrievedAt = new Date().toISOString();
  const metadata = { retrievedAt, source: `${API}/images/models`, catalogue: catalogue.data.map(({ id, architecture, supported_parameters, endpoints }) => ({ id, architecture, supported_parameters, endpoints })), models: [] };
  const endpoints = await Promise.allSettled(MODELS.map((model) => jsonGet(`${API}/images/models/${model}/endpoints`, fetcher)));
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const entry = { model, source: `${API}/images/models/${model}/endpoints`, endpoints: [] };
    if (endpoints[i].status === "fulfilled") entry.endpoints = endpoints[i].value.endpoints || [];
    const catalogEntry = catalogue.data.find((item) => item.id === model);
    if (catalogEntry?.architecture?.input_modalities?.includes("text") && catalogEntry?.architecture?.output_modalities?.includes("image")) {
      // Prefer AI Studio for Google's models; pin one endpoint for comparison fairness.
      const ordered = [...entry.endpoints].sort((a, b) => Number(b.provider_tag === "google-ai-studio") - Number(a.provider_tag === "google-ai-studio"));
      for (const endpoint of ordered) {
        try { entry.request = requestProfile(model, endpoint); break; } catch { /* Try another documented endpoint. */ }
      }
    }
    if (!entry.request) entry.unavailable = "No currently compatible endpoint; no generation will be sent.";
    metadata.models.push(entry);
  }
  await saveJson(join(out, "metadata.json"), metadata);
  await render(out, metadata);
  return metadata;
}

export async function verifyRaster(file, bytes) {
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
  if (!mimeType) throw new Error("Unsupported raster signature.");
  // Native macOS decoding avoids adding an image library or a handwritten parser.
  const decoded = `${file}.decoded.png`;
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", "png", file, "--out", decoded], { stdio: "pipe" });
    const details = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", decoded], { encoding: "utf8" });
    const width = Number(details.match(/pixelWidth:\s+(\d+)/)?.[1]);
    const height = Number(details.match(/pixelHeight:\s+(\d+)/)?.[1]);
    if (!width || !height) throw new Error("Raster did not decode.");
    return { mimeType, width, height };
  } finally { await rm(decoded, { force: true }); }
}

function responseReceipt(body) {
  // Preserve useful response metadata by allowlist; never store raw diagnostics or base64 in JSON.
  const usage = {};
  for (const key of ["cost", "prompt_tokens", "completion_tokens", "total_tokens"]) if (finiteCost(body?.usage?.[key])) usage[key] = body.usage[key];
  const code = body?.error?.code;
  return { usage, ...(typeof code === "number" || (typeof code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(code) && !code.startsWith("sk-or-")) ? { errorCode: code } : {}), imageCount: Array.isArray(body?.data) ? body.data.length : 0 };
}

export function renderHtml(metadata, ledger = [], stopped = "") {
  const summary = totals(ledger);
  const price = (model) => { const total = totals(ledger.filter((row) => row.model === model)); return total.images && !total.unknown ? total.costUsd / total.images : Infinity; };
  const rows = [...metadata.models].sort((a, b) => price(a.model) - price(b.model)).map((entry) => `<tr><th scope="row">${escapeHtml(entry.model)}<small>${escapeHtml(entry.request?.provider.only[0] || "Unavailable")}</small></th>${PROMPTS.map((prompt) => {
    const requests = ledger.filter((row) => row.model === entry.model && row.promptId === prompt.id);
    const row = requests.find((item) => item.image) || requests.at(-1);
    const elapsed = requests.reduce((sum, item) => sum + (item.latencyMs || 0), 0);
    const cost = requests.every((item) => finiteCost(item.costUsd)) ? requests.reduce((sum, item) => sum + item.costUsd, 0) : null;
    const image = row?.image;
    const content = image ? `<a href="${escapeHtml(image.file)}" target="_blank" rel="noopener"><img src="${escapeHtml(image.file)}" alt="${escapeHtml(prompt.title)} from ${escapeHtml(entry.model)}" loading="lazy"></a>` : `<div class="placeholder">${escapeHtml(entry.unavailable || row?.outcome || (stopped ? "Not run — comparison stopped" : "Not run yet"))}</div>`;
    return `<td>${content}${row ? `<p>${dollars(cost)} · ${(elapsed / 1000).toFixed(1)}s${elapsed > 60000 ? ' <strong class="slow">Over 60s</strong>' : ""}<br>${image ? `${image.width} × ${image.height} · ${escapeHtml(image.mimeType)}<br>` : ""}${requests.length} request${requests.length === 1 ? "" : "s"} · ${escapeHtml(row.outcome)}</p>` : ""}</td>`;
  }).join("")}</tr>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prompt Battle model comparison</title><style>body{font:16px system-ui,sans-serif;background:#f5f3ee;color:#182426;margin:0;padding:24px}main{max-width:1500px;margin:auto}h1{margin-bottom:8px}p{line-height:1.5}small{display:block;color:#526362;margin-top:8px;overflow-wrap:anywhere}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;background:white;table-layout:fixed;min-width:850px}th,td{border:1px solid #d4dcd7;padding:14px;vertical-align:top}th:first-child{width:190px;overflow-wrap:anywhere}thead th{position:sticky;top:0;background:#e3eee7}img{width:100%;aspect-ratio:1;object-fit:contain;background:#eff2ef}.placeholder{display:grid;place-items:center;aspect-ratio:1;background:#eff2ef;color:#526362;text-align:center}td p{font-size:13px;margin-bottom:0}.slow{color:#a33d13}.notice{padding:12px;background:#fff2d8;border-radius:8px}details{margin:12px 0}summary{cursor:pointer;font-weight:600}code{overflow-wrap:anywhere}</style><main><h1>Prompt Battle model comparison</h1><p>Faces, lettering, and action. Click any image for its original. Choose for prompt-following and fun first.</p><p>${summary.images}/30 images · ${summary.requests} provider requests · reported spend ${dollars(summary.costUsd)}${summary.unknown ? ` + ${summary.unknown} unresolved charge(s)` : ""} · $5 test-key limit</p>${stopped ? `<p class="notice">${escapeHtml(stopped)}</p>` : ""}<p><small>Metadata retrieved ${escapeHtml(metadata.retrievedAt)}. One result per prompt is a comparison sample, not a reliable failure-rate measurement. Originals are unchanged; size differences are shown.</small></p>${PROMPTS.map((prompt) => `<details><summary>${prompt.title} prompt</summary><p>${escapeHtml(prompt.text)}</p></details>`).join("")}<div class="scroll"><table><thead><tr><th scope="col">Model</th>${PROMPTS.map((prompt) => `<th scope="col">${prompt.title}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></main></html>`;
}

async function loadLedger(out) {
  try { return JSON.parse(await readFile(join(out, "ledger.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function render(out = OUTPUT, metadata) {
  metadata ||= JSON.parse(await readFile(join(out, "metadata.json"), "utf8"));
  const ledger = await loadLedger(out);
  let stopped = "";
  try { stopped = JSON.parse(await readFile(join(out, "status.json"), "utf8")).message; } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(join(out, "index.html"), renderHtml(metadata, ledger, stopped), { mode: 0o600 });
}

export async function runComparison({ key, out = OUTPUT, fetcher = fetch, wait = sleep, metadata, verify = verifyRaster, progress = console.log } = {}) {
  if (typeof key !== "string" || !/^sk-or-[A-Za-z0-9_-]+$/.test(key)) throw new Error("Supply OPENROUTER_API_KEY locally using scripts/setup-openrouter-comparison.command.");
  if (verify === verifyRaster) await access("/usr/bin/sips");
  metadata ||= await prepare(out, fetcher);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const ledger = await loadLedger(out);
  const save = async () => { await saveJson(join(out, "ledger.json"), ledger); await render(out, metadata); };
  const stop = async (message) => { await saveJson(join(out, "status.json"), { message, at: new Date().toISOString() }); await save(); return { stopped: message, ...totals(ledger) }; };
  if (totals(ledger).unknown) return stop("Stopped: unresolved billing in the existing ledger. Reconcile it before sending another paid request.");
  await saveJson(join(out, "status.json"), { message: "", at: new Date().toISOString() });
  for (const entry of metadata.models) {
    if (!entry.request) continue;
    for (const prompt of PROMPTS) {
      const prior = ledger.filter((row) => row.model === entry.model && row.promptId === prompt.id);
      if (prior.some((row) => row.image) || (prior.length && !prior.at(-1).retryable) || prior.length >= 3) continue;
      for (let attempt = prior.length; attempt < 3; attempt++) {
        let balance;
        try { balance = checkKey((await jsonGet(`${API}/key`, fetcher, key)).data); }
        catch { return stop("Stopped: cannot verify a dedicated $5 key with no reset and readable remaining usage."); }
        await saveJson(join(out, "key-limit.json"), balance);
        if (balance.remaining <= 0 || totals(ledger).costUsd >= BUDGET) return stop("Stopped: test budget exhausted.");
        const body = { ...entry.request, prompt: prompt.text };
        const row = { requestId: ledger.length + 1, model: entry.model, promptId: prompt.id, attempt: attempt + 1, startedAt: new Date().toISOString(), request: body, outcome: "pending", costUsd: null, latencyMs: null, retryable: false };
        // A crash after dispatch remains an unknown charge on restart, never a free retry.
        ledger.push(row);
        await save();
        progress(`${entry.model} / ${prompt.title} / request ${attempt + 1}`);
        const start = Date.now();
        let response, result;
        try {
          response = await fetcher(`${API}/images`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
          const raw = await response.text();
          if (raw.length > 80 * 1024 * 1024) throw new Error("Response too large.");
          result = JSON.parse(raw);
        } catch {
          row.latencyMs = Date.now() - start;
          row.outcome = "Unknown billing: transport, timeout, or unreadable response";
          return stop("Stopped: a request has unknown billing. Its pending charge is retained; no automatic retry was sent.");
        }
        row.latencyMs = Date.now() - start;
        row.status = response.status;
        row.response = responseReceipt(result);
        if (!response.ok) {
          const confirmed = result?.error && typeof result.error === "object" && !Array.isArray(result.error) && !row.response.imageCount && (!finiteCost(result?.usage?.cost) || result.usage.cost === 0);
          row.costUsd = confirmed ? 0 : null;
          row.outcome = confirmed ? `Provider error (${response.status})` : "Unknown billing: unrecognized provider error";
          row.retryable = confirmed && !["refusal", "content_policy_violation"].includes(row.response.errorCode) && (response.status === 429 || response.status >= 500);
          await save();
          if (!confirmed) return stop("Stopped: unrecognized error/billing outcome.");
          if ([401, 402, 403].includes(response.status)) return stop("Stopped: credentials, credits, or provider/key restrictions need attention.");
          if (!row.retryable || attempt === 2) break;
          const retryAfter = response.headers.get("retry-after");
          const requestedDelay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
          if (requestedDelay > 60000) { row.retryable = false; await save(); break; }
          await wait(Math.max(Number.isFinite(requestedDelay) ? requestedDelay : 0, attempt === 0 ? 1000 : 3000));
          continue;
        }
        row.costUsd = finiteCost(result?.usage?.cost) ? result.usage.cost : null;
        row.outcome = "No usable raster returned";
        const image = result?.data?.[0];
        if (typeof image?.b64_json === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json) && image.b64_json.length <= 35 * 1024 * 1024) {
          const bytes = Buffer.from(image.b64_json, "base64");
          const fileName = `${MODELS.indexOf(entry.model) + 1}-${prompt.id}-${attempt + 1}.image`;
          const file = join(out, fileName);
          await writeFile(file, bytes, { mode: 0o600 });
          try {
            const dimensions = await verify(file, bytes);
            if (image.media_type && image.media_type !== dimensions.mimeType) throw new Error("MIME mismatch.");
            const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[dimensions.mimeType];
            const saved = fileName.replace(/\.image$/, `.${extension}`);
            await rename(file, join(out, saved));
            row.image = { file: saved, ...dimensions, bytes: bytes.length };
            row.outcome = row.costUsd === null ? "Image returned; cost unknown" : "Success";
          } catch { await rm(file, { force: true }); row.outcome = "Invalid or unsupported raster returned"; }
        }
        await save();
        if (row.costUsd === null) return stop("Stopped: successful response has no finite reported cost. The image, if usable, is preserved.");
        break; // First successful response is final, even if its picture is disappointing.
      }
    }
  }
  return stop("Comparison finished. Review the images and choose the approved models and default.");
}

async function main() {
  const mode = process.argv[2];
  if (!["--prepare", "--run", "--render"].includes(mode) || process.argv.length > 3) throw new Error("Usage: node tools/openrouter-comparison.mjs --prepare | --run | --render");
  if (mode === "--prepare") { const metadata = await prepare(); console.log(`Prepared ${metadata.models.filter((row) => row.request).length}/10 models; no paid calls.`); }
  else if (mode === "--render") await render();
  else {
    let key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      try { key = (await readFile(join(ROOT, ".env.openrouter-comparison.local"), "utf8")).match(/^OPENROUTER_API_KEY=([^\r\n]+)$/m)?.[1]; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const result = await runComparison({ key: key?.trim() });
    console.log(`${result.stopped} ${result.images} images; reported spend ${dollars(result.costUsd)}; ${result.unknown} unknown charge(s).`);
  }
  console.log(`Grid: ${join(OUTPUT, "index.html")}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Comparison could not complete. Check local setup and the preserved ledger; no raw provider diagnostics or key are printed."); process.exitCode = 1; });

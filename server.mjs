import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env.local");
const fileEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => line.split(/=(.*)/s)).filter(([key]) => key && !key.startsWith("#")))
  : {};
const env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "DEFAULT_QUIZ_VERSION_ID", "WORKER_ORIGIN", "PORT"].includes(key))) };
const port = Number(env.PORT || 4173);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  const requestPath = new URL(request.url, "http://localhost").pathname;
  if (requestPath === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (requestPath === "/config.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(`window.QUIZ_PLATFORM_CONFIG=${JSON.stringify({ supabaseUrl: env.SUPABASE_URL || "", supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || "", defaultQuizVersionId: env.DEFAULT_QUIZ_VERSION_ID || "", workerOrigin: env.WORKER_ORIGIN || "https://wild-haze-73b3.matthew-belinkie-3af.workers.dev" })};`);
    return;
  }
  if (requestPath === "/media-assistant/search" && request.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const workerOrigin = env.WORKER_ORIGIN || "https://wild-haze-73b3.matthew-belinkie-3af.workers.dev";
      const upstream = await fetch(`${workerOrigin}/media-assistant/search`, { method: "POST", headers: { "content-type": request.headers["content-type"] || "application/json", authorization: request.headers.authorization || "" }, body: Buffer.concat(chunks) });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: `Image assistant proxy failed: ${error.message}` }));
    }
    return;
  }
  const safePath = normalize(requestPath === "/" ? "/index.html" : requestPath).replace(/^[/\\]+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log(`Quiz Control running on port ${port}`);
});

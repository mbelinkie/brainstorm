// The one real GitHub transport: it shells out to the authenticated `gh` CLI.
//
// This is the ONLY file under scripts/ allowed to start `gh` (see
// bypass-check.mjs and docs/roadmap/transport-inventory.md). It never receives,
// prints, logs or stores a token: `gh` reads its own stored credential, and
// anything token-shaped is scrubbed from error text before it leaves here.
//
// `gh api --include` prints "HTTP/x.y STATUS", the response headers, a blank
// line, then the body. Headers are the whole point: they carry the rate-limit
// evidence the gate needs.

import { spawnSync } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024;
// GitHub token shapes: gho_/ghp_/ghs_/ghu_/ghr_ and fine-grained github_pat_.
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function scrub(text) {
  return String(text ?? "").replace(TOKEN_SHAPE, "[redacted]").slice(0, 500);
}

export function parseIncludeOutput(stdout) {
  const text = String(stdout ?? "");
  const statusLine = /^HTTP\/[\d.]+\s+(\d{3})/.exec(text);
  if (!statusLine) return null;
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const bodyText = split === -1 ? "" : text.slice(split).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = null;
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { _unparsed: true };
    }
  }
  return { status: Number(statusLine[1]), headers, body };
}

export function buildGhInvocation(request) {
  if (request.kind === "graphql") {
    // The query travels on stdin as JSON, so no shell quoting or typing issues.
    return {
      args: ["api", "graphql", "--include", "--input", "-"],
      input: JSON.stringify({ query: request.query, variables: request.variables ?? {} }),
    };
  }
  if (request.kind === "rest") {
    const args = ["api", String(request.path).replace(/^\//, ""), "--include", "-X", request.method ?? "GET"];
    if (request.body !== undefined) {
      args.push("--input", "-");
      return { args, input: JSON.stringify(request.body) };
    }
    return { args, input: undefined };
  }
  throw new TypeError(`unknown request kind: ${request.kind}`);
}

export function createGhTransport({ spawn = spawnSync, command = "gh" } = {}) {
  return {
    request(request) {
      const { args, input } = buildGhInvocation(request);
      const result = spawn(command, args, { input, encoding: "utf8", maxBuffer: MAX_BUFFER });
      if (result.error) {
        return { status: 0, headers: {}, body: null, error: scrub(result.error.message) };
      }
      // gh exits non-zero for HTTP 4xx/5xx but still prints status, headers and body.
      const parsed = parseIncludeOutput(result.stdout);
      if (parsed) return parsed;
      return { status: 0, headers: {}, body: null, error: scrub(result.stderr || "gh produced no HTTP response") };
    },
  };
}

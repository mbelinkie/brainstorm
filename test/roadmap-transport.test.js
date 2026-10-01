import test from "node:test";
import assert from "node:assert/strict";
import { buildGhInvocation, createGhTransport, parseIncludeOutput, scrub } from "../scripts/roadmap/github-transport.mjs";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createBudget } from "../scripts/roadmap/rate-limit.mjs";

// The real transport is driven ONLY through an injected fake `spawn`; no test
// here starts `gh` or reaches GitHub.

const T0 = Date.parse("2026-10-01T00:00:00Z");
const crlf = (lines) => lines.join("\r\n");

test("gh --include output is split into status, lowercased headers and a JSON body", () => {
  const out = crlf([
    "HTTP/2.0 200 OK",
    "X-Ratelimit-Remaining: 4990",
    "X-RateLimit-Resource: graphql",
    "Content-Type: application/json; charset=utf-8",
    "",
    '{"data":{"viewer":{"login":"x"}}}',
  ]);
  const parsed = parseIncludeOutput(out);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers["x-ratelimit-remaining"], "4990");
  assert.equal(parsed.headers["x-ratelimit-resource"], "graphql");
  assert.equal(parsed.body.data.viewer.login, "x");
});

test("an HTTP error response keeps its status, Retry-After header and body", () => {
  const out = crlf(["HTTP/2.0 403 Forbidden", "Retry-After: 60", "", '{"message":"You have exceeded a secondary rate limit"}']);
  const parsed = parseIncludeOutput(out);
  assert.equal(parsed.status, 403);
  assert.equal(parsed.headers["retry-after"], "60");
  assert.match(parsed.body.message, /secondary/);
});

test("an unparseable body is flagged, and output without an HTTP line is not a response", () => {
  assert.equal(parseIncludeOutput(crlf(["HTTP/2.0 200 OK", "", "<html>oops"])).body._unparsed, true);
  assert.equal(parseIncludeOutput("gh: command not found"), null);
  assert.equal(parseIncludeOutput(""), null);
});

test("graphql requests send the query on stdin as JSON with no token anywhere in the arguments", () => {
  const { args, input } = buildGhInvocation({ kind: "graphql", query: "query Q { viewer { login } }", variables: { n: 1 } });
  assert.deepEqual(args, ["api", "graphql", "--include", "--input", "-"]);
  assert.deepEqual(JSON.parse(input), { query: "query Q { viewer { login } }", variables: { n: 1 } });
  assert.doesNotMatch(args.join(" "), /token|ghp_|authorization/i);
});

test("rest requests strip the leading slash, carry the method, and send bodies on stdin", () => {
  const get = buildGhInvocation({ kind: "rest", method: "GET", path: "/rate_limit" });
  assert.deepEqual(get.args, ["api", "rate_limit", "--include", "-X", "GET"]);
  assert.equal(get.input, undefined);
  const post = buildGhInvocation({ kind: "rest", method: "POST", path: "/repos/o/r/issues", body: { title: "t" } });
  assert.deepEqual(post.args, ["api", "repos/o/r/issues", "--include", "-X", "POST", "--input", "-"]);
  assert.deepEqual(JSON.parse(post.input), { title: "t" });
  assert.throws(() => buildGhInvocation({ kind: "carrier-pigeon" }), TypeError);
});

test("gh exiting non-zero on an HTTP error still yields the parsed response", () => {
  const spawn = () => ({ status: 1, stdout: crlf(["HTTP/2.0 502 Bad Gateway", "", ""]), stderr: "gh: HTTP 502" });
  const response = createGhTransport({ spawn }).request({ kind: "graphql", query: "query Q { a }" });
  assert.equal(response.status, 502);
});

test("a failure to start gh, or no HTTP output, is status 0 with scrubbed text", () => {
  const token = "ghp_" + "A".repeat(36);
  const failed = createGhTransport({ spawn: () => ({ error: new Error(`spawn gh ENOENT ${token}`) }) })
    .request({ kind: "graphql", query: "query Q { a }" });
  assert.equal(failed.status, 0);
  assert.doesNotMatch(failed.error, /ghp_/);
  const silent = createGhTransport({ spawn: () => ({ status: 4, stdout: "", stderr: `auth failed for ${token} github_pat_${"B".repeat(30)}` }) })
    .request({ kind: "graphql", query: "query Q { a }" });
  assert.equal(silent.status, 0);
  assert.doesNotMatch(silent.error, /ghp_|github_pat_/);
  assert.match(scrub(`x ${token} y`), /\[redacted\]/);
});

test("the real transport plugs into the gate: rate-limit headers and body feed the budget", async () => {
  const reset = (T0 + 3_600_000) / 1000;
  const responses = [
    // preflight
    crlf(["HTTP/2.0 200 OK", "X-Ratelimit-Resource: graphql", `X-Ratelimit-Reset: ${reset}`, "", JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4999, used: 1, resetAt: new Date(T0 + 3_600_000).toISOString(), cost: 1 } } })]),
    // the real read
    crlf(["HTTP/2.0 200 OK", "X-Ratelimit-Resource: graphql", "X-Ratelimit-Limit: 5000", "X-Ratelimit-Remaining: 4990", "X-Ratelimit-Used: 10", `X-Ratelimit-Reset: ${reset}`, "", JSON.stringify({ data: { viewer: { login: "mbelinkie" } } })]),
  ];
  const sent = [];
  const spawn = (_command, args, options) => { sent.push({ args, input: options.input }); return { status: 0, stdout: responses.shift(), stderr: "" }; };
  const budget = createBudget({ now: () => T0 });
  const gate = createGate({ transport: createGhTransport({ spawn }), budget, now: () => T0, lock: { acquire: () => ({ ok: true, release() {} }) } });
  const result = await gate.read({ query: "query Who { viewer { login } }" });
  assert.equal(result.ok, true);
  assert.equal(result.data.viewer.login, "mbelinkie");
  assert.equal(sent.length, 2);
  assert.equal(budget.snapshot().graphql.remaining, 4990, "the header on the real read updated the budget");
});

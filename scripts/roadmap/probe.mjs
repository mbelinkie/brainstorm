// Read-only diagnostic: asks GitHub for the current GraphQL and REST budgets
// THROUGH THE GATE and prints what the gate believes. Spends a few quota points.
// Usage: node scripts/roadmap/probe.mjs
//
// Prints no credentials. The only network traffic is the gate's own preflight.

import { createGate } from "./gate.mjs";
import { createGhTransport } from "./github-transport.mjs";

const logLines = [];
const gate = createGate({ transport: createGhTransport(), log: (entry) => logLines.push(entry) });

const graphql = await gate.read({ query: "query RoadmapProbe { viewer { login } }" });
const rest = await gate.rest({ method: "GET", path: "/rate_limit" });

const view = (result) => (result.ok
  ? { ok: true }
  : { ok: false, code: result.code, message: result.message, retryAt: result.retryAt });

console.log(JSON.stringify({
  graphql: view(graphql),
  graphqlRateLimit: graphql.rateLimit ?? null,
  rest: view(rest),
  budget: gate.budget.snapshot(),
  log: logLines,
}, null, 2));
process.exitCode = graphql.ok && rest.ok ? 0 : 1;

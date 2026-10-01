// Fake GitHub for the lifecycle wrapper tests: an in-memory world behind a fake
// transport. Nothing here calls GitHub. Recognises the wrapper's named operations.
import fs from "node:fs";
import { createGate } from "../../scripts/roadmap/gate.mjs";
import { createBudget } from "../../scripts/roadmap/rate-limit.mjs";
import { createLifecycle } from "../../scripts/roadmap/lifecycle.mjs";

export const root = new URL("../../", import.meta.url);
export const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));
export const T0 = Date.parse("2026-10-01T00:00:00Z");
export const SELF = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const VERIFIER = "44444444-4444-4444-8444-444444444444";
export const COMMIT = "cd15757cd7ffa0adadb91325a9613d99c9975f2d";
export const STATUS_OPTIONS = config.fields.Status.options;
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS_OPTIONS).map(([name, id]) => [id, name]));

export function contractBody({ acceptance = "Automated", deps = "Blocked by #4", baseline = "`main`, with #4 merged." } = {}) {
  const sections = {
    Outcome: "A tested wrapper.", Scope: "- CLI plus tests.", Exclusions: "- none.", Dependencies: deps,
    Acceptance: `${acceptance}\n- [ ] Tests prove it.`, Verification: "1. `npm test`.",
    "Boundaries and authorization": "Migrations: None.", "Starting baseline": baseline, "Routing and size rationale": "standard/high.",
  };
  return Object.entries(sections).map(([n, t]) => `## ${n}\n${t}`).join("\n\n");
}

export const doneItem = { id: "PVTI_done", projectNumber: 4, owner: "mbelinkie", status: "Done" };
export const completeComment = (n) => ({ id: `C_done_${n}`, body: `<!-- complete:v1 issue=${n} -->\nAccepted.`, createdAt: "2026-10-01T04:03:09Z" });

export function makeWorld(extra = {}) {
  return {
    repo: "mbelinkie/brainstorm",
    issues: {
      3: {
        id: "I_3", number: 3, state: "OPEN", title: "Work", body: contractBody(), labels: ["model:standard", "effort:high"],
        blockedBy: [{ number: 4, repo: "mbelinkie/brainstorm" }], comments: [],
        items: [{ id: "PVTI_3", projectNumber: 4, owner: "mbelinkie", status: "In progress", acceptance: "Automated" }],
      },
      4: { id: "I_4", number: 4, state: "CLOSED", title: "Dep", body: "x", labels: [], blockedBy: [], comments: [completeComment(4)], items: [{ ...doneItem }] },
    },
    other: {},
    compare: {}, // "<base>...<sha>" -> "identical" | "behind" | "ahead" | "diverged" | 404
    addCommentMode: "ok", statusFailures: [], closeFailures: [], dropStatusWrite: false, nextComment: 1,
    ...extra,
  };
}

const rl = () => ({ limit: 5000, remaining: 4000, used: 1000, resetAt: new Date(T0 + 3_600_000).toISOString(), cost: 1 });
const gqlOk = (data) => ({ status: 200, headers: {}, body: { data: { ...data, rateLimit: rl() } } });
const gqlHeaders = {
  "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "3990", "x-ratelimit-used": "1010",
  "x-ratelimit-reset": String((T0 + 3_600_000) / 1000), "x-ratelimit-resource": "graphql",
};
const mutOk = (data) => ({ status: 200, headers: gqlHeaders, body: { data } });
const restHeaders = { ...gqlHeaders, "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4900", "x-ratelimit-used": "100" };
const withAuthor = (c) => ({ ...c, author: c.author ?? { login: "mbelinkie" } });
const itemNodes = (issue) => issue.items.map((item) => ({
  id: item.id,
  project: { id: config.project.nodeId, number: item.projectNumber, owner: { login: item.owner } },
  status: item.status ? { name: item.status } : null,
  acceptance: item.acceptance ? { name: item.acceptance } : null,
}));

function issueNode(issue) {
  return {
    id: issue.id, number: issue.number, state: issue.state, title: issue.title, body: issue.body,
    labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
    blockedBy: { nodes: issue.blockedBy.map((b) => ({ number: b.number, state: "OPEN", repository: { nameWithOwner: b.repo } })), pageInfo: { hasNextPage: false } },
    comments: { nodes: issue.comments.map(withAuthor), pageInfo: { hasPreviousPage: false, hasNextPage: false } },
    projectItems: { nodes: itemNodes(issue), pageInfo: { hasNextPage: false } },
  };
}

export function makeTransport(world) {
  const calls = [];
  const mutations = () => calls.filter((c) => /\bmutation\b/.test(c.query ?? "") && !/RoadmapRateLimit/.test(c.query));
  const find = (id) => Object.values(world.issues).find((i) => i.id === id);
  return {
    calls, mutations,
    mutationNames: () => mutations().map((m) => /mutation\s+(\w+)/.exec(m.query)[1]),
    restPaths: () => calls.filter((c) => c.kind === "rest").map((c) => c.path),
    async request(request) {
      calls.push(request);
      if (request.kind === "rest") {
        if (request.path === "/rate_limit") {
          return { status: 200, headers: restHeaders, body: { resources: { core: { limit: 5000, remaining: 4900, used: 100, reset: (T0 + 3_600_000) / 1000 } } } };
        }
        const m = /\/compare\/(.+)$/.exec(request.path);
        const verdict = world.compare[decodeURIComponent(m[1])];
        if (verdict === 404 || verdict === undefined) return { status: 404, headers: restHeaders, body: { message: "Not Found" } };
        return { status: 200, headers: restHeaders, body: { status: verdict } };
      }
      const q = request.query ?? "";
      if (/RoadmapRateLimit/.test(q)) return gqlOk({});
      if (/query LifecycleIssue\b/.test(q)) {
        const { owner, name, number } = request.variables;
        const issue = `${owner}/${name}` === world.repo ? world.issues[number] : undefined;
        return gqlOk({ repository: { nameWithOwner: world.repo, ref: { target: { oid: COMMIT } }, issue: issue ? issueNode(issue) : null } });
      }
      if (/query LifecyclePrereqs\b/.test(q)) {
        const data = {};
        for (const m of q.matchAll(/(d\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issue\(number: (\d+)\)/g)) {
          const issue = `${m[2]}/${m[3]}` === world.repo ? world.issues[Number(m[4])] : world.other[`${m[2]}/${m[3]}#${m[4]}`];
          data[m[1]] = {
            issue: issue ? {
              number: issue.number, state: issue.state,
              projectItems: { nodes: itemNodes(issue), pageInfo: { hasNextPage: false } },
              comments: { nodes: issue.comments.map(withAuthor), pageInfo: { hasPreviousPage: false, hasNextPage: false } },
            } : null,
          };
        }
        return gqlOk(data);
      }
      if (/mutation LifecycleAddComment\b/.test(q)) {
        if (world.addCommentMode === "fail-before") return { status: 502, headers: {}, body: null };
        const issue = find(request.variables.id);
        const comment = { id: `C_${world.nextComment}`, body: request.variables.body, createdAt: new Date(T0).toISOString(), author: { login: "mbelinkie" } };
        world.nextComment += 1;
        issue.comments.push(comment);
        if (world.addCommentMode === "land-then-500") return { status: 502, headers: {}, body: null };
        return mutOk({ addComment: { commentEdge: { node: { id: comment.id, url: `https://example.test/${comment.id}` } } } });
      }
      if (/mutation LifecycleSetStatus\b/.test(q)) {
        const failure = world.statusFailures.shift();
        if (failure) return { status: failure, headers: {}, body: null };
        const { item, option } = request.variables;
        if (!world.dropStatusWrite) {
          for (const issue of Object.values(world.issues)) for (const it of issue.items) if (it.id === item) it.status = STATUS_NAME[option];
        }
        return mutOk({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item } } });
      }
      if (/mutation LifecycleCloseIssue\b/.test(q)) {
        const failure = world.closeFailures.shift();
        if (failure) return { status: failure, headers: {}, body: null };
        find(request.variables.id).state = "CLOSED";
        return mutOk({ closeIssue: { issue: { id: request.variables.id, state: "CLOSED" } } });
      }
      throw new Error(`fake transport: unexpected request ${q.slice(0, 80)}`);
    },
  };
}

export function setup({ world = makeWorld(), env = { CLAUDE_CODE_SESSION_ID: SELF }, lock } = {}) {
  const transport = makeTransport(world);
  let t = T0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const lockCalls = { acquired: 0, released: 0 };
  const defaultLock = { acquire: () => { lockCalls.acquired += 1; return { ok: true, release() { lockCalls.released += 1; } }; } };
  const gate = createGate({ transport, budget: createBudget({ now }), lock: lock ?? defaultLock, now, sleep });
  const lifecycle = createLifecycle({ gate, config, env, now });
  return { world, transport, gate, lifecycle, lockCalls };
}

export const claimComment = (executionId = SELF, n = 3, extra = {}) => ({
  id: "C_claim", createdAt: "2026-10-01T03:00:00Z",
  body: `<!-- claim:v1 issue=${n} -->\n**Claim**\n\n- Execution ID: \`${executionId}\`\n`, ...extra,
});
export const reviewComment = (commit = COMMIT, extra = {}) => ({
  id: "C_review", createdAt: "2026-10-01T05:00:00Z",
  body: `<!-- review:v1 issue=3 -->\n**Ready for acceptance.**\n\n- Tested commit: \`${commit}\`\n- Commands and results: npm test 1/1 pass\n- Outstanding acceptance steps: owner replies accepted\n`, ...extra,
});
export const acceptComment = (text = `accepted ${COMMIT.slice(0, 7)}`, extra = {}) => ({ id: "C_acc", createdAt: "2026-10-01T06:00:00Z", body: text, ...extra });
export const verifyComment = (verifier = VERIFIER, commit = COMMIT, extra = {}) => ({
  id: "C_verify", createdAt: "2026-10-01T05:30:00Z",
  body: `<!-- verify:v1 issue=3 -->\n**Independent verification**\n\n- Tested commit: \`${commit}\`\n- Verifier execution ID: \`${verifier}\`\n- Checks re-run and results: npm test pass\n`, ...extra,
});

// Issue 3 In review with a live claim by SELF and one review comment.
export function reviewedWorld({ acceptance = "Automated", comments = [], extra = {} } = {}) {
  const world = makeWorld(extra);
  const issue = world.issues[3];
  issue.body = contractBody({ acceptance });
  issue.items[0].acceptance = acceptance;
  issue.items[0].status = "In review";
  issue.comments = [claimComment(SELF), reviewComment(), ...comments];
  world.compare[`main...${COMMIT}`] = "behind";
  return world;
}

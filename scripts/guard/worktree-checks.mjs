// Pure checks for a fresh worktree (issue #6, playbook section 7). tools/worktree-setup.mjs
// gathers the facts with read-only git commands; this file only judges them, so it
// is testable without a repository.

const check = (id, ok, message, extra = {}) => ({ id, ok, message, ...extra });

// facts: { branch, clean, baseIsAncestor (true|false|null), nodeModulesIsLink,
//          lockfilePresent, nodeVersion, wantedNode }
export function evaluateWorktree(facts, { base = null, integrationBranch = "main" } = {}) {
  const checks = [];
  const branch = String(facts.branch ?? "").trim();
  checks.push(check("branch-not-integration", Boolean(branch) && branch !== integrationBranch && branch !== "master",
    branch ? (branch === integrationBranch ? `on ${integrationBranch}; work happens on a claude/<name> branch` : `on branch ${branch}`) : "detached HEAD or no branch; create claude/<name> first"));
  checks.push(check("tree-clean", facts.clean === true, facts.clean === true ? "working tree is clean" : "working tree has uncommitted changes; use a fresh worktree"));
  if (base) {
    checks.push(check("base-reachable", facts.baseIsAncestor === true, facts.baseIsAncestor === true ? `base ${base.slice(0, 7)} is an ancestor of HEAD` : `base ${base.slice(0, 7)} is not (or could not be shown to be) an ancestor of HEAD`));
  } else {
    checks.push(check("base-reachable", true, "no --base given; the starting commit was not verified", { skipped: true }));
  }
  checks.push(check("node-modules-not-shared", facts.nodeModulesIsLink !== true, facts.nodeModulesIsLink ? "node_modules is a link; installed dependencies must not be shared between worktrees" : "node_modules is not a link"));
  checks.push(check("lockfile-present", facts.lockfilePresent === true, facts.lockfilePresent ? "package-lock.json present" : "package-lock.json is missing; a frozen install is impossible"));
  if (facts.wantedNode) {
    const wanted = String(facts.wantedNode).replace(/^v/, "");
    const have = String(facts.nodeVersion ?? "").replace(/^v/, "");
    checks.push(check("node-version", have === wanted || have.startsWith(`${wanted}.`), `node ${facts.nodeVersion} (wanted ${facts.wantedNode})`));
  } else {
    checks.push(check("node-version", true, `node ${facts.nodeVersion ?? "unknown"}; no pinned version found`, { skipped: true }));
  }
  const ok = checks.every((c) => c.ok);
  return { ok, checks, install: ok ? ["npm", "ci"] : null };
}

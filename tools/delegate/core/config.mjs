// Load and validate tools/delegate/config.json. Validation is strict: a missing
// or malformed setting stops the harness before it spends anything.

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPosInt = (v) => Number.isInteger(v) && v > 0;

export function validateConfig(cfg) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };
  need(isObj(cfg), "config must be an object");
  if (!isObj(cfg)) return problems;
  need(isObj(cfg.repository) && cfg.repository.owner && cfg.repository.name && cfg.repository.integrationBranch, "repository.owner/name/integrationBranch required");
  for (const key of ["protectedPaths", "configPaths", "dependencyFiles", "testFileGlobs", "contextExcludes"]) need(isStrArray(cfg[key]), `${key} must be a string array`);
  need(typeof cfg.testGlob === "string", "testGlob required");
  need(isObj(cfg.fitGate) && isStrArray(cfg.fitGate.flagLabels), "fitGate.flagLabels required");
  for (const lane of ["express", "standard", "protected"]) {
    need(isObj(cfg.lanes?.[lane]) && isPosInt(cfg.lanes[lane].maxFiles) && isPosInt(cfg.lanes[lane].maxLines), `lanes.${lane} needs maxFiles/maxLines`);
  }
  need(Array.isArray(cfg.ladder) && cfg.ladder.length > 0 && cfg.ladder.every((r) => typeof r.model === "string" && ["low", "high", "max"].includes(r.effort)), "ladder rungs need model and effort low|high|max");
  need(Number.isInteger(cfg.repairStartRung) && cfg.repairStartRung >= 0 && cfg.repairStartRung < (cfg.ladder?.length ?? 0), "repairStartRung must index the ladder");
  need(isObj(cfg.deepseek) && /^https:\/\//.test(cfg.deepseek.baseUrl ?? ""), "deepseek.baseUrl must be https");
  need(isPosInt(cfg.deepseek?.maxTokens) && isPosInt(cfg.deepseek?.lengthRetryMaxTokens) && cfg.deepseek.lengthRetryMaxTokens <= 393216, "deepseek token caps invalid");
  need(typeof cfg.deepseek?.usdPerBatch === "number" && cfg.deepseek.usdPerBatch > 0, "deepseek.usdPerBatch must be positive");
  need(isObj(cfg.codex?.roles), "codex.roles required");
  for (const role of ["controller", "triage", "verifier", "sol"]) {
    const r = cfg.codex?.roles?.[role];
    need(isObj(r) && r.model && r.effort && r.card, `codex.roles.${role} needs model, effort, card`);
    need(isObj(cfg.budgets?.[role]) && isPosInt(cfg.budgets[role].input) && isPosInt(cfg.budgets[role].output), `budgets.${role} needs input/output`);
  }
  need(isObj(cfg.budgets?.sessionsPerTicket), "budgets.sessionsPerTicket required");
  need(isObj(cfg.plan) && typeof cfg.plan.headroomPercent === "number" && typeof cfg.plan.creditCap === "number" && cfg.plan.creditCap >= 0, "plan.headroomPercent/creditCap required");
  need(isObj(cfg.batch) && isPosInt(cfg.batch.deadlineHours), "batch.deadlineHours required");
  return problems;
}

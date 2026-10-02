// The pre-authorized implementation ladder (DELEGATION.md section 5 step 5).
// Pure orchestration: every side effect is an injected dependency, so the
// control flow is testable with fakes.
//
// deps:
//   spendCheck()                      -> { ok, code?, message? }   before every request
//   restoreBase()                     -> void                       before a fresh rung (after the first attempt)
//   callModel(rung, { attempt, previous, note }) -> { ok, code?, message?, artifact?, facts? }
//       codes: LENGTH/SPLIT_NEEDED (output limit twice), TRANSPORT/HTTP_ERROR (provider),
//              anything else (MODEL_MISMATCH, JSON_INVALID, ...) is a defect in the answer
//   apply(artifact)                   -> { ok, code?, message? }   validates fully, then writes
//   evaluate()                        -> { outcome: GREEN|FAILED|PROMOTE_LANE|PROMOTE_PROTECTED, guards, failure, diff }
//   record(entry)                     -> void
//
// Outcomes: GREEN, CAPPED, PROMOTE_LANE, PROMOTE_PROTECTED, SPLIT_NEEDED,
// WORKER_BLOCKED, STOPPED (spend/balance/provider; not a code defect).

export async function runLadder({ rungs, startRung = 0, note = null, deps }) {
  const attempts = [];
  let previous = null;
  let blockedInARow = 0;
  for (let index = startRung; index < rungs.length; index += 1) {
    const rung = rungs[index];
    const attempt = attempts.length + 1;

    const spend = await deps.spendCheck();
    if (!spend.ok) return finish("STOPPED", { code: spend.code, message: spend.message });

    if (attempt > 1 && rung.fresh) await deps.restoreBase();

    let answer = await deps.callModel(rung, { attempt, previous, note });
    if (!answer.ok && (answer.code === "TRANSPORT" || answer.code === "HTTP_ERROR")) {
      deps.record({ attempt, rung: index, model: rung.model, effort: rung.effort, result: "provider-retry", code: answer.code, facts: answer.facts });
      const again = await deps.spendCheck();
      if (!again.ok) return finish("STOPPED", { code: again.code, message: again.message });
      answer = await deps.callModel(rung, { attempt, previous, note });
      if (!answer.ok && (answer.code === "TRANSPORT" || answer.code === "HTTP_ERROR")) {
        return finish("STOPPED", { code: answer.code, message: answer.message ?? "provider unavailable" });
      }
    }
    if (!answer.ok && answer.code === "SPLIT_NEEDED") return finish("SPLIT_NEEDED", { code: answer.code, message: answer.message });

    if (!answer.ok) {
      const entry = { attempt, rung: index, model: rung.model, effort: rung.effort, result: "invalid-answer", code: answer.code, message: answer.message, facts: answer.facts };
      deps.record(entry);
      attempts.push(entry);
      previous = { failure: `Your previous answer was rejected (${answer.code}): ${answer.message ?? ""}`, diff: previous?.diff ?? "" };
      blockedInARow = 0;
      continue;
    }

    const applied = await deps.apply(answer.artifact);
    if (!applied.ok) {
      const entry = { attempt, rung: index, model: rung.model, effort: rung.effort, result: applied.code === "BLOCKED" ? "worker-blocked" : "apply-rejected", code: applied.code, message: applied.message, facts: answer.facts };
      deps.record(entry);
      attempts.push(entry);
      if (applied.code === "BLOCKED") {
        blockedInARow += 1;
        if (blockedInARow >= 2) return finish("WORKER_BLOCKED", { code: "BLOCKED", message: applied.message });
      } else blockedInARow = 0;
      previous = { failure: `Your artifact was not applied (${applied.code}): ${applied.message ?? ""}`, diff: previous?.diff ?? "" };
      continue;
    }
    blockedInARow = 0;

    const evaluation = await deps.evaluate();
    const entry = { attempt, rung: index, model: rung.model, effort: rung.effort, result: evaluation.outcome, guards: evaluation.guards, facts: answer.facts, notes: answer.artifact?.notes ?? [], summary: answer.artifact?.summary ?? "" };
    deps.record(entry);
    attempts.push(entry);
    if (evaluation.outcome === "GREEN") return finish("GREEN");
    if (evaluation.outcome === "PROMOTE_LANE" || evaluation.outcome === "PROMOTE_PROTECTED") return finish(evaluation.outcome);
    previous = { failure: evaluation.failure ?? "", diff: evaluation.diff ?? "" };
  }
  return finish("CAPPED");

  function finish(outcome, extra = {}) {
    return { outcome, attempts, ...extra };
  }
}

// At most `maxLines` lines of failure text: failing guards first, then test messages.
export function failureExcerpt({ guards = [], failingTests = [] }, maxLines = 40) {
  const lines = [];
  for (const g of guards) if (!g.ok) lines.push(`FAIL ${g.id}: ${g.detail}`);
  for (const t of failingTests) lines.push(`TEST FAIL ${t.name}: ${String(t.message ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
  return lines.slice(0, maxLines).join("\n");
}

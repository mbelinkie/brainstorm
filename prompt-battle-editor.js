import { validateQuiz } from "./quiz-validation.js";

const numericFields = new Set(["variants", "attemptBudget", "steps", "maxSessionSpendUsd", "maxSessionGenerations", "winnerPoints", "voterPoints"]);
const optionalFields = new Set(["steps", "resolution", "outputFormat", "maxSessionSpendUsd", "maxSessionGenerations"]);

export function createPromptBattleRound(id, title) {
  return {
    id,
    type: "prompt_battle",
    title,
    prompts: [{ id: "prompt-1", text: "" }],
    engine: { defaultProvider: "", defaultModel: "", permittedModels: [], variants: 1, attemptBudget: 1 },
    scoring: { winnerPoints: 100, voterPoints: 10 }
  };
}

export function addPromptToBattleRound(round, id) {
  if (!Array.isArray(round.prompts)) {
    if (round.prompts !== undefined) return;
    round.prompts = [];
  }
  round.prompts.push({ id, text: "" });
}

export function removePromptFromBattleRound(round, index) {
  if (!Array.isArray(round.prompts)) return;
  round.prompts.splice(index, 1);
}

export function duplicatePromptBattleRound(round, id, newPromptId) {
  const copy = structuredClone(round);
  copy.id = id;
  copy.title = `${round.title || "Untitled round"} (copy)`;
  if (Array.isArray(copy.prompts)) copy.prompts.forEach((prompt) => { if (prompt && typeof prompt === "object") prompt.id = newPromptId(); });
  return copy;
}

export function isRestorableAuthorDraft(draft) {
  const rounds = draft?.bank?.rounds;
  return Array.isArray(rounds) && rounds.length > 0 && rounds.every((round) => {
    if (!round || typeof round !== "object") return false;
    return round.type === "prompt_battle" || (Array.isArray(round.questions) && round.questions.length > 0);
  });
}

export function restoredAuthorSelection(draft) {
  const rounds = draft.bank.rounds;
  const roundIndex = Math.min(Math.max(0, Number(draft.selection?.roundIndex) || 0), rounds.length - 1);
  const round = rounds[roundIndex];
  const questionIndex = round.type === "prompt_battle"
    ? 0
    : Math.min(Math.max(0, Number(draft.selection?.questionIndex) || 0), round.questions.length - 1);
  return { roundIndex, questionIndex };
}

export function setPromptBattleField(round, path, rawValue) {
  const parts = path.split(".");
  if (parts[0] === "title" && parts.length === 1) { round.title = rawValue; return; }
  if (parts.length < 2 || parts.length > 3 || !["engine", "scoring", "prompts"].includes(parts[0])) return;
  const index = parts.length === 3 ? Number(parts[1]) : null;
  const key = parts.at(-1);
  if (parts.length === 2 && ["engine", "scoring"].includes(parts[0]) && (!round[parts[0]] || typeof round[parts[0]] !== "object" || Array.isArray(round[parts[0]]))) round[parts[0]] = {};
  const parent = parts.length === 3 ? round[parts[0]]?.[index] : round[parts[0]];
  if (!parent || typeof parent !== "object" || (parts.length === 3 && !Number.isInteger(index))) return;
  if (parts[0] === "prompts" && !["id", "text"].includes(key)) return;
  if (parts[0] === "engine" && !["defaultProvider", "defaultModel", "permittedModels", "variants", "attemptBudget", "steps", "resolution", "outputFormat", "maxSessionSpendUsd", "maxSessionGenerations"].includes(key)) return;
  if (parts[0] === "scoring" && !["winnerPoints", "voterPoints"].includes(key)) return;
  if (parts[0] === "engine" && key === "permittedModels" && parts.length === 2) {
    parent[key] = String(rawValue).split("\n").map((entry) => entry.trim()).filter(Boolean);
    return;
  }
  if (rawValue === "" && parts[0] === "engine" && optionalFields.has(key)) { delete parent[key]; return; }
  parent[key] = numericFields.has(key) ? Number(rawValue) : rawValue;
}

export function promptBattleErrorsByField(round, roundIndex) {
  const prefix = `Round ${roundIndex + 1}`;
  const errors = validateQuiz({ id: "editor-validation", title: "Editor validation", rounds: [round] })
    .filter((message) => message.startsWith("Round 1"))
    .map((message) => message.replace(/^Round 1/, prefix));
  const fields = {};
  for (const message of errors) {
    let field = "round";
    if (message.endsWith("needs a title.")) field = "title";
    else if (message.includes("battle prompt")) field = "prompts";
    else if (message.includes("needs an engine block")) field = "engine";
    else if (message.includes("needs a scoring block")) field = "scoring";
    const promptIndex = /^Round \d+, prompt (\d+)/.exec(message);
    if (promptIndex) {
      const index = Number(promptIndex[1]) - 1;
      if (message.includes("needs an ID") || message.includes("duplicate prompt ID")) field = `prompts.${index}.id`;
      else if (message.includes("prompt text")) field = `prompts.${index}.text`;
      else field = "prompts";
    } else if (message.includes("engine needs a default provider")) field = "engine.defaultProvider";
    else if (message.includes("engine needs a default model") || message.includes("default model must")) field = "engine.defaultModel";
    else if (message.includes("permitted model")) field = "engine.permittedModels";
    else if (message.includes("variants")) field = "engine.variants";
    else if (message.includes("attempt budget")) field = "engine.attemptBudget";
    else if (message.includes("steps")) field = "engine.steps";
    else if (message.includes("spend cap")) field = "engine.maxSessionSpendUsd";
    else if (message.includes("generation cap")) field = "engine.maxSessionGenerations";
    else if (message.includes("resolution")) field = "engine.resolution";
    else if (message.includes("output format")) field = "engine.outputFormat";
    else if (message.includes("winner points")) field = "scoring.winnerPoints";
    else if (message.includes("voter points")) field = "scoring.voterPoints";
    (fields[field] ||= []).push(message);
  }
  return Object.fromEntries(Object.entries(fields).map(([field, messages]) => [field, messages.join(" ")]));
}

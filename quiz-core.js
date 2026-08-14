// Shared client-safe quiz helpers. These functions deliberately expose only
// data a joined player needs; scoring remains authoritative in Supabase.

export function toPlayerQuestion(question = {}) {
  const playerQuestion = { id: question.id, type: question.type, prompt: question.prompt };
  if (question.questionImageAssetId) playerQuestion.questionImageAssetId = question.questionImageAssetId;
  if (question.options !== undefined) playerQuestion.options = question.options.map(({ id, label, imageAssetId }) => ({ id, label, ...(imageAssetId ? { imageAssetId } : {}) }));
  for (const key of ["items", "categories"]) if (question[key] !== undefined) playerQuestion[key] = question[key];
  if (question.clips !== undefined) playerQuestion.clips = question.clips.map(({ id, label }) => ({ id, label }));
  return playerQuestion;
}

export function correctOptionId(question = {}) {
  return question.correctOptionIds?.[0] || question.options?.[question.correctOption]?.id || null;
}

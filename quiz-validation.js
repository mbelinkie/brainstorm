export function validateQuiz(candidate) {
  const errors = [];
  const requiredText = (value) => typeof value === "string" && value.trim();
  const validNumericLiteral = (value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim());
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["Quiz must be a JSON object."];
  if (!requiredText(candidate.id)) errors.push("Quiz ID is required.");
  if (!requiredText(candidate.title)) errors.push("Quiz title is required.");
  if (candidate.titlePage !== undefined && (!candidate.titlePage || typeof candidate.titlePage !== "object" || Array.isArray(candidate.titlePage))) errors.push("Title page must be an object when provided.");
  if (candidate.titlePage?.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.titlePage.audio.mediaAssetId)) errors.push("Title page has an invalid private audio asset ID.");
  if (!Array.isArray(candidate.rounds) || candidate.rounds.length === 0) return [...errors, "Add at least one round."];
  const roundIds = new Set(); const questionIds = new Set();
  for (const [roundIndex, round] of candidate.rounds.entries()) {
    const roundLabel = `Round ${roundIndex + 1}`;
    if (!round || typeof round !== "object") { errors.push(`${roundLabel} must be an object.`); continue; }
    if (!requiredText(round.id)) errors.push(`${roundLabel} needs an ID.`); else if (roundIds.has(round.id)) errors.push(`${roundLabel} has a duplicate round ID: ${round.id}.`); else roundIds.add(round.id);
    if (!requiredText(round.title)) errors.push(`${roundLabel} needs a title.`);
    if (!Array.isArray(round.questions) || !round.questions.length) { errors.push(`${roundLabel} needs at least one question.`); continue; }
    for (const [questionIndex, item] of round.questions.entries()) {
      const label = `${roundLabel}, question ${questionIndex + 1}`;
      if (!item || typeof item !== "object") { errors.push(`${label} must be an object.`); continue; }
      if (!requiredText(item.id)) errors.push(`${label} needs an ID.`); else if (questionIds.has(item.id)) errors.push(`${label} has a duplicate question ID: ${item.id}.`); else questionIds.add(item.id);
      if (!requiredText(item.prompt)) errors.push(`${label} needs a player prompt.`);
      if (!Number.isFinite(Number(item.points ?? item.scoring?.points)) || Number(item.points ?? item.scoring?.points) <= 0) errors.push(`${label} needs positive points.`);
      if (item.type === "closest_number" && !validNumericLiteral(item.targetNumber)) errors.push(`${label} needs a valid target number.`);
      if (["single_choice", "multiple_choice", "true_false", "image_selection"].includes(item.type)) {
        const optionIds = new Set((item.options || []).map((option) => option?.id));
        if (!Array.isArray(item.options) || item.options.length < 2 || item.options.some((option) => !requiredText(option?.id) || !requiredText(option?.label))) errors.push(`${label} needs at least two labeled options with IDs.`);
        if (!Array.isArray(item.correctOptionIds) || !item.correctOptionIds.length || item.correctOptionIds.some((id) => !optionIds.has(id))) errors.push(`${label} has an invalid answer key.`);
      }
      if (item.type === "short_answer" && (!Array.isArray(item.acceptedAnswers) || item.acceptedAnswers.every((answer) => !requiredText(answer)))) errors.push(`${label} needs an accepted answer.`);
      if (item.type === "matching" && (!Array.isArray(item.options) || item.options.length < 2 || !Array.isArray(item.clips) || item.clips.length < 2 || !item.correctPairs || !Number.isFinite(Number(item.pointsPerPair)) || Number(item.pointsPerPair) <= 0)) errors.push(`${label} needs complete clips, options, pair key, and positive points per pair.`);
    }
  }
  return errors;
}

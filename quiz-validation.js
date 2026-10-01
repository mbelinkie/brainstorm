// The one validator. author.js used to carry a second, divergent copy of this
// function: that copy gated Publish while this one was the only copy under test,
// so a green test run proved nothing about what the editor accepted. The rules
// below are the union of what the two copies already checked — nothing new was
// invented during the merge.
export function validateQuiz(candidate) {
  const errors = [];
  // Rounds carried no `type` before Prompt Battle, so `undefined` is the
  // ordinary question round every existing quiz uses.
  const supportedRoundTypes = new Set(["prompt_battle"]);
  const supportedTypes = new Set(["single_choice", "multiple_choice", "true_false", "image_selection", "short_answer", "fill_in_the_blank", "multi_fill_in_the_blank", "arrange_in_order", "categorize", "matching", "closest_number"]);
  const requiredText = (value) => typeof value === "string" && value.trim();
  const validNumericLiteral = (value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim());
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["Quiz must be a JSON object."];
  if (!requiredText(candidate.id)) errors.push("Quiz ID is required.");
  if (!requiredText(candidate.title)) errors.push("Quiz title is required.");
  if (candidate.titlePage !== undefined && (!candidate.titlePage || typeof candidate.titlePage !== "object" || Array.isArray(candidate.titlePage))) errors.push("Title page must be an object when provided.");
  if (candidate.titlePage?.presenter !== undefined && (typeof candidate.titlePage.presenter !== "string" || candidate.titlePage.presenter.length > 120)) errors.push("Title page presenter must be a string of 120 characters or fewer.");
  if (candidate.titlePage?.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.titlePage.audio.mediaAssetId)) errors.push("Title page has an invalid private audio asset ID.");
  const titleAudio = candidate.titlePage?.audio;
  const validKaraoke = (cue) => cue.karaoke === undefined || (Array.isArray(cue.karaoke) && cue.karaoke.length <= 500 && cue.karaoke.every((segment) => segment && Object.getPrototypeOf(segment) === Object.prototype && Number.isFinite(segment.startMs) && segment.startMs >= cue.startMs && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs && segment.endMs <= cue.endMs && Number.isInteger(segment.startIndex) && segment.startIndex >= 0 && Number.isInteger(segment.endIndex) && segment.endIndex > segment.startIndex && segment.endIndex <= cue.text.length));
  if (titleAudio?.captionSourceName !== undefined && (typeof titleAudio.captionSourceName !== "string" || titleAudio.captionSourceName.length > 255)) errors.push("Title page caption source name must be a string of 255 characters or fewer.");
  if (titleAudio?.captions !== undefined && (!Array.isArray(titleAudio.captions) || titleAudio.captions.length > 500 || titleAudio.captions.some((cue) => !cue || Object.getPrototypeOf(cue) !== Object.prototype || !Number.isFinite(cue.startMs) || cue.startMs < 0 || !Number.isFinite(cue.endMs) || cue.endMs <= cue.startMs || typeof cue.text !== "string" || !cue.text.trim() || cue.text.length > 500 || !validKaraoke(cue)))) errors.push("Title page captions must contain at most 500 valid timed text cues.");
  for (const [key, audio] of Object.entries(candidate.finale?.audio || {})) if (audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audio.mediaAssetId)) errors.push(`Finale ${key} has an invalid private audio asset ID.`);
  for (const [screen, audio] of Object.entries(candidate.betweenRoundBonus?.audio || {})) {
    if (audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audio.mediaAssetId)) errors.push(`Between-round ${screen} sound has an invalid private audio asset ID.`);
  }
  if (candidate.betweenRoundBonus?.enabled) {
    const doors = candidate.betweenRoundBonus.doors;
    if (!Array.isArray(doors) || doors.length !== 3) errors.push("Between-round bonus needs exactly three doors.");
    else {
      const doorIds = new Set();
      doors.forEach((door, doorIndex) => {
        const label = `Bonus door ${doorIndex + 1}`;
        if (!requiredText(door?.id) || !requiredText(door?.name)) errors.push(`${label} needs an ID and name.`);
        else if (doorIds.has(door.id)) errors.push(`${label} has a duplicate ID.`);
        else doorIds.add(door.id);
        if (!requiredText(door?.icon)) errors.push(`${label} needs an icon.`);
        if (!Array.isArray(door?.outcomes) || door.outcomes.length === 0) errors.push(`${label} needs at least one outcome.`);
        else {
          const chanceTotal = door.outcomes.reduce((sum, outcome) => sum + Number(outcome?.chancePercent || 0), 0);
          if (Math.abs(chanceTotal - 100) > 0.001) errors.push(`${label} outcome chances must total 100%.`);
          if (door.outcomes.some((outcome) => !Number.isFinite(Number(outcome?.chancePercent)) || Number(outcome.chancePercent) <= 0 || !Number.isFinite(Number(outcome?.multiplier)) || Number(outcome.multiplier) <= 0 || Number(outcome.multiplier) > 10)) errors.push(`${label} needs positive chances and multipliers no greater than 10×.`);
        }
      });
    }
  }
  if (!Array.isArray(candidate.rounds) || candidate.rounds.length === 0) return [...errors, "Add at least one round."];
  const roundIds = new Set(); const questionIds = new Set();
  for (const [roundIndex, round] of candidate.rounds.entries()) {
    const roundLabel = `Round ${roundIndex + 1}`;
    if (!round || typeof round !== "object") { errors.push(`${roundLabel} must be an object.`); continue; }
    if (!requiredText(round.id)) errors.push(`${roundLabel} needs an ID.`); else if (roundIds.has(round.id)) errors.push(`${roundLabel} has a duplicate round ID: ${round.id}.`); else roundIds.add(round.id);
    if (!requiredText(round.title)) errors.push(`${roundLabel} needs a title.`);
    if (round.type !== undefined && !supportedRoundTypes.has(round.type)) { errors.push(`${roundLabel} has an unsupported round type.`); continue; }
    // A prompt_battle round has prompts instead of questions and no answer
    // key at all, so it takes its own rules and skips the question loop
    // entirely rather than being forced through a shape it does not have.
    if (round.type === "prompt_battle") { validatePromptBattleRound(round, roundLabel, errors); continue; }
    if (!Array.isArray(round.questions) || !round.questions.length) { errors.push(`${roundLabel} needs at least one question.`); continue; }
    for (const [questionIndex, item] of round.questions.entries()) {
      const label = `${roundLabel}, question ${questionIndex + 1}`;
      if (!item || typeof item !== "object") { errors.push(`${label} must be an object.`); continue; }
      if (!requiredText(item.id)) errors.push(`${label} needs an ID.`); else if (questionIds.has(item.id)) errors.push(`${label} has a duplicate question ID: ${item.id}.`); else questionIds.add(item.id);
      if (!supportedTypes.has(item.type)) errors.push(`${label} has an unsupported question type.`);
      if (!requiredText(item.prompt)) errors.push(`${label} needs a player prompt.`);
      if (item.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.audio.mediaAssetId)) errors.push(`${label} has an invalid private media asset ID.`);
      if (item.video !== undefined && (!item.video || typeof item.video !== "object" || Array.isArray(item.video))) errors.push(`${label} video must be an object.`);
      if (item.video?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.video.mediaAssetId)) errors.push(`${label} has an invalid private video asset ID.`);
      if ((item.audio?.mediaAssetId || item.audio?.url) && (item.video?.mediaAssetId || item.video?.url)) errors.push(`${label} may have either presentation audio or presentation video, not both.`);
      if (!["matching", "multi_fill_in_the_blank"].includes(item.type) && (!Number.isFinite(Number(item.points ?? item.scoring?.points)) || Number(item.points ?? item.scoring?.points) <= 0)) errors.push(`${label} needs positive points.`);
      if (item.type === "closest_number" && !validNumericLiteral(item.targetNumber)) errors.push(`${label} needs a valid target number.`);
      if (["single_choice", "multiple_choice", "true_false", "image_selection"].includes(item.type)) {
        const optionIds = new Set((item.options || []).map((option) => option?.id));
        if (!Array.isArray(item.options) || item.options.length < 2 || item.options.some((option) => !requiredText(option?.id) || !requiredText(option?.label))) errors.push(`${label} needs at least two labeled options with IDs.`);
        if (!Array.isArray(item.correctOptionIds) || !item.correctOptionIds.length || item.correctOptionIds.some((id) => !optionIds.has(id))) errors.push(`${label} has an invalid answer key.`);
      }
      if (item.type === "short_answer" && (!Array.isArray(item.acceptedAnswers) || item.acceptedAnswers.every((answer) => !requiredText(answer)))) errors.push(`${label} needs an accepted answer.`);
      if (item.type === "fill_in_the_blank" && (!Array.isArray(item.blanks) || item.blanks.length === 0 || item.blanks.some((blank) => !Array.isArray(blank?.acceptedAnswers) || blank.acceptedAnswers.every((answer) => !requiredText(answer))))) errors.push(`${label} needs accepted answers for every blank.`);
      if (item.type === "arrange_in_order") {
        const itemIds = new Set((item.items || []).map((entry) => entry?.id));
        if (!Array.isArray(item.items) || item.items.length < 2 || item.items.some((entry) => !requiredText(entry?.id) || !requiredText(entry?.label)) || !Array.isArray(item.correctOrder) || item.correctOrder.length !== item.items.length || new Set(item.correctOrder).size !== item.correctOrder.length || item.correctOrder.some((id) => !itemIds.has(id))) errors.push(`${label} needs a complete, unique order answer key.`);
      }
      if (item.type === "categorize") {
        const categoryIds = new Set((item.categories || []).map((entry) => entry?.id));
        const itemIds = (item.items || []).map((entry) => entry?.id);
        if (!Array.isArray(item.categories) || item.categories.length !== 2 || item.categories.some((entry) => !requiredText(entry?.id) || !requiredText(entry?.label)) || !Array.isArray(item.items) || item.items.length === 0 || item.items.some((entry) => !requiredText(entry?.id) || !requiredText(entry?.label)) || !item.correctCategories || itemIds.some((id) => !categoryIds.has(item.correctCategories[id]))) errors.push(`${label} needs two categories and a complete valid assignment key.`);
      }
      if (item.type === "matching") {
        const optionIds = new Set((item.options || []).map((entry) => entry?.id));
        const clipIds = (item.clips || []).map((entry) => entry?.id);
        if (!Number.isFinite(Number(item.pointsPerPair)) || Number(item.pointsPerPair) <= 0 || !Array.isArray(item.options) || item.options.length < 2 || item.options.some((entry) => !requiredText(entry?.id) || !requiredText(entry?.label)) || !Array.isArray(item.clips) || item.clips.length < 2 || item.clips.some((entry) => !requiredText(entry?.id) || !requiredText(entry?.label)) || !item.correctPairs || clipIds.some((id) => !optionIds.has(item.correctPairs[id]))) errors.push(`${label} needs complete clips, options, pair key, and positive points per pair.`);
      }
      if (item.type === "multi_fill_in_the_blank" && (!Array.isArray(item.clips) || item.clips.length < 2 || item.clips.some((clip) => !requiredText(clip?.id) || !requiredText(clip?.label) || !Array.isArray(clip.acceptedAnswers) || clip.acceptedAnswers.every((answer) => !requiredText(answer))) || !Number.isFinite(Number(item.pointsPerBlank)) || Number(item.pointsPerBlank) <= 0)) errors.push(`${label} needs labeled clips, accepted answers for every clip, and positive points per blank.`);
    }
  }
  return errors;
}

// Prompt Battle round rules — base spec section 4, as amended by the free-engine
// addendum section 5. Two things that look like omissions are deliberate:
// `resolution` and `outputFormat` are adapter-dependent and ignored entirely by
// the workers_ai adapter, so they are optional and never required; and
// `maxSessionSpendUsd: null` means "no monetary cap" (0 means generation is
// disabled), which is why null is accepted and a negative number is not.
function validatePromptBattleRound(round, roundLabel, errors) {
  const requiredText = (value) => typeof value === "string" && value.trim();
  const positiveInteger = (value) => Number.isInteger(value) && value > 0;

  const prompts = round.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0) errors.push(`${roundLabel} needs at least one battle prompt.`);
  else {
    const promptIds = new Set();
    prompts.forEach((prompt, promptIndex) => {
      const label = `${roundLabel}, prompt ${promptIndex + 1}`;
      if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) { errors.push(`${label} must be an object.`); return; }
      if (!requiredText(prompt.id)) errors.push(`${label} needs an ID.`);
      else if (promptIds.has(prompt.id)) errors.push(`${label} has a duplicate prompt ID: ${prompt.id}.`);
      else promptIds.add(prompt.id);
      // 2048 characters is the session_battle_matchups.prompt_text check
      // constraint in 0036; rejecting it here keeps the round unpublishable
      // rather than letting open_battle_round fail mid-show.
      if (!requiredText(prompt.text) || prompt.text.length > 2048) errors.push(`${label} needs prompt text of 2048 characters or fewer.`);
    });
  }

  const engine = round.engine;
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) { errors.push(`${roundLabel} needs an engine block.`); return; }
  if (!requiredText(engine.defaultProvider)) errors.push(`${roundLabel} engine needs a default provider.`);
  if (!requiredText(engine.defaultModel)) errors.push(`${roundLabel} engine needs a default model.`);
  if (!Array.isArray(engine.permittedModels) || engine.permittedModels.length === 0 || engine.permittedModels.some((model) => !requiredText(model))) errors.push(`${roundLabel} engine needs at least one permitted model.`);
  // set_battle_engine() in 0036 only accepts a model that appears in
  // permittedModels, so a default outside that list is unselectable.
  else if (requiredText(engine.defaultModel) && !engine.permittedModels.includes(engine.defaultModel)) errors.push(`${roundLabel} engine default model must be one of its permitted models.`);
  if (!positiveInteger(engine.variants) || engine.variants > 10) errors.push(`${roundLabel} engine needs between 1 and 10 variants.`);
  if (!positiveInteger(engine.attemptBudget)) errors.push(`${roundLabel} engine needs a positive attempt budget.`);
  if (engine.steps !== undefined && (!positiveInteger(engine.steps) || engine.steps > 8)) errors.push(`${roundLabel} engine steps must be between 1 and 8.`);
  if (engine.maxSessionSpendUsd !== undefined && engine.maxSessionSpendUsd !== null && (!Number.isFinite(Number(engine.maxSessionSpendUsd)) || Number(engine.maxSessionSpendUsd) < 0)) errors.push(`${roundLabel} engine spend cap must be null or a number of 0 or more.`);
  if (engine.maxSessionGenerations !== undefined && engine.maxSessionGenerations !== null && !positiveInteger(engine.maxSessionGenerations)) errors.push(`${roundLabel} engine generation cap must be null or a positive whole number.`);
  if (engine.resolution !== undefined && !requiredText(engine.resolution)) errors.push(`${roundLabel} engine resolution must be a string when provided.`);
  if (engine.outputFormat !== undefined && !requiredText(engine.outputFormat)) errors.push(`${roundLabel} engine output format must be a string when provided.`);

  const scoring = round.scoring;
  if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) { errors.push(`${roundLabel} needs a scoring block.`); return; }
  if (!Number.isFinite(Number(scoring.winnerPoints)) || Number(scoring.winnerPoints) <= 0) errors.push(`${roundLabel} needs positive winner points.`);
  if (!Number.isFinite(Number(scoring.voterPoints)) || Number(scoring.voterPoints) < 0) errors.push(`${roundLabel} needs voter points of 0 or more.`);
}

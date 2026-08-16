export function validateQuiz(candidate) {
  const errors = [];
  const requiredText = (value) => typeof value === "string" && value.trim();
  const validNumericLiteral = (value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim());
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["Quiz must be a JSON object."];
  if (!requiredText(candidate.id)) errors.push("Quiz ID is required.");
  if (!requiredText(candidate.title)) errors.push("Quiz title is required.");
  if (candidate.titlePage !== undefined && (!candidate.titlePage || typeof candidate.titlePage !== "object" || Array.isArray(candidate.titlePage))) errors.push("Title page must be an object when provided.");
  if (candidate.titlePage?.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.titlePage.audio.mediaAssetId)) errors.push("Title page has an invalid private audio asset ID.");
  const titleAudio = candidate.titlePage?.audio;
  const validKaraoke = (cue) => cue.karaoke === undefined || (Array.isArray(cue.karaoke) && cue.karaoke.length <= 500 && cue.karaoke.every((segment) => segment && Object.getPrototypeOf(segment) === Object.prototype && Number.isFinite(segment.startMs) && segment.startMs >= cue.startMs && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs && segment.endMs <= cue.endMs && Number.isInteger(segment.startIndex) && segment.startIndex >= 0 && Number.isInteger(segment.endIndex) && segment.endIndex > segment.startIndex && segment.endIndex <= cue.text.length));
  if (titleAudio?.captionSourceName !== undefined && (typeof titleAudio.captionSourceName !== "string" || titleAudio.captionSourceName.length > 255)) errors.push("Title page caption source name must be a string of 255 characters or fewer.");
  if (titleAudio?.captions !== undefined && (!Array.isArray(titleAudio.captions) || titleAudio.captions.length > 500 || titleAudio.captions.some((cue) => !cue || Object.getPrototypeOf(cue) !== Object.prototype || !Number.isFinite(cue.startMs) || cue.startMs < 0 || !Number.isFinite(cue.endMs) || cue.endMs <= cue.startMs || typeof cue.text !== "string" || !cue.text.trim() || cue.text.length > 500 || !validKaraoke(cue)))) errors.push("Title page captions must contain at most 500 valid timed text cues.");
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
    if (!Array.isArray(round.questions) || !round.questions.length) { errors.push(`${roundLabel} needs at least one question.`); continue; }
    for (const [questionIndex, item] of round.questions.entries()) {
      const label = `${roundLabel}, question ${questionIndex + 1}`;
      if (!item || typeof item !== "object") { errors.push(`${label} must be an object.`); continue; }
      if (!requiredText(item.id)) errors.push(`${label} needs an ID.`); else if (questionIds.has(item.id)) errors.push(`${label} has a duplicate question ID: ${item.id}.`); else questionIds.add(item.id);
      if (!requiredText(item.prompt)) errors.push(`${label} needs a player prompt.`);
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
      if (item.type === "matching" && (!Array.isArray(item.options) || item.options.length < 2 || !Array.isArray(item.clips) || item.clips.length < 2 || !item.correctPairs || !Number.isFinite(Number(item.pointsPerPair)) || Number(item.pointsPerPair) <= 0)) errors.push(`${label} needs complete clips, options, pair key, and positive points per pair.`);
      if (item.type === "multi_fill_in_the_blank" && (!Array.isArray(item.clips) || item.clips.length < 2 || item.clips.some((clip) => !requiredText(clip?.id) || !requiredText(clip?.label) || !Array.isArray(clip.acceptedAnswers) || clip.acceptedAnswers.every((answer) => !requiredText(answer))) || !Number.isFinite(Number(item.pointsPerBlank)) || Number(item.pointsPerBlank) <= 0)) errors.push(`${label} needs labeled clips, accepted answers for every clip, and positive points per blank.`);
    }
  }
  return errors;
}

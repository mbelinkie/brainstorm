import { downloadDiagnostics, recordDiagnostic, startDiagnostics } from "./diagnostics.js";
import { cropRect, panCrop } from "./image-crop.js";

const BANK_URL = "./music-trivia.question-bank.json";
const DRAFT_KEY = "quiz-control:author-draft:v1";
const PUBLISHED_SNAPSHOT_KEY = "quiz-control:last-published-bank:v1";
const IMAGE_SEARCH_DRAFT_KEY = "quiz-control:image-search-draft-mode:v1";
const ORIGINAL_SOURCE_INDEX_KEY = "quiz-control:original-image-sources:v1";
const ORIGINALS_DIRECTORY_DB = "quiz-control-originals";
const ORIGINALS_DIRECTORY_STORE = "directories";
const ORIGINALS_DIRECTORY_KEY = "source-folder";
const AUTHOR_EMAIL_KEY = "quiz-control:last-author-email:v1";
// Quiz clips need a consistent perceived level when played back to a room. The
// browser renderer works with PCM samples, so use a gated RMS estimate rather
// than relying on a source file's (often missing) volume metadata. -16 dBFS is
// a comfortable presentation target and the -1 dBFS ceiling preserves headroom.
const AUDIO_NORMALIZATION_TARGET_DBFS = -16;
const AUDIO_NORMALIZATION_PEAK_CEILING = 10 ** (-1 / 20);
const AUDIO_NORMALIZATION_GATE = 10 ** (-50 / 20);
let bank;
let selection = { roundIndex: 0, questionIndex: 0 };
let originalBank;
let lastPublishedBank = null;
const config = window.QUIZ_PLATFORM_CONFIG || {};
const DEPLOYED_WORKER_ORIGIN = "https://wild-haze-73b3.matthew-belinkie-3af.workers.dev";
const isLocalAuthoring = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const workerOrigin = config.workerOrigin || (isLocalAuthoring ? DEPLOYED_WORKER_ORIGIN : location.origin);
let supabase;
let currentUser;
let mediaAssets = [];
let mediaAssetsLoaded = false;
let originalsDirectoryHandle = null;
let originalSourceIndex = loadOriginalSourceIndex();
let navSearch = "";
let navTypeFilter = "";
let mediaPreviewUrls = [];
const uploadedImagePreviewUrls = new Map();
const uploadedAudioPreviewUrls = new Map();
let cropperSession = null;
let audioClipperSession = null;
let imageFinderTarget = null;
let pasteImageTarget = null;

const $ = (selector) => document.querySelector(selector);
const clone = (value) => structuredClone(value);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
const question = () => bank?.rounds?.[selection.roundIndex]?.questions?.[selection.questionIndex];
const selectedRound = () => bank?.rounds?.[selection.roundIndex];
const letters = (index) => String.fromCharCode(65 + index);
const typeLabel = (type) => type.replaceAll("_", " ");
const validNumericLiteral = (value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim());
const validAssetId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const titlePage = () => (bank.titlePage ||= {});
const finaleConfig = () => (bank.finale ||= { audio: {} });
const DEFAULT_BETWEEN_ROUND_BONUS = Object.freeze({ enabled: true, audio: {}, doors: [
  { id: "safe", name: "Safe Door", icon: "shield", outcomes: [{ chancePercent: 100, multiplier: 1.2 }] },
  { id: "gamble", name: "Gamble Door", icon: "dice", outcomes: [{ chancePercent: 50, multiplier: 1.6 }, { chancePercent: 50, multiplier: 0.8 }] },
  { id: "hail-mary", name: "Hail Mary Door", icon: "lightning", outcomes: [{ chancePercent: 25, multiplier: 3 }, { chancePercent: 75, multiplier: 0.6 }] }
] });
const bonusConfig = () => (bank.betweenRoundBonus ||= clone(DEFAULT_BETWEEN_ROUND_BONUS));

function imageActionControls(target, uploadInput) {
  return `<div class="option-image-actions image-split" data-image-split><button class="button button-quiet image-paste-button" data-paste-image="${escapeHtml(target)}" type="button">Paste image</button><button class="button button-quiet image-menu-button" data-image-menu type="button" aria-label="More image options" aria-expanded="false">⌄</button><div class="image-action-menu" role="menu"><label class="image-menu-item" role="menuitem">Upload image${uploadInput}</label><button class="image-menu-item" data-find-image="${escapeHtml(target)}" type="button" role="menuitem">Find image</button></div></div>`;
}

function attachedImagePreview(assetId, alt) {
  if (!assetId) return "";
  const asset = mediaAssets.find((entry) => entry.id === assetId && entry.kind === "image");
  // A valid private asset ID is enough to try the authenticated Worker preview.
  // Do not equate a failed/stale media-library listing with a deleted object.
  if (!asset && !uploadedImagePreviewUrls.has(assetId) && !validAssetId(assetId)) {
    if (!mediaAssetsLoaded) return `<div class="missing-image-preview is-loading"><strong>Loading private image…</strong><span>Checking your private media library.</span></div>`;
    return `<div class="missing-image-preview"><strong>Image unavailable</strong><span>This older placeholder is not an uploaded private image.</span></div>`;
  }
  return `<figure class="attached-image-preview"><img data-media-preview="${escapeHtml(assetId)}" alt="${escapeHtml(alt)}" /><figcaption>Attached private image</figcaption></figure>`;
}

function imageReformatButton(target) {
  return `<button class="button button-quiet asset-reformat" data-reformat-image="${escapeHtml(target)}" type="button">Reformat image</button>`;
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ bank, selection, savedAt: new Date().toISOString() })); } catch { /* A browser with full storage still keeps the open draft. */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* Storage may be disabled. */ }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function restorePublishedSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(PUBLISHED_SNAPSHOT_KEY) || "null");
    return snapshot?.bank && Array.isArray(snapshot.bank.rounds) ? snapshot.bank : null;
  } catch { return null; }
}

function rememberPublishedSnapshot() {
  lastPublishedBank = clone(bank);
  try { localStorage.setItem(PUBLISHED_SNAPSHOT_KEY, JSON.stringify({ bank: lastPublishedBank, publishedAt: new Date().toISOString() })); } catch { /* The exported backup remains available. */ }
}

function hasUnpublishedChanges() {
  return !lastPublishedBank || canonicalJson(bank) !== canonicalJson(lastPublishedBank);
}

function syncPublishControl() {
  const publish = $("#publish");
  if (!publish) return;
  const changed = Boolean(bank) && hasUnpublishedChanges();
  publish.disabled = !currentUser || !changed;
  publish.textContent = currentUser ? changed ? "Publish new version" : "Publish new version" : "Publish version";
  publish.title = !currentUser ? "Sign in to publish." : changed ? "Publish this new version." : "No unpublished changes. Your working JSON matches the most recently published version.";
}

function restoredDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    // An in-progress draft is allowed to be temporarily invalid (for example,
    // while its prompt or answer list is being rewritten). Publication still
    // validates strictly, but refresh must never discard editable work.
    if (!draft?.bank || !Array.isArray(draft.bank.rounds) || !draft.bank.rounds.length || draft.bank.rounds.some((round) => !Array.isArray(round?.questions) || !round.questions.length)) return null;
    const roundIndex = Math.min(Math.max(0, Number(draft.selection?.roundIndex) || 0), draft.bank.rounds.length - 1);
    const questionIndex = Math.min(Math.max(0, Number(draft.selection?.questionIndex) || 0), draft.bank.rounds[roundIndex].questions.length - 1);
    return { bank: draft.bank, selection: { roundIndex, questionIndex } };
  } catch { return null; }
}

function validateQuiz(candidate) {
  const errors = [];
  const supportedTypes = new Set(["single_choice", "multiple_choice", "true_false", "image_selection", "short_answer", "fill_in_the_blank", "multi_fill_in_the_blank", "arrange_in_order", "categorize", "matching", "closest_number"]);
  const requiredText = (value) => typeof value === "string" && value.trim();
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["Quiz must be a JSON object."];
  if (!requiredText(candidate.id)) errors.push("Quiz ID is required.");
  if (!requiredText(candidate.title)) errors.push("Quiz title is required.");
  if (candidate.titlePage !== undefined && (!candidate.titlePage || typeof candidate.titlePage !== "object" || Array.isArray(candidate.titlePage))) errors.push("Title page must be an object when provided.");
  if (candidate.titlePage?.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.titlePage.audio.mediaAssetId)) errors.push("Title page has an invalid private audio asset ID.");
  for (const [key, audio] of Object.entries(candidate.finale?.audio || {})) if (audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audio.mediaAssetId)) errors.push(`Finale ${key} has an invalid private audio asset ID.`);
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

  const roundIds = new Set();
  const questionIds = new Set();
  candidate.rounds.forEach((round, roundIndex) => {
    const roundLabel = `Round ${roundIndex + 1}`;
    if (!round || typeof round !== "object") { errors.push(`${roundLabel} must be an object.`); return; }
    if (!requiredText(round.id)) errors.push(`${roundLabel} needs an ID.`);
    else if (roundIds.has(round.id)) errors.push(`${roundLabel} has a duplicate round ID: ${round.id}.`);
    else roundIds.add(round.id);
    if (!requiredText(round.title)) errors.push(`${roundLabel} needs a title.`);
    if (!Array.isArray(round.questions) || round.questions.length === 0) { errors.push(`${roundLabel} needs at least one question.`); return; }

    round.questions.forEach((item, questionIndex) => {
      const label = `${roundLabel}, question ${questionIndex + 1}`;
      if (!item || typeof item !== "object") { errors.push(`${label} must be an object.`); return; }
      if (!requiredText(item.id)) errors.push(`${label} needs an ID.`);
      else if (questionIds.has(item.id)) errors.push(`${label} has a duplicate question ID: ${item.id}.`);
      else questionIds.add(item.id);
      if (!supportedTypes.has(item.type)) errors.push(`${label} has an unsupported question type.`);
      if (!requiredText(item.prompt)) errors.push(`${label} needs a player prompt.`);
      if (item.audio?.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.audio.mediaAssetId)) errors.push(`${label} has an invalid private media asset ID.`);
      // Image asset IDs may be opaque local placeholders (for planned artwork) or
      // UUIDs issued by the private-media library. Both are valid authoring states.
      const questionPoints = item.points ?? item.scoring?.points;
      if (!["matching", "multi_fill_in_the_blank"].includes(item.type) && (!Number.isFinite(Number(questionPoints)) || Number(questionPoints) <= 0)) errors.push(`${label} needs positive points.`);

      const optionTypes = new Set(["single_choice", "multiple_choice", "true_false", "image_selection"]);
      if (optionTypes.has(item.type)) {
        const optionIds = new Set((item.options || []).map((option) => option?.id));
        if (!Array.isArray(item.options) || item.options.length < 2 || item.options.some((option) => !requiredText(option?.id) || !requiredText(option?.label))) errors.push(`${label} needs at least two labeled options with IDs.`);
        if (!Array.isArray(item.correctOptionIds) || item.correctOptionIds.length === 0 || item.correctOptionIds.some((id) => !optionIds.has(id))) errors.push(`${label} has an invalid answer key.`);
      }
      if (item.type === "short_answer" && (!Array.isArray(item.acceptedAnswers) || item.acceptedAnswers.every((answer) => !requiredText(answer)))) errors.push(`${label} needs an accepted answer.`);
      if (item.type === "closest_number" && !validNumericLiteral(item.targetNumber)) errors.push(`${label} needs a valid target number.`);
      if (item.type === "fill_in_the_blank" && (!Array.isArray(item.blanks) || item.blanks.length === 0 || item.blanks.some((blank) => !Array.isArray(blank.acceptedAnswers) || blank.acceptedAnswers.every((answer) => !requiredText(answer))))) errors.push(`${label} needs accepted answers for every blank.`);
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
      if (item.type === "multi_fill_in_the_blank" && (!Number.isFinite(Number(item.pointsPerBlank)) || Number(item.pointsPerBlank) <= 0 || !Array.isArray(item.clips) || item.clips.length < 2 || item.clips.some((clip) => !requiredText(clip?.id) || !requiredText(clip?.label) || !Array.isArray(clip.acceptedAnswers) || clip.acceptedAnswers.every((answer) => !requiredText(answer))))) errors.push(`${label} needs labeled clips, accepted answers for every clip, and positive points per blank.`);
    });
  });
  return errors;
}

function validationSummary(candidate) {
  const errors = validateQuiz(candidate);
  return errors.length ? `Fix ${errors.length} issue${errors.length === 1 ? "" : "s"}: ${errors.slice(0, 3).join(" ")}${errors.length > 3 ? " …" : ""}` : "Quiz is valid and ready to download or publish.";
}

function changeQuestionType(type) {
  const current = question();
  const base = { id: current.id, type, prompt: current.prompt, points: current.points || 1, hostReveal: current.hostReveal || "Add the answer reveal note." };
  if (current.audio) base.audio = current.audio;
  if (["single_choice", "multiple_choice", "image_selection"].includes(type)) Object.assign(base, { options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], correctOptionIds: ["a"] });
  if (type === "true_false") Object.assign(base, { options: [{ id: "true", label: "True" }, { id: "false", label: "False" }], correctOptionIds: ["true"] });
  if (type === "short_answer") base.acceptedAnswers = ["Answer"];
  if (type === "closest_number") base.targetNumber = 100;
  if (type === "fill_in_the_blank") base.blanks = [{ acceptedAnswers: ["Answer"] }];
  if (type === "arrange_in_order") Object.assign(base, { items: [{ id: "one", label: "First item" }, { id: "two", label: "Second item" }], correctOrder: ["one", "two"] });
  if (type === "categorize") Object.assign(base, { categories: [{ id: "category-a", label: "Category A" }, { id: "category-b", label: "Category B" }], items: [{ id: "item-1", label: "First item" }, { id: "item-2", label: "Second item" }], correctCategories: { "item-1": "category-a", "item-2": "category-b" } });
  if (type === "matching") Object.assign(base, { pointsPerPair: 1, options: [{ id: "movie-a", label: "Movie A" }, { id: "movie-b", label: "Movie B" }], clips: [{ id: "song-1", label: "Song title A" }, { id: "song-2", label: "Song title B" }], correctPairs: { "song-1": "movie-a", "song-2": "movie-b" } });
  if (type === "multi_fill_in_the_blank") Object.assign(base, { pointsPerBlank: 1, clips: [{ id: "clip-1", label: "Intro 1", acceptedAnswers: ["Song title A"] }, { id: "clip-2", label: "Intro 2", acceptedAnswers: ["Song title B"] }] });
  bank.rounds[selection.roundIndex].questions[selection.questionIndex] = base;
  markChanged();
}

function markChanged() {
  saveDraft();
  $("#save-state").textContent = "Saved in this browser — download or publish when ready";
  $("#raw-json").value = JSON.stringify(bank, null, 2);
  renderQuizHealth();
  syncPublishControl();
}

function renderNav() {
  $("#nav-title").textContent = bank.title || "Untitled question bank";
  const needle = navSearch.trim().toLowerCase();
  const visibleRounds = bank.rounds.map((round, roundIndex) => {
    const roundMatches = round.title.toLowerCase().includes(needle);
    const visibleQuestions = round.questions.map((item, questionIndex) => ({ item, questionIndex })).filter(({ item }) => (!needle || roundMatches || `${item.prompt} ${item.type}`.toLowerCase().includes(needle)) && (!navTypeFilter || item.type === navTypeFilter));
    return { round, roundIndex, visibleQuestions };
  }).filter(({ visibleQuestions }) => visibleQuestions.length);
  $("#round-nav").innerHTML = visibleRounds.length ? visibleRounds.map(({ round, roundIndex, visibleQuestions }) => `
    <section class="round-group"><span class="round-label">${escapeHtml(round.title)} <b>${round.questions.length}</b></span>
      ${visibleQuestions.map(({ item, questionIndex }) => `<button class="nav-question ${selection.roundIndex === roundIndex && selection.questionIndex === questionIndex ? "is-active" : ""}" data-select="${roundIndex}:${questionIndex}"><small>${escapeHtml(typeLabel(item.type))}</small>${escapeHtml(item.prompt || "Untitled question")}</button>`).join("")}
    </section>`).join("") : `<p class="nav-empty">No questions match “${escapeHtml(navSearch)}”.</p>`;
  document.querySelectorAll("[data-select]").forEach((button) => button.addEventListener("click", () => {
    const [roundIndex, questionIndex] = button.dataset.select.split(":").map(Number);
    selection = { roundIndex, questionIndex }; render();
  }));
}

function renderQuizHealth() {
  const target = $("#quiz-health");
  if (!target || !bank) return;
  const questions = bank.rounds.flatMap((round) => round.questions || []);
  const errors = validateQuiz(bank);
  const typeCount = new Set(questions.map((item) => item.type)).size;
  const privateImages = questions.reduce((count, item) => count + (item.options || []).filter((option) => option.imageAssetId).length + (item.questionImageAssetId ? 1 : 0) + (item.revealImageAssetId ? 1 : 0), 0) + (bank.titlePage?.imageAssetId ? 1 : 0);
  const privateAudio = questions.filter((item) => item.audio?.mediaAssetId).length + (bank.titlePage?.audio?.mediaAssetId ? 1 : 0) + Object.values(bank.finale?.audio || {}).filter((audio) => audio?.mediaAssetId).length;
  target.innerHTML = `<p class="eyebrow">Quiz health</p><strong>${questions.length} questions · ${typeCount} formats</strong><span>${privateAudio} private audio clip${privateAudio === 1 ? "" : "s"} · ${privateImages} private image${privateImages === 1 ? "" : "s"}</span><span class="${errors.length ? "health-warning" : "health-good"}">${errors.length ? `${errors.length} issue${errors.length === 1 ? "" : "s"} to fix before publishing` : "Ready to publish"}</span>`;
}

function mediaAssetOptions(kind, currentId = "") {
  const assets = mediaAssets.filter((asset) => asset.kind === kind);
  const label = kind === "audio" ? "Choose uploaded audio" : "Choose uploaded image";
  return `<select data-existing-media="${kind}" data-current-media="${escapeHtml(currentId)}"><option value="">${label}</option>${assets.map((asset) => `<option value="${asset.id}" ${asset.id === currentId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select>`;
}

function privateAudioPreview(assetId, label = "Uploaded clip", target = "question") {
  if (!assetId) return "";
  return `<div class="audio-preview"><strong>${escapeHtml(label)}</strong><audio data-media-preview="${escapeHtml(assetId)}" controls preload="metadata"></audio><span data-audio-preview-status>Loading private clip…</span><button class="button button-danger asset-unlink" data-remove-audio="${escapeHtml(target)}" type="button">Remove audio</button></div>`;
}

function field(label, key, value, { textarea = false, type = "text" } = {}) {
  const control = textarea
    ? `<textarea data-field="${key}" aria-label="${escapeHtml(label)}">${escapeHtml(value)}</textarea>`
    : `<input type="${type}" data-field="${key}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" />`;
  return `<div class="field"><label>${label}</label>${control}</div>`;
}

function optionsEditor(item) {
  if (!item.options) return "";
  const isChoice = ["single_choice", "multiple_choice", "true_false", "image_selection"].includes(item.type);
  const isMatching = item.type === "matching";
  const supportsImages = ["image_selection", "matching"].includes(item.type);
  const rows = item.options.map((option, index) => {
    const checked = item.correctOptionIds?.includes(option.id) ? "checked" : "";
    const imageControls = supportsImages ? `${imageActionControls(`option:${index}`, `<input data-upload-image="${index}" type="file" accept="image/jpeg,image/png,image/webp" hidden />`)}<select data-existing-image="${index}"><option value="">Choose uploaded image</option>${mediaAssets.filter((asset) => asset.kind === "image").map((asset) => `<option value="${asset.id}" ${asset.id === option.imageAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select>` : "";
    return `<div class="option-row"><span class="choice-key">${letters(index)}</span><input data-option-label="${index}" value="${escapeHtml(option.label)}" aria-label="Option ${letters(index)}" />${imageControls}${isChoice ? `<label class="correct-check"><input type="${item.type === "multiple_choice" ? "checkbox" : "radio"}" name="correct-option" data-correct-option="${index}" ${checked} /> Correct</label>` : ""}${isMatching ? "" : `<button class="icon-button" data-remove-option="${index}" title="Remove option">×</button>`}</div>${supportsImages && option.imageAssetId ? `<div class="asset-attached">${attachedImagePreview(option.imageAssetId, `${option.label} preview`)}<p class="asset-status">Private image attached</p>${imageReformatButton(`option:${index}`)}<button class="button button-danger asset-unlink" data-remove-image="option:${index}" type="button">Remove image</button></div>` : ""}`;
  }).join("");
  return `<section class="section"><div class="section-head"><span class="section-label">${isMatching ? "Movie-poster targets" : "Answer options"}</span>${!isMatching ? '<button class="button button-quiet" data-add-option>+ Option</button>' : ""}</div>${isMatching ? '<p class="audio-editor-help">Players drag the song titles onto these fixed movie posters. Add a poster to each target when you want an image-based match.</p>' : ""}${rows}</section>`;
}

function answerEditor(item) {
  if (item.type === "closest_number") return `<section class="section"><span class="section-label">Closest-number answer</span><div class="field"><label>Correct number</label><input data-field="targetNumber" type="number" inputmode="decimal" step="any" value="${escapeHtml(item.targetNumber ?? "")}" /><small>Players enter a number; the closest guess wins. Exact tied guesses split the question points evenly.</small></div></section>`;
  if (item.type === "fill_in_the_blank") {
    const blanks = item.blanks || [];
    return `<section class="section"><span class="section-label">Accepted answers (comma-separated)</span>${blanks.map((blank, index) => `<div class="field"><input data-blank="${index}" value="${escapeHtml((blank.acceptedAnswers || []).join(", "))}" /></div>`).join("")}</section>`;
  }
  if (item.type === "short_answer") return `<section class="section"><span class="section-label">Accepted answers (comma-separated)</span><div class="field"><input data-accepted value="${escapeHtml((item.acceptedAnswers || []).join(", "))}" /></div></section>`;
  if (item.type === "arrange_in_order") {
    const items = item.items || [];
    return `<section class="section"><span class="section-label">Order items and correct positions</span>${items.map((entry, index) => `<div class="order-row"><span class="choice-key">${index + 1}</span><input data-order-label="${index}" value="${escapeHtml(entry.label)}" /><select data-order-correct="${index}">${items.map((_, position) => `<option value="${position}" ${item.correctOrder?.[position] === entry.id ? "selected" : ""}>Position ${position + 1}</option>`).join("")}</select></div>`).join("")}</section>`;
  }
  if (item.type === "categorize") {
    const categories = item.categories || [];
    return `<section class="section"><span class="section-label">Categories and correct assignments</span><div class="field-grid">${categories.map((category, index) => `<div class="field"><label>Category ${index + 1}</label><input data-category-label="${index}" value="${escapeHtml(category.label)}" /></div>`).join("")}</div>${(item.items || []).map((entry, index) => `<div class="pair-row"><span class="choice-key">${index + 1}</span><input data-category-item-label="${index}" value="${escapeHtml(entry.label)}" /><select data-category-correct="${index}">${categories.map((category) => `<option value="${category.id}" ${item.correctCategories?.[entry.id] === category.id ? "selected" : ""}>${escapeHtml(category.label)}</option>`).join("")}</select></div>`).join("")}</section>`;
  }
  if (item.type === "matching") {
    return `<section class="section"><span class="section-label">Draggables, audio, and answer key</span><p class="audio-editor-help">Each draggable owns a clip. Upload once, trim it, then use the compact player to verify it. The host chooses an intro to play; its tile lights up in Presentation.</p>${(item.clips || []).map((clip, index) => `<div class="matching-clip-author"><div class="pair-row"><span class="choice-key">${index + 1}</span><input data-clip-label="${index}" value="${escapeHtml(clip.label)}" aria-label="Draggable label" /><label class="button button-quiet option-upload">Trim and upload clip<input data-upload-clip-audio="${index}" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label><select data-pair="${index}">${item.options.map((option) => `<option value="${option.id}" ${item.correctPairs?.[clip.id] === option.id ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></div>${privateAudioPreview(clip.mediaAssetId, `${clip.label} preview`, `clip:${index}`)}</div>`).join("")}</section>`;
  }
  if (item.type === "multi_fill_in_the_blank") {
    return `<section class="section"><span class="section-label">Audio clips and accepted song titles</span><p class="audio-editor-help">Each numbered field owns one clip. Enter comma-separated accepted spellings; players see only the number and a title field.</p>${(item.clips || []).map((clip, index) => `<div class="matching-clip-author"><div class="pair-row"><span class="choice-key">${index + 1}</span><input data-clip-label="${index}" value="${escapeHtml(clip.label)}" aria-label="Clip label" /><label class="button button-quiet option-upload">Trim and upload clip<input data-upload-clip-audio="${index}" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label><input data-clip-accepted="${index}" value="${escapeHtml((clip.acceptedAnswers || []).join(", "))}" aria-label="Accepted titles for ${escapeHtml(clip.label)}" /></div>${privateAudioPreview(clip.mediaAssetId, `${clip.label} preview`, `clip:${index}`)}</div>`).join("")}</section>`;
  }
  return revealImageEditor(item);
}

function revealImageEditor(item) {
  return `<section class="section"><div class="section-head"><span class="section-label">Optional answer-reveal image</span>${imageActionControls("reveal", '<input data-upload-reveal-image type="file" accept="image/jpeg,image/png,image/webp" hidden />')}</div><p class="audio-editor-help">This is hidden while players answer, then appears with the answer reveal on the presentation screen and player phones.</p><div class="field"><label>Reuse private image</label><select data-existing-reveal-image><option value="">Choose uploaded image</option>${mediaAssets.filter((asset) => asset.kind === "image").map((asset) => `<option value="${asset.id}" ${asset.id === item.revealImageAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></div>${item.revealImageAssetId ? `<div class="asset-attached">${attachedImagePreview(item.revealImageAssetId, "Answer-reveal image preview")}<p class="asset-status">Reveal image attached</p>${imageReformatButton("reveal")}<button class="button button-danger asset-unlink" data-remove-image="reveal" type="button">Remove image</button></div>` : ""}</section>`;
}

function questionImageEditor(item) {
  if (!["single_choice", "fill_in_the_blank"].includes(item.type)) return "";
  return `<section class="section"><div class="section-head"><span class="section-label">Optional question image</span>${imageActionControls("question-image", '<input data-upload-question-image type="file" accept="image/jpeg,image/png,image/webp" hidden />')}</div><p class="audio-editor-help">This stays onscreen while players answer. If an answer-reveal image is attached, that image replaces it when the answer is revealed.</p><div class="field"><label>Reuse private image</label><select data-existing-question-image><option value="">Choose uploaded image</option>${mediaAssets.filter((asset) => asset.kind === "image").map((asset) => `<option value="${asset.id}" ${asset.id === item.questionImageAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></div>${item.questionImageAssetId ? `<div class="asset-attached">${attachedImagePreview(item.questionImageAssetId, "Question image preview")}<p class="asset-status">Question image attached</p>${imageReformatButton("question-image")}<button class="button button-danger asset-unlink" data-remove-image="question-image" type="button">Remove image</button></div>` : ""}</section>`;
}

function audioEditor(item) {
  const audio = item.audio || {};
  return `<section class="section"><div class="section-head"><span class="section-label">Presentation audio cue</span><label class="button button-quiet">Trim and upload clip<input data-upload-audio type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label></div><p class="audio-editor-help">Choose a source file, trim it in the browser, and optionally fade in or out. The presentation view plays the uploaded clip.</p>${privateAudioPreview(audio.mediaAssetId, audio.suggestedWindow || "Preview audio", "question")}<div class="field-grid">${field("Opaque asset ID", "audio.assetId", audio.assetId || "")}${field("Suggested window", "audio.suggestedWindow", audio.suggestedWindow || "")}</div>${field("Audio URL (optional fallback)", "audio.url", audio.url || "", { type: "url" })}${field("Production cue", "audio.cue", audio.cue || "", { textarea: true })}</section>`;
}

function betweenRoundSoundEditor(config) {
  const slots = [
    ["roundEnd", "End-of-round transition", "A short sting when the End of Round card arrives."],
    ["scoreboard", "Scoreboard transition", "A short sting as the scoreboard is revealed."],
    ["doorChoice", "Door selection", "Suspenseful music that begins when players choose a door."],
    ["roundStart", "Next-round transition", "A short sting when the Round card arrives."]
  ];
  return `<section class="between-round-sounds"><div><span class="section-label">Auto-triggered presentation sound</span><p class="audio-editor-help">Every slot is optional. These clips play only in the shared Presentation tab after its one-time sound setup; player phones stay silent.</p></div><div class="between-round-sound-grid">${slots.map(([key, label, help]) => {
    const audio = config.audio?.[key] || {};
    return `<article class="between-round-sound"><strong>${label}</strong><p>${help}</p>${privateAudioPreview(audio.mediaAssetId, `${label} preview`, `between:${key}`)}<label class="button button-quiet option-upload">Trim and upload clip<input data-upload-between-round-audio="${key}" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label><label class="field"><span>Reuse private audio</span><select data-existing-between-round-audio="${key}"><option value="">No auto sound</option>${mediaAssets.filter((asset) => asset.kind === "audio").map((asset) => `<option value="${asset.id}" ${asset.id === audio.mediaAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></label>${audio.mediaAssetId ? `<button class="button button-danger asset-unlink" data-remove-between-round-audio="${key}" type="button">Remove sound</button>` : ""}</article>`;
  }).join("")}</div></section>`;
}

function betweenRoundBonusEditor() {
  const config = bonusConfig();
  const iconOptions = [
    ["shield", "Shield"], ["dice", "Dice"], ["lightning", "Lightning"],
    ["star", "Star"], ["key", "Key"], ["flame", "Flame"]
  ];
  const doorCards = (config.doors || []).map((door, doorIndex) => {
    const expected = (door.outcomes || []).reduce((sum, outcome) => sum + Number(outcome.chancePercent || 0) / 100 * Number(outcome.multiplier || 0), 0);
    return `<article class="bonus-author-door"><div class="bonus-author-door-head"><span class="bonus-author-icon bonus-author-icon--${escapeHtml(door.icon)}" aria-hidden="true"></span><strong>Door ${doorIndex + 1}</strong><span>Expected ${expected.toFixed(2)}×</span></div><div class="field-grid"><div class="field"><label>Door name</label><input data-bonus-door-name="${doorIndex}" value="${escapeHtml(door.name)}" maxlength="32" /></div><div class="field"><label>Icon</label><select data-bonus-door-icon="${doorIndex}">${iconOptions.map(([value, label]) => `<option value="${value}" ${door.icon === value ? "selected" : ""}>${label}</option>`).join("")}</select></div></div><div class="bonus-outcomes"><span class="section-label">Possible outcomes</span>${(door.outcomes || []).map((outcome, outcomeIndex) => `<div class="bonus-outcome-row"><label>Chance <span><input data-bonus-chance="${doorIndex}:${outcomeIndex}" type="number" min="0.01" max="100" step="0.01" value="${escapeHtml(outcome.chancePercent)}" />%</span></label><label>Multiplier <span><input data-bonus-multiplier="${doorIndex}:${outcomeIndex}" type="number" min="0.01" max="10" step="0.01" value="${escapeHtml(outcome.multiplier)}" />×</span></label>${door.outcomes.length > 1 ? `<button class="icon-button" data-remove-bonus-outcome="${doorIndex}:${outcomeIndex}" type="button" aria-label="Remove outcome">×</button>` : ""}</div>`).join("")}<button class="button button-quiet bonus-add-outcome" data-add-bonus-outcome="${doorIndex}" type="button">+ Add outcome</button></div></article>`;
  }).join("");
  return `<section class="section between-round-bonus-editor"><div class="section-head"><div><span class="section-label">Between-round door bonus</span><p class="audio-editor-help">After every round, players see an end-of-round card and the scoreboard before choosing a door. Rewards affect automatic points in that next round only.</p></div><label class="bonus-enabled"><input data-bonus-enabled type="checkbox" ${config.enabled ? "checked" : ""} /> Enabled</label></div><div class="bonus-author-grid ${config.enabled ? "" : "is-disabled"}">${doorCards}</div>${betweenRoundSoundEditor(config)}<div class="bonus-author-footer"><span>Balanced defaults target an expected 1.20× for every door.</span><button class="button button-quiet" data-reset-bonus type="button">Restore balanced defaults</button></div></section>`;
}

function titlePageEditor() {
  const opening = titlePage();
  const audio = opening.audio || {};
  return `<section class="section section-first title-page-editor"><div class="section-head"><span class="section-label">Opening title page</span><span class="asset-status">Presentation waiting room</span></div><p class="audio-editor-help">This appears before the first question. Add optional transparent theme art and waiting-room music; neither is a scored question.</p><div class="field-grid">${field("Quiz title", "quiz-title", bank.title)}<div class="field"><label>Title-page subtitle</label><textarea data-title-field="subtitle">${escapeHtml(opening.subtitle || "Get your phone ready — we’ll begin shortly.")}</textarea></div><div class="field"><label>Title-card circle icon</label><input data-title-field="icon" maxlength="8" value="${escapeHtml(opening.icon || "♫")}" /><small>Use an emoji or a short symbol; it replaces the yellow music note on the title card.</small></div><div class="field"><label>Theme artwork alt text</label><input data-title-field="imageAlt" value="${escapeHtml(opening.imageAlt || "Quiz theme artwork")}" /></div></div><div class="section-head"><span class="section-label">Theme artwork</span>${imageActionControls("title", '<input data-upload-title-image type="file" accept="image/jpeg,image/png,image/webp" hidden />')}</div><div class="field"><label>Reuse private image</label><select data-existing-title-image><option value="">Choose uploaded image</option>${mediaAssets.filter((asset) => asset.kind === "image").map((asset) => `<option value="${asset.id}" ${asset.id === opening.imageAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></div>${opening.imageAssetId ? `<div class="asset-attached">${attachedImagePreview(opening.imageAssetId, opening.imageAlt || "Title-page art preview")}<p class="asset-status">Title artwork attached</p>${imageReformatButton("title")}<button class="button button-danger asset-unlink" data-remove-title-image type="button">Remove image</button></div>` : ""}<div class="section-head"><span class="section-label">Waiting-room music</span><label class="button button-quiet">Trim and upload clip<input data-upload-title-audio type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label></div><p class="audio-editor-help">The host alone gets playback controls. Audio plays through Presentation after its one-time sound setup.</p><div class="field-grid">${field("Music label", "title-audio.suggestedWindow", audio.suggestedWindow || "Waiting-room music")}${field("Audio URL (optional fallback)", "title-audio.url", audio.url || "", { type: "url" })}</div><div class="field"><label>Reuse private audio</label><select data-existing-title-audio><option value="">Choose uploaded audio</option>${mediaAssets.filter((asset) => asset.kind === "audio").map((asset) => `<option value="${asset.id}" ${asset.id === audio.mediaAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></div>${audio.mediaAssetId ? '<button class="button button-danger asset-unlink" data-remove-title-audio type="button">Remove waiting-room music</button>' : ""}</section>`;
}

function finaleEditor() {
  const finale = finaleConfig();
  const slots = [
    ["drumroll", "Winner drumroll", "Starts when the host opens the full-screen ‘And the winner is…’ cue."],
    ["outro", "Closing music", "Starts when the host shows the final title-style score screen as people leave."]
  ];
  return `<section class="section finale-editor"><div class="section-head"><div><span class="section-label">Finale audio</span><p class="audio-editor-help">The finale is host-cued: suspense, podium, then final standings. These optional clips play only in the shared Presentation tab.</p></div><span class="asset-status">Host controlled</span></div><div class="between-round-sound-grid">${slots.map(([key, label, help]) => { const audio = finale.audio?.[key] || {}; return `<article class="between-round-sound"><strong>${label}</strong><p>${help}</p>${audio.mediaAssetId ? privateAudioPreview(audio.mediaAssetId, `${label} preview`, `finale:${key}`) : ""}<label class="button button-quiet option-upload">Trim and upload clip<input data-upload-finale-audio="${key}" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/x-wav" hidden /></label><label class="field"><span>Reuse private audio</span><select data-existing-finale-audio="${key}"><option value="">No sound</option>${mediaAssets.filter((asset) => asset.kind === "audio").map((asset) => `<option value="${asset.id}" ${asset.id === audio.mediaAssetId ? "selected" : ""}>${escapeHtml(asset.display_name || asset.source_title || asset.id.slice(0, 8))} · ${formatBytes(asset.byte_size)}</option>`).join("")}</select></label></article>`; }).join("")}</div></section>`;
}

function renderEditor() {
  const item = question();
  const round = selectedRound();
  if (!item) { $("#form-editor").innerHTML = $("#empty-state").innerHTML; return; }
  $("#question-location").textContent = `${round.title} · Question ${selection.questionIndex + 1}`;
  $("#editor-title").textContent = item.id || "Question editor";
  $("#form-editor").innerHTML = `
    ${selection.roundIndex === 0 && selection.questionIndex === 0 ? `${titlePageEditor()}${betweenRoundBonusEditor()}${finaleEditor()}` : ""}<section class="section"><span class="section-label">Round details</span><div class="field-grid">${field("Round title", "round-title", round.title)}</div></section>
    <div class="field-grid">${field("Question ID", "id", item.id)}<div class="field"><label>Question type</label><select data-field="type" aria-label="Question type">${["single_choice","multiple_choice","true_false","image_selection","arrange_in_order","categorize","fill_in_the_blank","multi_fill_in_the_blank","short_answer","closest_number","matching"].map((type) => `<option value="${type}" ${item.type === type ? "selected" : ""}>${escapeHtml(typeLabel(type))}</option>`).join("")}</select></div></div>
    ${field("Player prompt", "prompt", item.prompt, { textarea: true })}
    <div class="field-grid">${field(item.type === "matching" ? "Points per pair" : item.type === "multi_fill_in_the_blank" ? "Points per blank" : "Points", item.type === "matching" ? "pointsPerPair" : item.type === "multi_fill_in_the_blank" ? "pointsPerBlank" : "points", item.type === "matching" ? item.pointsPerPair : item.type === "multi_fill_in_the_blank" ? item.pointsPerBlank : item.points, { type: "number" })}${field("Host reveal", "hostReveal", item.hostReveal || "", { textarea: true })}</div>
    ${audioEditor(item)}${questionImageEditor(item)}${optionsEditor(item)}${answerEditor(item)}${["fill_in_the_blank", "multi_fill_in_the_blank", "short_answer", "arrange_in_order", "categorize", "matching", "closest_number"].includes(item.type) ? revealImageEditor(item) : ""}
  `;
  bindEditorEvents();
}

function renderPreview() {
  const item = question();
  if (!item) { $("#preview").innerHTML = ""; return; }
  const correct = new Set(item.correctOptionIds || []);
  let body = "";
  if (item.options) body = `<div class="preview-options">${item.options.map((option, index) => `<div class="preview-option ${correct.has(option.id) ? "correct" : ""}"><span class="choice-key">${letters(index)}</span>${escapeHtml(option.label)}</div>`).join("")}</div>`;
  if (item.type === "matching") body = `<div class="preview-answer">10-pair finale · ${item.pointsPerPair || 1} point per correct match</div>`;
  if (item.type === "multi_fill_in_the_blank") body = `<div class="preview-answer">${(item.clips || []).length}-blank audio finale · ${item.pointsPerBlank || 1} point per correct title · answers save automatically</div>`;
  if (["fill_in_the_blank", "short_answer"].includes(item.type)) body = `<div class="preview-answer">Free-text response · accepted answer variants are graded automatically.</div>`;
  if (item.type === "closest_number") body = `<div class="preview-answer">Closest-number round · target: ${escapeHtml(item.targetNumber)} · tied closest guesses split ${escapeHtml(item.points)} point${Number(item.points) === 1 ? "" : "s"}.</div>`;
  if (item.type === "arrange_in_order") body = `<div class="preview-options">${(item.items || []).map((entry, index) => `<div class="preview-option"><span class="choice-key">${index + 1}</span>${escapeHtml(entry.label)}</div>`).join("")}</div>`;
  if (item.type === "categorize") body = `<div class="preview-answer">${(item.categories || []).map((category) => escapeHtml(category.label)).join(" vs. ")} · ${(item.items || []).length} items to sort</div>`;
  if (item.revealImageAssetId) body += `<div class="preview-answer">Optional answer-reveal image attached.</div>`;
  $("#preview").innerHTML = `<span class="preview-type">${escapeHtml(typeLabel(item.type))}</span><h2>${escapeHtml(item.prompt)}</h2>${item.audio ? `<div class="preview-answer"><strong>Host audio:</strong> ${escapeHtml(item.audio.suggestedWindow || "Clip")}</div>` : ""}${body}<div class="preview-answer"><strong>Reveal:</strong> ${escapeHtml(item.hostReveal || "Add a host reveal note.")}</div>`;
}

function render() { renderNav(); renderQuizHealth(); renderEditor(); renderPreview(); $("#raw-json").value = JSON.stringify(bank, null, 2); }

function updateField(key, value) {
  const item = question();
  if (key.startsWith("title-audio.")) { titlePage().audio ||= {}; titlePage().audio[key.slice(12)] = value; } else if (key.startsWith("audio.")) { item.audio ||= {}; item.audio[key.slice(6)] = value; } else item[key] = ["points", "pointsPerPair", "pointsPerBlank", "targetNumber"].includes(key) ? Number(value) : value;
  markChanged(); renderNav(); renderQuizHealth(); renderPreview();
}

function bindEditorEvents() {
  $("[data-bonus-enabled]")?.addEventListener("change", (event) => { bonusConfig().enabled = event.target.checked; markChanged(); renderEditor(); });
  document.querySelectorAll("[data-bonus-door-name]").forEach((input) => input.addEventListener("input", () => { bonusConfig().doors[Number(input.dataset.bonusDoorName)].name = input.value; markChanged(); }));
  document.querySelectorAll("[data-bonus-door-icon]").forEach((select) => select.addEventListener("change", () => { bonusConfig().doors[Number(select.dataset.bonusDoorIcon)].icon = select.value; markChanged(); renderEditor(); }));
  document.querySelectorAll("[data-bonus-chance], [data-bonus-multiplier]").forEach((input) => input.addEventListener("change", () => { const [doorIndex, outcomeIndex] = String(input.dataset.bonusChance || input.dataset.bonusMultiplier).split(":").map(Number); const fieldName = input.dataset.bonusChance ? "chancePercent" : "multiplier"; bonusConfig().doors[doorIndex].outcomes[outcomeIndex][fieldName] = Number(input.value); markChanged(); renderEditor(); }));
  document.querySelectorAll("[data-add-bonus-outcome]").forEach((button) => button.addEventListener("click", () => { bonusConfig().doors[Number(button.dataset.addBonusOutcome)].outcomes.push({ chancePercent: 10, multiplier: 1 }); markChanged(); renderEditor(); }));
  document.querySelectorAll("[data-remove-bonus-outcome]").forEach((button) => button.addEventListener("click", () => { const [doorIndex, outcomeIndex] = button.dataset.removeBonusOutcome.split(":").map(Number); bonusConfig().doors[doorIndex].outcomes.splice(outcomeIndex, 1); markChanged(); renderEditor(); }));
  $("[data-reset-bonus]")?.addEventListener("click", () => { bank.betweenRoundBonus = clone(DEFAULT_BETWEEN_ROUND_BONUS); markChanged(); renderEditor(); });
  document.querySelectorAll("[data-field]").forEach((input) => {
    if (["quiz-title", "round-title"].includes(input.dataset.field)) return;
    const commit = () => { input.dataset.field === "type" ? changeQuestionType(input.value) : updateField(input.dataset.field, input.value); renderEditor(); renderPreview(); };
    if (input.tagName === "SELECT" || input.type === "number") input.addEventListener("change", commit);
    else input.addEventListener("input", () => {
      const key = input.dataset.field;
      const item = question();
      if (key.startsWith("title-audio.")) { titlePage().audio ||= {}; titlePage().audio[key.slice(12)] = input.value; } else if (key.startsWith("audio.")) { item.audio ||= {}; item.audio[key.slice(6)] = input.value; } else item[key] = input.value;
      markChanged(); renderNav(); renderPreview();
    });
  });
  $("[data-field='quiz-title']")?.addEventListener("input", (event) => { bank.title = event.target.value; markChanged(); renderNav(); });
  document.querySelectorAll("[data-title-field]").forEach((input) => input.addEventListener("input", () => { titlePage()[input.dataset.titleField] = input.value; markChanged(); renderPreview(); }));
  $("[data-field='round-title']")?.addEventListener("input", (event) => { selectedRound().title = event.target.value; markChanged(); renderNav(); $("#question-location").textContent = `${event.target.value} · Question ${selection.questionIndex + 1}`; });
  document.querySelectorAll("[data-option-label]").forEach((input) => input.addEventListener("input", () => { question().options[Number(input.dataset.optionLabel)].label = input.value; markChanged(); renderNav(); renderPreview(); }));
  document.querySelectorAll("[data-correct-option]").forEach((input) => input.addEventListener("change", () => { const option = question().options[Number(input.dataset.correctOption)]; if (question().type === "multiple_choice") { const set = new Set(question().correctOptionIds || []); input.checked ? set.add(option.id) : set.delete(option.id); question().correctOptionIds = [...set]; } else question().correctOptionIds = [option.id]; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll("[data-remove-option]").forEach((button) => button.addEventListener("click", () => { const index = Number(button.dataset.removeOption); const [removed] = question().options.splice(index, 1); question().correctOptionIds = (question().correctOptionIds || []).filter((id) => id !== removed.id); markChanged(); render(); }));
  $("[data-add-option]")?.addEventListener("click", () => { const item = question(); item.options.push({ id: crypto.randomUUID(), label: "New option" }); markChanged(); render(); });
  document.querySelectorAll("[data-blank]").forEach((input) => input.addEventListener("input", () => { question().blanks[Number(input.dataset.blank)].acceptedAnswers = input.value.split(",").map((entry) => entry.trim()).filter(Boolean); markChanged(); renderPreview(); }));
  $("[data-accepted]")?.addEventListener("input", (event) => { question().acceptedAnswers = event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean); markChanged(); renderPreview(); });
  document.querySelectorAll("[data-order-label]").forEach((input) => input.addEventListener("input", () => { question().items[Number(input.dataset.orderLabel)].label = input.value; markChanged(); renderPreview(); }));
  document.querySelectorAll("[data-order-correct]").forEach((select) => select.addEventListener("change", () => { const item = question(); const selectedItem = item.items[Number(select.dataset.orderCorrect)]; item.correctOrder[Number(select.value)] = selectedItem.id; markChanged(); }));
  document.querySelectorAll("[data-category-label]").forEach((input) => input.addEventListener("input", () => { question().categories[Number(input.dataset.categoryLabel)].label = input.value; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll("[data-category-item-label]").forEach((input) => input.addEventListener("input", () => { question().items[Number(input.dataset.categoryItemLabel)].label = input.value; markChanged(); renderPreview(); }));
  document.querySelectorAll("[data-category-correct]").forEach((select) => select.addEventListener("change", () => { const item = question(); const selectedItem = item.items[Number(select.dataset.categoryCorrect)]; item.correctCategories[selectedItem.id] = select.value; markChanged(); }));
  document.querySelectorAll("[data-clip-label]").forEach((input) => input.addEventListener("input", () => { question().clips[Number(input.dataset.clipLabel)].label = input.value; markChanged(); renderPreview(); }));
  document.querySelectorAll("[data-clip-accepted]").forEach((input) => input.addEventListener("input", () => { question().clips[Number(input.dataset.clipAccepted)].acceptedAnswers = input.value.split(",").map((entry) => entry.trim()).filter(Boolean); markChanged(); renderPreview(); }));
  document.querySelectorAll("[data-clip-media]").forEach((select) => select.addEventListener("change", () => { const clip = question().clips[Number(select.dataset.clipMedia)]; if (select.value) clip.mediaAssetId = select.value; else delete clip.mediaAssetId; markChanged(); }));
  document.querySelectorAll("[data-pair]").forEach((select) => select.addEventListener("change", () => { const clip = question().clips[Number(select.dataset.pair)]; question().correctPairs[clip.id] = select.value; markChanged(); renderPreview(); }));
  $("[data-add-audio]")?.addEventListener("click", () => { question().audio = { assetId: "audio-clip", suggestedWindow: "0:00–0:10", cue: "Describe when to play this clip." }; markChanged(); render(); });
  $("[data-upload-audio]")?.addEventListener("change", async (event) => { try { await uploadPrivateAudio(event.target.files?.[0]); } catch (error) { alert(`Could not upload private audio: ${error.message}`); $("#save-state").textContent = "Audio upload failed"; } finally { event.target.value = ""; } });
  $("[data-upload-title-audio]")?.addEventListener("change", async (event) => { try { await uploadPrivateAudio(event.target.files?.[0], "title"); } catch (error) { alert(`Could not upload waiting-room music: ${error.message}`); $("#save-state").textContent = "Waiting-room music upload failed"; } finally { event.target.value = ""; } });
  document.querySelectorAll("[data-upload-finale-audio]").forEach((input) => input.addEventListener("change", async (event) => { const audioKey = event.target.dataset.uploadFinaleAudio; try { await uploadPrivateAudio(event.target.files?.[0], { finaleAudioKey: audioKey }); } catch (error) { alert(`Could not upload finale audio: ${error.message}`); $("#save-state").textContent = "Finale audio upload failed"; } finally { event.target.value = ""; } }));
  document.querySelectorAll("[data-upload-between-round-audio]").forEach((input) => input.addEventListener("change", async (event) => { const audioKey = event.target.dataset.uploadBetweenRoundAudio; try { await uploadPrivateAudio(event.target.files?.[0], { betweenRoundAudioKey: audioKey }); } catch (error) { alert(`Could not upload between-round sound: ${error.message}`); $("#save-state").textContent = "Between-round sound upload failed"; } finally { event.target.value = ""; } }));
  document.querySelectorAll("[data-upload-clip-audio]").forEach((input) => input.addEventListener("change", async (event) => { try { await uploadPrivateAudio(event.target.files?.[0], { clipIndex: Number(event.target.dataset.uploadClipAudio) }); } catch (error) { alert(`Could not upload intro clip: ${error.message}`); $("#save-state").textContent = "Intro clip upload failed"; } finally { event.target.value = ""; } }));
  document.querySelectorAll("[data-upload-image]").forEach((input) => input.addEventListener("change", async (event) => { try { await uploadPrivateImage(event.target.files?.[0], Number(event.target.dataset.uploadImage)); } catch (error) { alert(`Could not upload private image: ${error.message}`); $("#save-state").textContent = "Image upload failed"; } finally { event.target.value = ""; } }));
  $("[data-upload-question-image]")?.addEventListener("change", async (event) => { try { await uploadPrivateImage(event.target.files?.[0], "question-image"); } catch (error) { alert(`Could not upload question image: ${error.message}`); $("#save-state").textContent = "Question image upload failed"; } finally { event.target.value = ""; } });
  $("[data-upload-reveal-image]")?.addEventListener("change", async (event) => { try { await uploadPrivateImage(event.target.files?.[0], "reveal"); } catch (error) { alert(`Could not upload reveal image: ${error.message}`); $("#save-state").textContent = "Reveal image upload failed"; } finally { event.target.value = ""; } });
  $("[data-upload-title-image]")?.addEventListener("change", async (event) => { try { await uploadPrivateImage(event.target.files?.[0], "title"); } catch (error) { alert(`Could not upload title artwork: ${error.message}`); $("#save-state").textContent = "Title artwork upload failed"; } finally { event.target.value = ""; } });
  document.querySelectorAll("[data-paste-image]").forEach((button) => button.addEventListener("click", () => armImagePaste(button.dataset.pasteImage)));
  document.querySelectorAll("[data-image-menu]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); const split = button.closest("[data-image-split]"); const isOpen = split.classList.toggle("is-open"); button.setAttribute("aria-expanded", String(isOpen)); document.querySelectorAll("[data-image-split].is-open").forEach((entry) => { if (entry !== split) { entry.classList.remove("is-open"); entry.querySelector("[data-image-menu]")?.setAttribute("aria-expanded", "false"); } }); }));
  document.querySelectorAll("[data-find-image]").forEach((button) => button.addEventListener("click", () => openImageFinder(button.dataset.findImage)));
  document.querySelectorAll("[data-existing-image]").forEach((select) => select.addEventListener("change", () => { const option = question().options[Number(select.dataset.existingImage)]; if (select.value) option.imageAssetId = select.value; else delete option.imageAssetId; markChanged(); renderEditor(); renderPreview(); }));
  $("[data-existing-reveal-image]")?.addEventListener("change", (event) => { question().revealImageAssetId = event.target.value || undefined; markChanged(); renderEditor(); renderPreview(); });
  $("[data-existing-question-image]")?.addEventListener("change", (event) => { question().questionImageAssetId = event.target.value || undefined; markChanged(); renderEditor(); renderPreview(); });
  $("[data-existing-title-image]")?.addEventListener("change", (event) => { titlePage().imageAssetId = event.target.value || undefined; markChanged(); renderEditor(); renderPreview(); });
  $("[data-existing-title-audio]")?.addEventListener("change", (event) => { titlePage().audio ||= {}; if (event.target.value) titlePage().audio.mediaAssetId = event.target.value; else delete titlePage().audio.mediaAssetId; markChanged(); renderEditor(); renderPreview(); });
  document.querySelectorAll("[data-existing-finale-audio]").forEach((select) => select.addEventListener("change", () => { const audioKey = select.dataset.existingFinaleAudio; finaleConfig().audio ||= {}; if (select.value) { finaleConfig().audio[audioKey] ||= {}; finaleConfig().audio[audioKey].mediaAssetId = select.value; } else delete finaleConfig().audio[audioKey]; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll("[data-existing-between-round-audio]").forEach((select) => select.addEventListener("change", () => { const audioKey = select.dataset.existingBetweenRoundAudio; bonusConfig().audio ||= {}; if (select.value) { bonusConfig().audio[audioKey] ||= {}; bonusConfig().audio[audioKey].mediaAssetId = select.value; } else delete bonusConfig().audio[audioKey]; markChanged(); renderEditor(); renderPreview(); }));
  $("[data-remove-title-image]")?.addEventListener("click", () => { delete titlePage().imageAssetId; markChanged(); renderEditor(); renderPreview(); });
  $("[data-remove-title-audio]")?.addEventListener("click", () => { delete titlePage().audio; markChanged(); renderEditor(); renderPreview(); });
  document.querySelectorAll("[data-remove-between-round-audio]").forEach((button) => button.addEventListener("click", () => { if (bonusConfig().audio) delete bonusConfig().audio[button.dataset.removeBetweenRoundAudio]; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll("[data-remove-audio]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.removeAudio;
    if (target === "question") {
      if (question().audio) delete question().audio.mediaAssetId;
    } else if (target.startsWith("finale:")) {
      if (finaleConfig().audio) delete finaleConfig().audio[target.slice(7)];
    } else if (target.startsWith("clip:")) {
      const clip = question().clips?.[Number(target.slice(5))];
      if (clip) delete clip.mediaAssetId;
    }
    markChanged();
    renderEditor();
    renderPreview();
  }));
  document.querySelectorAll("[data-remove-image]").forEach((button) => button.addEventListener("click", () => { const target = resolveImageFinderTarget(button.dataset.removeImage); if (!target) return; if (target.target === "reveal") delete question().revealImageAssetId; else if (target.target === "question-image") delete question().questionImageAssetId; else delete question().options[target.optionIndex].imageAssetId; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll("[data-reformat-image]").forEach((button) => button.addEventListener("click", () => reformatAttachedImage(button.dataset.reformatImage).catch((error) => { alert(`Could not reformat image: ${error.message}`); $("#save-state").textContent = "Image reformat failed"; })));
  document.querySelectorAll("[data-existing-media='audio']").forEach((select) => select.addEventListener("change", () => { if (!select.value) return; question().audio ||= {}; question().audio.mediaAssetId = select.value; markChanged(); renderEditor(); renderPreview(); }));
  document.querySelectorAll(".editor-card [data-media-preview]").forEach((element) => loadMediaPreview(element));
}

function armImagePaste(target) {
  const resolved = resolveImageFinderTarget(target);
  if (!resolved) return;
  pasteImageTarget = resolved.target;
  document.querySelectorAll("[data-image-split]").forEach((entry) => { entry.classList.remove("is-open"); entry.querySelector("[data-image-menu]")?.setAttribute("aria-expanded", "false"); });
  $("#save-state").textContent = `Paste ready for ${resolved.label} — press ⌘V to use an image from your clipboard.`;
}

async function pasteClipboardImage(event) {
  if (!pasteImageTarget) return;
  const imageItem = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  const target = resolveImageFinderTarget(pasteImageTarget);
  pasteImageTarget = null;
  const file = imageItem.getAsFile();
  if (!target || !file) return;
  try {
    $("#save-state").textContent = "Preparing pasted image…";
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    await uploadPrivateImage(new File([file], `pasted-image.${extension}`, { type: file.type }), ["title", "reveal", "question-image"].includes(target.target) ? target.target : target.optionIndex);
  } catch (error) {
    alert(`Could not paste private image: ${error.message}`);
    $("#save-state").textContent = "Pasted image upload failed";
  }
}

function addQuestion() {
  addQuestionTemplate("single_choice");
}

function addQuestionTemplate(type) {
  const round = selectedRound();
  const item = newQuestion();
  if (type && type !== "single_choice") {
    const base = { id: item.id, type, prompt: "New question", points: 1, hostReveal: "Add the answer reveal note." };
    if (["multiple_choice", "image_selection"].includes(type)) Object.assign(base, { options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], correctOptionIds: ["a"] });
    if (type === "true_false") Object.assign(base, { options: [{ id: "true", label: "True" }, { id: "false", label: "False" }], correctOptionIds: ["true"] });
    if (type === "short_answer") base.acceptedAnswers = ["Answer"];
    if (type === "closest_number") base.targetNumber = 100;
    if (type === "fill_in_the_blank") base.blanks = [{ acceptedAnswers: ["Answer"] }];
    if (type === "arrange_in_order") Object.assign(base, { items: [{ id: "one", label: "First item" }, { id: "two", label: "Second item" }], correctOrder: ["one", "two"] });
    if (type === "categorize") Object.assign(base, { categories: [{ id: "category-a", label: "Category A" }, { id: "category-b", label: "Category B" }], items: [{ id: "item-1", label: "First item" }, { id: "item-2", label: "Second item" }], correctCategories: { "item-1": "category-a", "item-2": "category-b" } });
    if (type === "matching") Object.assign(base, { pointsPerPair: 1, options: [{ id: "movie-a", label: "Movie A" }, { id: "movie-b", label: "Movie B" }], clips: [{ id: "song-1", label: "Song title A" }, { id: "song-2", label: "Song title B" }], correctPairs: { "song-1": "movie-a", "song-2": "movie-b" } });
    if (type === "multi_fill_in_the_blank") Object.assign(base, { pointsPerBlank: 1, clips: [{ id: "clip-1", label: "Intro 1", acceptedAnswers: ["Song title A"] }, { id: "clip-2", label: "Intro 2", acceptedAnswers: ["Song title B"] }] });
    round.questions.push(base);
  } else round.questions.push(item);
  selection.questionIndex = round.questions.length - 1; markChanged(); render();
}

function newQuiz() {
  if (!confirm("Start a new blank quiz? Any unsaved editor changes will be replaced.")) return;
  bank = {
    id: `quiz-${crypto.randomUUID().slice(0, 8)}`,
    title: "Untitled quiz",
    betweenRoundBonus: clone(DEFAULT_BETWEEN_ROUND_BONUS),
    rounds: [{
      id: "round-1",
      title: "Round 1",
      questions: [{ id: "question-1", type: "single_choice", prompt: "New question", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], correctOptionIds: ["a"], points: 1, hostReveal: "Add the answer reveal note." }]
    }]
  };
  selection = { roundIndex: 0, questionIndex: 0 };
  markChanged();
  render();
}

function duplicateQuestion() {
  const source = question();
  const round = selectedRound();
  if (!source || !round) return;
  const copy = clone(source);
  copy.id = `question-${crypto.randomUUID().slice(0, 8)}`;
  copy.prompt = `${source.prompt || "Untitled question"} (copy)`;
  round.questions.splice(selection.questionIndex + 1, 0, copy);
  selection.questionIndex += 1;
  markChanged();
  render();
}

function moveQuestion(offset) {
  const round = selectedRound();
  const destination = selection.questionIndex + offset;
  if (!round || destination < 0 || destination >= round.questions.length) return;
  [round.questions[selection.questionIndex], round.questions[destination]] = [round.questions[destination], round.questions[selection.questionIndex]];
  selection.questionIndex = destination;
  markChanged();
  render();
}

function selectQuestion(offset) {
  const round = selectedRound();
  if (!round) return;
  const next = selection.questionIndex + offset;
  if (next < 0 || next >= round.questions.length) return;
  selection.questionIndex = next;
  render();
}

function newQuestion() {
  return { id: `question-${crypto.randomUUID().slice(0, 8)}`, type: "single_choice", prompt: "New question", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], correctOptionIds: ["a"], points: 1, hostReveal: "Add the answer reveal note." };
}

async function uploadPrivateAudio(file, target = "question") {
  if (!file) return;
  if (!supabase || !currentUser) { alert("Sign in as an authorized quiz author before uploading media."); return; }
  if (!file.type.startsWith("audio/") || file.size > 26214400) { alert("Choose an audio file up to 25 MB."); return; }
  $("#save-state").textContent = "Preparing audio clip…";
  await saveOriginalMedia(file);
  const clipped = await chooseAudioClip(file);
  if (!clipped) { $("#save-state").textContent = "Audio upload cancelled"; return; }
  if (clipped.blob.size > 26214400) throw new Error("The rendered WAV clip is over 25 MB. Trim it shorter or use a smaller source file.");
  const storagePath = `${currentUser.id}/${crypto.randomUUID()}.wav`;
  $("#save-state").textContent = "Uploading rendered audio clip…";
  const { error: uploadError } = await supabase.storage.from("quiz-media").upload(storagePath, clipped.blob, { contentType: "audio/wav", upsert: false });
  if (uploadError) throw uploadError;
  const { data: asset, error: registrationError } = await supabase.rpc("register_media_asset", { p_storage_path: storagePath, p_kind: "audio", p_mime_type: "audio/wav", p_byte_size: clipped.blob.size });
  if (registrationError) throw registrationError;
  uploadedAudioPreviewUrls.set(asset.id, URL.createObjectURL(clipped.blob));
  await nameMediaAsset(asset.id, `${file.name.replace(/\.[^.]+$/, "")} · ${formatSeconds(clipped.duration)}`);
  if (target === "title") { titlePage().audio ||= {}; titlePage().audio.mediaAssetId = asset.id; }
  else if (target?.finaleAudioKey) { finaleConfig().audio ||= {}; finaleConfig().audio[target.finaleAudioKey] ||= {}; finaleConfig().audio[target.finaleAudioKey].mediaAssetId = asset.id; }
  else if (target?.betweenRoundAudioKey) { bonusConfig().audio ||= {}; bonusConfig().audio[target.betweenRoundAudioKey] ||= {}; bonusConfig().audio[target.betweenRoundAudioKey].mediaAssetId = asset.id; }
  else if (Number.isInteger(target?.clipIndex)) question().clips[target.clipIndex].mediaAssetId = asset.id;
  else { question().audio ||= {}; question().audio.mediaAssetId = asset.id; }
  await loadMediaAssets();
  markChanged();
  $("#save-state").textContent = `Rendered and loudness-leveled clip uploaded (${formatSeconds(clipped.duration)} · ${formatBytes(clipped.blob.size)}) — publish a new quiz version to use it.`;
  renderEditor();
  renderPreview();
}

async function uploadPrivateImage(file, optionIndex, source = null) {
  if (!file) return;
  if (!supabase || !currentUser) { alert("Sign in as an authorized quiz author before uploading media."); return; }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 104857600) { alert("Choose a JPG, PNG, or WebP image up to 100 MB."); return; }
  $("#save-state").textContent = "Preparing game-ready image…";
  const crop = await chooseImageCrop(file);
  if (!crop) { $("#save-state").textContent = "Image upload cancelled"; return; }
  const originalSource = await saveOriginalImage(file, optionIndex);
  const optimized = await optimizeImage(file, crop, { preserveAlpha: optionIndex === "title" });
  if (optimized.blob.size > 26214400) throw new Error("The optimized image is still over 25 MB. Choose a smaller source image.");
  const storagePath = `${currentUser.id}/${crypto.randomUUID()}.webp`;
  const { error: uploadError } = await supabase.storage.from("quiz-media").upload(storagePath, optimized.blob, { contentType: "image/webp", upsert: false });
  if (uploadError) throw uploadError;
  const { data: asset, error: registrationError } = await supabase.rpc("register_media_asset_with_source", { p_storage_path: storagePath, p_kind: "image", p_mime_type: "image/webp", p_byte_size: optimized.blob.size, p_source_url: source?.pageUrl || source?.originalUrl || "", p_source_title: source?.title || "", p_source_license: source?.license || "" });
  if (registrationError) throw registrationError;
  const priorPreview = uploadedImagePreviewUrls.get(asset.id);
  if (priorPreview) URL.revokeObjectURL(priorPreview);
  uploadedImagePreviewUrls.set(asset.id, URL.createObjectURL(optimized.blob));
  if (!mediaAssets.some((entry) => entry.id === asset.id)) mediaAssets.unshift({ ...asset, id: asset.id, kind: "image", storage_path: storagePath, byte_size: optimized.blob.size, display_name: source?.title || file.name });
  await nameMediaAsset(asset.id, source?.title || file.name);
  if (originalSource) rememberOriginalSource(asset.id, originalSource);
  if (optionIndex === "title") titlePage().imageAssetId = asset.id;
  else if (optionIndex === "reveal") question().revealImageAssetId = asset.id;
  else if (optionIndex === "question-image") question().questionImageAssetId = asset.id;
  else question().options[optionIndex].imageAssetId = asset.id;
  await loadMediaAssets();
  markChanged();
  $("#save-state").textContent = `Optimized image uploaded (${formatBytes(file.size)} → ${formatBytes(optimized.blob.size)})${originalSource ? "" : " · original copy was not saved; choose an originals folder to enable reformatting"} — publish a new quiz version to use it.`;
  renderEditor();
  renderPreview();
}

function imageAssetIdForTarget(target) {
  if (target === "title") return titlePage().imageAssetId;
  if (target === "reveal") return question().revealImageAssetId;
  if (target === "question-image") return question().questionImageAssetId;
  const optionIndex = Number(String(target).replace(/^option:/, ""));
  return question().options?.[optionIndex]?.imageAssetId;
}

async function reformatAttachedImage(target) {
  const assetId = imageAssetIdForTarget(target);
  const source = assetId && originalSourceIndex[assetId];
  if (!source) throw new Error("This image was uploaded before its original was saved locally. Paste or upload it again once to create a reusable source copy.");
  const file = await loadOriginalSourceFile(source);
  if (!file) throw new Error("The original source file is not available. Choose the same originals folder, then try again.");
  const resolved = resolveImageFinderTarget(target);
  if (!resolved) return;
  const optionIndex = ["title", "reveal", "question-image"].includes(resolved.target) ? resolved.target : resolved.optionIndex;
  const crop = await chooseImageCrop(file);
  if (!crop) { $("#save-state").textContent = "Image reformat cancelled"; return; }
  $("#save-state").textContent = "Rendering revised image…";
  const optimized = await optimizeImage(file, crop, { preserveAlpha: optionIndex === "title" });
  if (optimized.blob.size > 26214400) throw new Error("The optimized image is still over 25 MB. Choose a smaller source image.");
  const storagePath = `${currentUser.id}/${crypto.randomUUID()}.webp`;
  const { error: uploadError } = await supabase.storage.from("quiz-media").upload(storagePath, optimized.blob, { contentType: "image/webp", upsert: false });
  if (uploadError) throw uploadError;
  const { data: asset, error: registrationError } = await supabase.rpc("register_media_asset_with_source", { p_storage_path: storagePath, p_kind: "image", p_mime_type: "image/webp", p_byte_size: optimized.blob.size, p_source_url: "", p_source_title: "", p_source_license: "" });
  if (registrationError) throw registrationError;
  uploadedImagePreviewUrls.set(asset.id, URL.createObjectURL(optimized.blob));
  await nameMediaAsset(asset.id, `${file.name.replace(/\.[^.]+$/, "")} · reformatted`);
  rememberOriginalSource(asset.id, source);
  if (optionIndex === "title") titlePage().imageAssetId = asset.id;
  else if (optionIndex === "reveal") question().revealImageAssetId = asset.id;
  else if (optionIndex === "question-image") question().questionImageAssetId = asset.id;
  else question().options[optionIndex].imageAssetId = asset.id;
  await loadMediaAssets();
  markChanged();
  $("#save-state").textContent = `Reformatted image uploaded (${formatBytes(optimized.blob.size)}) — publish a new quiz version to use it.`;
  renderEditor();
  renderPreview();
}

function resolveImageFinderTarget(target = imageFinderTarget) {
  if (target === "title") return { target: "title", label: "the opening title-page artwork" };
  if (target === "reveal") return { target: "reveal", label: "the answer reveal" };
  if (target === "question-image") return { target: "question-image", label: "the question image" };
  const index = Number(String(target || "").replace(/^option:/, ""));
  const option = question()?.options?.[index];
  return option ? { target: `option:${index}`, optionIndex: index, label: option.label } : null;
}

function openImageFinder(target) {
  const resolved = resolveImageFinderTarget(target);
  if (!resolved) return;
  imageFinderTarget = resolved.target;
  const item = question();
  const dialog = $("#image-finder");
  $("#image-finder-target").textContent = `Finding an image for ${resolved.label}. The assistant also sees this quiz: ${bank.title}${item ? ` · ${item.prompt}` : ""}`;
  $("#image-finder-query").value = resolved.label;
  $("#image-finder-status").textContent = "Describe the image you want, then search.";
  $("#image-finder-results").innerHTML = "";
  $("#image-finder-draft-mode").checked = localStorage.getItem(IMAGE_SEARCH_DRAFT_KEY) === "true";
  $("#image-finder-search").textContent = $("#image-finder-draft-mode").checked ? "Open Google Images" : "Find cleared images";
  dialog.showModal();
}

function draftImageSearch(query, target) {
  const item = question();
  const terms = [target.label, query, item?.prompt].filter(Boolean).join(" ");
  window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(terms)}`, "_blank", "noopener,noreferrer");
  $("#image-finder-status").textContent = "Google Images opened in a new tab for drafting reference only. Clear rights before adding an image to the final quiz.";
}

async function findImageIdeas() {
  const item = question();
  const status = $("#image-finder-status");
  const results = $("#image-finder-results");
  const target = resolveImageFinderTarget();
  const requestedImage = $("#image-finder-query").value.trim();
  if (!target) { status.textContent = "Choose an image target first."; return; }
  if ($("#image-finder-draft-mode").checked) { draftImageSearch(requestedImage, target); return; }
  if (!currentUser) { status.textContent = "Sign in as an authorized author to use image suggestions."; return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) { status.textContent = "Your sign-in has expired. Sign in again to use image suggestions."; return; }
  status.textContent = "Researching image ideas…";
  results.innerHTML = "";
  try {
    const response = await fetch("/media-assistant/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ prompt: item.prompt, options: item.options, targetLabel: target.label, imageRequest: requestedImage }) });
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch { throw new Error(response.ok ? "The image assistant returned an unreadable response." : `Image assistant request failed (${response.status}): ${responseText.slice(0, 120) || "no response"}`); }
    if (!response.ok) throw new Error(data.error || "Could not find image ideas.");
    status.textContent = data.guidance || "Review each source and license before approval.";
    results.innerHTML = `<p class="suggested-queries">${(data.queries || []).map((query) => `<span>${escapeHtml(query)}</span>`).join("")}</p>${(data.candidates || []).map((candidate, index) => `<article class="media-candidate"><img src="${escapeHtml(candidate.thumbnailUrl)}" alt="${escapeHtml(candidate.title)}" /><div><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.license)}</small><a href="${escapeHtml(candidate.pageUrl)}" target="_blank" rel="noreferrer">View source & license</a><button class="button button-primary" data-use-suggestion="${index}">Approve and attach</button></div></article>`).join("") || "<p>No Wikimedia Commons images matched. Try a more specific request or upload your own image.</p>"}`;
    document.querySelectorAll("[data-use-suggestion]").forEach((button) => button.addEventListener("click", () => approveSuggestedImage(data.candidates[Number(button.dataset.useSuggestion)], button)));
  } catch (error) { status.textContent = error.message; }
}

async function approveSuggestedImage(candidate, button) {
  const target = resolveImageFinderTarget();
  if (!candidate?.originalUrl || !target) return;
  button.disabled = true;
  button.textContent = "Downloading…";
  try {
    const response = await fetch(candidate.originalUrl);
    if (!response.ok) throw new Error("The source image could not be downloaded. Use the source page to download it manually, then upload your own copy.");
    const blob = await response.blob();
    const type = ["image/jpeg", "image/png", "image/webp"].includes(blob.type) ? blob.type : "image/jpeg";
    await uploadPrivateImage(new File([blob], candidate.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "suggested-image", { type }), ["title", "reveal", "question-image"].includes(target.target) ? target.target : target.optionIndex, candidate);
    $("#image-finder-status").textContent = "Approved image optimized and attached. Publish a new version when ready.";
  } catch (error) { button.disabled = false; button.textContent = "Approve and attach"; $("#image-finder-status").textContent = error.message; }
}

async function chooseImageCrop(file) {
  if (!window.createImageBitmap || !window.HTMLDialogElement) return { aspect: null, focalX: 0.5, focalY: 0.5, zoom: 1 };
  const source = await createImageBitmap(file, { imageOrientation: "from-image" });
  const dialog = $("#image-cropper");
  const canvas = $("#cropper-canvas");
  const context = canvas.getContext("2d");
  const ratioControl = $("#cropper-ratio");
  const zoomControl = $("#cropper-zoom");
  const zoomValue = $("#cropper-zoom-value");
  const summary = $("#cropper-summary");
  let crop = { aspect: 1, focalX: 0.5, focalY: 0.5, zoom: 1 };
  let drag = null;
  const renderCrop = () => {
    const rect = cropRect(source.width, source.height, crop.aspect, crop.focalX, crop.focalY, crop.zoom);
    const previewWidth = 640;
    const previewHeight = Math.round(previewWidth * rect.height / rect.width);
    if (canvas.width !== previewWidth) canvas.width = previewWidth;
    if (canvas.height !== previewHeight) canvas.height = previewHeight;
    context.drawImage(source, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    zoomValue.textContent = `${Math.round(crop.zoom * 100)}%`;
    summary.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} source area · drag the preview to reposition`;
  };
  ratioControl.value = "1";
  zoomControl.value = "1";
  renderCrop();
  return new Promise((resolve, reject) => {
    const finish = (result) => {
      dialog.close();
      source.close();
      cropperSession = null;
      resolve(result);
    };
    cropperSession = {
      render: renderCrop,
      setRatio: () => { crop.aspect = ratioControl.value === "original" ? null : Number(ratioControl.value); renderCrop(); },
      setZoom: () => { crop.zoom = Number(zoomControl.value) || 1; renderCrop(); },
      startDrag: (event) => {
        if (event.button > 0) return;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("is-dragging");
      },
      moveDrag: (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const display = canvas.getBoundingClientRect();
        const next = panCrop(crop, source.width, source.height, event.clientX - drag.x, event.clientY - drag.y, display.width, display.height);
        crop.focalX = next.focalX;
        crop.focalY = next.focalY;
        drag.x = event.clientX;
        drag.y = event.clientY;
        renderCrop();
      },
      endDrag: (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag = null;
        canvas.classList.remove("is-dragging");
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      },
      reset: () => { crop.focalX = 0.5; crop.focalY = 0.5; renderCrop(); },
      apply: () => finish(crop),
      cancel: () => finish(null)
    };
    dialog.showModal();
  });
}

async function optimizeImage(file, crop = { aspect: null, focalX: 0.5, focalY: 0.5, zoom: 1 }, { preserveAlpha = false } = {}) {
  if (!window.createImageBitmap) throw new Error("This browser cannot optimize images. Use a current Chrome, Edge, or Firefox browser.");
  const source = await createImageBitmap(file, { imageOrientation: "from-image" });
  const rect = cropRect(source.width, source.height, crop.aspect, crop.focalX, crop.focalY, crop.zoom);
  const scale = Math.min(1, 1600 / Math.max(rect.width, rect.height));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", { alpha: preserveAlpha }).drawImage(source, rect.left, rect.top, rect.width, rect.height, 0, 0, width, height);
  source.close();
  const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode the optimized image.")), "image/webp", 0.84));
  return { blob, width, height };
}

function loadOriginalSourceIndex() {
  try { return JSON.parse(localStorage.getItem(ORIGINAL_SOURCE_INDEX_KEY) || "{}"); } catch { return {}; }
}

function rememberOriginalSource(assetId, source) {
  originalSourceIndex[assetId] = source;
  try { localStorage.setItem(ORIGINAL_SOURCE_INDEX_KEY, JSON.stringify(originalSourceIndex)); } catch { /* The uploaded image remains usable without local reformatting. */ }
}

function sourceFileSegment(value, fallback) {
  return String(value || fallback).trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}

function originalTargetLabel(target) {
  if (target === "title") return "title-art";
  if (target === "reveal") return "answer-reveal";
  if (target === "question-image") return "question-image";
  const option = question()?.options?.[Number(target)];
  return option ? `option-${sourceFileSegment(option.label, letters(Number(target)))}` : "image";
}

function localOriginalName(file, target = "source") {
  const extension = (file.name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || (file.type === "image/png" ? ".png" : file.type === "image/webp" ? ".webp" : ".jpg")).toLowerCase();
  const quiz = sourceFileSegment(bank?.title || bank?.id, "quiz");
  const section = sourceFileSegment(selectedRound()?.title || selectedRound()?.id, "opening");
  const item = sourceFileSegment(target === "title" ? "title-page" : question()?.id, "title-page");
  return `${quiz}__${section}__${item}__${originalTargetLabel(target)}__${new Date().toISOString().replace(/[:.]/g, "-")}${extension}`;
}

async function saveOriginalMedia(file, target = "audio") {
  if (!originalsDirectoryHandle) return null;
  try {
    // Permission prompts must come from the explicit folder-picker click.
    // Backup originals are optional, so an expired/restricted grant should
    // never stop the cropped image itself from being uploaded.
    if (await originalsDirectoryHandle.queryPermission({ mode: "readwrite" }) !== "granted") return null;
    const fileName = localOriginalName(file, target);
    const fileHandle = await originalsDirectoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
    return { fileName, folderName: originalsDirectoryHandle.name };
  } catch (error) {
    console.warn("Could not save optional original media copy.", error);
    return null;
  }
}

async function saveOriginalImage(file, target) { return saveOriginalMedia(file, target); }

function originalsDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ORIGINALS_DIRECTORY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(ORIGINALS_DIRECTORY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeOriginalsDirectoryHandle(handle) {
  if (!window.indexedDB) return;
  const database = await originalsDatabase();
  await new Promise((resolve, reject) => { const transaction = database.transaction(ORIGINALS_DIRECTORY_STORE, "readwrite"); transaction.objectStore(ORIGINALS_DIRECTORY_STORE).put(handle, ORIGINALS_DIRECTORY_KEY); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  database.close();
}

async function restoreOriginalsDirectoryHandle() {
  if (!window.indexedDB) return;
  try {
    const database = await originalsDatabase();
    const handle = await new Promise((resolve, reject) => { const request = database.transaction(ORIGINALS_DIRECTORY_STORE).objectStore(ORIGINALS_DIRECTORY_STORE).get(ORIGINALS_DIRECTORY_KEY); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    database.close();
    if (!handle) return;
    originalsDirectoryHandle = handle;
    const granted = await handle.queryPermission({ mode: "readwrite" }) === "granted";
    $("#originals-folder-status").textContent = granted ? `Saving full-size originals to “${handle.name}”. Reformat image reloads them later; published JSON versions go in its Published Quizzes folder.` : `Saved originals folder: “${handle.name}”. Choose it again if the browser asks for access.`;
  } catch { /* Folder persistence is an optional browser enhancement. */ }
}

async function loadOriginalSourceFile(source) {
  if (!originalsDirectoryHandle) return null;
  let granted = await originalsDirectoryHandle.queryPermission({ mode: "readwrite" });
  if (granted !== "granted") granted = await originalsDirectoryHandle.requestPermission({ mode: "readwrite" });
  if (granted !== "granted") return null;
  try { return await (await originalsDirectoryHandle.getFileHandle(source.fileName)).getFile(); } catch { return null; }
}

function formatSeconds(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(safe / 60)}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
}

function drawAudioWaveform(buffer, start, end, playhead = null) {
  const canvas = $("#audio-waveform");
  const context = canvas.getContext("2d");
  const width = 760; const height = 180;
  canvas.width = width; canvas.height = height;
  context.fillStyle = "#f0edf9"; context.fillRect(0, 0, width, height);
  const samples = buffer.getChannelData(0);
  const stride = Math.max(1, Math.floor(samples.length / width));
  context.strokeStyle = "#503f8b"; context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    let peak = 0;
    for (let index = x * stride; index < Math.min(samples.length, (x + 1) * stride); index += 1) peak = Math.max(peak, Math.abs(samples[index]));
    const y = peak * (height * 0.42);
    context.moveTo(x + .5, height / 2 - y); context.lineTo(x + .5, height / 2 + y);
  }
  context.stroke();
  const duration = buffer.duration || 1;
  const left = Math.max(0, Math.min(width, start / duration * width));
  const right = Math.max(left, Math.min(width, end / duration * width));
  context.fillStyle = "rgba(36,15,110,.18)"; context.fillRect(0, 0, left, height); context.fillRect(right, 0, width - right, height);
  context.strokeStyle = "#005de8"; context.lineWidth = 3; context.strokeRect(left, 2, Math.max(2, right - left), height - 4);
  if (Number.isFinite(playhead)) {
    const x = Math.max(0, Math.min(width, playhead / duration * width));
    context.strokeStyle = "#b21f40"; context.lineWidth = 2;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
}

function audioBufferToWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const output = new ArrayBuffer(44 + frames * channels * bytesPerSample);
  const view = new DataView(output);
  const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, "RIFF"); view.setUint32(4, 36 + frames * channels * bytesPerSample, true); writeText(8, "WAVE"); writeText(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); writeText(36, "data"); view.setUint32(40, frames * channels * bytesPerSample, true);
  const data = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channels; channel += 1) { view.setInt16(offset, Math.max(-1, Math.min(1, data[channel][frame])) * 0x7fff, true); offset += 2; }
  return new Blob([output], { type: "audio/wav" });
}

function normalizeAudioBuffer(buffer) {
  let peak = 0;
  let sumSquares = 0;
  let audibleSamples = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      if (magnitude >= AUDIO_NORMALIZATION_GATE) { sumSquares += sample * sample; audibleSamples += 1; }
    }
  }
  if (!audibleSamples || !peak) return { gain: 1, inputDbfs: null, outputDbfs: null };
  const inputRms = Math.sqrt(sumSquares / audibleSamples);
  const targetRms = 10 ** (AUDIO_NORMALIZATION_TARGET_DBFS / 20);
  const requestedGain = targetRms / inputRms;
  const gain = Math.min(requestedGain, AUDIO_NORMALIZATION_PEAK_CEILING / peak);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
  }
  const inputDbfs = 20 * Math.log10(inputRms);
  return { gain, inputDbfs, outputDbfs: inputDbfs + 20 * Math.log10(gain) };
}

function formatNormalization(normalization) {
  if (normalization?.inputDbfs == null) return "Automatic loudness leveling skipped (the selection is silent).";
  const change = 20 * Math.log10(normalization.gain);
  return `Automatic loudness leveling: ${change >= 0 ? "+" : ""}${change.toFixed(1)} dB · target ${AUDIO_NORMALIZATION_TARGET_DBFS} dBFS · peak ceiling −1 dBFS`;
}

async function renderAudioClip(buffer, { start, end, fadeIn, fadeOut }) {
  const duration = Math.max(.05, end - start);
  const sampleRate = buffer.sampleRate;
  const offline = new OfflineAudioContext(Math.min(2, buffer.numberOfChannels), Math.ceil(duration * sampleRate), sampleRate);
  const source = offline.createBufferSource(); source.buffer = buffer;
  const gain = offline.createGain(); source.connect(gain).connect(offline.destination);
  const inLength = Math.min(Math.max(0, fadeIn), duration / 2);
  const outLength = Math.min(Math.max(0, fadeOut), duration / 2);
  gain.gain.setValueAtTime(inLength ? 0 : 1, 0);
  if (inLength) gain.gain.linearRampToValueAtTime(1, inLength);
  if (outLength) { gain.gain.setValueAtTime(1, Math.max(inLength, duration - outLength)); gain.gain.linearRampToValueAtTime(0, duration); }
  source.start(0, start, duration);
  const rendered = await offline.startRendering();
  return { buffer: rendered, normalization: normalizeAudioBuffer(rendered) };
}

async function chooseAudioClip(file) {
  if (!window.AudioContext || !window.OfflineAudioContext || !window.HTMLDialogElement) throw new Error("This browser cannot trim audio. Use a current Chrome, Edge, or Firefox browser.");
  const context = new AudioContext();
  let source;
  try { source = await context.decodeAudioData(await file.arrayBuffer()); } catch { throw new Error("This audio format could not be decoded in this browser. Try an MP3, WAV, AAC, or OGG file."); } finally { await context.close(); }
  const dialog = $("#audio-clipper"); const startRange = $("#audio-clip-start"); const endRange = $("#audio-clip-end"); const startNumber = $("#audio-clip-start-number"); const endNumber = $("#audio-clip-end-number"); const fadeIn = $("#audio-fade-in"); const fadeOut = $("#audio-fade-out"); const summary = $("#audio-clip-summary"); const player = $("#audio-source-player"); const playhead = $("#audio-playhead");
  const sourceUrl = URL.createObjectURL(file);
  player.src = sourceUrl;
  let clip = { start: 0, end: source.duration, fadeIn: 0, fadeOut: 0 };
  const sync = () => {
    const maximumStart = Math.max(0, source.duration - .1);
    clip.start = Math.min(maximumStart, Math.max(0, Number(clip.start) || 0)); clip.end = Math.min(source.duration, Math.max(clip.start + .1, Number(clip.end) || source.duration));
    clip.fadeIn = Math.max(0, Number(clip.fadeIn) || 0); clip.fadeOut = Math.max(0, Number(clip.fadeOut) || 0);
    [startRange, startNumber].forEach((input) => input.value = String(clip.start)); [endRange, endNumber].forEach((input) => input.value = String(clip.end)); fadeIn.value = String(clip.fadeIn); fadeOut.value = String(clip.fadeOut);
    $("#audio-clip-duration").textContent = `${formatSeconds(clip.end - clip.start)} clip`;
    summary.textContent = `${formatSeconds(source.duration)} source · click waveform to seek · set the in/out points from the red playhead`;
    playhead.textContent = `Playhead ${formatSeconds(player.currentTime || 0)}`;
    drawAudioWaveform(source, clip.start, clip.end, player.currentTime || 0);
  };
  startRange.max = endRange.max = startNumber.max = endNumber.max = String(source.duration); startRange.value = startNumber.value = "0"; endRange.value = endNumber.value = String(source.duration); sync();
  return new Promise((resolve, reject) => {
    const finish = async (apply) => {
      player.pause(); player.removeAttribute("src"); player.load(); URL.revokeObjectURL(sourceUrl); dialog.close(); audioClipperSession = null;
      if (!apply) { resolve(null); return; }
      try {
        const rendered = await renderAudioClip(source, clip);
        resolve({ blob: audioBufferToWav(rendered.buffer), duration: clip.end - clip.start, normalization: rendered.normalization });
      } catch (error) { reject(error); }
    };
    audioClipperSession = {
      update: (key, value) => { clip[key] = value; sync(); },
      seek: (event) => { const rect = $("#audio-waveform").getBoundingClientRect(); player.currentTime = Math.max(0, Math.min(source.duration, (event.clientX - rect.left) / rect.width * source.duration)); sync(); },
      setStart: () => { clip.start = Math.min(player.currentTime || 0, clip.end - .1); sync(); },
      setEnd: () => { clip.end = Math.max(player.currentTime || 0, clip.start + .1); sync(); },
      updatePlayhead: () => sync(),
      toggleSource: async () => {
        if (player.paused) await player.play();
        else player.pause();
      },
      preview: async () => {
        const rendered = await renderAudioClip(source, clip);
        summary.textContent = formatNormalization(rendered.normalization);
        const audio = new Audio(URL.createObjectURL(audioBufferToWav(rendered.buffer)));
        audio.addEventListener("ended", () => URL.revokeObjectURL(audio.src), { once: true });
        await audio.play();
      },
      apply: () => finish(true), cancel: () => finish(false)
    };
    dialog.showModal();
  });
}

async function chooseOriginalsFolder() {
  if (!window.showDirectoryPicker) { alert("This browser does not support local-folder access. Use a current Chrome or Edge browser to keep originals automatically."); return; }
  try {
    originalsDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (await originalsDirectoryHandle.requestPermission({ mode: "readwrite" }) !== "granted") {
      originalsDirectoryHandle = null;
      $("#originals-folder-status").textContent = "Folder access was not granted. Images can still upload; choose a folder later to enable reformatting.";
      return;
    }
    await storeOriginalsDirectoryHandle(originalsDirectoryHandle);
    $("#originals-folder-status").textContent = `Saving full-size originals to “${originalsDirectoryHandle.name}”. New files are named by quiz, section, question, and image role; published JSON versions go in its Published Quizzes folder.`;
  } catch (error) {
    if (error.name !== "AbortError") alert(`Could not choose originals folder: ${error.message}`);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown size";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMediaLibrary() {
  const status = $("#media-library-status");
  const list = $("#media-library-list");
  const normalizeButton = ensureNormalizeLibraryButton();
  if (!status || !list) return;
  if (!currentUser) { status.textContent = "Sign in to view uploaded private media."; list.innerHTML = ""; normalizeButton.disabled = true; return; }
  normalizeButton.disabled = !mediaAssets.some((asset) => asset.kind === "audio");
  status.textContent = mediaAssets.length ? `${mediaAssets.length} private asset${mediaAssets.length === 1 ? "" : "s"}` : "No private media uploaded yet.";
  mediaPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaPreviewUrls = [];
  list.innerHTML = mediaAssets.map((asset) => {
    const inDraft = JSON.stringify(bank).includes(asset.id);
    const title = asset.display_name || asset.source_title || `${asset.kind} · ${asset.id.slice(0, 8)}`;
    const preview = asset.kind === "image" ? `<img class="media-thumb" data-media-preview="${asset.id}" alt="${escapeHtml(title)}" />` : `<audio class="media-audio" data-media-preview="${asset.id}" controls preload="none"></audio>`;
    return `<li>${preview}<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(formatBytes(asset.byte_size))}${asset.source_license ? ` · ${escapeHtml(asset.source_license)}` : ""}</span>${asset.source_url ? `<a href="${escapeHtml(asset.source_url)}" target="_blank" rel="noreferrer">Source</a>` : ""}</div><button class="media-rename" data-rename-media="${asset.id}">Rename</button>${inDraft ? '<em>Used in open draft</em>' : `<button class="media-delete" data-delete-media="${asset.id}">Delete</button>`}</li>`;
  }).join("");
  document.querySelectorAll("[data-rename-media]").forEach((button) => button.addEventListener("click", () => promptRenameMediaAsset(button.dataset.renameMedia)));
  document.querySelectorAll("[data-delete-media]").forEach((button) => button.addEventListener("click", () => deleteUnusedMediaAsset(button.dataset.deleteMedia)));
  document.querySelectorAll("[data-media-preview]").forEach((element) => loadMediaPreview(element));
}

function ensureNormalizeLibraryButton() {
  let button = $("#normalize-library-audio");
  if (button) return button;
  button = document.createElement("button");
  button.id = "normalize-library-audio";
  button.type = "button";
  button.className = "button button-quiet";
  button.textContent = "Level all audio";
  button.title = "Replace every private audio clip with a loudness-leveled WAV while keeping its quiz asset ID.";
  button.addEventListener("click", () => normalizeExistingLibraryAudio().catch((error) => {
    alert(`Could not loudness-level the media library: ${error.message}`);
    $("#save-state").textContent = "Media-library loudness leveling failed";
    button.disabled = !mediaAssets.some((asset) => asset.kind === "audio");
  }));
  $("#refresh-media")?.before(button);
  return button;
}

async function normalizeExistingLibraryAudio() {
  const assets = mediaAssets.filter((asset) => asset.kind === "audio");
  if (!assets.length) { $("#save-state").textContent = "No private audio clips to level"; return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Your author sign-in has expired. Sign in again, then retry.");
  const button = ensureNormalizeLibraryButton();
  button.disabled = true;
  const context = new AudioContext();
  try {
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      $("#save-state").textContent = `Loudness-leveling private audio ${index + 1} of ${assets.length}…`;
      const response = await fetch(`${workerOrigin}/author-media/${encodeURIComponent(asset.id)}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (!response.ok) throw new Error(`Could not download “${asset.display_name || asset.id}” (${response.status}).`);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      const normalization = normalizeAudioBuffer(decoded);
      const blob = audioBufferToWav(decoded);
      if (blob.size > 26214400) throw new Error(`“${asset.display_name || asset.id}” would exceed the 25 MB upload limit after rendering.`);
      const { error } = await supabase.storage.from("quiz-media").update(asset.storage_path, blob, { contentType: "audio/wav" });
      if (error) throw error;
      asset.mime_type = "audio/wav";
      asset.byte_size = blob.size;
      const oldPreview = uploadedAudioPreviewUrls.get(asset.id);
      if (oldPreview) URL.revokeObjectURL(oldPreview);
      uploadedAudioPreviewUrls.set(asset.id, URL.createObjectURL(blob));
      console.info("Loudness-leveled private audio", { assetId: asset.id, normalization });
    }
    $("#save-state").textContent = `Loudness-leveled ${assets.length} private audio clip${assets.length === 1 ? "" : "s"}. Existing quiz versions keep their asset IDs.`;
    renderMediaLibrary();
  } finally {
    await context.close();
    button.disabled = !mediaAssets.some((asset) => asset.kind === "audio");
  }
}

async function loadMediaPreview(element) {
  const status = element.closest(".audio-preview")?.querySelector("[data-audio-preview-status]");
  const uploadedPreview = uploadedImagePreviewUrls.get(element.dataset.mediaPreview);
  const uploadedAudioPreview = uploadedAudioPreviewUrls.get(element.dataset.mediaPreview);
  if (uploadedPreview || uploadedAudioPreview) { element.src = uploadedPreview || uploadedAudioPreview; element.load?.(); if (status) status.textContent = "Private clip attached"; return; }
  if (!supabase) { if (status) status.textContent = "Sign in to preview this private clip."; return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) { if (status) status.textContent = "Your author sign-in has expired. Sign in again to preview audio."; return; }
  const previewUrl = `${workerOrigin}/author-media/${encodeURIComponent(element.dataset.mediaPreview)}`;
  try {
    const response = await fetch(previewUrl, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) {
      const stage = response.headers.get("x-quiz-media-stage");
      if (status) status.textContent = `Could not load private audio${stage ? ` (${stage})` : ""} [${response.status}] from ${new URL(previewUrl).host}.`;
      else element.closest("figure")?.replaceWith(Object.assign(document.createElement("div"), { className: "missing-image-preview", innerHTML: `<strong>Image unavailable</strong><span>Private image request failed${stage ? ` (${escapeHtml(stage)})` : ""} [${response.status}].</span>` }));
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    mediaPreviewUrls.push(url);
    element.src = url;
    element.load?.();
    if (status) status.textContent = "Private clip attached";
  } catch (error) {
    if (status) status.textContent = `Could not load private audio (${error.message}).`;
    else element.closest("figure")?.replaceWith(Object.assign(document.createElement("div"), { className: "missing-image-preview", innerHTML: "<strong>Image unavailable</strong><span>The private image request could not be completed.</span>" }));
  }
}

async function loadMediaAssets() {
  if (!supabase || !currentUser) { mediaAssets = []; mediaAssetsLoaded = false; renderMediaLibrary(); return; }
  mediaAssetsLoaded = false;
  let { data, error } = await supabase.from("media_assets").select("id,kind,byte_size,storage_path,display_name,source_url,source_title,source_license,created_at").order("created_at", { ascending: false });
  if (error) {
    // Optional naming/source columns were added in later migrations. Loading
    // core asset records must still work if those metadata migrations lag.
    ({ data, error } = await supabase.from("media_assets").select("id,kind,byte_size,storage_path,created_at").order("created_at", { ascending: false }));
  }
  if (error) { mediaAssetsLoaded = true; $("#media-library-status").textContent = `Could not load private media (${error.message}). Attached UUID assets will still be checked directly.`; renderEditor(); return; }
  mediaAssets = data || [];
  mediaAssetsLoaded = true;
  renderMediaLibrary();
  renderEditor();
  renderPreview();
}

async function nameMediaAsset(assetId, name) {
  const { error } = await supabase.rpc("rename_media_asset", { p_asset_id: assetId, p_display_name: name });
  if (error) console.warn("Could not save media name", error);
}

function requestMediaAssetName(existingName) {
  const dialog = document.createElement("dialog");
  dialog.className = "image-finder";
  dialog.innerHTML = `<form method="dialog"><div class="cropper-head"><div><p class="eyebrow">Private media</p><h2>Rename asset</h2></div><button class="icon-button" type="button" data-cancel aria-label="Cancel rename">×</button></div><label class="field"><span>Name</span><input data-name maxlength="180" /></label><small>Leave the name blank to use the source title or asset ID.</small><div class="cropper-actions"><span></span><button class="button button-quiet" type="button" data-cancel>Cancel</button><button class="button button-primary" type="submit">Save name</button></div></form>`;
  document.body.append(dialog);
  const input = dialog.querySelector("[data-name]");
  input.value = existingName;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); finish(input.value.trim()); });
    dialog.querySelectorAll("[data-cancel]").forEach((button) => button.addEventListener("click", () => finish(null)));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    dialog.showModal();
    input.focus();
    input.select();
  });
}

async function promptRenameMediaAsset(assetId) {
  const asset = mediaAssets.find((entry) => entry.id === assetId);
  if (!asset) return;
  const existingName = asset.display_name || asset.source_title || "";
  const nextName = await requestMediaAssetName(existingName);
  if (nextName === null || nextName === existingName) return;
  try {
    const { error } = await supabase.rpc("rename_media_asset", { p_asset_id: assetId, p_display_name: nextName });
    if (error) throw error;
    await loadMediaAssets();
    $("#save-state").textContent = "Media asset renamed";
  } catch (error) { alert(`Could not rename media: ${error.message}`); }
}

async function deleteUnusedMediaAsset(assetId) {
  const asset = mediaAssets.find((entry) => entry.id === assetId);
  if (!asset || JSON.stringify(bank).includes(assetId)) return;
  if (!confirm(`Delete this ${asset.kind} asset? It cannot be restored. Published quiz references are protected automatically.`)) return;
  const { error } = await supabase.rpc("delete_unused_media_asset", { p_asset_id: assetId });
  if (error) { alert(`Could not delete media: ${error.message}`); return; }
  await loadMediaAssets();
  $("#save-state").textContent = "Unused private media deleted";
}

function addRound() {
  const round = { id: `round-${crypto.randomUUID().slice(0, 8)}`, title: `Round ${bank.rounds.length + 1}`, questions: [newQuestion()] };
  bank.rounds.splice(selection.roundIndex + 1, 0, round);
  selection = { roundIndex: selection.roundIndex + 1, questionIndex: 0 };
  markChanged();
  render();
}

function duplicateRound() {
  const source = selectedRound();
  if (!source) return;
  const copy = clone(source);
  copy.id = `round-${crypto.randomUUID().slice(0, 8)}`;
  copy.title = `${source.title || "Untitled round"} (copy)`;
  copy.questions.forEach((item) => { item.id = `question-${crypto.randomUUID().slice(0, 8)}`; });
  bank.rounds.splice(selection.roundIndex + 1, 0, copy);
  selection = { roundIndex: selection.roundIndex + 1, questionIndex: 0 };
  markChanged();
  render();
}

function deleteRound() {
  if (bank.rounds.length <= 1) return;
  const round = selectedRound();
  if (!confirm(`Delete ${round.title || "this round"} and all of its questions? This cannot be undone in the editor.`)) return;
  bank.rounds.splice(selection.roundIndex, 1);
  selection = { roundIndex: Math.max(0, selection.roundIndex - 1), questionIndex: 0 };
  markChanged();
  render();
}

function moveRound(offset) {
  const destination = selection.roundIndex + offset;
  if (destination < 0 || destination >= bank.rounds.length) return;
  [bank.rounds[selection.roundIndex], bank.rounds[destination]] = [bank.rounds[destination], bank.rounds[selection.roundIndex]];
  selection.roundIndex = destination;
  markChanged();
  render();
}

function download() {
  const errors = validateQuiz(bank);
  if (errors.length) { alert(validationSummary(bank)); return; }
  const blob = new Blob([JSON.stringify(bank, null, 2) + "\n"], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${(bank.id || "music-trivia-question-bank").replace(/[^a-z0-9-]/gi, "-")}.json` });
  link.click(); URL.revokeObjectURL(link.href); $("#save-state").textContent = "Downloaded — your working copy is still open";
}

function publishedQuizBackupName(published) {
  const title = sourceFileSegment(published?.title || bank?.title || bank?.id, "quiz");
  const version = Number(published?.version) || "published";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${title}__v${version}__${timestamp}.json`;
}

function downloadPublishedQuizBackup(fileName, contents) {
  const blob = new Blob([contents], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function savePublishedQuizBackup(published) {
  const fileName = publishedQuizBackupName(published);
  const contents = JSON.stringify(bank, null, 2) + "\n";
  try {
    if (originalsDirectoryHandle && await originalsDirectoryHandle.queryPermission({ mode: "readwrite" }) === "granted") {
      const backupFolder = await originalsDirectoryHandle.getDirectoryHandle("Published Quizzes", { create: true });
      const fileHandle = await backupFolder.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(contents);
      await writable.close();
      return `Saved JSON backup to “${originalsDirectoryHandle.name}/Published Quizzes/${fileName}”.`;
    }
  } catch (error) {
    console.warn("Could not save published quiz backup in the selected folder.", error);
  }
  downloadPublishedQuizBackup(fileName, contents);
  return `Downloaded JSON backup “${fileName}”. Choose an originals folder to save future backups in its Published Quizzes folder.`;
}

async function initialiseAuth() {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return;
  if (!supabase) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }
  ({ data: { user: currentUser } } = await supabase.auth.getUser());
  $("#sign-in").textContent = currentUser ? `Signed in: ${currentUser.email}` : "Sign in to publish";
  $("#sign-in").title = currentUser ? "This browser is connected and ready to publish. Click to sign out." : "Sign in once; future launches from Open Quiz Authoring.command will reuse this browser session.";
  syncPublishControl();
  $("#refresh-media").disabled = !currentUser;
  await loadMediaAssets();
  renderEditor();
}

function signInDialog() {
  let dialog = $("#author-sign-in-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "author-sign-in-dialog";
  dialog.className = "image-finder";
  dialog.innerHTML = `<form method="dialog"><div class="cropper-head"><div><p class="eyebrow">Author access</p><h2>Sign in to publish</h2></div><button class="icon-button" type="button" data-close-sign-in aria-label="Close sign-in">×</button></div><p>We’ll send a one-time sign-in link. Open it in this same browser to enable publishing and private-media access.</p><label class="field"><span>Authorized email</span><input id="author-sign-in-email" type="email" autocomplete="email" required /></label><small id="author-sign-in-status" role="status"></small><div class="cropper-actions"><span></span><button class="button button-quiet" type="button" data-close-sign-in>Cancel</button><button class="button button-primary" type="submit">Send sign-in link</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelectorAll("[data-close-sign-in]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = dialog.querySelector("#author-sign-in-email").value.trim();
    const status = dialog.querySelector("#author-sign-in-status");
    const submit = dialog.querySelector("button[type='submit']");
    if (!email) return;
    submit.disabled = true;
    status.textContent = "Sending sign-in link…";
    try {
      localStorage.setItem(AUTHOR_EMAIL_KEY, email);
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
      if (error) throw error;
      status.textContent = "Sign-in link sent. Open it in this browser to finish.";
    } catch (error) {
      status.textContent = `Could not send sign-in link: ${error.message}`;
      submit.disabled = false;
    }
  });
  return dialog;
}

function openSignInDialog() {
  const dialog = signInDialog();
  dialog.querySelector("#author-sign-in-email").value = localStorage.getItem(AUTHOR_EMAIL_KEY) || "";
  dialog.querySelector("#author-sign-in-status").textContent = "";
  dialog.querySelector("button[type='submit']").disabled = false;
  dialog.showModal();
  dialog.querySelector("#author-sign-in-email").focus();
}

$("#sign-in").addEventListener("click", async () => {
  if (currentUser) { await supabase.auth.signOut(); currentUser = null; await initialiseAuth(); return; }
  openSignInDialog();
});
$("#publish").addEventListener("click", async () => {
  const validationErrors = validateQuiz(bank);
  if (validationErrors.length) { alert(validationSummary(bank)); return; }
  const button = $("#publish"); button.disabled = true; button.textContent = "Publishing…";
  const { data, error } = await supabase.rpc("publish_quiz_version", { p_definition: bank });
  if (error) { recordDiagnostic("publish-quiz", error); alert(`Could not publish: ${error.message}`); button.disabled = false; button.textContent = "Publish version"; return; }
  originalBank = clone(bank);
  rememberPublishedSnapshot();
  const backupMessage = await savePublishedQuizBackup(data);
  $("#save-state").textContent = `Published ${data.title} · v${data.version}. ${backupMessage}`;
  syncPublishControl();
});

$("#download").addEventListener("click", download);
$("#refresh-media").addEventListener("click", () => loadMediaAssets());
$("#download-diagnostics").addEventListener("click", downloadDiagnostics);
$("#choose-originals-folder").addEventListener("click", chooseOriginalsFolder);
$("#suggest-images").addEventListener("click", () => { const item = question(); openImageFinder(item?.options?.length ? "option:0" : "reveal"); });
$("#image-draft-mode").checked = localStorage.getItem(IMAGE_SEARCH_DRAFT_KEY) === "true";
$("#image-draft-mode").addEventListener("change", (event) => localStorage.setItem(IMAGE_SEARCH_DRAFT_KEY, String(event.target.checked)));
$("#image-finder-draft-mode").addEventListener("change", (event) => { localStorage.setItem(IMAGE_SEARCH_DRAFT_KEY, String(event.target.checked)); $("#image-draft-mode").checked = event.target.checked; $("#image-finder-search").textContent = event.target.checked ? "Open Google Images" : "Find cleared images"; });
$("#image-finder-search").addEventListener("click", findImageIdeas);
$("#image-finder-close").addEventListener("click", () => $("#image-finder").close());
$("#image-finder-cancel").addEventListener("click", () => $("#image-finder").close());
document.addEventListener("paste", pasteClipboardImage);
document.addEventListener("click", () => document.querySelectorAll("[data-image-split].is-open").forEach((entry) => { entry.classList.remove("is-open"); entry.querySelector("[data-image-menu]")?.setAttribute("aria-expanded", "false"); }));
$("#nav-search").addEventListener("input", (event) => { navSearch = event.target.value; renderNav(); });
$("#nav-type-filter").addEventListener("change", (event) => { navTypeFilter = event.target.value; renderNav(); });
$("#validate-quiz").addEventListener("click", () => { const errors = validateQuiz(bank); $("#save-state").textContent = validationSummary(bank); if (errors.length) alert(validationSummary(bank)); });
$("#new-quiz").addEventListener("click", newQuiz);
$("#discard-draft").addEventListener("click", () => { if (!confirm("Discard this browser’s saved draft and reload the bundled question bank?")) return; clearDraft(); location.reload(); });
$("#add-question").addEventListener("click", addQuestion);
$("#add-question-template").addEventListener("change", (event) => { if (!event.target.value) return; addQuestionTemplate(event.target.value); event.target.value = ""; });
$("#cropper-ratio").addEventListener("change", () => cropperSession?.setRatio());
$("#cropper-zoom").addEventListener("input", () => cropperSession?.setZoom());
$("#cropper-canvas").addEventListener("pointerdown", (event) => cropperSession?.startDrag(event));
$("#cropper-canvas").addEventListener("pointermove", (event) => cropperSession?.moveDrag(event));
$("#cropper-canvas").addEventListener("pointerup", (event) => cropperSession?.endDrag(event));
$("#cropper-canvas").addEventListener("pointercancel", (event) => cropperSession?.endDrag(event));
$("#cropper-reset").addEventListener("click", () => cropperSession?.reset());
$("#cropper-cancel").addEventListener("click", () => cropperSession?.cancel());
$("[data-cropper-cancel]").addEventListener("click", () => cropperSession?.cancel());
$("#cropper-apply").addEventListener("click", () => cropperSession?.apply());
$("#image-cropper").addEventListener("cancel", (event) => { event.preventDefault(); cropperSession?.cancel(); });
$("#audio-clip-start").addEventListener("input", (event) => audioClipperSession?.update("start", event.target.value));
$("#audio-clip-end").addEventListener("input", (event) => audioClipperSession?.update("end", event.target.value));
$("#audio-clip-start-number").addEventListener("change", (event) => audioClipperSession?.update("start", event.target.value));
$("#audio-clip-end-number").addEventListener("change", (event) => audioClipperSession?.update("end", event.target.value));
$("#audio-fade-in").addEventListener("input", (event) => audioClipperSession?.update("fadeIn", event.target.value));
$("#audio-fade-out").addEventListener("input", (event) => audioClipperSession?.update("fadeOut", event.target.value));
$("#audio-waveform").addEventListener("click", (event) => audioClipperSession?.seek(event));
$("#audio-source-player").addEventListener("timeupdate", () => audioClipperSession?.updatePlayhead());
$("#audio-source-player").addEventListener("seeked", () => audioClipperSession?.updatePlayhead());
$("#audio-set-start").addEventListener("click", () => audioClipperSession?.setStart());
$("#audio-set-end").addEventListener("click", () => audioClipperSession?.setEnd());
$("#audio-clip-preview").addEventListener("click", () => audioClipperSession?.preview().catch((error) => alert(`Could not preview this clip: ${error.message}`)));
$("#audio-clip-cancel").addEventListener("click", () => audioClipperSession?.cancel());
$("[data-audio-clipper-cancel]").addEventListener("click", () => audioClipperSession?.cancel());
$("#audio-clip-apply").addEventListener("click", () => audioClipperSession?.apply());
$("#audio-clipper").addEventListener("cancel", (event) => { event.preventDefault(); audioClipperSession?.cancel(); });
$("#audio-clipper").addEventListener("keydown", (event) => {
  if (event.code !== "Space" || !audioClipperSession) return;
  event.preventDefault();
  audioClipperSession.toggleSource().catch((error) => alert(`Could not play source audio: ${error.message}`));
});
$("#move-question-up").addEventListener("click", () => moveQuestion(-1));
$("#move-question-down").addEventListener("click", () => moveQuestion(1));
$("#duplicate-question").addEventListener("click", duplicateQuestion);
$("#add-round").addEventListener("click", addRound);
$("#move-round-up").addEventListener("click", () => moveRound(-1));
$("#move-round-down").addEventListener("click", () => moveRound(1));
$("#duplicate-round").addEventListener("click", duplicateRound);
$("#delete-round").addEventListener("click", deleteRound);
$("#delete-question").addEventListener("click", () => { const round = selectedRound(); if (round.questions.length <= 1 || !confirm("Delete this question? This cannot be undone in the editor.")) return; round.questions.splice(selection.questionIndex, 1); selection.questionIndex = Math.max(0, selection.questionIndex - 1); markChanged(); render(); });
$("#apply-raw").addEventListener("click", () => { try { const candidate = JSON.parse($("#raw-json").value); const errors = validateQuiz(candidate); if (errors.length) throw new Error(validationSummary(candidate)); bank = candidate; selection = { roundIndex: 0, questionIndex: 0 }; $("#raw-status").textContent = "Applied and validated."; markChanged(); render(); } catch (error) { $("#raw-status").textContent = `Not applied: ${error.message}`; } });
$("#import-file").addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const candidate = JSON.parse(await file.text()); const errors = validateQuiz(candidate); if (errors.length) throw new Error(validationSummary(candidate)); bank = candidate; selection = { roundIndex: 0, questionIndex: 0 }; $("#save-state").textContent = `Imported and validated ${file.name} — download to keep edits`; render(); } catch (error) { alert(`Could not import this JSON: ${error.message}`); } finally { event.target.value = ""; } });

window.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); selectQuestion(-1); }
  if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); selectQuestion(1); }
});

startDiagnostics("author");
try {
  const bundledBank = await fetch(BANK_URL, { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error("Question bank not found"); return response.json(); });
  originalBank = clone(bundledBank);
  lastPublishedBank = restorePublishedSnapshot();
  const draft = restoredDraft();
  if (draft) { bank = draft.bank; selection = draft.selection; $("#save-state").textContent = "Recovered saved browser draft"; }
  else { bank = bundledBank; $("#save-state").textContent = "Loaded — edits save in this browser automatically"; }
  render();
  syncPublishControl();
} catch (error) {
  recordDiagnostic("load-question-bank", error);
  $("#nav-title").textContent = "Question bank is not connected";
  const localFile = location.protocol === "file:";
  $("#save-state").textContent = localFile
    ? "Open this page through the local app server: run npm run dev, then visit http://127.0.0.1:4173/author.html."
    : `Could not load music-trivia.question-bank.json: ${error.message}`;
}
restoreOriginalsDirectoryHandle();
initialiseAuth().catch((error) => { recordDiagnostic("author-sign-in", error); console.warn("Author sign-in unavailable.", error); });

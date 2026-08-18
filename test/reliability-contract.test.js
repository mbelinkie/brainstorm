import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
const authorHtml = fs.readFileSync(new URL("../author.html", import.meta.url), "utf8");

test("player UI waits for server confirmation before recording submission", () => {
  const submit = app.slice(app.indexOf('document.querySelector("[data-submit]")'), app.indexOf('document.querySelector("[data-player]")'));
  assert.ok(submit.indexOf("await roomApi.submitAnswer") < submit.indexOf("sessionStorage.setItem"));
  assert.match(submit, /Your answer was not submitted\. Please try again/);
});

test("temporarily invalid author drafts survive refresh", () => {
  const restore = author.slice(author.indexOf("function restoredDraft"), author.indexOf("function validationSummary"));
  assert.doesNotMatch(restore, /validateQuiz/);
  assert.match(restore, /Array\.isArray\(draft\.bank\.rounds\)/);
});

test("the editor validates with the shared quiz-validation module instead of a private copy", () => {
  assert.match(author, /import \{ validateQuiz \} from "\.\/quiz-validation\.js";/);
  assert.doesNotMatch(author, /function validateQuiz/);
});

test("a saved author draft survives a failed bundled-bank fetch", () => {
  const boot = author.slice(author.indexOf('startDiagnostics("author")'));
  // The draft is the author's own unpublished work and does not depend on the
  // bundled bank, so it must be restored before that fetch can throw.
  assert.ok(boot.indexOf("restoredDraft()") < boot.indexOf("await fetch(BANK_URL"));
  // …and the editor must still render on the failure path when a draft exists,
  // rather than leaving `bank` undefined for renderMediaLibrary to dereference.
  assert.ok(boot.indexOf("} catch (error) {") < boot.indexOf("if (bank) { render(); syncPublishControl(); }"));
  // …and the media panel must not dereference an unloaded bank at all.
  assert.match(author, /const inDraft = !bank \|\| JSON\.stringify\(bank\)\.includes\(asset\.id\);/);
  assert.match(author, /if \(!asset \|\| !bank \|\| JSON\.stringify\(bank\)\.includes\(assetId\)\) return;/);
});

test("importing a JSON file persists the draft it just adopted", () => {
  const importer = author.slice(author.indexOf('$("#import-file").addEventListener'), author.indexOf('window.addEventListener("keydown"'));
  assert.match(importer, /markChanged\(\)/);
  assert.doesNotMatch(importer, /download to keep edits/);
});

test("removing a between-round sound actually removes it, and an unrecognised target never reports a save", () => {
  const start = author.indexOf('document.querySelectorAll("[data-remove-audio]")');
  const source = author.slice(start, author.indexOf('document.querySelectorAll("[data-remove-image]")', start));
  const body = source.slice(source.indexOf("=> {") + 4, source.lastIndexOf("}));"));
  const handler = new Function("button", "question", "finaleConfig", "bonusConfig", "markChanged", "renderEditor", "renderPreview", body);
  const bonus = { audio: { roundEnd: { mediaAssetId: "asset-1" }, doorChoice: { mediaAssetId: "asset-2" } } };
  const noop = () => {};
  let saved = 0;
  const run = (target) => handler({ dataset: { removeAudio: target } }, () => ({}), () => ({}), () => bonus, () => { saved += 1; }, noop, noop);
  run("between:roundEnd");
  assert.deepEqual(Object.keys(bonus.audio), ["doorChoice"]);
  assert.equal(saved, 1);
  saved = 0;
  run("mystery:thing");
  assert.deepEqual(Object.keys(bonus.audio), ["doorChoice"]);
  assert.equal(saved, 0);
});

test("valid attached images do not depend on the media-library list", () => {
  const preview = author.slice(author.indexOf("function attachedImagePreview"), author.indexOf("function imageReformatButton"));
  assert.match(preview, /validAssetId\(assetId\)/);
  assert.match(author, /select\("id,kind,byte_size,storage_path,created_at"\)/);
});

test("optional originals-folder access cannot block an image upload", () => {
  const upload = author.slice(author.indexOf("async function uploadPrivateImage"), author.indexOf("function imageAssetIdForTarget"));
  const backup = author.slice(author.indexOf("async function saveOriginalMedia"), author.indexOf("async function saveOriginalImage"));
  assert.doesNotMatch(upload, /if \(!originalsDirectoryHandle\)/);
  assert.match(upload, /original copy was not saved/);
  assert.match(backup, /queryPermission\(\{ mode: "readwrite" \}\)/);
  assert.match(backup, /catch \(error\)/);
  assert.match(backup, /return null/);
});

test("audio trimmer lets Space toggle source playback", () => {
  assert.match(author, /toggleSource: async \(\) =>/);
  assert.match(author, /if \(player\.paused\) await player\.play\(\)/);
  assert.match(author, /\$\("#audio-clipper"\)\.addEventListener\("keydown"/);
  assert.match(author, /event\.code !== "Space"/);
  assert.match(author, /audioClipperSession\.toggleSource\(\)/);
});

test("the old hardcoded door-background 50% gain override no longer exists", () => {
  assert.doesNotMatch(author, /DOOR_BACKGROUND_AUDIO_GAIN/);
  assert.doesNotMatch(author, /doorBackgroundMusic/);
  assert.doesNotMatch(author, /reduceDoorBackgroundAudioVolume/);
  assert.doesNotMatch(authorHtml, /data-reduce-door-audio-volume/);
});

test("any audio clip, including door background music, can be uploaded at a manually chosen volume instead of auto-leveled", () => {
  const chooser = author.slice(author.indexOf("async function chooseAudioClip"), author.indexOf("async function chooseOriginalsFolder"));
  const renderer = author.slice(author.indexOf("async function renderAudioClip"), author.indexOf("async function chooseAudioClip"));
  assert.match(author, /import \{ [^}]*resolveAudioClipProcessing[^}]*\} from ".\/video-utils\.js"/);
  assert.match(chooser, /#audio-volume-override-enabled/);
  assert.match(chooser, /#audio-volume-override-percent/);
  assert.match(chooser, /resolveAudioClipProcessing\(\{\}, clip\.volumeOverride \? clip\.volumePercent : null\)/);
  assert.match(renderer, /const normalization = normalize \? normalizeAudioBuffer\(rendered\) : null/);
  assert.match(renderer, /applyAudioGain\(rendered, outputGain\)/);
  assert.match(authorHtml, /id="audio-volume-override-enabled" type="checkbox"/);
  assert.match(authorHtml, /id="audio-volume-override-percent" type="range"/);
});

test("publish state and published JSON backups are tracked locally", () => {
  assert.match(author, /const PUBLISHED_SNAPSHOT_KEY/);
  assert.match(author, /function hasUnpublishedChanges/);
  assert.match(author, /function syncPublishControl/);
  assert.match(author, /publish\.disabled = !currentUser \|\| !changed/);
  assert.match(author, /function savePublishedQuizBackup/);
  assert.match(author, /getDirectoryHandle\("Published Quizzes", \{ create: true \}\)/);
  assert.match(author, /downloadPublishedQuizBackup/);
  assert.match(author, /rememberPublishedSnapshot\(\)/);
});

test("presentation replaces its loaded private audio when the host cues another clip", () => {
  assert.match(app, /loadedPrivateAudioAssetId === assetId/);
  assert.match(app, /loadedPrivateAudioAssetId = null/);
  assert.match(app, /loadedPrivateAudioAssetId = assetId/);
});

test("title-page SRT captions stay local to the presentation audio clock", () => {
  assert.match(author, /parseSrt/);
  assert.match(author, /data-import-title-captions/);
  assert.match(author, /data-remove-title-captions/);
  assert.match(app, /const timeMs = \(presentationAudioPlayer\?\.currentTime \|\| 0\) \* 1000/);
  assert.match(app, /visibleCaptionAt\(captions, timeMs\)/);
  assert.match(app, /data-title-caption-overlay/);
  assert.match(app, /text\.textContent = cue\.text/);
  assert.match(app, /data-karaoke-start/);
  assert.match(app, /requestAnimationFrame/);
  assert.doesNotMatch(app.match(/state\.audioCommand = \{[\s\S]*?\};/)?.[0] || "", /captions/);
});

test("audio commands identify the exact authored question and clip", () => {
  assert.match(app, /questionId: hostQuestion\.id, clipId: state\.activeClipId/);
  assert.match(app, /function questionDefinitionById/);
  assert.match(app, /questionDefinitionById\(command\?\.questionId\)/);
  assert.match(app, /commandedQuestion\?\.clips\?\.find/);
});

test("Host can adjust audio volume on any screen without interrupting playback, and it carries forward", () => {
  assert.match(app, /data-audio-volume/);
  // The slider must render on every playable audio panel (title, question,
  // between-round, finale), not just the title screen's.
  assert.match(app, /const volumeControl = playable \? `<label class="host-audio-volume"/);
  // setAudioCommand always stamps the host's persisted volume, regardless of
  // which scope the command targets.
  assert.match(app, /state\.audioCommand = \{ id: crypto\.randomUUID\(\), volume: currentAudioVolume\(\), \.\.\.command \};/);
  const command = app.slice(app.indexOf("async function applyPresentationAudioCommand"), app.indexOf("async function clearActiveClip"));
  assert.match(command, /presentationAudioPlayer\.volume = normalizedAudioVolume\(command\.volume\)/);
  // A volume-only command must return before preparePresentationAudio runs,
  // so nudging the slider never reloads or swaps the active clip.
  assert.ok(command.indexOf('command.action === "volume"') < command.indexOf("await preparePresentationAudio(command)"));
  assert.ok(command.indexOf("await preparePresentationAudio(command)") < command.indexOf('command.action === "pause"'));
});

test("host setup and join controls appear only on the title screen", () => {
  const renderHost = app.slice(app.indexOf("function renderHost"), app.indexOf("function scoreCelebration"));
  assert.match(renderHost, /isHostedRoom && state\.presentationScreen === "title"/);
  assert.doesNotMatch(renderHost, /isHostedRoom && state\.phase === "lobby" \? `\$\{state\.presentationScreen/);
});

test("presenter text questions render anonymous answers instead of a disabled player input", () => {
  assert.match(app, /function anonymousTextAnswerWall/);
  assert.match(app, /presenter && \["short_answer", "fill_in_the_blank"\]/);
  assert.match(app, /host-text-answers/);
  assert.match(app, /Typed answers could not be loaded\. Retrying/);
  assert.match(app, /realtimeTextAnswers\.set\(payload\.playerId/);
  assert.match(app, /questionId: state\.questionId \|\| state\.question\?\.id/);
  assert.match(app, /type: "presentation-submission"/);
  assert.match(app, /function updateAnonymousTextAnswerWall/);
  assert.match(app, /wall\.innerHTML === nextWall\.innerHTML/);
  assert.match(app, /wall\.replaceWith\(nextWall\)/);
  assert.match(app, /!realtimeAnswersAvailable && anonymousTextAnswerRetries < 3/);
  const answerRefresh = app.slice(app.indexOf("async function refreshAnonymousTextAnswers"), app.indexOf("function revealImage"));
  assert.doesNotMatch(answerRefresh, /\brender\(\)/);
});

test("auto-submit skips a selection after its question has closed or changed", () => {
  const autoSubmit = app.slice(app.indexOf("function queueAutoSubmission"), app.indexOf("function updateMatchingSelectAvailability"));
  assert.match(autoSubmit, /state\.phase !== "open"/);
  assert.match(autoSubmit, /serverRevision/);
  assert.match(autoSubmit, /state\.revision \|\| 0\) !== serverRevision/);
});

test("player title and fallback intermission screens hide the active question until the host starts it", () => {
  const renderPlayer = app.slice(app.indexOf("function renderPlayer"), app.indexOf("function render()"));
  assert.match(renderPlayer, /presentationScreen === "title"/);
  assert.match(renderPlayer, /presentationScreen === "intermission"/);
  assert.match(renderPlayer, /The next question will appear here when the host starts it/);
  assert.doesNotMatch(renderPlayer, /The host is showing the leaderboard/);
  assert.doesNotMatch(renderPlayer, /\$\{playerScoreCards\(\)\}/);
});

test("manual score changes redraw player scoreboards and notify player screens", () => {
  const playerKey = app.slice(app.indexOf("function playerRenderKey"), app.indexOf("function presenterRenderKey"));
  const shell = app.slice(app.indexOf("function shell"), app.indexOf("function brandTopbar"));
  assert.match(playerKey, /players: roomState\?\.players/);
  assert.match(playerKey, /scoreNotification: roomState\?\.scoreNotification/);
  assert.match(shell, /isPlayer && view === "player" \? scoreCelebration\(\) : ""/);
});

test("player and presenter branding uses plain BRAINSTORM text", () => {
  const brand = app.slice(app.indexOf("function brandTopbar"), app.indexOf("function preflightChecklist"));
  assert.doesNotMatch(brand, /🧠|brand-brain/);
});

test("question-stage and reveal artwork render only in Presentation", () => {
  const publicState = app.slice(app.indexOf("function publicRoomState"), app.indexOf("function setHostQuestion"));
  const renderHost = app.slice(app.indexOf("function renderHost"), app.indexOf("function scoreCelebration"));
  const renderPlayer = app.slice(app.indexOf("function renderPlayer"), app.indexOf("function render()"));
  assert.doesNotMatch(publicState, /questionImageAssetId|revealImageAssetId/);
  assert.doesNotMatch(renderHost, /questionImage\(|revealImage\(/);
  assert.doesNotMatch(renderPlayer, /questionImage\(|revealImage\(/);
  assert.match(app, /questionImage\(\{ presenter: true \}\)/);
  assert.match(app, /revealImage\(\{ presenter: true \}\)/);
});

test("reveal performs locking and scoring in one host action", () => {
  assert.match(app, /async function revealQuestion\(\)/);
  assert.match(app, /await lockQuestion\(\{ renderAfter: false \}\)/);
  assert.match(app, /data-reveal-question/);
  assert.doesNotMatch(app, />Lock answers </);
});

test("selection questions save without a submit button or full player redraw", () => {
  assert.match(app, /const manualSubmit = \["short_answer", "fill_in_the_blank", "numeric_estimate", "closest_number"\]/);
  assert.match(app, /function queueAutoSubmission/);
  const answerHandler = app.slice(app.indexOf('document.querySelectorAll("[data-answer]")'), app.indexOf('document.querySelector("[data-text-answer]")'));
  assert.match(answerHandler, /queueAutoSubmission\(\)/);
  assert.doesNotMatch(answerHandler, /render\(\)/);
});

test("mobile matching and categorization use compact non-drag controls", () => {
  assert.match(app, /function matchingSelectBoard/);
  assert.match(app, /data-match-select/);
  assert.match(app, /usedOptionIds\.has\(option\.id\).*disabled/);
  assert.match(app, /function categorizeTapBoard/);
  assert.match(app, /data-categorize-item/);
  assert.match(app, /matching-board--text-only/);
  assert.doesNotMatch(app, />Movie poster</);
});

test("all correct choices are highlighted on multi-select reveal", () => {
  assert.match(app, /revealedCorrectOptionIds/);
  assert.match(app, /revealedCorrectIds\.includes\(option\.id\)/);
});

test("player ignores presentation-only audio state changes", () => {
  const key = app.slice(app.indexOf("function playerRenderKey"), app.indexOf("function presenterRenderKey"));
  assert.doesNotMatch(key, /audioCommand/);
  assert.doesNotMatch(key, /activeClipId/);
});

test("multi-blank answers autosave without remounting and follow clip playback", () => {
  assert.match(app, /function multiBlankBoard/);
  assert.match(app, /data-multi-blank=/);
  assert.match(app, /queueAutoSubmission\(\{ allowEmpty: true, delay: 40 \}\)/);
  assert.match(app, /function updateMultiBlankPlayingState/);
  assert.match(app, /data-multi-blank-playback-status/);
  assert.match(app, /Now playing' : "Listen closely"/);
  assert.match(app, /presentationAudioPlayer\?\.addEventListener\("ended", announceAudioEnded\)/);
  assert.match(app, /\["matching", "multi_fill_in_the_blank"\]\.includes\(hostQuestion\.type\)/);
});

test("finale reveal titles and door odds remain legible on the presentation screen", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /presentation-card--multi_fill_in_the_blank \.multi-blank-row > span[\s\S]*color: var\(--purple\)/);
  assert.match(css, /presentation-card--multi_fill_in_the_blank \.multi-blank-row > span[\s\S]*font-size: clamp\(22px, 3\.8vh, 44px\)/);
  assert.match(css, /presentation-card--doors \.door-odds[\s\S]*font-size: clamp\(19px, 2\.5vh, 31px\)/);
});

test("presenter applies audio-only updates without remounting the shared screen", () => {
  const receive = app.slice(app.indexOf("function receive"), app.indexOf("function playerRenderKey"));
  const key = app.slice(app.indexOf("function presenterRenderKey"), app.indexOf("localChannel.onmessage"));
  assert.match(receive, /priorPresenterRenderKey/);
  assert.match(receive, /updatePresenterActiveClipState\(\)/);
  assert.match(receive, /applyPresentationAudioCommand\(\)/);
  assert.match(key, /activeClipId, audioCommand, revision, submitted/);
  assert.match(key, /JSON\.stringify\(visualState\)/);
});

test("host navigation uses one next and previous control for keys, arrows, and visible buttons", () => {
  const next = app.slice(app.indexOf("async function showNextScreen"), app.indexOf("let playerId"));
  assert.match(app, /async function showNextScreen\(\)/);
  assert.match(app, /async function showPreviousScreen\(\)/);
  assert.match(next, /if \(state\.phase === "open"\) return revealQuestion\(\)/);
  assert.doesNotMatch(next, /if \(state\.phase === "open"\) return lockQuestion\(\)/);
  assert.match(app, /data-next-screen/);
  assert.match(app, /data-previous/);
  assert.match(app, /event\.key === "ArrowRight"/);
  assert.match(app, /event\.key === "ArrowLeft"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "n"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "p"/);
  assert.match(app, /screenHistory/);
});

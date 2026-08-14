import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("player UI waits for server confirmation before recording submission", () => {
  const submit = app.slice(app.indexOf('document.querySelector("[data-submit]")'), app.indexOf('document.querySelector("[data-player]")'));
  assert.ok(submit.indexOf("await roomApi.submitAnswer") < submit.indexOf("sessionStorage.setItem"));
  assert.match(submit, /Your answer was not submitted\. Please try again/);
});

test("temporarily invalid author drafts survive refresh", () => {
  const restore = author.slice(author.indexOf("function restoredDraft"), author.indexOf("function validateQuiz"));
  assert.doesNotMatch(restore, /validateQuiz/);
  assert.match(restore, /Array\.isArray\(draft\.bank\.rounds\)/);
});

test("local authoring proxies image-assistant requests to the Worker", () => {
  assert.match(server, /requestPath === "\/media-assistant\/search"/);
  assert.match(server, /workerOrigin/);
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

test("audio commands identify the exact authored question and clip", () => {
  assert.match(app, /questionId: hostQuestion\.id, clipId: state\.activeClipId/);
  assert.match(app, /function questionDefinitionById/);
  assert.match(app, /questionDefinitionById\(command\?\.questionId\)/);
  assert.match(app, /commandedQuestion\?\.clips\?\.find/);
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
});

test("player title and intermission screens hide the active question until the host starts it", () => {
  const renderPlayer = app.slice(app.indexOf("function renderPlayer"), app.indexOf("function render()"));
  assert.match(renderPlayer, /presentationScreen === "title"/);
  assert.match(renderPlayer, /presentationScreen === "intermission"/);
  assert.match(renderPlayer, /The next question will appear here when it starts/);
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
  const key = app.slice(app.indexOf("function playerRenderKey"), app.indexOf("function emit"));
  assert.doesNotMatch(key, /audioCommand/);
  assert.doesNotMatch(key, /activeClipId/);
});

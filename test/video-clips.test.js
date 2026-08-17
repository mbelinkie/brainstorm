import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fadeFactor, outputVideoDimensions, validateVideoEdit, clampManualAudioVolumePercent, manualAudioVolumeGain, resolveAudioClipProcessing } from "../video-utils.js";
import { toPlayerQuestion } from "../quiz-core.js";
import { validateQuiz } from "../quiz-validation.js";

const migration = fs.readFileSync(new URL("../supabase/migrations/0032_video_media_assets.sql", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../video-processor.worker.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("video edit ranges and fades are bounded deterministically", () => {
  assert.deepEqual(validateVideoEdit({ startSeconds: 0, endSeconds: 10, videoFadeInSeconds: 9, videoFadeOutSeconds: 9 }, 12), { startSeconds: 0, endSeconds: 10, duration: 10, videoFadeInSeconds: 5, videoFadeOutSeconds: 5, audioFadeInSeconds: 0, audioFadeOutSeconds: 0 });
  assert.equal(fadeFactor(0, 10, 2, 2), 0);
  assert.equal(fadeFactor(2, 10, 2, 2), 1);
  assert.equal(fadeFactor(9, 10, 2, 2), .5);
  assert.throws(() => validateVideoEdit({ startSeconds: 0, endSeconds: 46 }, 50), /45 seconds/);
});

test("manual audio volume override clamps percent and bypasses automatic leveling", () => {
  assert.equal(clampManualAudioVolumePercent(40), 40);
  assert.equal(clampManualAudioVolumePercent(0), 1);
  assert.equal(clampManualAudioVolumePercent(9999), 150);
  assert.equal(clampManualAudioVolumePercent("nonsense"), 100);
  assert.equal(manualAudioVolumeGain(50), .5);
  assert.deepEqual(resolveAudioClipProcessing({ normalize: true, outputGain: 1 }, null), { normalize: true, outputGain: 1 });
  assert.deepEqual(resolveAudioClipProcessing({ normalize: true, outputGain: 1 }, 40), { normalize: false, outputGain: .4 });
  // A manual override also wins over a non-default base, e.g. door background music.
  assert.deepEqual(resolveAudioClipProcessing({ normalize: false, outputGain: .5 }, 30), { normalize: false, outputGain: .3 });
});

test("video output dimensions preserve aspect ratio and AVC-safe pixels", () => {
  assert.deepEqual(outputVideoDimensions(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(outputVideoDimensions(1080, 1920), { width: 404, height: 720 });
  assert.deepEqual(outputVideoDimensions(501, 501), { width: 500, height: 500 });
});

test("video asset data is never present in a player question", () => {
  const player = toPlayerQuestion({ id: "q", type: "single_choice", prompt: "Question", video: { mediaAssetId: "secret-video", sourceTitle: "Private source", url: "https://private.example/video" }, options: [{ id: "a", label: "A" }] });
  assert.equal(JSON.stringify(player).includes("secret-video"), false);
  assert.equal(JSON.stringify(player).includes("private.example"), false);
});

test("video validation requires a UUID and rejects an audio/video question", () => {
  const quiz = { id: "quiz", title: "Quiz", rounds: [{ id: "r", title: "R", questions: [{ id: "q", type: "single_choice", prompt: "P", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"], audio: { mediaAssetId: "00000000-0000-4000-8000-000000000000" }, video: { mediaAssetId: "00000000-0000-4000-8000-000000000000" } }] }] };
  assert.match(validateQuiz(quiz).join(" "), /either presentation audio or presentation video/);
  quiz.rounds[0].questions[0].audio = undefined;
  quiz.rounds[0].questions[0].video.mediaAssetId = "not-a-uuid";
  assert.match(validateQuiz(quiz).join(" "), /invalid private video/);
});

test("video persistence is private, standardized, and author-gated", () => {
  assert.match(migration, /video\/mp4/);
  assert.match(migration, /kind in \('audio', 'image', 'video'\)/);
  assert.match(migration, /register_video_media_asset/);
  assert.match(migration, /is_quiz_author/);
  assert.match(migration, /p_byte_size > 26214400/);
  assert.match(migration, /p_duration_ms > 45000/);
});

test("presentation video commands omit assets and do not remount the stage", () => {
  assert.match(app, /function questionPresentationMedia/);
  assert.match(app, /mediaCommand: state\.mediaCommand \? \{ id: state\.mediaCommand\.id, kind: state\.mediaCommand\.kind, action: state\.mediaCommand\.action/);
  assert.doesNotMatch(app.slice(app.indexOf("function publicRoomState"), app.indexOf("function setHostQuestion")), /mediaAssetId/);
  assert.match(app, /presentationVideoPlayer/);
  assert.match(app, /presentationVideoObjectUrl\) URL\.revokeObjectURL/);
  assert.match(app, /const \{ mediaCommand, \.\.\.visualState \}/);
});

test("worker uses only the primary tracks, capability checks, MP4 AVC and fast start", () => {
  assert.match(worker, /await video\.canDecode\(\)/);
  assert.match(worker, /await audio\.canDecode\(\)/);
  assert.match(worker, /tracks: "primary"/);
  assert.match(worker, /Mp4OutputFormat\(\{ fastStart: "in-memory" \}\)/);
  assert.match(worker, /codec: "avc"/);
  assert.match(worker, /codec: "aac"/);
  assert.match(worker, /conversion\.cancel\(\)/);
});

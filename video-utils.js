// Deterministic video-editing rules shared by the author UI and media Worker.
export const MAX_VIDEO_DURATION_SECONDS = 45;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function validateVideoEdit(edit = {}, sourceDuration = Infinity) {
  const startSeconds = Number(edit.startSeconds);
  const endSeconds = Number(edit.endSeconds);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error("Choose a valid start and end time.");
  const duration = endSeconds - startSeconds;
  if (duration < 0.1) throw new Error("Video clips must be at least 0.1 seconds long.");
  if (duration > MAX_VIDEO_DURATION_SECONDS) throw new Error("Video clips may be at most 45 seconds long.");
  if (endSeconds > sourceDuration + 0.05) throw new Error("The selected end time is past the source video.");
  return { startSeconds, endSeconds, duration, videoFadeInSeconds: clamp(edit.videoFadeInSeconds, 0, duration / 2), videoFadeOutSeconds: clamp(edit.videoFadeOutSeconds, 0, duration / 2), audioFadeInSeconds: clamp(edit.audioFadeInSeconds, 0, duration / 2), audioFadeOutSeconds: clamp(edit.audioFadeOutSeconds, 0, duration / 2) };
}

export function fadeFactor(timeSeconds, durationSeconds, fadeInSeconds = 0, fadeOutSeconds = 0) {
  const fadeIn = fadeInSeconds > 0 ? clamp(timeSeconds / fadeInSeconds, 0, 1) : 1;
  const fadeOut = fadeOutSeconds > 0 ? clamp((durationSeconds - timeSeconds) / fadeOutSeconds, 0, 1) : 1;
  return Math.min(fadeIn, fadeOut);
}

export function outputVideoDimensions(width, height, maxWidth = 1280, maxHeight = 720) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("The source video has invalid dimensions.");
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  // AVC's broadest browser-compatible profiles require even coded dimensions.
  const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

export function videoOutputProfile(width, height, frameRate = 30) {
  const dimensions = outputVideoDimensions(width, height);
  return { ...dimensions, frameRate: Math.min(30, Math.max(1, Number(frameRate) || 30)), videoBitrate: 2_500_000, audioBitrate: 128_000, keyFrameInterval: 2 };
}

// An author can bypass automatic loudness leveling for a clip and bake in a
// specific volume instead (e.g. a clip they deliberately want quieter). The
// percent is of full scale; invalid input falls back to 100% (unchanged).
export const MIN_MANUAL_AUDIO_VOLUME_PERCENT = 1;
export const MAX_MANUAL_AUDIO_VOLUME_PERCENT = 150;
export const DEFAULT_MANUAL_AUDIO_VOLUME_PERCENT = 100;

export function clampManualAudioVolumePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return DEFAULT_MANUAL_AUDIO_VOLUME_PERCENT;
  return clamp(percent, MIN_MANUAL_AUDIO_VOLUME_PERCENT, MAX_MANUAL_AUDIO_VOLUME_PERCENT);
}

export function manualAudioVolumeGain(percent) {
  return clampManualAudioVolumePercent(percent) / 100;
}

// Decide how an uploaded audio clip should be rendered: the caller's default
// (automatic loudness leveling, or a fixed gain like door background music),
// or — when the author supplies a manual override percent — a fixed gain at
// that volume instead, bypassing automatic leveling entirely.
export function resolveAudioClipProcessing(defaultProcessing = {}, manualVolumePercent) {
  const { normalize = true, outputGain = 1 } = defaultProcessing;
  if (manualVolumePercent == null) return { normalize, outputGain };
  return { normalize: false, outputGain: manualAudioVolumeGain(manualVolumePercent) };
}

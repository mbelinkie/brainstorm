import { ALL_FORMATS, AudioSample, AudioSampleSink, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from "mediabunny";
import { MAX_VIDEO_BYTES, fadeFactor, outputVideoDimensions, validateVideoEdit } from "./video-utils.js";

let activeJob = null;
const progress = (jobId, phase, value) => postMessage({ type: "progress", jobId, phase, progress: Math.max(0, Math.min(1, value)) });

async function inspect(file, jobId) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  if (!await input.canRead()) throw new Error("This file cannot be read as an MP4, MOV, or WebM video in this browser.");
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  if (!video) throw new Error("The selected file has no primary video track.");
  if (!await video.canDecode()) throw new Error("This browser cannot decode the source video codec. Try a current Chrome or Edge browser.");
  if (audio && !await audio.canDecode()) throw new Error("This browser cannot decode the source audio track; it will not be silently removed.");
  const duration = await input.getDurationFromMetadata() ?? await input.computeDuration();
  const width = await video.getDisplayWidth();
  const height = await video.getDisplayHeight();
  const frameRate = (await video.computeFrameRateMetrics()).bestGuessFrameRate || 30;
  progress(jobId, "inspect", 1);
  return { input, duration, width, height, frameRate, hasAudio: Boolean(audio), audio };
}

async function analyzeAudio(track, start, end, jobId) {
  if (!track) return { gain: 1 };
  let peak = 0; let sumSquares = 0; let audible = 0; let scanned = 0;
  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples(start, end)) {
    try {
      const bytes = sample.allocationSize({ planeIndex: 0, format: "f32" });
      const data = new Float32Array(bytes / Float32Array.BYTES_PER_ELEMENT);
      sample.copyTo(data, { planeIndex: 0, format: "f32" });
      for (const value of data) { const magnitude = Math.abs(value); peak = Math.max(peak, magnitude); if (magnitude >= 10 ** (-50 / 20)) { sumSquares += value * value; audible += 1; } }
      scanned += 1;
      if (scanned % 20 === 0) progress(jobId, "analyze-audio", Math.min(0.98, (sample.timestamp - start) / Math.max(.01, end - start)));
    } finally { sample.close(); }
  }
  if (!audible || !peak) return { gain: 1 };
  const rms = Math.sqrt(sumSquares / audible);
  return { gain: Math.min((10 ** (-16 / 20)) / rms, (10 ** (-1 / 20)) / peak) };
}

async function encode({ jobId, file, edit }) {
  progress(jobId, "inspect", 0);
  const source = await inspect(file, jobId);
  const selected = validateVideoEdit(edit, source.duration);
  const dimensions = outputVideoDimensions(source.width, source.height);
  const audioNormalization = source.hasAudio ? await analyzeAudio(source.audio, selected.startSeconds, selected.endSeconds, jobId) : { gain: 1 };
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  // A canvas in the Worker bakes video fades and orientation into frames; no
  // source tags, thumbnails, subtitles, attachments, or secondary tracks are copied.
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const conversion = await Conversion.init({
    input: source.input,
    output,
    tracks: "primary",
    trim: { start: selected.startSeconds, end: selected.endSeconds },
    tags: {},
    showWarnings: false,
    video: {
      codec: "avc",
      width: dimensions.width,
      height: dimensions.height,
      frameRate: Math.min(30, source.frameRate || 30),
      bitrate: 2_500_000,
      keyFrameInterval: 2,
      allowRotationMetadata: false,
      forceTranscode: true,
      process: (sample) => {
        const relativeTime = sample.timestamp;
        const opacity = fadeFactor(relativeTime, selected.duration, selected.videoFadeInSeconds, selected.videoFadeOutSeconds);
        context.fillStyle = "black";
        context.fillRect(0, 0, dimensions.width, dimensions.height);
        context.globalAlpha = opacity;
        sample.draw(context, 0, 0, dimensions.width, dimensions.height);
        context.globalAlpha = 1;
        return canvas;
      }
    },
    audio: source.hasAudio ? {
      codec: "aac",
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 128_000,
      forceTranscode: true,
      sampleFormat: "f32",
      process: (sample) => {
        const data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: "f32" }) / Float32Array.BYTES_PER_ELEMENT);
        sample.copyTo(data, { planeIndex: 0, format: "f32" });
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        for (let frame = 0; frame < frames; frame += 1) {
          const time = sample.timestamp + frame / sample.sampleRate;
          const factor = audioNormalization.gain * fadeFactor(time, selected.duration, selected.audioFadeInSeconds, selected.audioFadeOutSeconds);
          for (let channel = 0; channel < channels; channel += 1) { const index = frame * channels + channel; data[index] = Math.max(-1, Math.min(1, data[index] * factor)); }
        }
        return new AudioSample({ data, format: "f32", numberOfChannels: channels, sampleRate: sample.sampleRate, timestamp: sample.timestamp });
      }
    } : { discard: true }
  });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map(({ reason }) => reason).join(", ");
    throw new Error(`This browser cannot create the required H.264/AAC MP4 (${reasons || "unsupported codec configuration"}).`);
  }
  activeJob = { jobId, conversion };
  conversion.onProgress = (value) => progress(jobId, "encode", value);
  try {
    await conversion.execute();
  } finally {
    activeJob = null;
    context.clearRect(0, 0, dimensions.width, dimensions.height);
  }
  const buffer = output.target.buffer;
  if (!buffer || buffer.byteLength > MAX_VIDEO_BYTES) throw new Error("The rendered MP4 is over 25 MB. Shorten the selected range and try again.");
  progress(jobId, "encode", 1);
  postMessage({ type: "result", jobId, buffer, mimeType: "video/mp4", durationMs: Math.round(selected.duration * 1000), width: dimensions.width, height: dimensions.height, hasAudio: source.hasAudio, byteSize: buffer.byteLength }, [buffer]);
}

self.onmessage = async ({ data }) => {
  if (data?.type === "cancel" && activeJob?.jobId === data.jobId) { await activeJob.conversion.cancel(); return; }
  if (data?.type !== "encode") return;
  try { await encode(data); }
  catch (error) { postMessage({ type: "error", jobId: data.jobId, message: error?.name === "ConversionCanceledError" ? "Video rendering cancelled." : error?.message || "Video rendering failed." }); }
};

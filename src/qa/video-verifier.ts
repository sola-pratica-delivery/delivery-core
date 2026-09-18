import { FfprobeError, runFfprobe } from "../probe/ffprobe.js";
import type { RawFfprobeOutput, RawFfprobeStream } from "../probe/types.js";
import { FfmpegError, runFfmpeg } from "./ffmpeg-runner.js";
import type {
  AvSyncCheck,
  BlackScreenCheck,
  FreezeFrameCheck,
  QaInterval,
  VideoQaDetails,
  VideoQaOptions,
  VideoQaReport,
} from "./types.js";

export const DEFAULT_QA_OPTIONS: Required<VideoQaOptions> = {
  blackDetectMinDuration: 1.0,
  blackDetectPicTh: 0.98,
  blackDetectPixTh: 0.1,
  freezeDetectMinDuration: 2.0,
  freezeDetectNoise: 0.001,
  maxAvDiffSeconds: 1.0,
  requireAudio: true,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 30_000,
};

export function resolveQaOptions(
  options: VideoQaOptions,
): Required<VideoQaOptions> {
  const resolved: Required<VideoQaOptions> = { ...DEFAULT_QA_OPTIONS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

export function parseBlackDetectLog(stderr: string): QaInterval[] {
  const intervals: QaInterval[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(
      /black_start:\s*([\d.eE+-]+)\s+black_end:\s*([\d.eE+-]+)\s+black_duration:\s*([\d.eE+-]+)/,
    );
    if (match !== null) {
      const start = Number.parseFloat(match[1] ?? "0");
      const end = Number.parseFloat(match[2] ?? "0");
      intervals.push({ start, end, duration: Math.max(0, end - start) });
    }
  }
  return intervals;
}

function extractFreezeValue(
  line: string,
  key: "freeze_start" | "freeze_end" | "freeze_duration",
): number | null {
  const match = line.match(
    new RegExp(
      `(?:${key}|lavfi\\.freezedetect\\.${key})\\s*:\\s*([\\d.eE+-]+)`,
    ),
  );
  return match !== null ? Number.parseFloat(match[1] ?? "0") : null;
}

export function parseFreezeDetectLog(
  stderr: string,
  totalDuration: number,
): QaInterval[] {
  const intervals: QaInterval[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const start = extractFreezeValue(line, "freeze_start");
    const end = extractFreezeValue(line, "freeze_end");
    const duration = extractFreezeValue(line, "freeze_duration");

    if (start !== null) {
      pendingStart = start;
    }
    if (end !== null) {
      if (pendingStart !== null) {
        intervals.push({
          start: pendingStart,
          end,
          duration: Math.max(0, end - pendingStart),
        });
        pendingStart = null;
      } else if (duration !== null && duration > 0) {
        intervals.push({
          start: Math.max(0, end - duration),
          end,
          duration,
        });
      }
    }
  }

  if (pendingStart !== null && totalDuration > pendingStart) {
    intervals.push({
      start: pendingStart,
      end: totalDuration,
      duration: totalDuration - pendingStart,
    });
  }

  return intervals;
}

function parseDurationValue(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "N/A") {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function computeAvSync(input: {
  videoDuration: number;
  audioDuration: number | null;
  requireAudio: boolean;
  maxAvDiffSeconds: number;
}): AvSyncCheck {
  const { videoDuration, audioDuration, requireAudio, maxAvDiffSeconds } = input;
  const base = {
    videoDuration,
    audioDuration,
    maxAllowedDiffSeconds: maxAvDiffSeconds,
  };
  if (audioDuration === null) {
    return requireAudio
      ? { ...base, passed: false, diffSeconds: null }
      : { ...base, passed: true, diffSeconds: null };
  }
  const diffSeconds = Math.abs(videoDuration - audioDuration);
  return {
    ...base,
    passed: diffSeconds <= maxAvDiffSeconds,
    diffSeconds: Math.round(diffSeconds * 1000) / 1000,
  };
}

function describeProbeFailure(error: unknown): string {
  if (error instanceof FfprobeError) {
    if (error.kind === "not-found") {
      return `Probing failed: ffprobe binary not found (${error.message})`;
    }
    if (error.kind === "timeout") {
      return `Probing failed: ffprobe timed out (${error.message})`;
    }
    const detail = error.stderr.length > 0 ? error.stderr : error.message;
    return `Probing failed: ${detail}`;
  }
  if (error instanceof Error) {
    return `Probing failed: ${error.message}`;
  }
  return `Probing failed: ${String(error)}`;
}

function describeFilterFailure(operation: string, error: unknown): string {
  if (error instanceof FfmpegError) {
    if (error.kind === "timeout") {
      return `${operation} failed: ffmpeg timed out (${error.message})`;
    }
    if (error.kind === "not-found") {
      return `${operation} failed: ffmpeg binary not found (${error.message})`;
    }
    const detail = error.stderr.length > 0 ? error.stderr : error.message;
    return `${operation} failed: ${detail}`;
  }
  if (error instanceof Error) {
    return `${operation} failed: ${error.message}`;
  }
  return `${operation} failed: ${String(error)}`;
}

async function runBlackDetect(
  filePath: string,
  options: Required<VideoQaOptions>,
  failureReasons: string[],
): Promise<BlackScreenCheck> {
  const maxAllowedDuration = options.blackDetectMinDuration;
  try {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-vf",
      `blackdetect=d=${options.blackDetectMinDuration}:pic_th=${options.blackDetectPicTh}:pix_th=${options.blackDetectPixTh}`,
      "-an",
      "-f",
      "null",
      "-",
    ];
    const { stderr } = await runFfmpeg(args, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    });
    const detectedIntervals = parseBlackDetectLog(stderr);
    const passed = detectedIntervals.every(
      (interval) => interval.duration <= maxAllowedDuration,
    );
    for (const interval of detectedIntervals) {
      if (interval.duration > maxAllowedDuration) {
        failureReasons.push(
          `Black screen detected from ${interval.start.toFixed(2)}s to ${interval.end.toFixed(2)}s (${interval.duration.toFixed(2)}s exceeds max allowed ${maxAllowedDuration}s)`,
        );
      }
    }
    return { passed, maxAllowedDuration, detectedIntervals };
  } catch (error) {
    failureReasons.push(describeFilterFailure("Black screen detection", error));
    return { passed: false, maxAllowedDuration, detectedIntervals: [] };
  }
}

async function runFreezeDetect(
  filePath: string,
  options: Required<VideoQaOptions>,
  totalDuration: number,
  failureReasons: string[],
): Promise<FreezeFrameCheck> {
  const maxAllowedDuration = options.freezeDetectMinDuration;
  try {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-vf",
      `freezedetect=d=${options.freezeDetectMinDuration}:n=${options.freezeDetectNoise}`,
      "-an",
      "-f",
      "null",
      "-",
    ];
    const { stderr } = await runFfmpeg(args, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    });
    const detectedIntervals = parseFreezeDetectLog(stderr, totalDuration);
    const passed = detectedIntervals.every(
      (interval) => interval.duration <= maxAllowedDuration,
    );
    for (const interval of detectedIntervals) {
      if (interval.duration > maxAllowedDuration) {
        failureReasons.push(
          `Freeze detected from ${interval.start.toFixed(2)}s to ${interval.end.toFixed(2)}s (${interval.duration.toFixed(2)}s exceeds max allowed ${maxAllowedDuration}s)`,
        );
      }
    }
    return { passed, maxAllowedDuration, detectedIntervals };
  } catch (error) {
    failureReasons.push(describeFilterFailure("Freeze detection", error));
    return { passed: false, maxAllowedDuration, detectedIntervals: [] };
  }
}

async function probeStreams(
  filePath: string,
  options: Required<VideoQaOptions>,
): Promise<{
  output: RawFfprobeOutput;
  videoStream: RawFfprobeStream | undefined;
  audioStream: RawFfprobeStream | undefined;
  videoDuration: number;
  audioDuration: number | null;
}> {
  const output = await runFfprobe(filePath, {
    ffprobePath: options.ffprobePath,
    timeoutMs: options.timeoutMs,
  });
  const videoStream = output.streams.find((stream) => stream.codec_type === "video");
  const audioStream = output.streams.find((stream) => stream.codec_type === "audio");
  const videoDuration =
    parseDurationValue(videoStream?.duration) ??
    parseDurationValue(output.format?.duration) ??
    0;
  const audioDuration =
    audioStream === undefined
      ? null
      : (parseDurationValue(audioStream.duration) ??
        parseDurationValue(output.format?.duration) ??
        null);
  return { output, videoStream, audioStream, videoDuration, audioDuration };
}

export async function verifyVideoQuality(
  filePath: string,
  options: VideoQaOptions = {},
): Promise<VideoQaReport> {
  const resolved = resolveQaOptions(options);
  const failureReasons: string[] = [];
  const checkedAt = new Date().toISOString();

  let probe: {
    videoStream: RawFfprobeStream | undefined;
    audioStream: RawFfprobeStream | undefined;
    videoDuration: number;
    audioDuration: number | null;
  };
  try {
    probe = await probeStreams(filePath, resolved);
  } catch (error) {
    failureReasons.push(describeProbeFailure(error));
    return {
      passed: false,
      checkedAt,
      blackScreen: {
        passed: false,
        maxAllowedDuration: resolved.blackDetectMinDuration,
        detectedIntervals: [],
      },
      freezeFrame: {
        passed: false,
        maxAllowedDuration: resolved.freezeDetectMinDuration,
        detectedIntervals: [],
      },
      avSync: {
        passed: false,
        videoDuration: 0,
        audioDuration: null,
        diffSeconds: null,
        maxAllowedDiffSeconds: resolved.maxAvDiffSeconds,
      },
      details: { totalDuration: 0 },
      failureReasons,
    };
  }

  const { videoStream, audioStream, videoDuration, audioDuration } = probe;

  const avSync = computeAvSync({
    videoDuration,
    audioDuration,
    requireAudio: resolved.requireAudio,
    maxAvDiffSeconds: resolved.maxAvDiffSeconds,
  });
  if (audioStream === undefined && resolved.requireAudio) {
    failureReasons.push("Missing audio stream");
  } else if (
    audioDuration !== null &&
    avSync.diffSeconds !== null &&
    avSync.diffSeconds > resolved.maxAvDiffSeconds
  ) {
    failureReasons.push(
      `AV sync difference ${avSync.diffSeconds.toFixed(3)}s exceeds max allowed ${resolved.maxAvDiffSeconds}s`,
    );
  }

  const blackScreen = await runBlackDetect(
    filePath,
    resolved,
    failureReasons,
  );
  const freezeFrame = await runFreezeDetect(
    filePath,
    resolved,
    videoDuration,
    failureReasons,
  );

  const details: VideoQaDetails = {
    totalDuration: videoDuration,
    ...(videoStream?.codec_name !== undefined
      ? { videoCodec: videoStream.codec_name }
      : {}),
    audioCodec: audioStream?.codec_name ?? null,
  };

  return {
    passed:
      avSync.passed && blackScreen.passed && freezeFrame.passed,
    checkedAt,
    blackScreen,
    freezeFrame,
    avSync,
    details,
    failureReasons,
  };
}
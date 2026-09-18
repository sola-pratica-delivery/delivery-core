import { FfprobeError, runFfprobe } from "../probe/ffprobe.js";
import type { RawFfprobeStream } from "../probe/types.js";
import { FfmpegError, runFfmpeg } from "./ffmpeg-runner.js";
import type {
  AudioLoudnessCheck,
  AudioQaDetails,
  AudioQaOptions,
  AudioQaReport,
  AudioTruePeakCheck,
  AudioVoicePresenceCheck,
  QaInterval,
} from "./types.js";

export const DEFAULT_AUDIO_QA_OPTIONS: Required<AudioQaOptions> = {
  minIntegratedLufs: -14.5,
  maxIntegratedLufs: -13.5,
  maxTruePeakDb: -1.0,
  maxSilenceDuration: 3.0,
  silenceNoiseThresholdDb: -50,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 30_000,
};

export function resolveAudioQaOptions(
  options: AudioQaOptions,
): Required<AudioQaOptions> {
  const resolved: Required<AudioQaOptions> = { ...DEFAULT_AUDIO_QA_OPTIONS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

function parseNumericValue(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("inf")) {
    return normalized.startsWith("-")
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseEbur128Log(stderr: string): {
  integratedLoudness: number | null;
  truePeak: number | null;
  loudnessRange: number | null;
} {
  const summaryMarker = stderr.lastIndexOf("Summary:");
  const summary =
    summaryMarker === -1 ? stderr : stderr.slice(summaryMarker);

  const loudnessMatch = summary.match(
    /I:\s*(-?inf|-?\d+\.?\d*)\s*LUFS/i,
  );
  const truePeakMatch = summary.match(
    /Peak:\s*(-?inf|-?\d+\.?\d*)\s*(?:dBTP|dBFS)/i,
  );
  const lraMatch = summary.match(
    /LRA:\s*(-?inf|-?\d+\.?\d*)\s*LU/i,
  );

  return {
    integratedLoudness:
      loudnessMatch !== null
        ? parseNumericValue(loudnessMatch[1] ?? "")
        : null,
    truePeak:
      truePeakMatch !== null
        ? parseNumericValue(truePeakMatch[1] ?? "")
        : null,
    loudnessRange:
      lraMatch !== null ? parseNumericValue(lraMatch[1] ?? "") : null,
  };
}

function extractSilenceValue(
  line: string,
  key: "silence_start" | "silence_end",
): number | null {
  const match = line.match(
    new RegExp(
      `(?:${key}|lavfi\\.silencedetect\\.${key})\\s*:\\s*([\\d.eE+-]+)`,
    ),
  );
  return match !== null ? Number.parseFloat(match[1] ?? "0") : null;
}

export function parseSilenceDetectLog(
  stderr: string,
  totalDuration: number,
): QaInterval[] {
  const intervals: QaInterval[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const start = extractSilenceValue(line, "silence_start");
    const end = extractSilenceValue(line, "silence_end");

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

async function probeStreams(
  filePath: string,
  options: Required<AudioQaOptions>,
): Promise<{
  audioStream: RawFfprobeStream | undefined;
  duration: number;
}> {
  const output = await runFfprobe(filePath, {
    ffprobePath: options.ffprobePath,
    timeoutMs: options.timeoutMs,
  });
  const audioStream = output.streams.find(
    (stream) => stream.codec_type === "audio",
  );
  const duration =
    parseDurationValue(audioStream?.duration) ??
    parseDurationValue(output.format?.duration) ??
    0;
  return { audioStream, duration };
}

function failedChecks(
  options: Required<AudioQaOptions>,
  details: AudioQaDetails,
  failureReasons: string[],
  checkedAt: string,
): AudioQaReport {
  return {
    passed: false,
    checkedAt,
    loudness: {
      passed: false,
      integratedLoudness: 0,
      minAllowedLufs: options.minIntegratedLufs,
      maxAllowedLufs: options.maxIntegratedLufs,
    },
    truePeak: {
      passed: false,
      truePeak: 0,
      maxAllowedTruePeak: options.maxTruePeakDb,
    },
    voicePresence: {
      passed: false,
      maxAllowedSilenceDuration: options.maxSilenceDuration,
      detectedSilenceIntervals: [],
      totalSilenceDuration: 0,
      silencePercentage: 0,
    },
    details,
    failureReasons,
  };
}

async function runEbur128(
  filePath: string,
  options: Required<AudioQaOptions>,
  failureReasons: string[],
): Promise<{
  loudness: AudioLoudnessCheck;
  truePeak: AudioTruePeakCheck;
}> {
  try {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ];
    const { stderr } = await runFfmpeg(args, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    });
    const parsed = parseEbur128Log(stderr);
    const integratedLoudness = parsed.integratedLoudness;
    const truePeak = parsed.truePeak;

    const loudnessPassed =
      integratedLoudness !== null &&
      integratedLoudness >= options.minIntegratedLufs &&
      integratedLoudness <= options.maxIntegratedLufs;
    if (!loudnessPassed) {
      if (integratedLoudness === null) {
        failureReasons.push("Integrated loudness could not be measured");
      } else if (integratedLoudness < options.minIntegratedLufs) {
        failureReasons.push(
          `Integrated loudness ${integratedLoudness.toFixed(1)} LUFS is below minimum ${options.minIntegratedLufs} LUFS`,
        );
      } else {
        failureReasons.push(
          `Integrated loudness ${integratedLoudness.toFixed(1)} LUFS exceeds maximum ${options.maxIntegratedLufs} LUFS`,
        );
      }
    }

    const loudness: AudioLoudnessCheck = {
      passed: loudnessPassed,
      integratedLoudness: integratedLoudness ?? 0,
      minAllowedLufs: options.minIntegratedLufs,
      maxAllowedLufs: options.maxIntegratedLufs,
    };
    if (parsed.loudnessRange !== null) {
      loudness.loudnessRange = parsed.loudnessRange;
    }

    const truePeakPassed =
      truePeak !== null && truePeak < options.maxTruePeakDb;
    if (!truePeakPassed) {
      if (truePeak === null) {
        failureReasons.push("True peak could not be measured");
      } else {
        failureReasons.push(
          `True peak ${truePeak.toFixed(1)} dBTP exceeds maximum ${options.maxTruePeakDb} dBTP`,
        );
      }
    }

    return {
      loudness,
      truePeak: {
        passed: truePeakPassed,
        truePeak: truePeak ?? 0,
        maxAllowedTruePeak: options.maxTruePeakDb,
      },
    };
  } catch (error) {
    failureReasons.push(describeFilterFailure("Loudness measurement", error));
    return {
      loudness: {
        passed: false,
        integratedLoudness: 0,
        minAllowedLufs: options.minIntegratedLufs,
        maxAllowedLufs: options.maxIntegratedLufs,
      },
      truePeak: {
        passed: false,
        truePeak: 0,
        maxAllowedTruePeak: options.maxTruePeakDb,
      },
    };
  }
}

async function runSilenceDetect(
  filePath: string,
  options: Required<AudioQaOptions>,
  totalDuration: number,
  failureReasons: string[],
): Promise<AudioVoicePresenceCheck> {
  try {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-af",
      `silencedetect=noise=${options.silenceNoiseThresholdDb}dB:d=${options.maxSilenceDuration}`,
      "-f",
      "null",
      "-",
    ];
    const { stderr } = await runFfmpeg(args, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    });
    const detectedSilenceIntervals = parseSilenceDetectLog(
      stderr,
      totalDuration,
    );
    const totalSilenceDuration = detectedSilenceIntervals.reduce(
      (sum, interval) => sum + interval.duration,
      0,
    );
    const silencePercentage =
      totalDuration > 0
        ? Math.min(100, (totalSilenceDuration / totalDuration) * 100)
        : 0;
    const passed = detectedSilenceIntervals.every(
      (interval) => interval.duration <= options.maxSilenceDuration,
    );
    for (const interval of detectedSilenceIntervals) {
      if (interval.duration > options.maxSilenceDuration) {
        failureReasons.push(
          `Silence detected from ${interval.start.toFixed(2)}s to ${interval.end.toFixed(2)}s (${interval.duration.toFixed(2)}s exceeds max allowed ${options.maxSilenceDuration}s)`,
        );
      }
    }
    return {
      passed,
      maxAllowedSilenceDuration: options.maxSilenceDuration,
      detectedSilenceIntervals,
      totalSilenceDuration,
      silencePercentage,
    };
  } catch (error) {
    failureReasons.push(describeFilterFailure("Silence detection", error));
    return {
      passed: false,
      maxAllowedSilenceDuration: options.maxSilenceDuration,
      detectedSilenceIntervals: [],
      totalSilenceDuration: 0,
      silencePercentage: 0,
    };
  }
}

export async function verifyAudioQuality(
  filePath: string,
  options: AudioQaOptions = {},
): Promise<AudioQaReport> {
  const resolved = resolveAudioQaOptions(options);
  const failureReasons: string[] = [];
  const checkedAt = new Date().toISOString();

  let probe: {
    audioStream: RawFfprobeStream | undefined;
    duration: number;
  };
  try {
    probe = await probeStreams(filePath, resolved);
  } catch (error) {
    failureReasons.push(describeProbeFailure(error));
    return failedChecks(resolved, { duration: 0 }, failureReasons, checkedAt);
  }

  const { audioStream, duration } = probe;

  if (audioStream === undefined) {
    failureReasons.push("Missing audio stream in media file");
    return failedChecks(resolved, { duration }, failureReasons, checkedAt);
  }

  const { loudness, truePeak } = await runEbur128(
    filePath,
    resolved,
    failureReasons,
  );
  const voicePresence = await runSilenceDetect(
    filePath,
    resolved,
    duration,
    failureReasons,
  );

  const details: AudioQaDetails = {
    duration,
    ...(audioStream.sample_rate !== undefined &&
    audioStream.sample_rate !== ""
      ? { sampleRate: Number(audioStream.sample_rate) }
      : {}),
    ...(audioStream.channels !== undefined
      ? { channels: audioStream.channels }
      : {}),
    audioCodec: audioStream.codec_name ?? null,
  };

  return {
    passed: loudness.passed && truePeak.passed && voicePresence.passed,
    checkedAt,
    loudness,
    truePeak,
    voicePresence,
    details,
    failureReasons,
  };
}
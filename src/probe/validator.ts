import { stat } from "node:fs/promises";
import type {
  MediaProbeMetadata,
  MediaValidationResult,
  ProbeRunnerOptions,
  RawFfprobeOutput,
  SupportedVideoCodec,
} from "./types.js";
import { detectMagicBytes } from "./magic-bytes.js";
import { FfprobeError, runFfprobe } from "./ffprobe.js";

const SUPPORTED_VIDEO_CODECS: Record<string, SupportedVideoCodec> = {
  h264: "h264",
  avc1: "h264",
  hevc: "h265",
  h265: "h265",
  hev1: "h265",
  hvc1: "h265",
  prores: "prores",
  apch: "prores",
  apcn: "prores",
  apcs: "prores",
  apco: "prores",
  ap4h: "prores",
  ap4x: "prores",
  av1: "av1",
  av01: "av1",
};

const SUPPORTED_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "flac"]);

const SUPPORTED_CODECS_LIST = "h264, h265, prores, av1";

export function normalizeFramerate(raw: string | undefined): number | null {
  if (raw === undefined || raw === "" || raw === "N/A") {
    return null;
  }
  const [numStr, denStr] = raw.split("/");
  const numerator = Number(numStr);
  const denominator =
    denStr === undefined || denStr === "" ? 1 : Number(denStr);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function parseDurationValue(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function validateMedia(
  filePath: string,
  options: ProbeRunnerOptions = {},
): Promise<MediaValidationResult> {
  let fileSizeBytes: number;
  try {
    fileSizeBytes = (await stat(filePath)).size;
  } catch {
    return {
      valid: false,
      error: {
        code: "PROBE_ERROR",
        message: "Unable to read media file",
      },
    };
  }

  const magic = await detectMagicBytes(filePath);
  if (!magic.valid) {
    return {
      valid: false,
      error: {
        code: "INVALID_MAGIC_BYTES",
        message: magic.error?.message ?? "Invalid video container signature",
      },
    };
  }

  let raw: RawFfprobeOutput;
  try {
    raw = await runFfprobe(filePath, options);
  } catch (error) {
    if (error instanceof FfprobeError) {
      if (error.kind === "timeout") {
        return {
          valid: false,
          error: {
            code: "PROBE_TIMEOUT",
            message: `Video probing timed out: ${error.message}`,
          },
        };
      }
      if (error.kind === "not-found") {
        return {
          valid: false,
          error: {
            code: "PROBE_ERROR",
            message: error.message,
          },
        };
      }
      return {
        valid: false,
        error: {
          code: "CORRUPTED_CONTAINER",
          message: "Video container appears corrupted or unreadable",
          details: {
            probeMessage: error.message,
            ...(error.stderr.length > 0 ? { stderr: error.stderr } : {}),
          },
        },
      };
    }
    return {
      valid: false,
      error: {
        code: "PROBE_ERROR",
        message: "Unexpected error while probing media file",
      },
    };
  }

  const videoStreams = raw.streams.filter(
    (stream) =>
      stream.codec_type === "video" &&
      (stream.width ?? 0) > 0 &&
      (stream.height ?? 0) > 0,
  );

  if (videoStreams.length === 0) {
    return {
      valid: false,
      error: {
        code: "MISSING_VIDEO_STREAM",
        message: "No video stream found in container",
      },
    };
  }

  const video = videoStreams[0];
  if (video === undefined) {
    return {
      valid: false,
      error: {
        code: "MISSING_VIDEO_STREAM",
        message: "No video stream found in container",
      },
    };
  }

  const codecName = video.codec_name;
  const normalizedCodec =
    codecName !== undefined ? SUPPORTED_VIDEO_CODECS[codecName] : undefined;
  if (normalizedCodec === undefined) {
    return {
      valid: false,
      error: {
        code: "UNSUPPORTED_VIDEO_CODEC",
        message: `Video codec '${codecName ?? "unknown"}' is not supported. Supported codecs: ${SUPPORTED_CODECS_LIST}.`,
        details: {
          detectedCodec: codecName ?? "unknown",
        },
      },
    };
  }

  const duration = parseDurationValue(raw.format?.duration) ?? parseDurationValue(video.duration);
  if (duration === undefined) {
    return {
      valid: false,
      error: {
        code: "CORRUPTED_STREAM",
        message: "Video stream has no measurable duration",
        details: { streamIndex: video.index },
      },
    };
  }

  const audioStreams = raw.streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  let audioCodec: string | null = null;
  let audioChannels = 0;

  for (const audio of audioStreams) {
    const channels = audio.channels ?? 0;
    if (channels <= 0) {
      return {
        valid: false,
        error: {
          code: "CORRUPTED_STREAM",
          message: "Audio stream has invalid channel count",
          details: { streamIndex: audio.index, channels },
        },
      };
    }
    const codec = audio.codec_name;
    const codecSupported =
      codec !== undefined &&
      (SUPPORTED_AUDIO_CODECS.has(codec) || codec.startsWith("pcm_"));
    if (!codecSupported) {
      return {
        valid: false,
        error: {
          code: "CORRUPTED_STREAM",
          message: `Audio codec '${codec ?? "unknown"}' is not supported. Supported codecs: aac, pcm, mp3, opus, flac.`,
          details: { streamIndex: audio.index, codec: codec ?? "unknown" },
        },
      };
    }
    if (audioCodec === null) {
      audioCodec = codec ?? null;
      audioChannels = channels;
    }
  }

  const metadata: MediaProbeMetadata = {
    duration: Math.round(duration * 1000) / 1000,
    resolution: {
      width: video.width ?? 0,
      height: video.height ?? 0,
    },
    framerate: normalizeFramerate(video.avg_frame_rate) ?? 0,
    audioChannels,
    hasAudio: audioStreams.length > 0,
    videoCodec: normalizedCodec,
    audioCodec,
    containerFormat: raw.format?.format_name ?? magic.signature ?? "unknown",
    bitrate: parseBitrate(raw.format?.bit_rate ?? video.bit_rate),
    pixelFormat: video.pix_fmt ?? null,
    fileSizeBytes,
  };

  return { valid: true, metadata };
}

function parseBitrate(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
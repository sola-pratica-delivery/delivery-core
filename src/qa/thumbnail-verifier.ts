import { open, stat } from "node:fs/promises";
import { FfprobeError, runFfprobe } from "../probe/ffprobe.js";
import type { RawFfprobeStream } from "../probe/types.js";
import { FfmpegError, runFfmpeg } from "./ffmpeg-runner.js";
import type {
  ThumbnailContrastCheck,
  ThumbnailDimensionCheck,
  ThumbnailFileSizeCheck,
  ThumbnailFormatCheck,
  ThumbnailQaDetails,
  ThumbnailQaOptions,
  ThumbnailQaReport,
} from "./types.js";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC_READ_LENGTH = 16;

export const DEFAULT_THUMBNAIL_QA_OPTIONS: Required<ThumbnailQaOptions> = {
  expectedWidth: 1280,
  expectedHeight: 720,
  maxFileSizeBytes: 2_097_152,
  minContrastRange: 20,
  allowedFormats: ["jpeg", "png"],
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 15_000,
};

export function resolveThumbnailOptions(
  options: ThumbnailQaOptions,
): Required<ThumbnailQaOptions> {
  const resolved: Required<ThumbnailQaOptions> = {
    ...DEFAULT_THUMBNAIL_QA_OPTIONS,
    allowedFormats: [...DEFAULT_THUMBNAIL_QA_OPTIONS.allowedFormats],
  };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

export function detectImageMagicBytes(buffer: Buffer): "jpeg" | "png" | null {
  if (
    buffer.length >= JPEG_MAGIC.length &&
    buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)
  ) {
    return "jpeg";
  }
  if (
    buffer.length >= PNG_MAGIC.length &&
    buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
  ) {
    return "png";
  }
  return null;
}

export function parseSignalStatsOutput(output: string): {
  yMin: number;
  yMax: number;
  yAvg: number;
} {
  return {
    yMin: lastSignalStatsValue(output, "YMIN"),
    yMax: lastSignalStatsValue(output, "YMAX"),
    yAvg: lastSignalStatsValue(output, "YAVG"),
  };
}

function lastSignalStatsValue(
  output: string,
  key: "YMIN" | "YMAX" | "YAVG",
): number {
  const matches = Array.from(
    output.matchAll(
      new RegExp(`(?:lavfi\\.signalstats\\.)?${key}=(\\d+(?:\\.\\d+)?)`, "g"),
    ),
  );
  if (matches.length === 0) {
    return 0;
  }
  const raw = matches[matches.length - 1]?.[1];
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

function computeAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return `${width}:${height}`;
  }
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function codecMatchesFormat(
  detectedFormat: "jpeg" | "png",
  codecName: string | undefined,
): boolean {
  if (codecName === undefined) {
    return false;
  }
  if (detectedFormat === "jpeg") {
    return codecName === "mjpeg" || codecName === "jpeg";
  }
  return codecName === "png";
}

function mimeTypeFor(format: "jpeg" | "png"): string {
  return format === "jpeg" ? "image/jpeg" : "image/png";
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

async function readLeadingBytes(
  filePath: string,
  length: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
}

function failedThumbnailReport(
  options: Required<ThumbnailQaOptions>,
  details: ThumbnailQaDetails,
  fileSize: ThumbnailFileSizeCheck,
  failureReasons: string[],
  checkedAt: string,
): ThumbnailQaReport {
  return {
    passed: false,
    checkedAt,
    dimensions: {
      passed: false,
      width: details.width,
      height: details.height,
      expectedWidth: options.expectedWidth,
      expectedHeight: options.expectedHeight,
      aspectRatio: computeAspectRatio(details.width, details.height),
    },
    fileSize,
    format: {
      passed: false,
      detectedFormat: details.format,
      ...(details.format !== null
        ? { mimeType: mimeTypeFor(details.format) }
        : {}),
    },
    contrast: {
      passed: false,
      yMin: 0,
      yMax: 0,
      yAvg: 0,
      luminanceRange: 0,
      minAllowedRange: options.minContrastRange,
    },
    details,
    failureReasons,
  };
}

async function runContrastCheck(
  filePath: string,
  options: Required<ThumbnailQaOptions>,
  failureReasons: string[],
): Promise<ThumbnailContrastCheck> {
  try {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-vf",
      "signalstats,metadata=print:file=-",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ];
    const { stdout, stderr } = await runFfmpeg(args, {
      ffmpegPath: options.ffmpegPath,
      timeoutMs: options.timeoutMs,
    });
    const parsed = parseSignalStatsOutput(`${stdout}\n${stderr}`);
    const luminanceRange = parsed.yMax - parsed.yMin;
    const passed = luminanceRange >= options.minContrastRange;
    if (!passed) {
      failureReasons.push(
        `Image lacks basic contrast / is blank or solid color (luminance range ${luminanceRange}, min allowed ${options.minContrastRange})`,
      );
    }
    return {
      passed,
      yMin: parsed.yMin,
      yMax: parsed.yMax,
      yAvg: parsed.yAvg,
      luminanceRange,
      minAllowedRange: options.minContrastRange,
    };
  } catch (error) {
    failureReasons.push(describeFilterFailure("Contrast check", error));
    return {
      passed: false,
      yMin: 0,
      yMax: 0,
      yAvg: 0,
      luminanceRange: 0,
      minAllowedRange: options.minContrastRange,
    };
  }
}

export async function verifyThumbnail(
  filePath: string,
  options: ThumbnailQaOptions = {},
): Promise<ThumbnailQaReport> {
  const resolved = resolveThumbnailOptions(options);
  const failureReasons: string[] = [];
  const checkedAt = new Date().toISOString();

  let fileSizeBytes: number;
  try {
    fileSizeBytes = (await stat(filePath)).size;
  } catch {
    failureReasons.push(
      `Thumbnail file not found or unreadable: ${filePath}`,
    );
    return failedThumbnailReport(
      resolved,
      { width: 0, height: 0, fileSizeBytes: 0, format: null },
      {
        passed: false,
        fileSizeBytes: 0,
        maxAllowedBytes: resolved.maxFileSizeBytes,
      },
      failureReasons,
      checkedAt,
    );
  }

  const fileSize: ThumbnailFileSizeCheck = {
    passed: fileSizeBytes < resolved.maxFileSizeBytes,
    fileSizeBytes,
    maxAllowedBytes: resolved.maxFileSizeBytes,
  };
  if (!fileSize.passed) {
    failureReasons.push(
      `File size ${fileSizeBytes} bytes exceeds maximum ${resolved.maxFileSizeBytes} bytes`,
    );
  }

  let magicBuffer: Buffer;
  try {
    magicBuffer = await readLeadingBytes(filePath, MAGIC_READ_LENGTH);
  } catch {
    failureReasons.push(`Thumbnail file not readable: ${filePath}`);
    return failedThumbnailReport(
      resolved,
      { width: 0, height: 0, fileSizeBytes, format: null },
      fileSize,
      failureReasons,
      checkedAt,
    );
  }

  const detectedFormat = detectImageMagicBytes(magicBuffer);
  if (detectedFormat === null) {
    failureReasons.push(
      "Invalid image format: magic bytes are not JPEG or PNG",
    );
    return failedThumbnailReport(
      resolved,
      { width: 0, height: 0, fileSizeBytes, format: null },
      fileSize,
      failureReasons,
      checkedAt,
    );
  }
  if (!resolved.allowedFormats.includes(detectedFormat)) {
    failureReasons.push(
      `Image format ${detectedFormat} is not in allowed formats (${resolved.allowedFormats.join(", ")})`,
    );
  }

  let videoStream: RawFfprobeStream | undefined;
  try {
    const output = await runFfprobe(filePath, {
      ffprobePath: resolved.ffprobePath,
      timeoutMs: resolved.timeoutMs,
    });
    videoStream = output.streams.find(
      (stream) => stream.codec_type === "video",
    );
  } catch (error) {
    failureReasons.push(describeProbeFailure(error));
    return failedThumbnailReport(
      resolved,
      { width: 0, height: 0, fileSizeBytes, format: detectedFormat },
      fileSize,
      failureReasons,
      checkedAt,
    );
  }
  if (videoStream === undefined) {
    failureReasons.push("No image/video stream detected in thumbnail file");
    return failedThumbnailReport(
      resolved,
      { width: 0, height: 0, fileSizeBytes, format: detectedFormat },
      fileSize,
      failureReasons,
      checkedAt,
    );
  }

  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;
  const codecName = videoStream.codec_name;

  const codecMatches = codecMatchesFormat(detectedFormat, codecName);
  const formatAllowed = resolved.allowedFormats.includes(detectedFormat);
  const format: ThumbnailFormatCheck = {
    passed: codecMatches && formatAllowed,
    detectedFormat,
    mimeType: mimeTypeFor(detectedFormat),
  };
  if (!codecMatches) {
    failureReasons.push(
      `Image format mismatch: magic bytes indicate ${detectedFormat} but stream codec is ${codecName ?? "unknown"}`,
    );
  }

  const dimensions: ThumbnailDimensionCheck = {
    passed:
      width === resolved.expectedWidth && height === resolved.expectedHeight,
    width,
    height,
    expectedWidth: resolved.expectedWidth,
    expectedHeight: resolved.expectedHeight,
    aspectRatio: computeAspectRatio(width, height),
  };
  if (!dimensions.passed) {
    failureReasons.push(
      `Dimension ${width}x${height} does not match required ${resolved.expectedWidth}x${resolved.expectedHeight}`,
    );
  }

  const contrast = await runContrastCheck(filePath, resolved, failureReasons);

  const details: ThumbnailQaDetails = {
    width,
    height,
    fileSizeBytes,
    format: detectedFormat,
  };

  return {
    passed:
      fileSize.passed && format.passed && dimensions.passed && contrast.passed,
    checkedAt,
    dimensions,
    fileSize,
    format,
    contrast,
    details,
    failureReasons,
  };
}
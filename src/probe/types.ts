export type SupportedVideoCodec = "h264" | "h265" | "prores";

export interface MediaResolution {
  width: number;
  height: number;
}

export interface MediaProbeMetadata {
  duration: number;
  resolution: MediaResolution;
  framerate: number;
  audioChannels: number;
  hasAudio: boolean;
  videoCodec: SupportedVideoCodec;
  audioCodec: string | null;
  containerFormat: string;
  bitrate: number | null;
  pixelFormat: string | null;
  fileSizeBytes: number;
}

export type MediaValidationErrorCode =
  | "INVALID_MAGIC_BYTES"
  | "CORRUPTED_CONTAINER"
  | "MISSING_VIDEO_STREAM"
  | "UNSUPPORTED_VIDEO_CODEC"
  | "CORRUPTED_STREAM"
  | "PROBE_TIMEOUT"
  | "PROBE_ERROR";

export interface MediaValidationError {
  code: MediaValidationErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type MediaValidationResult =
  | {
      valid: true;
      metadata: MediaProbeMetadata;
    }
  | {
      valid: false;
      error: MediaValidationError;
    };

export interface ProbeRunnerOptions {
  ffprobePath?: string;
  timeoutMs?: number;
}

export type MagicBytesSignature = "mp4" | "mov" | "matroska" | "webm" | "avi";

export interface MagicBytesResult {
  valid: boolean;
  signature: MagicBytesSignature | null;
  error: MediaValidationError | null;
}

export interface RawFfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  pix_fmt?: string;
  avg_frame_rate?: string;
}

export interface RawFfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  size?: string;
}

export interface RawFfprobeOutput {
  streams: RawFfprobeStream[];
  format?: RawFfprobeFormat;
}
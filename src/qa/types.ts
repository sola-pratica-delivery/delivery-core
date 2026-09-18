export interface QaInterval {
  start: number;
  end: number;
  duration: number;
}

export interface BlackScreenCheck {
  passed: boolean;
  maxAllowedDuration: number;
  detectedIntervals: QaInterval[];
}

export interface FreezeFrameCheck {
  passed: boolean;
  maxAllowedDuration: number;
  detectedIntervals: QaInterval[];
}

export interface AvSyncCheck {
  passed: boolean;
  videoDuration: number;
  audioDuration: number | null;
  diffSeconds: number | null;
  maxAllowedDiffSeconds: number;
}

export interface VideoQaDetails {
  totalDuration: number;
  videoCodec?: string;
  audioCodec?: string | null;
}

export interface VideoQaReport {
  uploadId?: string;
  passed: boolean;
  checkedAt: string;
  blackScreen: BlackScreenCheck;
  freezeFrame: FreezeFrameCheck;
  avSync: AvSyncCheck;
  details: VideoQaDetails;
  failureReasons: string[];
}

export interface VideoQaOptions {
  blackDetectMinDuration?: number;
  blackDetectPicTh?: number;
  blackDetectPixTh?: number;
  freezeDetectMinDuration?: number;
  freezeDetectNoise?: number;
  maxAvDiffSeconds?: number;
  requireAudio?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

export interface AudioLoudnessCheck {
  passed: boolean;
  integratedLoudness: number;
  minAllowedLufs: number;
  maxAllowedLufs: number;
  loudnessRange?: number;
}

export interface AudioTruePeakCheck {
  passed: boolean;
  truePeak: number;
  maxAllowedTruePeak: number;
}

export interface AudioVoicePresenceCheck {
  passed: boolean;
  maxAllowedSilenceDuration: number;
  detectedSilenceIntervals: QaInterval[];
  totalSilenceDuration: number;
  silencePercentage: number;
}

export interface AudioQaDetails {
  duration: number;
  sampleRate?: number;
  channels?: number;
  audioCodec?: string | null;
}

export interface AudioQaReport {
  uploadId?: string;
  passed: boolean;
  checkedAt: string;
  loudness: AudioLoudnessCheck;
  truePeak: AudioTruePeakCheck;
  voicePresence: AudioVoicePresenceCheck;
  details: AudioQaDetails;
  failureReasons: string[];
}

export interface AudioQaOptions {
  minIntegratedLufs?: number;
  maxIntegratedLufs?: number;
  maxTruePeakDb?: number;
  maxSilenceDuration?: number;
  silenceNoiseThresholdDb?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

export interface ThumbnailDimensionCheck {
  passed: boolean;
  width: number;
  height: number;
  expectedWidth: number;
  expectedHeight: number;
  aspectRatio: string;
}

export interface ThumbnailFileSizeCheck {
  passed: boolean;
  fileSizeBytes: number;
  maxAllowedBytes: number;
}

export interface ThumbnailFormatCheck {
  passed: boolean;
  detectedFormat: "jpeg" | "png" | null;
  mimeType?: string;
}

export interface ThumbnailContrastCheck {
  passed: boolean;
  yMin: number;
  yMax: number;
  yAvg: number;
  luminanceRange: number;
  minAllowedRange: number;
}

export interface ThumbnailQaDetails {
  width: number;
  height: number;
  fileSizeBytes: number;
  format: "jpeg" | "png" | null;
}

export interface ThumbnailQaReport {
  uploadId?: string;
  passed: boolean;
  checkedAt: string;
  dimensions: ThumbnailDimensionCheck;
  fileSize: ThumbnailFileSizeCheck;
  format: ThumbnailFormatCheck;
  contrast: ThumbnailContrastCheck;
  details: ThumbnailQaDetails;
  failureReasons: string[];
}

export interface ThumbnailQaOptions {
  expectedWidth?: number;
  expectedHeight?: number;
  maxFileSizeBytes?: number;
  minContrastRange?: number;
  allowedFormats?: Array<"jpeg" | "png">;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

export interface ConsolidatedQaReport {
  uploadId?: string;
  video?: VideoQaReport;
  audio?: AudioQaReport;
  thumbnail?: ThumbnailQaReport;
  passed: boolean;
  checkedAt: string;
}
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
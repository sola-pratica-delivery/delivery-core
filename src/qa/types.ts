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

export interface ConsolidatedQaReport {
  uploadId?: string;
  video?: VideoQaReport;
  audio?: AudioQaReport;
  passed: boolean;
  checkedAt: string;
}
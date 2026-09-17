import type { MediaProbeMetadata } from "../probe/types.js";

export const JOB_STATUSES = [
  "UPLOADING",
  "UPLOAD_COMPLETED",
  "PROCESSING",
  "AUTO_QA",
  "AUTO_PUBLISH_YOUTUBE",
  "COMPLETED",
  "FAILED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<
  JobStatus,
  readonly JobStatus[]
> = {
  UPLOADING: ["UPLOAD_COMPLETED", "FAILED"],
  UPLOAD_COMPLETED: ["PROCESSING", "FAILED"],
  PROCESSING: ["AUTO_QA", "FAILED"],
  AUTO_QA: ["AUTO_PUBLISH_YOUTUBE", "FAILED"],
  AUTO_PUBLISH_YOUTUBE: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["UPLOADING"],
} as const;

export interface JobStateTransition {
  from: JobStatus | null;
  to: JobStatus;
  timestamp: string;
  durationMs?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadJobMetadata {
  filename: string;
  filetype: string;
  totalSize: number;
  uploadedBytes: number;
  userId?: string;
  duration?: number;
  resolution?: { width: number; height: number };
  framerate?: number;
  videoCodec?: string;
  audioCodec?: string | null;
  audioChannels?: number;
  hasAudio?: boolean;
  containerFormat?: string;
  bitrate?: number | null;
  rawMetadata?: Record<string, string | null>;
}

export interface JobError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface JobRecord {
  jobId: string;
  uploadId: string;
  status: JobStatus;
  filePath: string;
  metadata: UploadJobMetadata;
  transitions: JobStateTransition[];
  createdAt: string;
  updatedAt: string;
  error?: JobError;
  isPurged?: boolean;
  purgedAt?: string;
}

export interface JobStore {
  create(
    job: Omit<JobRecord, "createdAt" | "updatedAt" | "transitions">,
  ): Promise<JobRecord>;
  get(jobIdOrUploadId: string): Promise<JobRecord | null>;
  transition(
    uploadId: string,
    to: JobStatus,
    reason?: string,
    updates?: Partial<JobRecord>,
    transitionMetadata?: Record<string, unknown>,
  ): Promise<JobRecord>;
  update(uploadId: string, updates: Partial<JobRecord>): Promise<JobRecord>;
}

export function toUploadJobMetadata(
  upload: {
    filename: string;
    filetype: string;
    totalSize: number;
    uploadedBytes: number;
    userId?: string;
    rawMetadata?: Record<string, string | null>;
  },
  probe?: MediaProbeMetadata,
): UploadJobMetadata {
  return {
    filename: upload.filename,
    filetype: upload.filetype,
    totalSize: upload.totalSize,
    uploadedBytes: upload.uploadedBytes,
    ...(upload.userId !== undefined ? { userId: upload.userId } : {}),
    ...(upload.rawMetadata !== undefined
      ? { rawMetadata: upload.rawMetadata }
      : {}),
    ...(probe !== undefined
      ? {
          duration: probe.duration,
          resolution: probe.resolution,
          framerate: probe.framerate,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          audioChannels: probe.audioChannels,
          hasAudio: probe.hasAudio,
          containerFormat: probe.containerFormat,
          bitrate: probe.bitrate,
        }
      : {}),
  };
}

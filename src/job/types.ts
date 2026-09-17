import type { MediaProbeMetadata } from "../probe/types.js";

export type JobStatus = "UPLOADING" | "PROCESSING" | "FAILED";

export interface JobStateTransition {
  from: JobStatus | null;
  to: JobStatus;
  timestamp: string;
  reason?: string;
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
  ): Promise<JobRecord>;
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

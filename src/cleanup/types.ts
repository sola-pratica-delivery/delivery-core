export interface StorageCleanupConfig {
  orphanTtlMs: number;
}

export type CleanupReason =
  | "ORPHAN_INCOMPLETE_UPLOAD"
  | "ORPHAN_UNTRACKED_FILE"
  | "COMPLETED_PURGE";

export interface CleanupFileDetail {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  reason: CleanupReason;
}

export interface CleanupResult {
  scannedFilesCount: number;
  deletedFilesCount: number;
  reclaimedBytes: number;
  deletedJobsCount: number;
  details: CleanupFileDetail[];
  executedAt: string;
}

export interface PurgeResult {
  uploadId: string;
  jobId: string;
  purgedFiles: string[];
  reclaimedBytes: number;
  purgedAt: string;
}

export interface StorageCleanupService {
  cleanOrphans(maxAgeMs?: number): Promise<CleanupResult>;
  purgeUpload(uploadId: string): Promise<PurgeResult>;
}
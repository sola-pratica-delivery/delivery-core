import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "../job/types.js";
import type { JobStore } from "../job/types.js";
import type {
  CleanupFileDetail,
  CleanupResult,
  CleanupReason,
  PurgeResult,
  StorageCleanupConfig,
  StorageCleanupService as StorageCleanupServiceInterface,
} from "./types.js";

export const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export class PurgeNotFoundError extends Error {}
export class PurgeConflictError extends Error {}

interface ScannedFile {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export class StorageCleanupService implements StorageCleanupServiceInterface {
  constructor(
    private readonly storageDir: string,
    private readonly jobStore: JobStore,
    private readonly config: StorageCleanupConfig = {
      orphanTtlMs: DEFAULT_ORPHAN_TTL_MS,
    },
  ) {}

  async cleanOrphans(maxAgeMs?: number): Promise<CleanupResult> {
    const effectiveMaxAge = maxAgeMs ?? this.config.orphanTtlMs;
    const now = Date.now();
    const files = await this.scanFiles();

    const result: CleanupResult = {
      scannedFilesCount: files.length,
      deletedFilesCount: 0,
      reclaimedBytes: 0,
      deletedJobsCount: 0,
      details: [],
      executedAt: new Date().toISOString(),
    };

    const raws = new Map<string, ScannedFile>();
    const tusJson = new Map<string, ScannedFile>();
    const validations = new Map<string, ScannedFile>();
    const jobFiles: ScannedFile[] = [];

    for (const file of files) {
      if (file.fileName.endsWith(".job.json")) {
        jobFiles.push(file);
      } else if (file.fileName.endsWith(".validation.json")) {
        validations.set(file.fileName.slice(0, -16), file);
      } else if (file.fileName.endsWith(".json")) {
        tusJson.set(file.fileName.slice(0, -5), file);
      } else {
        raws.set(file.fileName, file);
      }
    }

    for (const [uploadId, rawFile] of raws) {
      if (now - rawFile.mtimeMs < effectiveMaxAge) {
        continue;
      }
      const job = await this.jobStore.get(uploadId);
      let reason: CleanupReason;
      if (job === null) {
        reason = "ORPHAN_UNTRACKED_FILE";
      } else if (job.status === "UPLOADING") {
        reason = "ORPHAN_INCOMPLETE_UPLOAD";
        await this.jobStore.transition(uploadId, "FAILED", "ORPHAN_UPLOAD_EXPIRED", {
          error: {
            code: "ORPHAN_UPLOAD_EXPIRED",
            message: "Orphan upload exceeded the staging TTL",
          },
        });
      } else {
        continue;
      }
      await this.deleteFile(rawFile, reason, result);
      const tus = tusJson.get(uploadId);
      if (tus !== undefined) {
        await this.deleteFile(tus, reason, result);
      }
      const validation = validations.get(uploadId);
      if (validation !== undefined) {
        await this.deleteFile(validation, reason, result);
      }
    }

    for (const [uploadId, file] of tusJson) {
      if (now - file.mtimeMs < effectiveMaxAge) {
        continue;
      }
      if (raws.has(uploadId)) {
        continue;
      }
      await this.deleteFile(file, "ORPHAN_UNTRACKED_FILE", result);
    }

    for (const [uploadId, file] of validations) {
      if (now - file.mtimeMs < effectiveMaxAge) {
        continue;
      }
      if (raws.has(uploadId)) {
        continue;
      }
      await this.deleteFile(file, "ORPHAN_UNTRACKED_FILE", result);
    }

    for (const jobFile of jobFiles) {
      if (now - jobFile.mtimeMs < effectiveMaxAge) {
        continue;
      }
      const record = await this.readJobRecord(jobFile.filePath);
      if (record === null) {
        await this.deleteFile(jobFile, "ORPHAN_UNTRACKED_FILE", result);
        result.deletedJobsCount += 1;
        continue;
      }
      if (!raws.has(record.uploadId) && record.isPurged !== true) {
        await this.jobStore.transition(
          record.uploadId,
          record.status,
          "Marked as purged after raw material loss",
          { isPurged: true, purgedAt: new Date().toISOString() },
        );
      }
    }

    return result;
  }

  async purgeUpload(uploadId: string): Promise<PurgeResult> {
    const job = await this.jobStore.get(uploadId);
    if (job === null) {
      throw new PurgeNotFoundError(`Job not found for upload ${uploadId}`);
    }
    if (job.status === "UPLOADING") {
      throw new PurgeConflictError(
        `Upload ${uploadId} is still in progress and cannot be purged`,
      );
    }
    const purgedAt = new Date().toISOString();
    if (job.isPurged === true) {
      return {
        uploadId,
        jobId: job.jobId,
        purgedFiles: [],
        reclaimedBytes: 0,
        purgedAt: job.purgedAt ?? purgedAt,
      };
    }

    const purgedFiles: string[] = [];
    let reclaimedBytes = 0;
    try {
      const info = await stat(job.filePath);
      if (info.isFile()) {
        await rm(job.filePath, { force: true });
        purgedFiles.push(job.filePath);
        reclaimedBytes += info.size;
      }
    } catch {
      // Physical file already gone; purge marking stays idempotent.
    }

    await this.jobStore.transition(uploadId, job.status, "Raw material purged", {
      isPurged: true,
      purgedAt,
    });

    const refreshed = await this.jobStore.get(uploadId);
    return {
      uploadId,
      jobId: refreshed?.jobId ?? job.jobId,
      purgedFiles,
      reclaimedBytes,
      purgedAt,
    };
  }

  private async scanFiles(): Promise<ScannedFile[]> {
    let entries;
    try {
      entries = await readdir(this.storageDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: ScannedFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(this.storageDir, entry.name);
      try {
        const info = await stat(filePath);
        files.push({
          fileName: entry.name,
          filePath,
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        continue;
      }
    }
    return files;
  }

  private async deleteFile(
    file: ScannedFile,
    reason: CleanupReason,
    result: CleanupResult,
  ): Promise<void> {
    const detail: CleanupFileDetail = {
      fileName: file.fileName,
      filePath: file.filePath,
      sizeBytes: file.sizeBytes,
      reason,
    };
    try {
      await rm(file.filePath, { force: true });
    } catch {
      result.details.push(detail);
      return;
    }
    result.deletedFilesCount += 1;
    result.reclaimedBytes += file.sizeBytes;
    result.details.push(detail);
  }

  private async readJobRecord(filePath: string): Promise<JobRecord | null> {
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as JobRecord;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.uploadId !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
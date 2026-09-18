import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  JobPublicationArchive,
  JobRecord,
  JobStateTransition,
  JobStatus,
  JobStore,
} from "./types.js";
import { JobStateMachine } from "./state-machine.js";

export class FileJobStore implements JobStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private jobPath(jobId: string): string {
    return path.join(this.directory, `${jobId}.job.json`);
  }

  async create(
    job: Omit<JobRecord, "createdAt" | "updatedAt" | "transitions">,
  ): Promise<JobRecord> {
    await mkdir(this.directory, { recursive: true });
    const now = new Date().toISOString();
    const record: JobRecord = {
      ...job,
      jobId: job.jobId ?? randomUUID(),
      transitions: [
        { from: null, to: job.status, timestamp: now, reason: "Upload started" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(record);
    return record;
  }

  async get(jobIdOrUploadId: string): Promise<JobRecord | null> {
    const direct = await this.readFile(this.jobPath(jobIdOrUploadId));
    if (direct !== null) {
      return direct;
    }

    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      return null;
    }

    for (const file of files) {
      if (!file.endsWith(".job.json")) {
        continue;
      }
      const record = await this.readFile(path.join(this.directory, file));
      if (record !== null && record.uploadId === jobIdOrUploadId) {
        return record;
      }
    }

    return null;
  }

  async transition(
    uploadId: string,
    to: JobStatus,
    reason?: string,
    updates?: Partial<JobRecord>,
    transitionMetadata?: Record<string, unknown>,
  ): Promise<JobRecord> {
    const existing = await this.get(uploadId);
    if (existing === null) {
      throw new Error(`Job not found for upload ${uploadId}`);
    }

    JobStateMachine.validateTransition(existing.status, to);

    const now = new Date().toISOString();
    const previous = existing.transitions[existing.transitions.length - 1];
    const durationMs =
      previous !== undefined
        ? JobStateMachine.calculateDuration(previous.timestamp, now)
        : undefined;
    const transition: JobStateTransition = {
      from: existing.status,
      to,
      timestamp: now,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(transitionMetadata !== undefined
        ? { metadata: transitionMetadata }
        : {}),
    };

    const record: JobRecord = {
      ...existing,
      ...updates,
      status: to,
      updatedAt: now,
      transitions: [...existing.transitions, transition],
    };

    await this.save(record);
    return record;
  }

  async update(
    uploadId: string,
    updates: Partial<JobRecord>,
  ): Promise<JobRecord> {
    const existing = await this.get(uploadId);
    if (existing === null) {
      throw new Error(`Job not found for upload ${uploadId}`);
    }

    const record: JobRecord = {
      ...existing,
      ...updates,
      status: existing.status,
      transitions: existing.transitions,
      updatedAt: new Date().toISOString(),
    };

    await this.save(record);
    return record;
  }

  async completeJob(
    uploadId: string,
    publication?: Omit<JobPublicationArchive, "archivedAt"> & {
      archivedAt?: string;
    },
    reason?: string,
  ): Promise<JobRecord> {
    const existing = await this.get(uploadId);
    if (existing === null) {
      throw new Error(`Job not found for upload ${uploadId}`);
    }

    JobStateMachine.validateTransition(existing.status, "COMPLETED");

    const now = new Date().toISOString();
    const previous = existing.transitions[existing.transitions.length - 1];
    const durationMs =
      previous !== undefined
        ? JobStateMachine.calculateDuration(previous.timestamp, now)
        : undefined;
    const transition: JobStateTransition = {
      from: existing.status,
      to: "COMPLETED",
      timestamp: now,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };

    const record: JobRecord = {
      ...existing,
      status: "COMPLETED",
      ...(publication !== undefined
        ? {
            publication: {
              ...publication,
              archivedAt: publication.archivedAt ?? now,
            },
          }
        : {}),
      completedAt: now,
      updatedAt: now,
      transitions: [...existing.transitions, transition],
    };

    await this.save(record);
    return record;
  }

  private async readFile(filePath: string): Promise<JobRecord | null> {
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as JobRecord;
    } catch {
      return null;
    }
  }

  private async save(record: JobRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.jobPath(record.jobId),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}
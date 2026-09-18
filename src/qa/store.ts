import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AudioQaReport,
  ConsolidatedQaReport,
  VideoQaReport,
} from "./types.js";

interface StoredQaReport {
  uploadId?: string;
  video?: VideoQaReport;
  audio?: AudioQaReport;
  passed: boolean;
  checkedAt: string;
}

export class QaStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private reportPath(uploadId: string): string {
    return path.join(this.directory, `${uploadId}.qa.json`);
  }

  private async readRaw(uploadId: string): Promise<StoredQaReport | null> {
    try {
      const content = await readFile(this.reportPath(uploadId), "utf8");
      return JSON.parse(content) as StoredQaReport;
    } catch {
      return null;
    }
  }

  private async writeStored(uploadId: string, stored: StoredQaReport): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.reportPath(uploadId),
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8",
    );
  }

  async save(uploadId: string, report: VideoQaReport): Promise<void> {
    const existing = await this.readRaw(uploadId);
    const video = { ...report, uploadId };
    const stored: StoredQaReport = {
      uploadId,
      video,
      ...(existing?.audio !== undefined ? { audio: existing.audio } : {}),
      passed: video.passed && (existing?.audio?.passed ?? true),
      checkedAt: report.checkedAt,
    };
    await this.writeStored(uploadId, stored);
  }

  async saveAudio(uploadId: string, report: AudioQaReport): Promise<void> {
    const existing = await this.readRaw(uploadId);
    const audio = { ...report, uploadId };
    const stored: StoredQaReport = {
      uploadId,
      ...(existing?.video !== undefined ? { video: existing.video } : {}),
      audio,
      passed: (existing?.video?.passed ?? true) && audio.passed,
      checkedAt: report.checkedAt,
    };
    await this.writeStored(uploadId, stored);
  }

  async saveConsolidated(
    uploadId: string,
    report: ConsolidatedQaReport,
  ): Promise<void> {
    const existing = await this.readRaw(uploadId);
    const video = report.video ?? existing?.video;
    const audio = report.audio ?? existing?.audio;
    const stored: StoredQaReport = {
      uploadId,
      ...(video !== undefined ? { video } : {}),
      ...(audio !== undefined ? { audio } : {}),
      passed: (video?.passed ?? true) && (audio?.passed ?? true),
      checkedAt: report.checkedAt,
    };
    await this.writeStored(uploadId, stored);
  }

  async read(uploadId: string): Promise<VideoQaReport | null> {
    const raw = await this.readRaw(uploadId);
    return raw?.video ?? null;
  }

  async readAudio(uploadId: string): Promise<AudioQaReport | null> {
    const raw = await this.readRaw(uploadId);
    return raw?.audio ?? null;
  }

  async readConsolidated(
    uploadId: string,
  ): Promise<ConsolidatedQaReport | null> {
    const raw = await this.readRaw(uploadId);
    if (raw === null) {
      return null;
    }
    return {
      ...(raw.uploadId !== undefined ? { uploadId: raw.uploadId } : {}),
      ...(raw.video !== undefined ? { video: raw.video } : {}),
      ...(raw.audio !== undefined ? { audio: raw.audio } : {}),
      passed: raw.passed,
      checkedAt: raw.checkedAt,
    };
  }
}
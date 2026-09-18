import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AudioQaReport,
  ConsolidatedQaReport,
  ThumbnailQaReport,
  VideoQaReport,
} from "./types.js";

interface StoredQaReport {
  uploadId?: string;
  video?: VideoQaReport;
  audio?: AudioQaReport;
  thumbnail?: ThumbnailQaReport;
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
      ...(existing?.thumbnail !== undefined
        ? { thumbnail: existing.thumbnail }
        : {}),
      passed:
        video.passed &&
        (existing?.audio?.passed ?? true) &&
        (existing?.thumbnail?.passed ?? true),
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
      ...(existing?.thumbnail !== undefined
        ? { thumbnail: existing.thumbnail }
        : {}),
      passed:
        (existing?.video?.passed ?? true) &&
        audio.passed &&
        (existing?.thumbnail?.passed ?? true),
      checkedAt: report.checkedAt,
    };
    await this.writeStored(uploadId, stored);
  }

  async saveThumbnail(
    uploadId: string,
    report: ThumbnailQaReport,
  ): Promise<void> {
    const existing = await this.readRaw(uploadId);
    const thumbnail = { ...report, uploadId };
    const stored: StoredQaReport = {
      uploadId,
      ...(existing?.video !== undefined ? { video: existing.video } : {}),
      ...(existing?.audio !== undefined ? { audio: existing.audio } : {}),
      thumbnail,
      passed:
        (existing?.video?.passed ?? true) &&
        (existing?.audio?.passed ?? true) &&
        thumbnail.passed,
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
    const thumbnail = report.thumbnail ?? existing?.thumbnail;
    const stored: StoredQaReport = {
      uploadId,
      ...(video !== undefined ? { video } : {}),
      ...(audio !== undefined ? { audio } : {}),
      ...(thumbnail !== undefined ? { thumbnail } : {}),
      passed:
        (video?.passed ?? true) &&
        (audio?.passed ?? true) &&
        (thumbnail?.passed ?? true),
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

  async readThumbnail(uploadId: string): Promise<ThumbnailQaReport | null> {
    const raw = await this.readRaw(uploadId);
    return raw?.thumbnail ?? null;
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
      ...(raw.thumbnail !== undefined ? { thumbnail: raw.thumbnail } : {}),
      passed: raw.passed,
      checkedAt: raw.checkedAt,
    };
  }
}
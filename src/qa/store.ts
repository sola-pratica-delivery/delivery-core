import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoQaReport } from "./types.js";

export class QaStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private reportPath(uploadId: string): string {
    return path.join(this.directory, `${uploadId}.qa.json`);
  }

  async save(uploadId: string, report: VideoQaReport): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const persisted: VideoQaReport = { ...report, uploadId };
    await writeFile(
      this.reportPath(uploadId),
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
  }

  async read(uploadId: string): Promise<VideoQaReport | null> {
    try {
      const content = await readFile(this.reportPath(uploadId), "utf8");
      return JSON.parse(content) as VideoQaReport;
    } catch {
      return null;
    }
  }
}
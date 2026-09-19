import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { YouTubeSeoMetadata } from "./types.js";

export class SeoStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private reportPath(uploadId: string): string {
    return path.join(this.directory, `${uploadId}.seo.json`);
  }

  async save(uploadId: string, metadata: YouTubeSeoMetadata): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.reportPath(uploadId),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  }

  async read(uploadId: string): Promise<YouTubeSeoMetadata | null> {
    try {
      const content = await readFile(this.reportPath(uploadId), "utf8");
      return JSON.parse(content) as YouTubeSeoMetadata;
    } catch {
      return null;
    }
  }
}
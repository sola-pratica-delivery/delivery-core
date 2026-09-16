import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MediaValidationError,
  MediaValidationResult,
  MediaProbeMetadata,
} from "./types.js";

export type ValidationStatus = "VALID" | "REJECTED";

export interface ValidationReport {
  uploadId: string;
  status: ValidationStatus;
  metadata?: MediaProbeMetadata;
  error?: MediaValidationError;
}

export function toValidationReport(
  uploadId: string,
  result: MediaValidationResult,
): ValidationReport {
  if (result.valid) {
    return { uploadId, status: "VALID", metadata: result.metadata };
  }
  return { uploadId, status: "REJECTED", error: result.error };
}

export class ValidationStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private reportPath(uploadId: string): string {
    return path.join(this.directory, `${uploadId}.validation.json`);
  }

  async save(uploadId: string, result: MediaValidationResult): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const report = toValidationReport(uploadId, result);
    await writeFile(
      this.reportPath(uploadId),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  async read(uploadId: string): Promise<ValidationReport | null> {
    try {
      const content = await readFile(this.reportPath(uploadId), "utf8");
      return JSON.parse(content) as ValidationReport;
    } catch {
      return null;
    }
  }
}
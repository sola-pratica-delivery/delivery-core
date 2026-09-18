import { execFile } from "node:child_process";
import type { ProbeRunnerOptions, RawFfprobeOutput } from "./types.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export type FfprobeErrorKind = "timeout" | "not-found" | "execution";

export class FfprobeError extends Error {
  readonly kind: FfprobeErrorKind;
  readonly stderr: string;

  constructor(kind: FfprobeErrorKind, message: string, stderr = "") {
    super(message);
    this.name = "FfprobeError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

const PROBE_ENTRIES =
  "format=format_name,duration,bit_rate,size:" +
  "stream=index,codec_name,codec_type,width,height,channels,sample_rate,bit_rate,pix_fmt,avg_frame_rate";

export function runFfprobe(
  filePath: string,
  options: ProbeRunnerOptions = {},
): Promise<RawFfprobeOutput> {
  const binary = options.ffprobePath ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-of",
      "json",
      "-show_entries",
      PROBE_ENTRIES,
      "--",
      filePath,
    ];

    execFile(
      binary,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const errno = error as NodeJS.ErrnoException;
          if (errno.code === "ETIMEDOUT" || error.killed) {
            reject(
              new FfprobeError(
                "timeout",
                `ffprobe timed out after ${timeoutMs}ms`,
              ),
            );
            return;
          }
          if (errno.code === "ENOENT") {
            reject(
              new FfprobeError(
                "not-found",
                `ffprobe binary not found at '${binary}'`,
              ),
            );
            return;
          }
          const stderrText = stderr?.trim() ?? "";
          reject(
            new FfprobeError(
              "execution",
              stderrText.length > 0 ? stderrText : error.message,
              stderrText,
            ),
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as Partial<RawFfprobeOutput>;
          const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
          resolve({ streams, ...(parsed.format ? { format: parsed.format } : {}) });
        } catch {
          reject(
            new FfprobeError(
              "execution",
              "Failed to parse ffprobe JSON output",
            ),
          );
        }
      },
    );
  });
}
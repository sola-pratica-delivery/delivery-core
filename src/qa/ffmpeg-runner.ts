import { execFile } from "node:child_process";

export const DEFAULT_FFMPEG_TIMEOUT_MS = 30_000;

export type FfmpegErrorKind = "timeout" | "not-found" | "execution";

export class FfmpegError extends Error {
  readonly kind: FfmpegErrorKind;
  readonly stderr: string;

  constructor(kind: FfmpegErrorKind, message: string, stderr = "") {
    super(message);
    this.name = "FfmpegError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

export interface FfmpegRunOptions {
  ffmpegPath?: string;
  timeoutMs?: number;
}

export interface FfmpegRunResult {
  stdout: string;
  stderr: string;
}

export function runFfmpeg(
  args: string[],
  options: FfmpegRunOptions = {},
): Promise<FfmpegRunResult> {
  const binary = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const errno = error as NodeJS.ErrnoException;
          if (errno.code === "ETIMEDOUT" || error.killed) {
            reject(
              new FfmpegError(
                "timeout",
                `ffmpeg timed out after ${timeoutMs}ms`,
              ),
            );
            return;
          }
          if (errno.code === "ENOENT") {
            reject(
              new FfmpegError(
                "not-found",
                `ffmpeg binary not found at '${binary}'`,
              ),
            );
            return;
          }
          const stderrText = stderr?.trim() ?? "";
          reject(
            new FfmpegError(
              "execution",
              stderrText.length > 0 ? stderrText : error.message,
              stderrText,
            ),
          );
          return;
        }

        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}
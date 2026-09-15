import { AsyncLocalStorage } from "node:async_hooks";

export type ChecksumAlgorithm = "sha1" | "sha256" | "md5";

export interface ParsedChecksum {
  algorithm: ChecksumAlgorithm;
  value: string;
}

const SUPPORTED_ALGORITHMS = new Map<string, ChecksumAlgorithm>([
  ["sha1", "sha1"],
  ["sha2-256", "sha256"],
  ["sha256", "sha256"],
  ["md5", "md5"],
]);

export function parseChecksumHeader(header?: string): ParsedChecksum | null {
  if (!header) {
    return null;
  }
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) {
    return null;
  }
  const [algorithm, value] = parts;
  const normalized = algorithm !== undefined ? SUPPORTED_ALGORITHMS.get(algorithm) : undefined;
  if (!normalized || !value) {
    return null;
  }
  return { algorithm: normalized, value };
}

export const checksumContext = new AsyncLocalStorage<ParsedChecksum | null>();
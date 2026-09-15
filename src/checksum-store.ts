import { createHash } from "node:crypto";
import { truncate } from "node:fs/promises";
import path from "node:path";
import type stream from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { ERRORS } from "@tus/server";
import { FileStore } from "@tus/file-store";
import { checksumContext } from "./checksum.js";

export interface ChecksumMismatchError extends Error {
  status_code: number;
  body: string;
}

export function createChecksumMismatchError(): ChecksumMismatchError {
  const error = new Error("Checksum Mismatch") as ChecksumMismatchError;
  error.status_code = 460;
  error.body = "Checksum Mismatch\n";
  return error;
}

export class ChecksumFileStore extends FileStore {
  override async write(
    readable: stream.Readable,
    fileId: string,
    offset: number,
  ): Promise<number> {
    const expected = checksumContext.getStore();
    if (!expected) {
      return super.write(readable, fileId, offset);
    }
    const hash = createHash(expected.algorithm);
    let bytesReceived = 0;
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        if (typeof chunk === "string") {
          hash.update(chunk);
          bytesReceived += Buffer.byteLength(chunk);
        } else {
          hash.update(chunk);
          bytesReceived += chunk.length;
        }
        callback(null, chunk);
      },
    });
    const filePath = path.join(this.directory, fileId);
    const writeStream = createWriteStream(filePath, {
      flags: "r+",
      start: offset,
    });
    try {
      await pipeline(readable, hasher, writeStream);
    } catch {
      throw ERRORS.FILE_WRITE_ERROR;
    }
    const actual = hash.digest("base64");
    if (actual !== expected.value) {
      await truncate(filePath, offset);
      throw createChecksumMismatchError();
    }
    return offset + bytesReceived;
  }
}
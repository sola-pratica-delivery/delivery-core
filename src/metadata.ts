import { stat } from "node:fs/promises";
import type { Upload } from "@tus/server";
import type { UploadMetadata } from "./types.js";

export async function toUploadMetadata(upload: Upload): Promise<UploadMetadata> {
  const metadata = upload.metadata ?? {};
  const dynamicZoom = parseDynamicZoom(metadata["dynamicZoom"]);
  let updatedAt = new Date().toISOString();
  const storagePath =
    upload.storage?.type === "file" ? upload.storage.path : undefined;
  if (storagePath) {
    try {
      updatedAt = (await stat(storagePath)).mtime.toISOString();
    } catch {
      updatedAt = new Date().toISOString();
    }
  }
  const rawMetadata =
    Object.keys(metadata).length > 0 ? metadata : undefined;
  return {
    uploadId: upload.id,
    filename: typeof metadata["filename"] === "string" ? metadata["filename"] : "",
    filetype: typeof metadata["filetype"] === "string" ? metadata["filetype"] : "",
    totalSize: upload.size ?? 0,
    uploadedBytes: upload.offset,
    ...(dynamicZoom !== undefined ? { dynamicZoom } : {}),
    createdAt: new Date(upload.creation_date ?? Date.now()).toISOString(),
    updatedAt,
    isCompleted: upload.size !== undefined && upload.offset >= upload.size,
    ...(rawMetadata ? { rawMetadata } : {}),
  };
}

export function parseDynamicZoom(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}
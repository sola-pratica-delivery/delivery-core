import { EVENTS, Server } from "@tus/server";
import type { AppConfig } from "./types.js";
import { ChecksumFileStore } from "./checksum-store.js";
import { toUploadMetadata } from "./metadata.js";

export const TUS_EXTENSIONS = ["creation", "termination", "checksum"];

export function createTusServer(config: AppConfig): Server {
  const store = new ChecksumFileStore({ directory: config.storageDir });
  store.extensions = [...TUS_EXTENSIONS];

  const server = new Server({
    path: config.uploadPath,
    datastore: store,
    maxSize: config.maxFileSize,
    relativeLocation: true,
    getFileIdFromRequest: (_req, lastPath) =>
      lastPath?.split("?")[0] || undefined,
    onIncomingRequest: async (req, id) => {
      if (req.method !== "PATCH") {
        return;
      }
      const upload = await store.getUpload(id);
      if (upload.size !== undefined && upload.offset >= upload.size) {
        throw Object.assign(new Error("Upload already completed"), {
          status_code: 409,
          body: "Upload already completed\n",
        });
      }
    },
  });

  server.on(EVENTS.POST_FINISH, async (_req, _res, upload) => {
    try {
      const stored = await store.getUpload(upload.id);
      const metadata = await toUploadMetadata(stored);
      await config.onUploadComplete?.(metadata);
    } catch {
      // Intentionally swallowed: observability wiring lands in a later issue.
    }
  });

  return server;
}
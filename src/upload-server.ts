import { EVENTS, Server } from "@tus/server";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, UploadMetadata } from "./types.js";
import { ChecksumFileStore } from "./checksum-store.js";
import { toUploadMetadata } from "./metadata.js";
import { validateMedia } from "./probe/validator.js";
import { ValidationStore } from "./probe/store.js";
import type { MediaValidationResult } from "./probe/types.js";
import { FileJobStore } from "./job/store.js";
import { toUploadJobMetadata } from "./job/types.js";
import { InMemoryEventDispatcher } from "./events/dispatcher.js";
import type { UploadCompletedEventPayload } from "./events/types.js";

export const TUS_EXTENSIONS = ["creation", "termination", "checksum"];

export function createTusServer(config: AppConfig): Server {
  const store = new ChecksumFileStore({ directory: config.storageDir });
  store.extensions = [...TUS_EXTENSIONS];
  const jobStore = new FileJobStore(config.storageDir);
  const dispatcher = new InMemoryEventDispatcher();

  const server = new Server({
    path: config.uploadPath,
    datastore: store,
    maxSize: config.maxFileSize,
    relativeLocation: true,
    getFileIdFromRequest: (_req, lastPath) =>
      lastPath?.split("?")[0] || undefined,
    onUploadCreate: async (_req, upload) => {
      try {
        const metadata = await toUploadMetadata(upload);
        const filePath = path.join(config.storageDir, upload.id);
        const job = await jobStore.create({
          jobId: randomUUID(),
          uploadId: upload.id,
          status: "UPLOADING",
          filePath,
          metadata: toUploadJobMetadata(metadata),
        });
        await config.onJobUpdated?.(job);
      } catch {
        // Intentionally swallowed: observability wiring lands in a later issue.
      }
      return {};
    },
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
      const storagePath =
        stored.storage?.type === "file"
          ? stored.storage.path
          : path.join(config.storageDir, upload.id);

      let job = await jobStore.get(upload.id);
      if (job !== null) {
        if (job.status === "PROCESSING" || job.status === "FAILED") {
          return;
        }
      } else {
        job = await jobStore.create({
          jobId: randomUUID(),
          uploadId: upload.id,
          status: "UPLOADING",
          filePath: storagePath,
          metadata: toUploadJobMetadata(metadata),
        });
      }

      const result = await runValidation(config, upload.id, storagePath, metadata);
      if (result.valid) {
        job = await jobStore.transition(
          upload.id,
          "UPLOAD_COMPLETED",
          "Media validation passed",
          {
            metadata: toUploadJobMetadata(metadata, result.metadata),
          },
        );
        job = await jobStore.transition(
          upload.id,
          "PROCESSING",
          "Video queued for processing",
        );
        await config.onJobUpdated?.(job);
        const event: UploadCompletedEventPayload = {
          eventId: randomUUID(),
          eventType: "UPLOAD_COMPLETED",
          jobId: job.jobId,
          uploadId: upload.id,
          filePath: job.filePath,
          metadata: job.metadata,
          occurredAt: new Date().toISOString(),
        };
        await dispatcher.dispatch(event);
        await config.onEventEmitted?.(event);
      } else {
        job = await jobStore.transition(upload.id, "FAILED", `Media validation rejected: ${result.error.code}`, {
          error: {
            code: result.error.code,
            message: result.error.message,
            ...(result.error.details !== undefined
              ? { details: result.error.details }
              : {}),
          },
        });
        await config.onJobUpdated?.(job);
      }
      await config.onUploadComplete?.(metadata);
    } catch {
      // Intentionally swallowed: observability wiring lands in a later issue.
    }
  });

  return server;
}

async function runValidation(
  config: AppConfig,
  uploadId: string,
  storagePath: string,
  metadata: UploadMetadata,
): Promise<MediaValidationResult> {
  const validationStore = new ValidationStore(config.storageDir);
  const result = await validateMedia(storagePath);
  await validationStore.save(uploadId, result);
  await config.onUploadValidated?.(result, metadata);
  return result;
}
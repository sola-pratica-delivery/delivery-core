import { stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./types.js";
import { createAuth } from "./auth.js";
import { requireOffsetContentType, requireTusResumable } from "./protocol.js";
import { createTusServer } from "./upload-server.js";
import { checksumContext, parseChecksumHeader } from "./checksum.js";
import { ValidationStore } from "./probe/store.js";
import { QaStore } from "./qa/store.js";
import { DEFAULT_QA_OPTIONS, verifyVideoQuality } from "./qa/video-verifier.js";
import { FileJobStore } from "./job/store.js";
import { JOB_STATUSES } from "./job/types.js";
import type { JobPublicationArchive } from "./job/types.js";
import { InvalidStateTransitionError } from "./job/state-machine.js";
import { InMemoryQueueManager } from "./queue/manager.js";
import { QUEUE_NAMES } from "./queue/types.js";
import type { VideoProcessingJobData, YouTubePublishJobData } from "./queue/types.js";
import {
  PurgeConflictError,
  PurgeNotFoundError,
  StorageCleanupService,
} from "./cleanup/service.js";

const youtubeVideoPublicationSchema = z.object({
  videoId: z.string().min(1),
  videoUrl: z.string().url().or(z.string().min(1)),
  title: z.string().optional(),
  publishedAt: z.string().optional(),
  privacyStatus: z.string().optional(),
});

const youtubeShortPublicationSchema = z.object({
  shortId: z.string().min(1),
  videoId: z.string().min(1),
  videoUrl: z.string().url().or(z.string().min(1)),
  title: z.string().optional(),
  publishedAt: z.string().optional(),
  cutIndex: z.number().int().nonnegative().optional(),
});

const cutStatisticItemSchema = z.object({
  cutId: z.string().min(1),
  startTimeSeconds: z.number().nonnegative().optional(),
  endTimeSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  aspectRatio: z.string().optional(),
  headline: z.string().optional(),
  shortId: z.string().optional(),
  youtubeVideoId: z.string().optional(),
  youtubeUrl: z.string().optional(),
});

const cutsStatisticsSchema = z.object({
  totalCuts: z.number().int().nonnegative(),
  totalDurationSeconds: z.number().nonnegative().optional(),
  averageDurationSeconds: z.number().nonnegative().optional(),
  items: z.array(cutStatisticItemSchema).optional(),
});

const publicationSchema = z.object({
  youtube: z
    .object({
      longVideo: youtubeVideoPublicationSchema.optional(),
      shorts: z.array(youtubeShortPublicationSchema).optional(),
    })
    .optional(),
  cuts: cutsStatisticsSchema.optional(),
  archivedAt: z.string().datetime({ offset: true }).optional(),
});

const transitionBodySchema = z.object({
  to: z.enum(JOB_STATUSES),
  reason: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  publication: publicationSchema.optional(),
});

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  const tus = createTusServer(config);
  const authenticate = createAuth(config);
  const validationStore = new ValidationStore(config.storageDir);
  const jobStore = new FileJobStore(config.storageDir);
  const qaStore = new QaStore(config.storageDir);
  const cleanupService = new StorageCleanupService(config.storageDir, jobStore, {
    orphanTtlMs: config.orphanTtlHours * 60 * 60 * 1000,
  });
  const queueManager = new InMemoryQueueManager({
    maxRetries: config.queue.maxRetries,
    backoffDelayMs: config.queue.backoffDelayMs,
    concurrency: {
      [QUEUE_NAMES.VIDEO_PROCESSING]: config.queue.concurrencyVideoEngine,
      [QUEUE_NAMES.YOUTUBE_PUBLISH]: config.queue.concurrencyPublisher,
    },
    onJobFailed: async (failure) => {
      const data = failure.data as Partial<
        VideoProcessingJobData & YouTubePublishJobData
      >;
      const jobId = typeof data.jobId === "string" ? data.jobId : undefined;
      const uploadId = typeof data.uploadId === "string" ? data.uploadId : undefined;
      const key = uploadId ?? jobId;
      if (key === undefined) {
        return;
      }
      const job = await jobStore.get(key);
      if (job === null || job.status === "FAILED" || job.status === "COMPLETED") {
        return;
      }
      await jobStore.transition(key, "FAILED", `Queue terminal failure: ${failure.error.message}`, {
        error: {
          code: "QUEUE_JOB_FAILED",
          message: failure.error.message,
        },
      });
    },
  });
  app.decorate("queueManager", queueManager);
  app.addHook("onClose", async () => {
    await queueManager.close();
  });

  async function resolveUploadFile(uploadId: string): Promise<string | null> {
    const job = await jobStore.get(uploadId);
    const candidates = [job?.filePath, path.join(config.storageDir, uploadId)];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate.length === 0) {
        continue;
      }
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          return candidate;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  async function tusGateway(request: FastifyRequest, reply: FastifyReply) {
    await authenticate(request, reply);
    if (reply.sent) {
      return;
    }
    await requireTusResumable(request, reply);
    if (reply.sent) {
      return;
    }
    await requireOffsetContentType(request, reply);
    if (reply.sent) {
      return;
    }
    const checksumHeader = request.headers["upload-checksum"];
    const checksumRaw =
      typeof checksumHeader === "string" ? checksumHeader : Array.isArray(checksumHeader) ? checksumHeader[0] : undefined;
    if (request.method === "PATCH") {
      if (checksumRaw !== undefined && parseChecksumHeader(checksumRaw) === null) {
        reply.status(400).send("Invalid or unsupported Upload-Checksum\n");
        return;
      }
    }
    const checksum = request.method === "PATCH" ? parseChecksumHeader(checksumRaw) : undefined;
    reply.hijack();
    try {
      await checksumContext.run(checksum ?? null, () =>
        tus.handle(request.raw, reply.raw),
      );
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end("Internal Server Error\n");
      }
    }
  }

  app.route({
    method: ["POST", "HEAD", "PATCH", "DELETE", "OPTIONS"],
    url: config.uploadPath,
    onRequest: tusGateway,
    handler: async () => {},
  });

  app.route({
    method: ["POST", "HEAD", "PATCH", "DELETE", "OPTIONS"],
    url: `${config.uploadPath}/:id`,
    onRequest: tusGateway,
    handler: async () => {},
  });

  app.get(`${config.uploadPath}/:id/validation`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      const report = await validationStore.read(id);
      if (report === null) {
        return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
      }
      if (report.status === "VALID") {
        return reply.status(200).send(report);
      }
      return reply.status(422).send(report);
    },
  });

  app.get(`${config.uploadPath}/:id/job`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      const job = await jobStore.get(id);
      if (job === null) {
        return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
      }
      return reply.status(200).send(job);
    },
  });

  app.post(`${config.uploadPath}/cleanup`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const body = (request.body ?? {}) as { maxAgeHours?: number };
      const maxAgeHours =
        typeof body.maxAgeHours === "number" ? body.maxAgeHours : undefined;
      const maxAgeMs =
        maxAgeHours !== undefined ? maxAgeHours * 60 * 60 * 1000 : undefined;
      const result = await cleanupService.cleanOrphans(maxAgeMs);
      return reply.status(200).send(result);
    },
  });

  app.post(`${config.uploadPath}/:id/purge`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      try {
        const result = await cleanupService.purgeUpload(id);
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof PurgeNotFoundError) {
          return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
        }
        if (error instanceof PurgeConflictError) {
          return reply.status(409).send({ uploadId: id, status: "UPLOADING" });
        }
        throw error;
      }
    },
  });

  app.post(`${config.uploadPath}/:id/transition`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      const parsed = transitionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: "INVALID_PAYLOAD",
          message: "Invalid transition payload",
        });
      }
      const job = await jobStore.get(id);
      if (job === null) {
        return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
      }
      try {
        const updated =
          parsed.data.to === "COMPLETED"
            ? await jobStore.completeJob(
                id,
                parsed.data.publication as
                  | (Omit<JobPublicationArchive, "archivedAt"> & {
                      archivedAt?: string;
                    })
                  | undefined,
                parsed.data.reason,
              )
            : await jobStore.transition(
                id,
                parsed.data.to,
                parsed.data.reason,
                undefined,
                parsed.data.metadata,
              );
        return reply.status(200).send(updated);
      } catch (error) {
        if (error instanceof InvalidStateTransitionError) {
          return reply.status(422).send({
            code: error.code,
            message: error.message,
            from: error.currentStatus,
            to: error.targetStatus,
          });
        }
        throw error;
      }
    },
  });

  app.get(`${config.uploadPath}/:id/qa`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      const report = await qaStore.read(id);
      if (report === null) {
        return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
      }
      if (report.passed) {
        return reply.status(200).send(report);
      }
      return reply.status(422).send(report);
    },
  });

  app.post(`${config.uploadPath}/:id/qa/video`, {
    onRequest: async (request, reply) => {
      await authenticate(request, reply);
    },
    handler: async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const { id } = request.params as { id?: string };
      if (typeof id !== "string" || id.length === 0) {
        return reply.status(404).send({ uploadId: id ?? "", status: "NOT_FOUND" });
      }
      const filePath = await resolveUploadFile(id);
      if (filePath === null) {
        return reply.status(404).send({ uploadId: id, status: "NOT_FOUND" });
      }
      const report = await verifyVideoQuality(filePath, {
        ffmpegPath: DEFAULT_QA_OPTIONS.ffmpegPath,
        ffprobePath: DEFAULT_QA_OPTIONS.ffprobePath,
        timeoutMs: DEFAULT_QA_OPTIONS.timeoutMs,
      });
      const persisted = { ...report, uploadId: id };
      await qaStore.save(id, persisted);
      if (persisted.passed) {
        return reply.status(200).send(persisted);
      }
      return reply.status(422).send(persisted);
    },
  });

  return app;
}
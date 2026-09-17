import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./types.js";
import { createAuth } from "./auth.js";
import { requireOffsetContentType, requireTusResumable } from "./protocol.js";
import { createTusServer } from "./upload-server.js";
import { checksumContext, parseChecksumHeader } from "./checksum.js";
import { ValidationStore } from "./probe/store.js";
import { FileJobStore } from "./job/store.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  const tus = createTusServer(config);
  const authenticate = createAuth(config);
  const validationStore = new ValidationStore(config.storageDir);
  const jobStore = new FileJobStore(config.storageDir);

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

  return app;
}
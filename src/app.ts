import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./types.js";
import { createAuth } from "./auth.js";
import { requireOffsetContentType, requireTusResumable } from "./protocol.js";
import { createTusServer } from "./upload-server.js";
import { checksumContext, parseChecksumHeader } from "./checksum.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  const tus = createTusServer(config);
  const authenticate = createAuth(config);

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

  return app;
}
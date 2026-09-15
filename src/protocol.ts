import type { FastifyReply, FastifyRequest } from "fastify";

export const TUS_RESUMABLE_VERSION = "1.0.0";

export async function requireTusResumable(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (request.method === "OPTIONS") {
    return;
  }
  const version = request.headers["tus-resumable"];
  if (version !== TUS_RESUMABLE_VERSION) {
    return reply
      .header("Tus-Version", TUS_RESUMABLE_VERSION)
      .header("Tus-Resumable", TUS_RESUMABLE_VERSION)
      .status(412)
      .send("Tus-Resumable missing or version not supported\n");
  }
  return;
}

export const OFFSET_CONTENT_TYPE = "application/offset+octet-stream";

export async function requireOffsetContentType(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (request.method === "PATCH") {
    const contentType = request.headers["content-type"];
    if (contentType !== OFFSET_CONTENT_TYPE) {
      request.log.warn({ contentType }, "invalid content type for TUS PATCH");
      return reply.status(415).send("Unsupported Media Type\n");
    }
  }
  return;
}
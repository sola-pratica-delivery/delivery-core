import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./types.js";

export function createAuth(config: AppConfig) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    if (request.method === "OPTIONS") {
      return;
    }
    const authorization = request.headers.authorization;
    const bearerToken =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
    const query = request.query as Record<string, unknown> | undefined;
    const queryToken =
      typeof query?.token === "string" ? query.token : undefined;
    const token = bearerToken ?? queryToken;
    if (typeof token !== "string" || !config.apiTokens.includes(token)) {
      return reply.status(401).send("Unauthorized\n");
    }
    request.upload = { token };
    return;
  };
}
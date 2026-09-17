import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

export const TEST_TOKEN = "test-token-123";
export const TEST_TOKEN_2 = "test-token-456";
export const UPLOAD_PATH = "/uploads";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    storageDir: path.join(os.tmpdir(), `delivery-core-test-${randomUUID()}`),
    maxFileSize: 50 * 1024 * 1024 * 1024,
    minChunkSize: 5 * 1024 * 1024,
    maxChunkSize: 20 * 1024 * 1024,
    apiTokens: [TEST_TOKEN, TEST_TOKEN_2],
    uploadPath: UPLOAD_PATH,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    orphanTtlHours: 24,
    ...overrides,
  };
}

export function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function metadataHeader(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${b64(value)}`)
    .join(",");
}

export interface TestContext {
  app: FastifyInstance;
  baseUrl: string;
  config: AppConfig;
}

export async function startServer(
  overrides: Partial<AppConfig> = {},
): Promise<TestContext> {
  const config = makeConfig(overrides);
  const app = buildApp(config);
  await app.listen({ host: config.host, port: 0 });
  const address = app.server.address();
  const baseUrl =
    typeof address === "object" && address !== null
      ? `http://127.0.0.1:${address.port}`
      : "";
  return { app, baseUrl, config };
}

export async function stopServer(context: TestContext): Promise<void> {
  await context.app.close();
  fs.rmSync(context.config.storageDir, { recursive: true, force: true });
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function rawRequest(
  baseUrl: string,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  payload?: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      `${baseUrl}${urlPath}`,
      { method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", (error: Error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    request.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

export interface CreateOptions {
  length: number;
  metadata?: Record<string, string>;
  token?: string | undefined;
  urlPath?: string;
  extraHeaders?: Record<string, string>;
  payload?: Buffer;
}

export function tusCreate(
  context: TestContext,
  options: CreateOptions,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "tus-resumable": "1.0.0",
    "upload-length": String(options.length),
    ...(Object.keys(options.metadata ?? {}).length > 0
      ? { "upload-metadata": metadataHeader(options.metadata!) }
      : {}),
    ...(options.token !== undefined
      ? { authorization: `Bearer ${options.token}` }
      : {}),
    ...(options.extraHeaders ?? {}),
  };
  return rawRequest(
    context.baseUrl,
    "POST",
    options.urlPath ?? UPLOAD_PATH,
    headers,
    options.payload,
  );
}

export function tusHead(
  context: TestContext,
  urlPath: string,
  token: string = TEST_TOKEN,
  extraHeaders: Record<string, string> = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "tus-resumable": "1.0.0",
    authorization: `Bearer ${token}`,
    ...extraHeaders,
  };
  return rawRequest(context.baseUrl, "HEAD", urlPath, headers);
}

export function tusPatch(
  context: TestContext,
  urlPath: string,
  offset: number,
  payload: Buffer,
  token: string = TEST_TOKEN,
  extraHeaders: Record<string, string> = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "tus-resumable": "1.0.0",
    "upload-offset": String(offset),
    "content-type": "application/offset+octet-stream",
    authorization: `Bearer ${token}`,
    ...extraHeaders,
  };
  return rawRequest(
    context.baseUrl,
    "PATCH",
    urlPath,
    headers,
    payload,
  );
}

export function tusDelete(
  context: TestContext,
  urlPath: string,
  token: string = TEST_TOKEN,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "tus-resumable": "1.0.0",
    authorization: `Bearer ${token}`,
  };
  return rawRequest(context.baseUrl, "DELETE", urlPath, headers);
}

export function locationUrl(response: RawResponse): string {
  const location = response.headers.location;
  if (typeof location !== "string") {
    throw new Error(`Missing Location header in response: ${response.status}`);
  }
  return location;
}

export async function createUpload(
  context: TestContext,
  length: number,
  metadata: Record<string, string> = { filename: "video.mp4", filetype: "video/mp4" },
  token: string = TEST_TOKEN,
): Promise<string> {
  const created = await tusCreate(context, { length, metadata, token });
  const location = locationUrl(created);
  return location;
}

export function listStorage(context: TestContext): string[] {
  try {
    return fs.readdirSync(context.config.storageDir);
  } catch {
    return [];
  }
}

export function storageFileSize(context: TestContext, fileId: string): number {
  const stats = fs.statSync(path.join(context.config.storageDir, fileId));
  return stats.size;
}
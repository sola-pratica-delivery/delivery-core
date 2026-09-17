import path from "node:path";
import { z } from "zod";
import type { AppConfig, QueueConfig } from "./types.js";

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024;
export const DEFAULT_MIN_CHUNK_SIZE = 5 * 1024 * 1024;
export const DEFAULT_MAX_CHUNK_SIZE = 20 * 1024 * 1024;
export const DEFAULT_UPLOAD_PATH = "/uploads";
export const DEFAULT_ORPHAN_TTL_HOURS = 24;

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  redisHost: "127.0.0.1",
  redisPort: 6379,
  redisPassword: "",
  concurrencyVideoEngine: 1,
  concurrencyPublisher: 2,
  maxRetries: 3,
  backoffDelayMs: 1000,
};

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  STORAGE_DIR: z
    .string()
    .default(path.join(process.cwd(), "data", "uploads")),
  UPLOAD_PATH: z.string().default(DEFAULT_UPLOAD_PATH),
  MAX_FILE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_FILE_SIZE),
  MIN_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MIN_CHUNK_SIZE),
  MAX_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_CHUNK_SIZE),
  API_TOKENS: z.string().default(""),
  UPLOAD_ORPHAN_TTL_HOURS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_ORPHAN_TTL_HOURS),
  REDIS_HOST: z.string().default(DEFAULT_QUEUE_CONFIG.redisHost),
  REDIS_PORT: z.coerce.number().int().positive().default(DEFAULT_QUEUE_CONFIG.redisPort),
  REDIS_PASSWORD: z
    .string()
    .default(DEFAULT_QUEUE_CONFIG.redisPassword ?? ""),
  WORKER_CONCURRENCY_VIDEO_ENGINE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_QUEUE_CONFIG.concurrencyVideoEngine),
  WORKER_CONCURRENCY_PUBLISHER: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_QUEUE_CONFIG.concurrencyPublisher),
  QUEUE_MAX_RETRIES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_QUEUE_CONFIG.maxRetries),
  QUEUE_BACKOFF_INITIAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_QUEUE_CONFIG.backoffDelayMs),
});

export interface Env {
  [key: string]: string | undefined;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    storageDir: parsed.STORAGE_DIR,
    uploadPath: parsed.UPLOAD_PATH,
    maxFileSize: parsed.MAX_FILE_SIZE,
    minChunkSize: parsed.MIN_CHUNK_SIZE,
    maxChunkSize: parsed.MAX_CHUNK_SIZE,
    apiTokens: parsed.API_TOKENS.split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
    orphanTtlHours: parsed.UPLOAD_ORPHAN_TTL_HOURS,
    queue: {
      redisHost: parsed.REDIS_HOST,
      redisPort: parsed.REDIS_PORT,
      redisPassword: parsed.REDIS_PASSWORD,
      concurrencyVideoEngine: parsed.WORKER_CONCURRENCY_VIDEO_ENGINE,
      concurrencyPublisher: parsed.WORKER_CONCURRENCY_PUBLISHER,
      maxRetries: parsed.QUEUE_MAX_RETRIES,
      backoffDelayMs: parsed.QUEUE_BACKOFF_INITIAL_MS,
    },
  };
}
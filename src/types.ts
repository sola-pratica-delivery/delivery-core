import type { MediaValidationResult } from "./probe/types.js";
import type { JobRecord } from "./job/types.js";
import type { UploadCompletedEventPayload } from "./events/types.js";

export interface UploadMetadata {
  uploadId: string;
  filename: string;
  filetype: string;
  totalSize: number;
  uploadedBytes: number;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
  rawMetadata?: Record<string, string | null>;
}

export interface UploadServiceConfig {
  storageDir: string;
  maxFileSize: number;
  minChunkSize: number;
  maxChunkSize: number;
  apiTokens: string[];
  uploadPath: string;
}

export interface QueueConfig {
  redisUrl?: string;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  concurrencyVideoEngine: number;
  concurrencyPublisher: number;
  maxRetries: number;
  backoffDelayMs: number;
}

export interface AppConfig extends UploadServiceConfig {
  host: string;
  port: number;
  logLevel: string;
  orphanTtlHours: number;
  queue: QueueConfig;
  onUploadComplete?: (metadata: UploadMetadata) => void | Promise<void>;
  onUploadValidated?: (
    result: MediaValidationResult,
    metadata: UploadMetadata,
  ) => void | Promise<void>;
  onJobUpdated?: (job: JobRecord) => void | Promise<void>;
  onEventEmitted?: (
    event: UploadCompletedEventPayload,
  ) => void | Promise<void>;
}

export interface AuthInfo {
  token: string;
}

declare module "fastify" {
  interface FastifyRequest {
    upload?: AuthInfo;
  }
}
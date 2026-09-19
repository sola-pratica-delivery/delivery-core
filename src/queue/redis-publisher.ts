import { Redis } from "ioredis";
import type { QueueConfig } from "../types.js";
import { QUEUE_NAMES } from "./types.js";
import type { QueueName, VideoProcessingJobData } from "./types.js";

export interface QueuePublisher {
  publish(queue: QueueName, data: unknown): Promise<boolean>;
  publishVideoProcessing(data: VideoProcessingJobData): Promise<boolean>;
  close(): Promise<void>;
}

export interface RedisClientLike {
  rpush(key: string, ...values: string[]): Promise<number>;
  quit(): Promise<string | void>;
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface RedisQueuePublisherLogger {
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
}

export interface RedisQueuePublisherOptions {
  config: QueueConfig;
  logger?: RedisQueuePublisherLogger;
  client?: RedisClientLike;
}

interface PublishContext {
  jobId?: string;
  uploadId?: string;
}

export class RedisQueuePublisher implements QueuePublisher {
  private readonly client: RedisClientLike;
  private readonly logger: RedisQueuePublisherLogger | undefined;

  constructor(options: RedisQueuePublisherOptions) {
    this.logger = options.logger;
    this.client = options.client ?? createRedisClient(options.config);
  }

  async publish(queue: QueueName, data: unknown): Promise<boolean> {
    const context = extractPublishContext(data);
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch (error) {
      this.logFailure(error, queue, context);
      return false;
    }
    try {
      await this.client.rpush(queue, payload);
      this.logger?.info(
        { queue, ...(context.jobId !== undefined ? { jobId: context.jobId } : {}) },
        "Published job to Redis queue",
      );
      return true;
    } catch (error) {
      this.logFailure(error, queue, context);
      return false;
    }
  }

  async publishVideoProcessing(data: VideoProcessingJobData): Promise<boolean> {
    return this.publish(QUEUE_NAMES.VIDEO_PROCESSING, data);
  }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1000);
    });
    try {
      await Promise.race([
        Promise.resolve(this.client.quit()).catch(() => undefined),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.client.disconnect();
    }
  }

  private logFailure(
    error: unknown,
    queue: QueueName,
    context: PublishContext,
  ): void {
    const details: Record<string, unknown> = {
      queue,
      error: error instanceof Error ? error.message : String(error),
    };
    if (context.jobId !== undefined) {
      details.jobId = context.jobId;
    }
    if (context.uploadId !== undefined) {
      details.uploadId = context.uploadId;
    }
    this.logger?.error(details, "Failed to publish job to Redis queue");
  }
}

function createRedisClient(config: QueueConfig): Redis {
  const client = new Redis({
    host: config.redisHost,
    port: config.redisPort,
    ...(config.redisPassword !== undefined && config.redisPassword.length > 0
      ? { password: config.redisPassword }
      : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
  client.on("error", () => {
    // Absorbed: connection errors surface through publish() command failures
    // and ioredis' own retry strategy.
  });
  return client;
}

function extractPublishContext(data: unknown): PublishContext {
  const context: PublishContext = {};
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (typeof record.jobId === "string") {
      context.jobId = record.jobId;
    }
    if (typeof record.uploadId === "string") {
      context.uploadId = record.uploadId;
    }
  }
  return context;
}
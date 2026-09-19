import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RedisQueuePublisher } from "../src/queue/redis-publisher.js";
import type { RedisClientLike } from "../src/queue/redis-publisher.js";
import { QUEUE_NAMES } from "../src/queue/types.js";
import type { VideoProcessingJobData } from "../src/queue/types.js";
import { DEFAULT_QUEUE_CONFIG } from "../src/config.js";
import {
  startServer,
  stopServer,
  createUpload,
  tusPatch,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { JobRecord } from "../src/job/types.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function generateSampleMp4(directory: string): Buffer {
  const output = path.join(directory, "sample.mp4");
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      output,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(output);
}

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

class RecordingClient implements RedisClientLike {
  rpushCalls: Array<{ key: string; values: string[] }> = [];
  success = 1;
  error: Error | null = null;
  quitError: Error | null = null;
  quitCalled = false;
  disconnectCalled = false;

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.rpushCalls.push({ key, values });
    if (this.error !== null) {
      throw this.error;
    }
    return this.success;
  }

  async quit(): Promise<string | void> {
    this.quitCalled = true;
    if (this.quitError !== null) {
      throw this.quitError;
    }
    return "OK";
  }

  disconnect(): void {
    this.disconnectCalled = true;
  }

  on(): this {
    return this;
  }
}

function makeVideoJob(overrides: Partial<VideoProcessingJobData> = {}): VideoProcessingJobData {
  return {
    jobId: "job-1",
    uploadId: "upload-1",
    filePath: "/tmp/storage/upload-1",
    metadata: {
      filename: "video.mp4",
      filetype: "video/mp4",
      totalSize: 100,
      uploadedBytes: 100,
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("RedisQueuePublisher - publicação unitária", () => {
  it("publica um job serializado como JSON via RPUSH na fila correta", async () => {
    const client = new RecordingClient();
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });

    const ok = await publisher.publish(QUEUE_NAMES.VIDEO_PROCESSING, {
      jobId: "job-1",
    });

    expect(ok).toBe(true);
    expect(client.rpushCalls).toHaveLength(1);
    const call = client.rpushCalls[0];
    expect(call?.key).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    expect(JSON.parse(call?.values[0] ?? "{}")).toEqual({ jobId: "job-1" });
    await publisher.close();
  });

  it("publica UPLOAD_COMPLETED com o payload canônico esperado pelo video-engine", async () => {
    const client = new RecordingClient();
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });
    const job = makeVideoJob();

    const ok = await publisher.publishVideoProcessing(job);

    expect(ok).toBe(true);
    const call = client.rpushCalls[0];
    expect(call?.key).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    const parsed = JSON.parse(call?.values[0] ?? "{}");
    expect(parsed).toEqual({
      jobId: "job-1",
      uploadId: "upload-1",
      filePath: "/tmp/storage/upload-1",
      metadata: {
        filename: "video.mp4",
        filetype: "video/mp4",
        totalSize: 100,
        uploadedBytes: 100,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await publisher.close();
  });

  it("retorna false e registra erro estruturado quando o client Redis falha", async () => {
    const client = new RecordingClient();
    client.error = new Error("ECONNREFUSED");
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });

    const ok = await publisher.publish(QUEUE_NAMES.VIDEO_PROCESSING, {
      jobId: "job-fail",
      uploadId: "upload-fail",
    });

    expect(ok).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged).toMatchObject({
      queue: QUEUE_NAMES.VIDEO_PROCESSING,
      jobId: "job-fail",
      uploadId: "upload-fail",
      error: "ECONNREFUSED",
    });
    await publisher.close();
  });

  it("isola erro de serialização do payload (referência circular) e retorna false", async () => {
    const client = new RecordingClient();
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });
    const circular: Record<string, unknown> = { jobId: "job-circular" };
    circular.self = circular;

    const ok = await publisher.publish(QUEUE_NAMES.VIDEO_PROCESSING, circular);

    expect(ok).toBe(false);
    expect(client.rpushCalls).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    await publisher.close();
  });

  it("encerra graciosamente chamando quit() com fallback para disconnect()", async () => {
    const client = new RecordingClient();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      client,
    });

    await publisher.close();

    expect(client.quitCalled).toBe(true);
    expect(client.disconnectCalled).toBe(true);
  });

  it("usa disconnect() como fallback quando quit() rejeita", async () => {
    const client = new RecordingClient();
    client.quitError = new Error("quit timed out");
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      client,
    });

    await expect(publisher.close()).resolves.toBeUndefined();

    expect(client.quitCalled).toBe(true);
    expect(client.disconnectCalled).toBe(true);
  });

  it("aceita o fallback do cliente ioredis real e encerra sem conexão ativa", async () => {
    const publisher = new RedisQueuePublisher({
      config: { ...DEFAULT_QUEUE_CONFIG, redisHost: "127.0.0.1", redisPort: 1 },
    });

    await expect(publisher.close()).resolves.toBeUndefined();
  });
});

describe.runIf(hasFfmpeg)("Integração: UPLOAD_COMPLETED publica na fila video-processing", () => {
  let sampleDir: string;
  let sampleBuffer: Buffer;

  beforeAll(() => {
    sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "redis-pub-sample-"));
    sampleBuffer = generateSampleMp4(sampleDir);
  });

  afterAll(() => {
    fs.rmSync(sampleDir, { recursive: true, force: true });
  });

  it("despacha automaticamente o job para o Redis ao finalizar o upload", async () => {
    const client = new RecordingClient();
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });
    const ctx = await startServer({ redisPublisher: publisher });
    try {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;

      const patched = await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);
      expect(patched.status).toBe(204);

      await vi.waitFor(() => {
        expect(client.rpushCalls).toHaveLength(1);
      });

      const call = client.rpushCalls[0];
      expect(call?.key).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
      const parsed = JSON.parse(call?.values[0] ?? "{}") as VideoProcessingJobData;
      expect(parsed.uploadId).toBe(uploadId);
      expect(parsed.jobId).toEqual(expect.any(String));
      expect(parsed.filePath).toEqual(expect.any(String));
      expect(parsed.createdAt).toEqual(expect.any(String));
      expect(parsed.metadata).toMatchObject({
        filename: "sample.mp4",
        filetype: "video/mp4",
        totalSize: sampleBuffer.length,
        uploadedBytes: sampleBuffer.length,
        videoCodec: "h264",
      });

      const jobResponse = await rawRequest(
        ctx.baseUrl,
        "GET",
        `${UPLOAD_PATH}/${uploadId}/job`,
        { authorization: `Bearer ${TEST_TOKEN}` },
      );
      expect(jobResponse.status).toBe(200);
      const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("PROCESSING");
    } finally {
      await stopServer(ctx);
    }
  });

  it("não aborta a resposta HTTP 204 nem corrompe o job quando o Redis falha", async () => {
    const client = new RecordingClient();
    client.error = new Error("ECONNREFUSED");
    const logger = makeLogger();
    const publisher = new RedisQueuePublisher({
      config: DEFAULT_QUEUE_CONFIG,
      logger,
      client,
    });
    const ctx = await startServer({ redisPublisher: publisher });
    try {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;

      const patched = await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);
      expect(patched.status).toBe(204);

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      const jobResponse = await rawRequest(
        ctx.baseUrl,
        "GET",
        `${UPLOAD_PATH}/${uploadId}/job`,
        { authorization: `Bearer ${TEST_TOKEN}` },
      );
      expect(jobResponse.status).toBe(200);
      const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("PROCESSING");
    } finally {
      await stopServer(ctx);
    }
  });
});
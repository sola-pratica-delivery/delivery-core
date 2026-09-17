import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { InMemoryQueueManager } from "../src/queue/manager.js";
import { QUEUE_NAMES } from "../src/queue/types.js";
import type { DlqJobData, QueueManager, QueueTerminalFailure } from "../src/queue/types.js";
import { FileJobStore } from "../src/job/store.js";
import type { JobRecord } from "../src/job/types.js";
import { DEFAULT_QUEUE_CONFIG } from "../src/config.js";
import {
  startServer,
  stopServer,
  tusCreate,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext } from "./helpers.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InMemoryQueueManager - enfileiramento e consumo", () => {
  it("processa jobs nas filas video-processing e youtube-publish", async () => {
    const manager = new InMemoryQueueManager();
    const processed: string[] = [];
    await manager.registerWorker<string, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async (data) => {
        processed.push(data);
      },
    );
    await manager.registerWorker<string, void>(
      QUEUE_NAMES.YOUTUBE_PUBLISH,
      async (data) => {
        processed.push(data);
      },
    );
    const first = await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, "v1");
    const second = await manager.enqueue(QUEUE_NAMES.YOUTUBE_PUBLISH, "y1");
    expect(first.jobId).toEqual(expect.any(String));
    expect(first.enqueuedAt).toEqual(expect.any(String));
    expect(second.queueName).toBe(QUEUE_NAMES.YOUTUBE_PUBLISH);
    await vi.waitFor(() => expect(processed).toEqual(["v1", "y1"]));
    await manager.close();
  });

  it("mantém ordem FIFO dentro da mesma prioridade", async () => {
    const manager = new InMemoryQueueManager();
    const processed: number[] = [];
    await manager.registerWorker<number, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async (data) => {
        processed.push(data);
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 1);
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 2);
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 3);
    await vi.waitFor(() => expect(processed).toEqual([1, 2, 3]));
    await manager.close();
  });

  it("prioriza jobs pelo campo priority (menor valor primeiro)", async () => {
    const manager = new InMemoryQueueManager();
    const processed: string[] = [];
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, "low", { priority: 10 });
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, "high", { priority: 0 });
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, "mid", { priority: 5 });
    await manager.registerWorker<string, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async (data) => {
        processed.push(data);
      },
    );
    await vi.waitFor(() => expect(processed).toEqual(["high", "mid", "low"]));
    await manager.close();
  });
});

describe("InMemoryQueueManager - controle de concorrência", () => {
  it("executa estritamente sequencial com concurrency 1", async () => {
    const manager = new InMemoryQueueManager({
      concurrency: { [QUEUE_NAMES.VIDEO_PROCESSING]: 1 },
    });
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const finishes: number[] = [];
    await manager.registerWorker<number, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async (data) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(data);
        await delay(15);
        active -= 1;
        finishes.push(data);
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 0);
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 1);
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 2);
    await vi.waitFor(() => expect(finishes.length).toBe(3));
    expect(maxActive).toBe(1);
    expect(starts).toEqual([0, 1, 2]);
    await manager.close();
  });

  it("limita a execução paralela do publisher a 2", async () => {
    const manager = new InMemoryQueueManager({
      concurrency: { [QUEUE_NAMES.YOUTUBE_PUBLISH]: 2 },
    });
    let active = 0;
    let maxActive = 0;
    let finished = 0;
    await manager.registerWorker<number, void>(
      QUEUE_NAMES.YOUTUBE_PUBLISH,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        finished += 1;
      },
    );
    for (let i = 0; i < 5; i += 1) {
      await manager.enqueue(QUEUE_NAMES.YOUTUBE_PUBLISH, i);
    }
    await vi.waitFor(() => expect(finished).toBe(5));
    expect(maxActive).toBeLessThanOrEqual(2);
    await manager.close();
  });
});

describe("InMemoryQueueManager - retry e backoff", () => {
  it("reprocessa com backoff exponencial até o sucesso", async () => {
    const manager = new InMemoryQueueManager({
      maxRetries: 3,
      backoffDelayMs: 5,
    });
    let attempts = 0;
    const startedAt = Date.now();
    await manager.registerWorker<never, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`transient ${attempts}`);
        }
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, null);
    await vi.waitFor(() => expect(attempts).toBe(3));
    // backoff exponencial: 5ms + 10ms entre tentativas
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(14);
    await manager.close();
  });

  it("respeita backoff fixo customizado por job", async () => {
    const manager = new InMemoryQueueManager({ maxRetries: 2, backoffDelayMs: 1000 });
    let attempts = 0;
    await manager.registerWorker<never, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        attempts += 1;
        throw new Error("always fails");
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, null, {
      backoff: { type: "fixed", delay: 5 },
    });
    await vi.waitFor(() => expect(attempts).toBe(2));
    await manager.close();
  });
});

describe("InMemoryQueueManager - DLQ", () => {
  it("isola na dead-letter queue após esgotar as tentativas", async () => {
    const manager = new InMemoryQueueManager({
      maxRetries: 3,
      backoffDelayMs: 5,
    });
    await manager.registerWorker<{ jobId: string; uploadId: string }, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        throw new TypeError("permanent failure");
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, {
      jobId: "job-1",
      uploadId: "upload-1",
    });
    const jobs = await vi.waitFor(async () => {
      const current = await manager.getDlqJobs();
      expect(current).toHaveLength(1);
      return current;
    });
    const record = jobs[0] as DlqJobData | undefined;
    expect(record?.originalQueue).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    expect(record?.attemptsMade).toBe(3);
    expect(record?.uploadId).toBe("upload-1");
    expect(record?.failedAt).toEqual(expect.any(String));
    expect(record?.error.message).toBe("permanent failure");
    expect(record?.error.stack).toEqual(expect.any(String));
    expect(record?.payload).toEqual({ jobId: "job-1", uploadId: "upload-1" });
    await manager.close();
  });

  it("invoca onJobFailed na falha terminal", async () => {
    const failures: QueueTerminalFailure[] = [];
    const manager = new InMemoryQueueManager({
      maxRetries: 2,
      backoffDelayMs: 5,
      onJobFailed: (failure) => {
        failures.push(failure);
      },
    });
    await manager.registerWorker<object, void>(
      QUEUE_NAMES.YOUTUBE_PUBLISH,
      async () => {
        throw new Error("boom");
      },
    );
    await manager.enqueue(QUEUE_NAMES.YOUTUBE_PUBLISH, { jobId: "job-2" });
    await vi.waitFor(() => expect(failures.length).toBe(1));
    expect(failures[0]?.queueName).toBe(QUEUE_NAMES.YOUTUBE_PUBLISH);
    expect(failures[0]?.attemptsMade).toBe(2);
    expect((failures[0]?.data as { jobId: string }).jobId).toBe("job-2");
    await manager.close();
  });
});

describe("InMemoryQueueManager - graceful shutdown", () => {
  it("aguarda jobs em execução no close e bloqueia novos enqueues", async () => {
    const manager = new InMemoryQueueManager();
    let finished = false;
    await manager.registerWorker<number, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        await delay(40);
        finished = true;
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 1);
    const closed = manager.close();
    await expect(manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, 2)).rejects.toThrow(
      "closed",
    );
    await closed;
    expect(finished).toBe(true);
  });
});

describe("Integração com a máquina de estados", () => {
  it("falha terminal marca o JobRecord como FAILED via store", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "queue-fsm-"));
    const store = new FileJobStore(dir);
    await store.create({
      jobId: "job-q1",
      uploadId: "upload-q1",
      status: "PROCESSING",
      filePath: "/tmp/upload-q1",
      metadata: {
        filename: "a.mp4",
        filetype: "video/mp4",
        totalSize: 10,
        uploadedBytes: 10,
      },
    });
    const manager = new InMemoryQueueManager({
      maxRetries: 2,
      backoffDelayMs: 5,
      onJobFailed: async (failure) => {
        const data = failure.data as { jobId: string; uploadId: string };
        const job = await store.get(data.uploadId);
        if (job === null || job.status === "FAILED" || job.status === "COMPLETED") {
          return;
        }
        await store.transition(data.uploadId, "FAILED", "Queue terminal failure", {
          error: { code: "QUEUE_JOB_FAILED", message: failure.error.message },
        });
      },
    });
    await manager.registerWorker<object, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        throw new Error("permanent");
      },
    );
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, {
      jobId: "job-q1",
      uploadId: "upload-q1",
    });
    await vi.waitFor(async () => {
      const job = await store.get("upload-q1");
      expect(job?.status).toBe("FAILED");
    });
    const finalJob = await store.get("upload-q1");
    expect(finalJob?.error?.code).toBe("QUEUE_JOB_FAILED");
    expect(finalJob?.transitions.at(-1)?.reason).toContain("Queue terminal failure");
    await manager.close();
  });
});

describe("Integração com o servidor", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer({
      queue: { ...DEFAULT_QUEUE_CONFIG, maxRetries: 1, backoffDelayMs: 5 },
    });
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("falha terminal na fila atualiza o job HTTP para FAILED", async () => {
    const manager = (ctx.app as unknown as { queueManager: QueueManager })
      .queueManager;
    await manager.registerWorker<object, void>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      async () => {
        throw new Error("worker boom");
      },
    );
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: { filename: "pending.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    expect(created.status).toBe(201);
    const uploadId = (created.headers.location as string).split("/").pop() as string;
    await manager.enqueue(QUEUE_NAMES.VIDEO_PROCESSING, {
      jobId: "app-job-1",
      uploadId,
      filePath: "/tmp/pending.mp4",
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(async () => {
      const response = await rawRequest(
        ctx.baseUrl,
        "GET",
        `${UPLOAD_PATH}/${uploadId}/job`,
        { authorization: `Bearer ${TEST_TOKEN}` },
      );
      expect(response.status).toBe(200);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
      expect(job.error?.code).toBe("QUEUE_JOB_FAILED");
    });
    const dlq = await manager.getDlqJobs();
    expect(dlq).toHaveLength(1);
  });
});
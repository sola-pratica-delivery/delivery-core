import { randomUUID } from "node:crypto";
import { QUEUE_NAMES } from "./types.js";
import type {
  DlqJobData,
  EnqueueOptions,
  JobEnqueueResult,
  QueueManager,
  QueueName,
  QueueTerminalFailure,
} from "./types.js";

interface WorkerBinding {
  processor: (data: unknown) => Promise<unknown> | unknown;
  concurrency: number;
}

interface QueuedJob {
  id: string;
  queue: QueueName;
  data: unknown;
  attempts: number;
  maxAttempts: number;
  backoffType: "exponential" | "fixed";
  baseDelay: number;
  priority: number;
  enqueuedAt: string;
}

export interface InMemoryQueueManagerOptions {
  maxRetries?: number;
  backoffDelayMs?: number;
  concurrency?: Partial<Record<QueueName, number>>;
  onJobFailed?: (failure: QueueTerminalFailure) => Promise<void> | void;
}

export class InMemoryQueueManager implements QueueManager {
  private readonly maxRetries: number;
  private readonly backoffDelayMs: number;
  private readonly concurrencyOverrides: Partial<Record<QueueName, number>>;
  private readonly onJobFailed:
    | ((failure: QueueTerminalFailure) => Promise<void> | void)
    | undefined;
  private readonly pending = new Map<QueueName, QueuedJob[]>();
  private readonly workers = new Map<QueueName, WorkerBinding>();
  private readonly active = new Map<QueueName, number>();
  private readonly dlq: DlqJobData[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private inFlight: Promise<unknown>[] = [];
  private closed = false;

  constructor(options: InMemoryQueueManagerOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffDelayMs = options.backoffDelayMs ?? 1000;
    this.concurrencyOverrides = options.concurrency ?? {};
    this.onJobFailed = options.onJobFailed;
    for (const name of Object.values(QUEUE_NAMES)) {
      this.pending.set(name, []);
      this.active.set(name, 0);
    }
  }

  async enqueue<T>(
    queue: QueueName,
    data: T,
    options?: EnqueueOptions,
  ): Promise<JobEnqueueResult> {
    if (this.closed) {
      throw new Error("Queue manager is closed");
    }
    const enqueuedAt = new Date().toISOString();
    const entry: QueuedJob = {
      id: randomUUID(),
      queue,
      data,
      attempts: 0,
      maxAttempts: options?.attempts ?? this.maxRetries,
      backoffType: options?.backoff?.type ?? "exponential",
      baseDelay: options?.backoff?.delay ?? this.backoffDelayMs,
      priority: options?.priority ?? 0,
      enqueuedAt,
    };
    this.pending.get(queue)?.push(entry);
    this.pump(queue);
    return { queueName: queue, jobId: entry.id, enqueuedAt };
  }

  async registerWorker<T, R>(
    queue: QueueName,
    processor: (data: T) => Promise<R>,
    concurrency?: number,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Queue manager is closed");
    }
    this.workers.set(queue, {
      processor: (data: unknown) => processor(data as T),
      concurrency: concurrency ?? this.concurrencyOverrides[queue] ?? 1,
    });
    this.pump(queue);
    return Promise.resolve();
  }

  async getDlqJobs(): Promise<DlqJobData[]> {
    return [...this.dlq];
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await Promise.allSettled(this.inFlight);
  }

  private pump(queue: QueueName): void {
    if (this.closed) {
      return;
    }
    const worker = this.workers.get(queue);
    if (worker === undefined) {
      return;
    }
    const queuePending = this.pending.get(queue);
    if (queuePending === undefined) {
      return;
    }
    while ((this.active.get(queue) ?? 0) < worker.concurrency) {
      const index = this.nextIndex(queuePending);
      if (index === -1) {
        return;
      }
      const entry = queuePending[index];
      if (entry === undefined) {
        return;
      }
      queuePending.splice(index, 1);
      this.active.set(queue, (this.active.get(queue) ?? 0) + 1);
      this.run(queue, entry, worker);
    }
  }

  private nextIndex(queuePending: QueuedJob[]): number {
    if (queuePending.length === 0) {
      return -1;
    }
    let best = 0;
    for (let i = 1; i < queuePending.length; i += 1) {
      const current = queuePending[i];
      const champion = queuePending[best];
      if (current !== undefined && champion !== undefined && current.priority < champion.priority) {
        best = i;
      }
    }
    return best;
  }

  private run(queue: QueueName, entry: QueuedJob, worker: WorkerBinding): void {
    const task = (async () => {
      try {
        await worker.processor(entry.data);
      } catch (error) {
        entry.attempts += 1;
        const errorLike = error instanceof Error ? error : new Error(String(error));
        if (entry.attempts >= entry.maxAttempts) {
          const uploadId = extractUploadId(entry.data);
          this.dlq.push({
            originalQueue: queue,
            originalJobId: entry.id,
            ...(uploadId !== undefined ? { uploadId } : {}),
            failedAt: new Date().toISOString(),
            attemptsMade: entry.attempts,
            error: {
              message: errorLike.message,
              ...(errorLike.stack !== undefined ? { stack: errorLike.stack } : {}),
              ...(typeof (errorLike as { code?: unknown }).code === "string"
                ? {
                    code: (errorLike as { code?: string }).code,
                  }
                : {}),
            },
            payload: entry.data,
          });
          if (this.onJobFailed !== undefined) {
            try {
              await this.onJobFailed({
                queueName: queue,
                data: entry.data,
                attemptsMade: entry.attempts,
                error: errorLike,
              });
            } catch {
              // Intentionally swallowed: hook errors must not crash workers.
            }
          }
        } else {
          const delay = this.computeDelay(entry);
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.closed) {
              return;
            }
            this.pending.get(queue)?.push(entry);
            this.pump(queue);
          }, delay);
          this.timers.add(timer);
        }
      } finally {
        this.active.set(queue, (this.active.get(queue) ?? 1) - 1);
        this.pump(queue);
      }
    })();
    this.track(task);
  }

  private track(task: Promise<unknown>): void {
    this.inFlight.push(task);
    void task.finally(() => {
      this.inFlight = this.inFlight.filter((t) => t !== task);
    });
  }

  private computeDelay(entry: QueuedJob): number {
    if (entry.backoffType === "fixed") {
      return entry.baseDelay;
    }
    return entry.baseDelay * 2 ** (entry.attempts - 1);
  }
}

function extractUploadId(data: unknown): string | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "uploadId" in data &&
    typeof (data as Record<string, unknown>).uploadId === "string"
  ) {
    return (data as Record<string, unknown>).uploadId as string;
  }
  return undefined;
}
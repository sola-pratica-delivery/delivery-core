export const QUEUE_NAMES = {
  VIDEO_PROCESSING: "video-processing",
  YOUTUBE_PUBLISH: "youtube-publish",
  DEAD_LETTER: "dead-letter",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface VideoProcessingJobData {
  jobId: string;
  uploadId: string;
  filePath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface YouTubePublishJobData {
  jobId: string;
  uploadId: string;
  processedVideoPath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DlqJobData {
  originalQueue: QueueName;
  originalJobId: string;
  uploadId?: string;
  failedAt: string;
  attemptsMade: number;
  error: {
    message: string;
    stack?: string;
    code?: string;
  };
  payload: unknown;
}

export interface EnqueueOptions {
  attempts?: number;
  backoff?: {
    type: "exponential" | "fixed";
    delay: number;
  };
  priority?: number;
}

export interface JobEnqueueResult {
  queueName: QueueName;
  jobId: string;
  enqueuedAt: string;
}

export interface QueueTerminalFailure {
  queueName: QueueName;
  data: unknown;
  attemptsMade: number;
  error: Error;
}

export interface QueueManager {
  enqueue<T>(
    queue: QueueName,
    data: T,
    options?: EnqueueOptions,
  ): Promise<JobEnqueueResult>;
  registerWorker<T, R>(
    queue: QueueName,
    processor: (data: T) => Promise<R>,
    concurrency?: number,
  ): Promise<void>;
  getDlqJobs(): Promise<DlqJobData[]>;
  close(): Promise<void>;
}
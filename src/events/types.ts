import type { UploadJobMetadata } from "../job/types.js";

export interface UploadCompletedEventPayload {
  eventId: string;
  eventType: "UPLOAD_COMPLETED";
  jobId: string;
  uploadId: string;
  filePath: string;
  metadata: UploadJobMetadata;
  occurredAt: string;
}

export interface EventDispatcher {
  dispatch(event: UploadCompletedEventPayload): Promise<void>;
  subscribe(
    eventType: "UPLOAD_COMPLETED",
    handler: (event: UploadCompletedEventPayload) => Promise<void> | void,
  ): () => void;
}

import type {
  EventDispatcher,
  UploadCompletedEventPayload,
} from "./types.js";

type Handler = (event: UploadCompletedEventPayload) => Promise<void> | void;

export class InMemoryEventDispatcher implements EventDispatcher {
  private readonly handlers = new Map<string, Handler[]>();
  private readonly dispatchedEventIds = new Set<string>();

  async dispatch(event: UploadCompletedEventPayload): Promise<void> {
    if (this.dispatchedEventIds.has(event.eventId)) {
      return;
    }
    this.dispatchedEventIds.add(event.eventId);

    const handlers = this.handlers.get(event.eventType) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch {
        // Isolated per handler - does not break dispatch
      }
    }
  }

  subscribe(
    eventType: "UPLOAD_COMPLETED",
    handler: Handler,
  ): () => void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);

    return () => {
      const current = this.handlers.get(eventType);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(handler);
      if (index >= 0) {
        current.splice(index, 1);
      }
    };
  }
}

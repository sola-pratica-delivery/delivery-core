import { describe, it, expect, vi } from "vitest";
import { InMemoryEventDispatcher } from "../src/events/dispatcher.js";
import type { UploadCompletedEventPayload } from "../src/events/types.js";

function makeEvent(): UploadCompletedEventPayload {
  return {
    eventId: "event-1",
    eventType: "UPLOAD_COMPLETED",
    jobId: "job-1",
    uploadId: "upload-1",
    filePath: "/tmp/storage/upload-1",
    metadata: {
      filename: "video.mp4",
      filetype: "video/mp4",
      totalSize: 100,
      uploadedBytes: 100,
    },
    occurredAt: new Date().toISOString(),
  };
}

describe("InMemoryEventDispatcher", () => {
  it("entrega o evento a todos os handlers inscritos", async () => {
    const dispatcher = new InMemoryEventDispatcher();
    const handler = vi.fn();
    dispatcher.subscribe("UPLOAD_COMPLETED", handler);

    await dispatcher.dispatch(makeEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0]?.[0] as UploadCompletedEventPayload;
    expect(received.eventType).toBe("UPLOAD_COMPLETED");
    expect(received.metadata.filename).toBe("video.mp4");
  });

  it("é idempotente por eventId (não reentrega o mesmo evento)", async () => {
    const dispatcher = new InMemoryEventDispatcher();
    const handler = vi.fn();
    dispatcher.subscribe("UPLOAD_COMPLETED", handler);

    const event = makeEvent();
    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isola a exceção de um handler sem quebrar os demais", async () => {
    const dispatcher = new InMemoryEventDispatcher();
    const throwing = vi.fn(() => {
      throw new Error("handler failure");
    });
    const ok = vi.fn();
    dispatcher.subscribe("UPLOAD_COMPLETED", throwing);
    dispatcher.subscribe("UPLOAD_COMPLETED", ok);

    await expect(dispatcher.dispatch(makeEvent())).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("espera a conclusão de handlers assíncronos", async () => {
    const dispatcher = new InMemoryEventDispatcher();
    let settled = false;
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled = true;
    });
    dispatcher.subscribe("UPLOAD_COMPLETED", handler);

    await dispatcher.dispatch(makeEvent());

    expect(settled).toBe(true);
  });

  it("remove a inscrição quando o unsubscribe é chamado", async () => {
    const dispatcher = new InMemoryEventDispatcher();
    const handler = vi.fn();
    const unsubscribe = dispatcher.subscribe("UPLOAD_COMPLETED", handler);
    unsubscribe();

    await dispatcher.dispatch(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });
});
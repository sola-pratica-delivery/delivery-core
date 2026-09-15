import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, tusCreate, tusHead, tusPatch, createUpload, storageFileSize } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

function chunkA(value: number): Buffer {
  return Buffer.alloc(MB * value, value % 256);
}

describe("Upload fracionado em chunks (chunk upload)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("envia 5MB + 10MB + 10MB e avança o Upload-Offset deterministicamente", async () => {
    const total = 25 * MB;
    const location = await createUpload(ctx, total);

    const first = await tusPatch(ctx, location, 0, chunkA(5));
    expect(first.status).toBe(204);
    expect(first.headers["upload-offset"]).toBe(String(5 * MB));

    const second = await tusPatch(ctx, location, 5 * MB, chunkA(10));
    expect(second.status).toBe(204);
    expect(second.headers["upload-offset"]).toBe(String(15 * MB));

    const third = await tusPatch(ctx, location, 15 * MB, chunkA(10));
    expect(third.status).toBe(204);
    expect(third.headers["upload-offset"]).toBe(String(total));
    expect(third.headers["tus-resumable"]).toBe("1.0.0");

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe(String(total));
    expect(head.headers["upload-length"]).toBe(String(total));
  });

  it("persiste os bytes incrementalmente em disco no staging", async () => {
    const firstChunk = 5 * MB;
    const location = await createUpload(ctx, 20 * MB);
    const uploadId = location.split("/").pop() as string;

    const first = await tusPatch(ctx, location, 0, chunkA(5));
    expect(first.status).toBe(204);
    expect(storageFileSize(ctx, uploadId)).toBe(firstChunk);

    const second = await tusPatch(ctx, location, firstChunk, chunkA(15));
    expect(second.status).toBe(204);
    expect(storageFileSize(ctx, uploadId)).toBe(20 * MB);
  });

  it("criação com upload simultâneo num único POST (creation-with-upload)", async () => {
    const payload = Buffer.alloc(2 * MB, 9);
    const created = await tusCreate(ctx, {
      length: payload.length,
      metadata: { filename: "instant.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
      extraHeaders: { "content-type": "application/offset+octet-stream" },
      payload,
    });
    expect(created.status).toBe(201);
    const location = created.headers.location as string;
    expect(location).toBeDefined();

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe(String(payload.length));
  });
});
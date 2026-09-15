import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, tusHead, tusPatch, tusDelete, createUpload } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

describe("Terminação de upload (termination extension)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("DELETE remove os arquivos de staging e retorna 204", async () => {
    const location = await createUpload(ctx, 10 * MB);

    const patch = await tusPatch(ctx, location, 0, Buffer.alloc(5 * MB, 1));
    expect(patch.status).toBe(204);

    const uploadId = location.split("/").pop() as string;
    const { storageFileSize } = await import("./helpers.js");
    expect(storageFileSize(ctx, uploadId)).toBe(5 * MB);

    const deleted = await tusDelete(ctx, location, TEST_TOKEN);
    expect(deleted.status).toBe(204);
    expect(deleted.headers["tus-resumable"]).toBe("1.0.0");

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(404);

    const { listStorage } = await import("./helpers.js");
    expect(listStorage(ctx)).toHaveLength(0);
  });

  it("DELETE em upload completo também retorna 204", async () => {
    const location = await createUpload(ctx, 1 * MB);

    const patch = await tusPatch(ctx, location, 0, Buffer.alloc(1 * MB, 3));
    expect(patch.status).toBe(204);

    const deleted = await tusDelete(ctx, location, TEST_TOKEN);
    expect(deleted.status).toBe(204);
  });

  it("DELETE em upload inexistente retorna 404", async () => {
    const deleted = await tusDelete(ctx, "/uploads/never-existed", TEST_TOKEN);
    expect(deleted.status).toBe(404);
  });
});
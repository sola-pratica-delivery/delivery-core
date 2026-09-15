import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, tusHead, tusPatch, createUpload } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

describe("Retomada e recuperação de upload (resume recovery)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("consulta progresso via HEAD e retoma a partir do offset confirmado", async () => {
    const total = 20 * MB;
    const location = await createUpload(ctx, total);

    const first = await tusPatch(ctx, location, 0, Buffer.alloc(5 * MB, 1));
    expect(first.status).toBe(204);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe(String(5 * MB));
    expect(head.headers["upload-length"]).toBe(String(total));

    const resumed = await tusPatch(ctx, location, 5 * MB, Buffer.alloc(5 * MB, 2));
    expect(resumed.status).toBe(204);
    expect(resumed.headers["upload-offset"]).toBe(String(10 * MB));

    const final = await tusPatch(ctx, location, 10 * MB, Buffer.alloc(10 * MB, 3));
    expect(final.status).toBe(204);
    expect(final.headers["upload-offset"]).toBe(String(total));

    const verify = await tusHead(ctx, location, TEST_TOKEN);
    expect(verify.headers["upload-offset"]).toBe(String(total));
    expect(verify.headers["upload-length"]).toBe(String(total));
  });

  it("retoma após reinício do servidor usando apenas a Location", async () => {
    const total = 10 * MB;
    const location = await createUpload(ctx, total);

    const first = await tusPatch(ctx, location, 0, Buffer.alloc(3 * MB, 5));
    expect(first.status).toBe(204);

    const restarted = await startServer({
      storageDir: ctx.config.storageDir,
      apiTokens: ctx.config.apiTokens,
    });
    try {
      const head = await tusHead(restarted, location, TEST_TOKEN);
      expect(head.status).toBe(200);
      expect(head.headers["upload-offset"]).toBe(String(3 * MB));

      const resumed = await tusPatch(restarted, location, 3 * MB, Buffer.alloc(7 * MB, 6));
      expect(resumed.status).toBe(204);
      expect(resumed.headers["upload-offset"]).toBe(String(total));

      const verify = await tusHead(restarted, location, TEST_TOKEN);
      expect(verify.headers["upload-offset"]).toBe(String(total));
    } finally {
      await restarted.app.close();
    }
  });

  it("interrupção antes do primeiro chunk mantém offset em 0", async () => {
    const location = await createUpload(ctx, 8 * MB);
    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe("0");

    const resumed = await tusPatch(ctx, location, 0, Buffer.alloc(8 * MB, 9));
    expect(resumed.status).toBe(204);
  });
});
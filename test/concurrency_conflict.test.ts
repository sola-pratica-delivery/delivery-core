import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, tusHead, tusPatch, createUpload } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

describe("Conflito de concorrência e offsets inválidos", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("PATCH com Upload-Offset divergente retorna 409 Conflict sem alterar o recurso", async () => {
    const location = await createUpload(ctx, 10 * MB);

    const first = await tusPatch(ctx, location, 0, Buffer.alloc(5 * MB, 1));
    expect(first.status).toBe(204);

    const conflict = await tusPatch(ctx, location, 0, Buffer.alloc(1024, 2));
    expect(conflict.status).toBe(409);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe(String(5 * MB));
  });

  it("PATCH com Upload-Offset maior que o real retorna 409 Conflict", async () => {
    const location = await createUpload(ctx, 10 * MB);

    const conflict = await tusPatch(ctx, location, 5 * MB, Buffer.alloc(1024, 3));
    expect(conflict.status).toBe(409);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe("0");
  });

  it("PATCH em upload já finalizado retorna 409 Conflict", async () => {
    const location = await createUpload(ctx, 1 * MB);

    const complete = await tusPatch(ctx, location, 0, Buffer.alloc(1 * MB, 7));
    expect(complete.status).toBe(204);

    const again = await tusPatch(ctx, location, 1 * MB, Buffer.alloc(0));
    expect(again.status).toBe(409);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe(String(1 * MB));
  });

  it("HEAD/PATCH/DELETE em upload inexistente retornam 404", async () => {
    const missing = "/uploads/does-not-exist";
    const head = await tusHead(ctx, missing, TEST_TOKEN);
    expect(head.status).toBe(404);

    const patch = await tusPatch(ctx, missing, 0, Buffer.alloc(1), TEST_TOKEN);
    expect(patch.status).toBe(404);

    const { tusDelete } = await import("./helpers.js");
    const del = await tusDelete(ctx, missing, TEST_TOKEN);
    expect(del.status).toBe(404);
  });
});
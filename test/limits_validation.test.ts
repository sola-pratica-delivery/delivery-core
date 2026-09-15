import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, tusCreate, tusPatch, locationUrl } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

describe("Validação de limites e tamanho máximo", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer({ maxFileSize: 10 * MB });
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("rejeita criação com Upload-Length maior que maxFileSize com 413", async () => {
    const response = await tusCreate(ctx, {
      length: 10 * MB + 1,
      token: TEST_TOKEN,
    });
    expect(response.status).toBe(413);
  });

  it("aceita criação exatamente no limite (Upload-Length == maxFileSize)", async () => {
    const response = await tusCreate(ctx, {
      length: 10 * MB,
      token: TEST_TOKEN,
    });
    expect(response.status).toBe(201);
  });

  it("rejeita PATCH que ultrapassa maxFileSize com 413", async () => {
    const created = await tusCreate(ctx, {
      length: 10 * MB,
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);

    const first = await tusPatch(ctx, location, 0, Buffer.alloc(8 * MB, 1));
    expect(first.status).toBe(204);

    const { rawRequest } = await import("./helpers.js");
    const overrun = await rawRequest(
      ctx.baseUrl,
      "PATCH",
      location,
      {
        "tus-resumable": "1.0.0",
        "upload-offset": String(8 * MB),
        "content-type": "application/offset+octet-stream",
        "content-length": String(3 * MB),
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      Buffer.alloc(1024),
    );
    expect(overrun.status).toBe(413);
  });

  it("rejeita Upload-Offset não numérico com 400", async () => {
    const created = await tusCreate(ctx, {
      length: 1 * MB,
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);

    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(
      ctx.baseUrl,
      "PATCH",
      location,
      {
        "tus-resumable": "1.0.0",
        "upload-offset": "abc",
        "content-type": "application/offset+octet-stream",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      Buffer.alloc(1),
    );
    expect(response.status).toBe(400);
  });
});
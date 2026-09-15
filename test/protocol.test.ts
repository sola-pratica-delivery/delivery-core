import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { startServer, stopServer, tusCreate, tusHead, tusPatch, locationUrl, createUpload } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN } from "./helpers.js";

const MB = 1024 * 1024;

describe("Validações de protocolo TUS", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("requisição sem Tus-Resumable retorna 412 com Tus-Version", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "POST", "/uploads", {
      "upload-length": "100",
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(response.status).toBe(412);
    expect(response.headers["tus-version"]).toBe("1.0.0");
    expect(response.headers["tus-resumable"]).toBe("1.0.0");
  });

  it("requisição com Tus-Resumable incompatível retorna 412 com Tus-Version", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "POST", "/uploads", {
      "tus-resumable": "0.2.0",
      "upload-length": "100",
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(response.status).toBe(412);
    expect(response.headers["tus-version"]).toBe("1.0.0");
  });

  it("PATCH com Content-Type diferente de application/offset+octet-stream retorna 415", async () => {
    const { rawRequest } = await import("./helpers.js");
    const created = await tusCreate(ctx, { length: 100, token: TEST_TOKEN });
    const location = locationUrl(created);

    const response = await rawRequest(
      ctx.baseUrl,
      "PATCH",
      location,
      {
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/json",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      Buffer.from("{}"),
    );
    expect(response.status).toBe(415);
  });

  it("PATCH sem Content-Type retorna 415", async () => {
    const { rawRequest } = await import("./helpers.js");
    const created = await tusCreate(ctx, { length: 100, token: TEST_TOKEN });
    const location = locationUrl(created);

    const response = await rawRequest(
      ctx.baseUrl,
      "PATCH",
      location,
      {
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      Buffer.alloc(10),
    );
    expect(response.status).toBe(415);
  });

  it("PATCH com Upload-Checksum malformado retorna 400", async () => {
    const location = await createUpload(ctx, 100);
    const response = await tusPatch(
      ctx,
      location,
      0,
      Buffer.alloc(10, 1),
      TEST_TOKEN,
      { "upload-checksum": "sha1" },
    );
    expect(response.status).toBe(400);
  });

  it("PATCH com checksum correto retorna 204 e avança o offset", async () => {
    const payload = Buffer.alloc(2 * MB, 7);
    const checksum = createHash("sha1").update(payload).digest("base64");

    const location = await createUpload(ctx, payload.length);
    const response = await tusPatch(
      ctx,
      location,
      0,
      payload,
      TEST_TOKEN,
      { "upload-checksum": `sha1 ${checksum}` },
    );
    expect(response.status).toBe(204);
    expect(response.headers["upload-offset"]).toBe(String(payload.length));
  });

  it("PATCH com checksum incorreto retorna 460 e mantém o offset", async () => {
    const location = await createUpload(ctx, 2 * MB);
    const response = await tusPatch(
      ctx,
      location,
      0,
      Buffer.alloc(2 * MB, 7),
      TEST_TOKEN,
      { "upload-checksum": "sha1 d3JvbmctY2hlY2tzdW0=" },
    );
    expect(response.status).toBe(460);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.headers["upload-offset"]).toBe("0");
  });

  it("checksum com algoritmo não suportado retorna 400", async () => {
    const location = await createUpload(ctx, 100);
    const response = await tusPatch(
      ctx,
      location,
      0,
      Buffer.alloc(10, 1),
      TEST_TOKEN,
      { "upload-checksum": "crc32 abc123" },
    );
    expect(response.status).toBe(400);
  });
});
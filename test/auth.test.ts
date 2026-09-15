import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startServer,
  stopServer,
  tusCreate,
  tusHead,
  tusPatch,
  tusDelete,
  TEST_TOKEN,
  TEST_TOKEN_2,
  UPLOAD_PATH,
  listStorage,
} from "./helpers.js";
import type { TestContext } from "./helpers.js";

describe("Autenticação TUS", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("bloqueia POST sem token com 401 e não cria arquivos de staging", async () => {
    const response = await tusCreate(ctx, {
      length: 100,
      token: undefined,
    });
    expect(response.status).toBe(401);
    expect(listStorage(ctx)).toHaveLength(0);
  });

  it("bloqueia POST com token inválido com 401", async () => {
    const response = await tusCreate(ctx, {
      length: 100,
      token: "invalid-token",
    });
    expect(response.status).toBe(401);
  });

  it("bloqueia HEAD sem token com 401", async () => {
    const response = await tusHead(ctx, `${UPLOAD_PATH}/does-not-exist`, "");
    expect(response.status).toBe(401);
  });

  it("bloqueia PATCH sem token com 401", async () => {
    const response = await tusPatch(ctx, `${UPLOAD_PATH}/does-not-exist`, 0, Buffer.alloc(1), "");
    expect(response.status).toBe(401);
  });

  it("bloqueia DELETE sem token com 401", async () => {
    const response = await tusDelete(ctx, `${UPLOAD_PATH}/does-not-exist`, "");
    expect(response.status).toBe(401);
  });

  it("liberação com Bearer token válido", async () => {
    const response = await tusCreate(ctx, { length: 100, token: TEST_TOKEN });
    expect(response.status).toBe(201);
  });

  it("liberação com qualquer token da lista configurada", async () => {
    const response = await tusCreate(ctx, { length: 100, token: TEST_TOKEN_2 });
    expect(response.status).toBe(201);
  });

  it("liberação com token presigned via query string (?token=...)", async () => {
    const created = await tusCreate(ctx, {
      length: 100,
      token: undefined,
      urlPath: `${UPLOAD_PATH}?token=${TEST_TOKEN}`,
    });
    expect(created.status).toBe(201);
    const location = created.headers.location as string;
    expect(location).not.toContain("token");

    const head = await tusHead(ctx, `${location}?token=${TEST_TOKEN}`);
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe("0");
  });

  it("OPTIONS não requer autenticação", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "OPTIONS", UPLOAD_PATH);
    expect(response.status).toBe(204);
  });
});
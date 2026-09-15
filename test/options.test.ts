import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { UPLOAD_PATH } from "./helpers.js";

describe("Descoberta de capacidades (OPTIONS)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("OPTIONS /uploads retorna as capacidades TUS do servidor", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "OPTIONS", UPLOAD_PATH);

    expect(response.status).toBe(204);
    expect(response.headers["tus-resumable"]).toBe("1.0.0");
    expect(response.headers["tus-version"]).toBe("1.0.0");
    expect(response.headers["tus-extension"]).toBe("creation,termination,checksum");
    expect(response.headers["tus-max-size"]).toBe(String(ctx.config.maxFileSize));
  });

  it("expoe os headers necessários para os clientes TUS", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "OPTIONS", UPLOAD_PATH);

    const exposed = String(response.headers["access-control-expose-headers"] ?? "");
    expect(exposed.toLowerCase()).toContain("location");
    expect(exposed.toLowerCase()).toContain("tus-resumable");
    expect(exposed.toLowerCase()).toContain("upload-offset");
  });
});
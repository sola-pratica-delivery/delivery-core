import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, rawRequest } from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";

function getPage(
  ctx: TestContext,
  path: "/" | "/upload",
): Promise<RawResponse> {
  return rawRequest(ctx.baseUrl, "GET", path);
}

describe("Interface web de upload (rotas públicas)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("GET / retorna 200 com Content-Type text/html; charset=utf-8", async () => {
    const response = await getPage(ctx, "/");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^text\/html;\s*charset=utf-8$/i,
    );
  });

  it("GET /upload retorna 200 com Content-Type text/html; charset=utf-8", async () => {
    const response = await getPage(ctx, "/upload");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^text\/html;\s*charset=utf-8$/i,
    );
  });

  it("corpo de GET /upload contém os elementos essenciais da interface", async () => {
    const response = await getPage(ctx, "/upload");
    const html = response.body.toString("utf8");

    expect(html).toContain('id="token-input"');
    expect(html).toContain('id="save-token"');
    expect(html).toContain('id="dropzone"');
    expect(html).toContain('id="file-input"');
    expect(html).toContain('id="start-upload"');
    expect(html).toContain('id="pause-upload"');
    expect(html).toContain('id="resume-upload"');
    expect(html).toContain('id="cancel-upload"');
    expect(html).toContain('id="progress-bar"');
    expect(html).toContain('id="job-status-badge"');
    expect(html).toContain('id="live-tracker"');
    expect(html).toContain("tus-js-client");
    expect(html).toContain('id="app-config"');
  });

  it("corpo de GET / contém os elementos essenciais da interface", async () => {
    const response = await getPage(ctx, "/");
    const html = response.body.toString("utf8");
    expect(html).toContain('id="dropzone"');
    expect(html).toContain('id="token-input"');
  });
});
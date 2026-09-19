import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startServer, stopServer, tusCreate, tusHead, tusPatch, b64, locationUrl, rawRequest } from "./helpers.js";
import type { TestContext } from "./helpers.js";
import { TEST_TOKEN, UPLOAD_PATH } from "./helpers.js";

describe("Criação de upload (creation extension)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  it("cria upload válido via POST /uploads retornando 201 e Location", async () => {
    const created = await tusCreate(ctx, {
      length: 1024 * 1024,
      metadata: { filename: "video.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    expect(created.status).toBe(201);
    const location = locationUrl(created);
    expect(location).toMatch(new RegExp(`^${UPLOAD_PATH}/[a-f0-9]+$`));
  });

  it("Location aponta para um recurso consultável via HEAD", async () => {
    const created = await tusCreate(ctx, {
      length: 5 * 1024 * 1024,
      metadata: { filename: "video.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);

    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe("0");
    expect(head.headers["upload-length"]).toBe(String(5 * 1024 * 1024));
    expect(head.headers["cache-control"]).toBe("no-store");
    expect(head.headers["tus-resumable"]).toBe("1.0.0");
  });

  it("retorna Upload-Metadata no HEAD (round-trip do metadado base64)", async () => {
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: { filename: "video.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);
    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(200);
    const metadata = head.headers["upload-metadata"];
    expect(metadata).toContain("filename");
    expect(metadata).toContain(b64("video.mp4"));
    expect(metadata).toContain("filetype");
    expect(metadata).toContain(b64("video/mp4"));
  });

  it("rejeita POST sem Upload-Length com 400", async () => {
    const { rawRequest, b64 } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "POST", UPLOAD_PATH, {
      "tus-resumable": "1.0.0",
      authorization: `Bearer ${TEST_TOKEN}`,
      "upload-metadata": `filename ${b64("video.mp4")}`,
    });
    expect(response.status).toBe(400);
  });

  it("rejeita POST com Upload-Metadata base64 malformado com 400", async () => {
    const { rawRequest } = await import("./helpers.js");
    const response = await rawRequest(ctx.baseUrl, "POST", UPLOAD_PATH, {
      "tus-resumable": "1.0.0",
      "upload-length": "100",
      "upload-metadata": "filename aGVsbG8",
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(response.status).toBe(400);
  });

  it("retorna dynamicZoom no Upload-Metadata do HEAD (round-trip base64)", async () => {
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: {
        filename: "video.mp4",
        filetype: "video/mp4",
        dynamicZoom: "true",
      },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);
    const head = await tusHead(ctx, location, TEST_TOKEN);
    expect(head.status).toBe(200);
    const metadata = head.headers["upload-metadata"];
    expect(metadata).toContain("dynamicZoom");
    expect(metadata).toContain(b64("true"));
  });

  it("persiste job.metadata.dynamicZoom === true no JobRecord quando enviado", async () => {
    const created = await tusCreate(ctx, {
      length: 10,
      metadata: {
        filename: "video.mp4",
        filetype: "video/mp4",
        dynamicZoom: "true",
      },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);
    const uploadId = location.split("/").pop() as string;

    const jobResponse = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/job`,
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(jobResponse.status).toBe(200);
    const job = JSON.parse(jobResponse.body.toString("utf8"));
    expect(job.metadata.dynamicZoom).toBe(true);
  });

  it("persiste job.metadata.dynamicZoom === false no JobRecord (valor heterogêneo '0')", async () => {
    const created = await tusCreate(ctx, {
      length: 10,
      metadata: {
        filename: "video.mp4",
        filetype: "video/mp4",
        dynamicZoom: "0",
      },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);
    const uploadId = location.split("/").pop() as string;

    const jobResponse = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/job`,
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(jobResponse.status).toBe(200);
    const job = JSON.parse(jobResponse.body.toString("utf8"));
    expect(job.metadata.dynamicZoom).toBe(false);
  });

  it("omite dynamicZoom quando o metadado não é enviado (upload legado)", async () => {
    const created = await tusCreate(ctx, {
      length: 10,
      metadata: { filename: "video.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    const location = locationUrl(created);
    const uploadId = location.split("/").pop() as string;

    const jobResponse = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/job`,
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(jobResponse.status).toBe(200);
    const job = JSON.parse(jobResponse.body.toString("utf8"));
    expect(job.metadata.dynamicZoom).toBeUndefined();
  });

  it("dispara o gancho onUploadComplete quando Upload-Offset == Upload-Length", async () => {
    const onUploadComplete = vi.fn();
    const local = await startServer({ onUploadComplete });
    try {
      const created = await tusCreate(local, {
        length: 10,
        metadata: { filename: "video.mp4", filetype: "video/mp4" },
        token: TEST_TOKEN,
      });
      const location = locationUrl(created);
      const patched = await tusPatch(local, location, 0, Buffer.alloc(10, 7));
      expect(patched.status).toBe(204);

      await vi.waitFor(() => {
        expect(onUploadComplete).toHaveBeenCalledTimes(1);
      });
      const metadata = onUploadComplete.mock.calls[0]?.[0];
      expect(metadata).toMatchObject({
        uploadId: expect.any(String),
        filename: "video.mp4",
        filetype: "video/mp4",
        totalSize: 10,
        uploadedBytes: 10,
        isCompleted: true,
      });
    } finally {
      await stopServer(local);
    }
  });
});
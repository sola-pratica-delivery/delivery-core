import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  startServer,
  stopServer,
  createUpload,
  tusPatch,
  tusCreate,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function getValidation(
  ctx: TestContext,
  uploadId: string,
  token: string = TEST_TOKEN,
): Promise<RawResponse> {
  return rawRequest(ctx.baseUrl, "GET", `${UPLOAD_PATH}/${uploadId}/validation`, {
    authorization: `Bearer ${token}`,
  });
}

async function waitForValidation(
  ctx: TestContext,
  uploadId: string,
): Promise<RawResponse> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await getValidation(ctx, uploadId);
    if (response.status !== 404) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timeout waiting for media validation report");
}

function generateSampleMp4(directory: string): Buffer {
  const output = path.join(directory, "sample.mp4");
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      output,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(output);
}

describe("Endpoint GET /uploads/:id/validation", () => {
  let ctx: TestContext;
  let validated: unknown[];
  let validatedMetadata: unknown[];

  beforeAll(async () => {
    validated = [];
    validatedMetadata = [];
    ctx = await startServer({
      onUploadValidated: (result, metadata) => {
        validated.push(result);
        validatedMetadata.push(metadata);
      },
    });
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  afterEach(() => {
    validated.length = 0;
    validatedMetadata.length = 0;
  });

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/validation`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/validation`,
      { authorization: "Bearer invalid-token" },
    );
    expect(response.status).toBe(401);
  });

  describe.runIf(hasFfmpeg)("com um arquivo de vídeo válido", () => {
    let sampleDir: string;
    let sampleBuffer: Buffer;

    beforeAll(() => {
      sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "validation-sample-"));
      sampleBuffer = generateSampleMp4(sampleDir);
    });

    afterAll(() => {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    });

    it("valida e retorna 200 OK com metadados", async () => {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;

      const patched = await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);
      expect(patched.status).toBe(204);

      const response = await waitForValidation(ctx, uploadId);
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body.toString("utf8"));
      expect(body.uploadId).toBe(uploadId);
      expect(body.status).toBe("VALID");
      expect(body.metadata.videoCodec).toBe("h264");
      expect(body.metadata.hasAudio).toBe(true);
      expect(body.metadata.audioChannels).toBeGreaterThan(0);
      expect(body.metadata.resolution).toEqual({ width: 320, height: 240 });
      expect(body.metadata.framerate).toBeCloseTo(30, 0);
      expect(body.metadata.duration).toBeGreaterThan(0.8);
      expect(body.metadata.fileSizeBytes).toBe(sampleBuffer.length);
    });

    it("persiste o relatório {@code uploadId}.validation.json no storage", async () => {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;
      await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);

      const response = await waitForValidation(ctx, uploadId);
      expect(response.status).toBe(200);

      const reportPath = path.join(
        ctx.config.storageDir,
        `${uploadId}.validation.json`,
      );
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      expect(report.status).toBe("VALID");
    });

    it("dispara o hook onUploadValidated com o resultado", async () => {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;
      await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);

      const response = await waitForValidation(ctx, uploadId);
      expect(response.status).toBe(200);

      await vi.waitFor(() => {
        expect(validated.length).toBe(1);
      });
      const result = validated[0] as { valid: boolean };
      expect(result.valid).toBe(true);
    });
  });

  it("retorna 422 REJECTED para arquivo não-mídia concluído", async () => {
    const payload = Buffer.from(
      "this is definitely not a video container",
      "utf8",
    );
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "fake.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    const patched = await tusPatch(ctx, location, 0, payload, TEST_TOKEN);
    expect(patched.status).toBe(204);

    const response = await waitForValidation(ctx, uploadId);
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString("utf8"));
    expect(body.uploadId).toBe(uploadId);
    expect(body.status).toBe("REJECTED");
    expect(body.error.code).toBe("INVALID_MAGIC_BYTES");
  });

  it("retorna 404 para upload existente mas ainda não concluído", async () => {
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: { filename: "pending.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    expect(created.status).toBe(201);
    const location = created.headers.location as string;
    const uploadId = location.split("/").pop() as string;

    const response = await getValidation(ctx, uploadId);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("NOT_FOUND");
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await getValidation(ctx, "does-not-exist");
    expect(response.status).toBe(404);
  });
});
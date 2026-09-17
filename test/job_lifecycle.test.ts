import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
import type { JobRecord } from "../src/job/types.js";
import { FileJobStore } from "../src/job/store.js";
import type { UploadCompletedEventPayload } from "../src/events/types.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function getJob(
  ctx: TestContext,
  uploadId: string,
  token: string = TEST_TOKEN,
): Promise<RawResponse> {
  return rawRequest(ctx.baseUrl, "GET", `${UPLOAD_PATH}/${uploadId}/job`, {
    authorization: `Bearer ${token}`,
  });
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

describe("Job lifecycle - GET /uploads/:id/job", () => {
  let ctx: TestContext;
  let events: UploadCompletedEventPayload[];

  beforeAll(async () => {
    events = [];
    ctx = await startServer({
      onEventEmitted: (event) => {
        events.push(event);
      },
    });
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  afterEach(() => {
    events.length = 0;
  });

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/job`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/job`,
      { authorization: "Bearer invalid-token" },
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await getJob(ctx, "does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("NOT_FOUND");
  });

  it("cria o job com status UPLOADING no início do upload", async () => {
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: { filename: "pending.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    expect(created.status).toBe(201);
    const uploadId = (created.headers.location as string).split("/").pop();

    const response = await getJob(ctx, uploadId as string);
    expect(response.status).toBe(200);
    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job.uploadId).toBe(uploadId);
    expect(job.status).toBe("UPLOADING");
    expect(job.transitions[0]).toMatchObject({ from: null, to: "UPLOADING" });
    expect(job.metadata.filename).toBe("pending.mp4");
    expect(job.metadata.totalSize).toBe(100);
  });

  it("retorna 200 com o registro completo via GET /uploads/:id/job", async () => {
    const location = await createUpload(
      ctx,
      100,
      { filename: "done.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;

    const response = await getJob(ctx, uploadId);
    expect(response.status).toBe(200);
    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job).toMatchObject({
      jobId: expect.any(String),
      uploadId,
      filePath: expect.any(String),
      metadata: {
        filename: "done.mp4",
        filetype: "video/mp4",
        totalSize: 100,
        uploadedBytes: 0,
      },
      transitions: expect.any(Array),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("transiciona para FAILED e não emite UPLOAD_COMPLETED para arquivo inválido", async () => {
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

    await vi.waitFor(async () => {
      const response = await getJob(ctx, uploadId);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
    });

    const response = await getJob(ctx, uploadId);
    expect(response.status).toBe(200);
    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("FAILED");
    expect(job.error).toMatchObject({
      code: "INVALID_MAGIC_BYTES",
      message: expect.any(String),
    });
    expect(job.transitions.map((t) => t.to)).toEqual(["UPLOADING", "FAILED"]);
    expect(events).toHaveLength(0);
  });

  it("é idempotente: segunda tentativa de completar o upload retorna 409 sem evento duplicado", async () => {
    const payload = Buffer.from("not a video at all", "utf8");
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "again.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, payload, TEST_TOKEN);

    await vi.waitFor(async () => {
      const response = await getJob(ctx, uploadId);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
    });

    const secondPatch = await tusPatch(ctx, location, payload.length, Buffer.alloc(0), TEST_TOKEN);
    expect(secondPatch.status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const response = await getJob(ctx, uploadId);
    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("FAILED");
    expect(job.transitions.filter((t) => t.to === "FAILED")).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  describe.runIf(hasFfmpeg)("com um arquivo de vídeo válido", () => {
    let sampleDir: string;
    let sampleBuffer: Buffer;

    beforeAll(() => {
      sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-sample-"));
      sampleBuffer = generateSampleMp4(sampleDir);
    });

    afterAll(() => {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    });

    it("transiciona para PROCESSING e emite UPLOAD_COMPLETED com metadados completos", async () => {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;

      const patched = await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);
      expect(patched.status).toBe(204);

      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });

      const event = events[0] as UploadCompletedEventPayload;
      expect(event.eventType).toBe("UPLOAD_COMPLETED");
      expect(event.eventId).toEqual(expect.any(String));
      expect(event.uploadId).toBe(uploadId);
      expect(event.jobId).toEqual(expect.any(String));
      expect(event.filePath).toEqual(expect.any(String));
      expect(event.occurredAt).toEqual(expect.any(String));
      expect(event.metadata).toMatchObject({
        filename: "sample.mp4",
        filetype: "video/mp4",
        totalSize: sampleBuffer.length,
        uploadedBytes: sampleBuffer.length,
        duration: expect.any(Number),
        resolution: { width: 320, height: 240 },
        framerate: 30,
        videoCodec: "h264",
        hasAudio: true,
        audioChannels: expect.any(Number),
        containerFormat: expect.any(String),
      });

      const response = await getJob(ctx, uploadId);
      expect(response.status).toBe(200);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("PROCESSING");
      expect(job.transitions.map((t) => t.to)).toEqual([
        "UPLOADING",
        "PROCESSING",
      ]);
      expect(job.metadata.videoCodec).toBe("h264");
    });
  });
});

describe("FileJobStore", () => {
  function makeStore(): FileJobStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jobstore-"));
    return new FileJobStore(dir);
  }

  it("cria, lê por uploadId e transiciona estados", async () => {
    const store = makeStore();
    const created = await store.create({
      jobId: "job-1",
      uploadId: "upload-1",
      status: "UPLOADING",
      filePath: "/tmp/upload-1",
      metadata: { filename: "a.mp4", filetype: "video/mp4", totalSize: 10, uploadedBytes: 0 },
    });
    expect(created.status).toBe("UPLOADING");
    expect(created.transitions).toHaveLength(1);

    const byUpload = await store.get("upload-1");
    expect(byUpload?.jobId).toBe("job-1");

    const byJobId = await store.get("job-1");
    expect(byJobId?.uploadId).toBe("upload-1");

    const processed = await store.transition(
      "upload-1",
      "PROCESSING",
      "Validation passed",
    );
    expect(processed.status).toBe("PROCESSING");
    expect(processed.transitions).toHaveLength(2);
    expect(processed.transitions[1]).toMatchObject({
      from: "UPLOADING",
      to: "PROCESSING",
      reason: "Validation passed",
    });
  });

  it("retorna null para identificador inexistente", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("lança erro ao transicionar um job inexistente", async () => {
    const store = makeStore();
    await expect(store.transition("missing", "FAILED")).rejects.toThrow(
      "Job not found",
    );
  });
});
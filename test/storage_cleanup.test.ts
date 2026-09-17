import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  startServer,
  stopServer,
  createUpload,
  tusPatch,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";
import type { CleanupResult, PurgeResult } from "../src/cleanup/types.js";
import type { JobRecord } from "../src/job/types.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function postCleanup(
  ctx: TestContext,
  token: string = TEST_TOKEN,
  body?: Record<string, unknown>,
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return rawRequest(
    ctx.baseUrl,
    "POST",
    `${UPLOAD_PATH}/cleanup`,
    headers,
    body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined,
  );
}

function postPurge(
  ctx: TestContext,
  uploadId: string,
  token: string = TEST_TOKEN,
): Promise<RawResponse> {
  return rawRequest(ctx.baseUrl, "POST", `${UPLOAD_PATH}/${uploadId}/purge`, {
    authorization: `Bearer ${token}`,
  });
}

function getJob(
  ctx: TestContext,
  uploadId: string,
): Promise<RawResponse> {
  return rawRequest(ctx.baseUrl, "GET", `${UPLOAD_PATH}/${uploadId}/job`, {
    authorization: `Bearer ${TEST_TOKEN}`,
  });
}

function backdate(filePath: string, hours: number): void {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(filePath, when, when);
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

describe("POST /uploads/cleanup", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await stopServer(ctx);
  });

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(ctx.baseUrl, "POST", `${UPLOAD_PATH}/cleanup`);
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await postCleanup(ctx, "invalid-token");
    expect(response.status).toBe(401);
  });

  it("preserva uploads em andamento recentes (< TTL)", async () => {
    const location = await createUpload(
      ctx,
      1024 * 1024,
      { filename: "pending.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, Buffer.alloc(512 * 1024, 1));

    const response = await postCleanup(ctx);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as CleanupResult;
    expect(body.deletedFilesCount).toBe(0);
    expect(fs.existsSync(path.join(ctx.config.storageDir, uploadId))).toBe(true);

    const jobResponse = await getJob(ctx, uploadId);
    const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("UPLOADING");
  });

  it("remove upload órfão com mtime retrocedido e transiciona o job para FAILED", async () => {
    const location = await createUpload(
      ctx,
      1024 * 1024,
      { filename: "orphan.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, Buffer.alloc(512 * 1024, 1));

    const rawPath = path.join(ctx.config.storageDir, uploadId);
    const tusJsonPath = path.join(ctx.config.storageDir, `${uploadId}.json`);
    const expectedRawSize = fs.statSync(rawPath).size;
    const tusJsonSize = fs.statSync(tusJsonPath).size;
    backdate(rawPath, 25);

    const response = await postCleanup(ctx, TEST_TOKEN, { maxAgeHours: 24 });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as CleanupResult;
    expect(body.deletedFilesCount).toBe(2);
    expect(body.reclaimedBytes).toBe(expectedRawSize + tusJsonSize);
    expect(body.details.some((d) => d.reason === "ORPHAN_INCOMPLETE_UPLOAD")).toBe(true);
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(tusJsonPath)).toBe(false);

    const jobResponse = await getJob(ctx, uploadId);
    const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("FAILED");
    expect(job.error?.code).toBe("ORPHAN_UPLOAD_EXPIRED");
    expect(job.transitions.some((t) => t.reason === "ORPHAN_UPLOAD_EXPIRED")).toBe(true);
  });

  it("respeita maxAgeHours do body: arquivo de 25h preservado com TTL de 48h", async () => {
    const location = await createUpload(
      ctx,
      1024 * 1024,
      { filename: "pending.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    const rawPath = path.join(ctx.config.storageDir, uploadId);
    backdate(rawPath, 25);

    const preserved = await postCleanup(ctx, TEST_TOKEN, { maxAgeHours: 48 });
    expect(preserved.status).toBe(200);
    const first = JSON.parse(preserved.body.toString("utf8")) as CleanupResult;
    expect(first.deletedFilesCount).toBe(0);
    expect(fs.existsSync(rawPath)).toBe(true);
  });

  it("remove arquivo órfão não rastreado por job como ORPHAN_UNTRACKED_FILE", async () => {
    const orphanPath = path.join(ctx.config.storageDir, "orphan.dat");
    fs.writeFileSync(orphanPath, Buffer.alloc(1024, 7));
    backdate(orphanPath, 25);

    const response = await postCleanup(ctx, TEST_TOKEN, { maxAgeHours: 24 });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as CleanupResult;
    const detail = body.details.find((d) => d.fileName === "orphan.dat");
    expect(detail?.reason).toBe("ORPHAN_UNTRACKED_FILE");
    expect(detail?.sizeBytes).toBe(1024);
    expect(body.reclaimedBytes).toBe(1024);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it("marca isPurged de forma idempotente quando o job perdeu o arquivo físico", async () => {
    const payload = Buffer.from("not a video at all", "utf8");
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "gone.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, payload, TEST_TOKEN);

    await vi.waitFor(async () => {
      const response = await getJob(ctx, uploadId);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
    });

    const rawPath = path.join(ctx.config.storageDir, uploadId);
    fs.rmSync(rawPath, { force: true });

    const jobResponse = await getJob(ctx, uploadId);
    const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
    const jobFilePath = path.join(ctx.config.storageDir, `${job.jobId}.job.json`);
    backdate(jobFilePath, 25);

    const response = await postCleanup(ctx, TEST_TOKEN, { maxAgeHours: 24 });
    expect(response.status).toBe(200);

    const refreshed = await getJob(ctx, uploadId);
    const updated = JSON.parse(refreshed.body.toString("utf8")) as JobRecord;
    expect(updated.isPurged).toBe(true);
    expect(typeof updated.purgedAt).toBe("string");
  });
});

describe("POST /uploads/:id/purge", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await stopServer(ctx);
  });

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/any/purge`,
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await postPurge(ctx, "does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("NOT_FOUND");
  });

  it("retorna 409 Conflict ao purgar upload em progresso (UPLOADING)", async () => {
    const location = await createUpload(
      ctx,
      1024 * 1024,
      { filename: "active.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, Buffer.alloc(128 * 1024, 1));

    const response = await postPurge(ctx, uploadId);
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("UPLOADING");
  });

  it("expurga a matéria-prima de job concluído (FAILED) e preserva o relatório de validação", async () => {
    const payload = Buffer.from("definitely not a video", "utf8");
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "done.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, payload, TEST_TOKEN);

    await vi.waitFor(async () => {
      const response = await getJob(ctx, uploadId);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
    });

    const rawPath = path.join(ctx.config.storageDir, uploadId);
    const validationPath = path.join(
      ctx.config.storageDir,
      `${uploadId}.validation.json`,
    );
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(validationPath)).toBe(true);

    const response = await postPurge(ctx, uploadId);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as PurgeResult;
    expect(body.uploadId).toBe(uploadId);
    expect(body.jobId).toEqual(expect.any(String));
    expect(body.purgedFiles).toEqual([rawPath]);
    expect(body.reclaimedBytes).toBe(payload.length);
    expect(typeof body.purgedAt).toBe("string");

    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(validationPath)).toBe(true);

    const jobResponse = await getJob(ctx, uploadId);
    const job = JSON.parse(jobResponse.body.toString("utf8")) as JobRecord;
    expect(job.isPurged).toBe(true);
    expect(job.purgedAt).toBe(body.purgedAt);
  });

  it("é idempotente: segunda chamada retorna purgedFiles vazio e 0 bytes", async () => {
    const payload = Buffer.from("not a video", "utf8");
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "twice.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    await tusPatch(ctx, location, 0, payload, TEST_TOKEN);

    await vi.waitFor(async () => {
      const response = await getJob(ctx, uploadId);
      const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(job.status).toBe("FAILED");
    });

    const first = await postPurge(ctx, uploadId);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body.toString("utf8")).reclaimedBytes).toBe(
      payload.length,
    );

    const second = await postPurge(ctx, uploadId);
    expect(second.status).toBe(200);
    const body = JSON.parse(second.body.toString("utf8")) as PurgeResult;
    expect(body.purgedFiles).toEqual([]);
    expect(body.reclaimedBytes).toBe(0);
  });

  describe.runIf(hasFfmpeg)("com um arquivo de vídeo válido", () => {
    let sampleDir: string;
    let sampleBuffer: Buffer;

    beforeEach(() => {
      sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-sample-"));
      sampleBuffer = generateSampleMp4(sampleDir);
    });

    afterEach(() => {
      fs.rmSync(sampleDir, { recursive: true, force: true });
    });

    it("expurga matéria-prima de job PROCESSING", async () => {
      const location = await createUpload(
        ctx,
        sampleBuffer.length,
        { filename: "sample.mp4", filetype: "video/mp4" },
        TEST_TOKEN,
      );
      const uploadId = location.split("/").pop() as string;
      await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);

      await vi.waitFor(async () => {
        const response = await getJob(ctx, uploadId);
        const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
        expect(job.status).toBe("PROCESSING");
      });

      const response = await postPurge(ctx, uploadId);
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body.toString("utf8")) as PurgeResult;
      expect(body.purgedFiles).toHaveLength(1);
      expect(body.reclaimedBytes).toBe(sampleBuffer.length);

      const rawPath = path.join(ctx.config.storageDir, uploadId);
      expect(fs.existsSync(rawPath)).toBe(false);
    });
  });
});

describe("StorageCleanupService direto (unidade)", () => {
  it("cleanOrphans em diretório vazio retorna zero", async () => {
    const { StorageCleanupService } = await import("../src/cleanup/service.js");
    const { FileJobStore } = await import("../src/job/store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-empty-"));
    try {
      const service = new StorageCleanupService(
        dir,
        new FileJobStore(dir),
        { orphanTtlMs: 24 * 60 * 60 * 1000 },
      );
      const result = await service.cleanOrphans();
      expect(result.scannedFilesCount).toBe(0);
      expect(result.deletedFilesCount).toBe(0);
      expect(result.details).toEqual([]);
      expect(typeof result.executedAt).toBe("string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleanOrphans ignora arquivos recentes quando fora da janela de expiração", async () => {
    const { StorageCleanupService } = await import("../src/cleanup/service.js");
    const { FileJobStore } = await import("../src/job/store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-fresh-"));
    try {
      fs.writeFileSync(path.join(dir, "fresh.bin"), Buffer.alloc(64));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const service = new StorageCleanupService(
        dir,
        new FileJobStore(dir),
        { orphanTtlMs: 60_000 },
      );
      const result = await service.cleanOrphans();
      expect(result.deletedFilesCount).toBe(0);
      expect(fs.existsSync(path.join(dir, "fresh.bin"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
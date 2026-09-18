import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { QaStore } from "../src/qa/store.js";
import type { VideoQaReport } from "../src/qa/types.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function sampleReport(uploadId: string, passed: boolean): VideoQaReport {
  return {
    uploadId,
    passed,
    checkedAt: new Date().toISOString(),
    blackScreen: {
      passed,
      maxAllowedDuration: 1.0,
      detectedIntervals: [],
    },
    freezeFrame: {
      passed,
      maxAllowedDuration: 2.0,
      detectedIntervals: [],
    },
    avSync: {
      passed,
      videoDuration: 10,
      audioDuration: 10,
      diffSeconds: 0,
      maxAllowedDiffSeconds: 1.0,
    },
    details: { totalDuration: 10, videoCodec: "h264", audioCodec: "aac" },
    failureReasons: passed ? [] : ["Black screen detected"],
  };
}

function generateSampleMp4(directory: string, durationSeconds = 2): Buffer {
  const output = path.join(directory, "sample.mp4");
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=30:duration=${durationSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durationSeconds}`,
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

describe("QA persistence - QaStore", () => {
  it("salva e lê relatório em <uploadId>.qa.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-"));
    try {
      const store = new QaStore(dir);
      await store.save("upload-1", sampleReport("upload-1", true));

      const reportPath = path.join(dir, "upload-1.qa.json");
      expect(fs.existsSync(reportPath)).toBe(true);
      const persisted = JSON.parse(
        fs.readFileSync(reportPath, "utf8"),
      ) as VideoQaReport;
      expect(persisted.uploadId).toBe("upload-1");
      expect(persisted.passed).toBe(true);
      expect(persisted.checkedAt).toEqual(expect.any(String));

      const read = await store.read("upload-1");
      expect(read?.passed).toBe(true);
      expect(await store.read("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Endpoint GET /uploads/:id/qa", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function getQa(
    uploadId: string,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(ctx.baseUrl, "GET", `${UPLOAD_PATH}/${uploadId}/qa`, {
      authorization: `Bearer ${token}`,
    });
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa`,
      { authorization: "Bearer invalid-token" },
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para relatório inexistente", async () => {
    const response = await getQa("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("NOT_FOUND");
  });

  it("retorna 200 com o relatório aprovado e bloco completo de checks", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save("qa-passed", sampleReport("qa-passed", true));

    const response = await getQa("qa-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(response.body.toString("utf8")) as VideoQaReport;
    expect(report.uploadId).toBe("qa-passed");
    expect(report.passed).toBe(true);
    expect(report.blackScreen.passed).toBe(true);
    expect(report.freezeFrame.passed).toBe(true);
    expect(report.avSync.passed).toBe(true);
    expect(report.details.totalDuration).toBe(10);
    expect(report.checkedAt).toEqual(expect.any(String));
  });

  it("retorna 422 com failureReasons quando o relatório reprova", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save("qa-failed", sampleReport("qa-failed", false));

    const response = await getQa("qa-failed");
    expect(response.status).toBe(422);
    const report = JSON.parse(response.body.toString("utf8")) as VideoQaReport;
    expect(report.passed).toBe(false);
    expect(report.blackScreen.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);
  });
});

describe("Endpoint POST /uploads/:id/qa/video", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function postQaVideo(
    uploadId: string,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/${uploadId}/qa/video`,
      { authorization: `Bearer ${token}` },
    );
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/any-id/qa/video`,
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await postQaVideo("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe("NOT_FOUND");
  });

  it("reprova arquivo não-mídia com 422 e persiste o relatório", async () => {
    const payload = Buffer.from("this is definitely not a video container", "utf8");
    const location = await createUpload(
      ctx,
      payload.length,
      { filename: "fake.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    const uploadId = location.split("/").pop() as string;
    const patched = await tusPatch(ctx, location, 0, payload, TEST_TOKEN);
    expect(patched.status).toBe(204);

    const response = await postQaVideo(uploadId);
    expect(response.status).toBe(422);
    const report = JSON.parse(response.body.toString("utf8")) as VideoQaReport;
    expect(report.uploadId).toBe(uploadId);
    expect(report.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);

    const reportPath = path.join(ctx.config.storageDir, `${uploadId}.qa.json`);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  describe.runIf(hasFfmpeg)("com um arquivo de vídeo válido", () => {
    it("executa a verificação, aprova e persiste relatório acessível via GET", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-sample-"));
      try {
        const sampleBuffer = generateSampleMp4(sampleDir);
        const location = await createUpload(
          ctx,
          sampleBuffer.length,
          { filename: "sample.mp4", filetype: "video/mp4" },
          TEST_TOKEN,
        );
        const uploadId = location.split("/").pop() as string;
        const patched = await tusPatch(ctx, location, 0, sampleBuffer, TEST_TOKEN);
        expect(patched.status).toBe(204);

        const response = await postQaVideo(uploadId);
        expect(response.status).toBe(200);
        const report = JSON.parse(response.body.toString("utf8")) as VideoQaReport;
        expect(report.uploadId).toBe(uploadId);
        expect(report.passed).toBe(true);
        expect(report.blackScreen.passed).toBe(true);
        expect(report.freezeFrame.passed).toBe(true);
        expect(report.avSync.passed).toBe(true);
        expect(report.details.totalDuration).toBeGreaterThan(0);
        expect(report.details.videoCodec).toBe("h264");
        expect(report.details.audioCodec).toBe("aac");

        const getResponse = await rawRequest(
          ctx.baseUrl,
          "GET",
          `${UPLOAD_PATH}/${uploadId}/qa`,
          { authorization: `Bearer ${TEST_TOKEN}` },
        );
        expect(getResponse.status).toBe(200);
        expect(
          (JSON.parse(getResponse.body.toString("utf8")) as VideoQaReport).passed,
        ).toBe(true);
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });
  });
});
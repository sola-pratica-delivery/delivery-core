import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  startServer,
  stopServer,
  createUpload,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";
import { QaStore } from "../src/qa/store.js";
import type {
  AudioQaReport,
  ConsolidatedQaReport,
  ThumbnailQaReport,
  VideoQaReport,
} from "../src/qa/types.js";

const hasFfmpeg = (() => {
  const tool = (name: string) =>
    spawnSync(name, ["-version"], { encoding: "utf8" }).status === 0;
  return tool("ffmpeg") && tool("ffprobe");
})();

function sampleVideoReport(uploadId: string, passed: boolean): VideoQaReport {
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

function sampleAudioReport(uploadId: string, passed: boolean): AudioQaReport {
  return {
    uploadId,
    passed,
    checkedAt: new Date().toISOString(),
    loudness: {
      passed,
      integratedLoudness: -14.2,
      minAllowedLufs: -14.5,
      maxAllowedLufs: -13.5,
    },
    truePeak: {
      passed,
      truePeak: -1.5,
      maxAllowedTruePeak: -1.0,
    },
    voicePresence: {
      passed,
      maxAllowedSilenceDuration: 3.0,
      detectedSilenceIntervals: [],
      totalSilenceDuration: 0,
      silencePercentage: 0,
    },
    details: { duration: 10, sampleRate: 48000, channels: 2, audioCodec: "aac" },
    failureReasons: passed ? [] : ["Integrated loudness below minimum"],
  };
}

function sampleThumbnailReport(
  uploadId: string,
  passed: boolean,
): ThumbnailQaReport {
  return {
    uploadId,
    passed,
    checkedAt: new Date().toISOString(),
    dimensions: {
      passed,
      width: 1280,
      height: 720,
      expectedWidth: 1280,
      expectedHeight: 720,
      aspectRatio: "16:9",
    },
    fileSize: {
      passed,
      fileSizeBytes: 1_048_576,
      maxAllowedBytes: 2_097_152,
    },
    format: { passed, detectedFormat: "jpeg", mimeType: "image/jpeg" },
    contrast: {
      passed,
      yMin: 16,
      yMax: 235,
      yAvg: 125,
      luminanceRange: 219,
      minAllowedRange: 20,
    },
    details: {
      width: 1280,
      height: 720,
      fileSizeBytes: 1_048_576,
      format: "jpeg",
    },
    failureReasons: passed ? [] : ["Dimension mismatch"],
  };
}

function generateImage(
  directory: string,
  name: string,
  lavfi: string,
  extraArgs: string[] = [],
): Buffer {
  const output = path.join(directory, name);
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", lavfi, "-frames:v", "1", ...extraArgs, output],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(output);
}

describe("QaStore - persistência de thumbnail e consolidação", () => {
  it("salva e lê relatório de thumbnail via saveThumbnail/readThumbnail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-thumb-"));
    try {
      const store = new QaStore(dir);
      await store.saveThumbnail(
        "upload-thumb-1",
        sampleThumbnailReport("upload-thumb-1", true),
      );

      const read = await store.readThumbnail("upload-thumb-1");
      expect(read?.passed).toBe(true);
      expect(read?.dimensions.aspectRatio).toBe("16:9");
      expect(read?.details.format).toBe("jpeg");
      expect(read?.format.detectedFormat).toBe("jpeg");
      expect(await store.readThumbnail("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge vídeo, áudio e thumbnail no relatório consolidado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-tri-"));
    try {
      const store = new QaStore(dir);
      await store.save(
        "upload-tri",
        sampleVideoReport("upload-tri", true),
      );
      await store.saveAudio(
        "upload-tri",
        sampleAudioReport("upload-tri", true),
      );
      await store.saveThumbnail(
        "upload-tri",
        sampleThumbnailReport("upload-tri", true),
      );

      const consolidated = await store.readConsolidated("upload-tri");
      expect(consolidated).not.toBeNull();
      expect(consolidated?.uploadId).toBe("upload-tri");
      expect(consolidated?.passed).toBe(true);
      expect(consolidated?.video?.passed).toBe(true);
      expect(consolidated?.audio?.passed).toBe(true);
      expect(consolidated?.thumbnail?.passed).toBe(true);
      expect(consolidated?.thumbnail?.details.width).toBe(1280);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reprova o consolidado quando a seção de thumbnail falha", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-thumbfail-"));
    try {
      const store = new QaStore(dir);
      await store.save("upload-tf", sampleVideoReport("upload-tf", true));
      await store.saveThumbnail(
        "upload-tf",
        sampleThumbnailReport("upload-tf", false),
      );

      const consolidated = await store.readConsolidated("upload-tf");
      expect(consolidated?.video?.passed).toBe(true);
      expect(consolidated?.thumbnail?.passed).toBe(false);
      expect(consolidated?.passed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva thumbnail ao salvar vídeo ou áudio depois (ordem inversa)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-inv-thumb-"));
    try {
      const store = new QaStore(dir);
      await store.saveThumbnail(
        "upload-inv-thumb",
        sampleThumbnailReport("upload-inv-thumb", true),
      );
      await store.save(
        "upload-inv-thumb",
        sampleVideoReport("upload-inv-thumb", true),
      );
      await store.saveAudio(
        "upload-inv-thumb",
        sampleAudioReport("upload-inv-thumb", true),
      );

      const consolidated = await store.readConsolidated("upload-inv-thumb");
      expect(consolidated?.video?.passed).toBe(true);
      expect(consolidated?.audio?.passed).toBe(true);
      expect(consolidated?.thumbnail?.passed).toBe(true);
      expect(consolidated?.passed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readConsolidated retorna null para upload inexistente", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-miss-thumb-"));
    try {
      const store = new QaStore(dir);
      expect(await store.readConsolidated("missing")).toBeNull();
      expect(await store.readThumbnail("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Endpoint GET /uploads/:id/qa/thumbnail", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function getQaThumbnail(
    uploadId: string,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/qa/thumbnail`,
      { authorization: `Bearer ${token}` },
    );
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa/thumbnail`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa/thumbnail`,
      { authorization: "Bearer invalid-token" },
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para relatório inexistente", async () => {
    const response = await getQaThumbnail("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("retorna 200 com o relatório de thumbnail aprovado", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveThumbnail(
      "thumb-passed",
      sampleThumbnailReport("thumb-passed", true),
    );

    const response = await getQaThumbnail("thumb-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ThumbnailQaReport;
    expect(report.uploadId).toBe("thumb-passed");
    expect(report.passed).toBe(true);
    expect(report.dimensions.passed).toBe(true);
    expect(report.dimensions.width).toBe(1280);
    expect(report.fileSize.passed).toBe(true);
    expect(report.format.passed).toBe(true);
    expect(report.contrast.passed).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
  });

  it("retorna 422 com failureReasons quando o relatório reprova", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveThumbnail(
      "thumb-failed",
      sampleThumbnailReport("thumb-failed", false),
    );

    const response = await getQaThumbnail("thumb-failed");
    expect(response.status).toBe(422);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ThumbnailQaReport;
    expect(report.passed).toBe(false);
    expect(report.dimensions.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);
  });
});

describe("Endpoint GET /uploads/:id/qa (relatório consolidado com thumbnail)", () => {
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

  it("retorna consolidado quando há vídeo e thumbnail", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save("vt-passed", sampleVideoReport("vt-passed", true));
    await store.saveThumbnail(
      "vt-passed",
      sampleThumbnailReport("vt-passed", true),
    );

    const response = await getQa("vt-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ConsolidatedQaReport;
    expect(report.uploadId).toBe("vt-passed");
    expect(report.video?.passed).toBe(true);
    expect(report.thumbnail?.passed).toBe(true);
    expect(report.thumbnail?.dimensions.aspectRatio).toBe("16:9");
  });

  it("retorna consolidado completo com vídeo, áudio e thumbnail", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save("vat-passed", sampleVideoReport("vat-passed", true));
    await store.saveAudio(
      "vat-passed",
      sampleAudioReport("vat-passed", true),
    );
    await store.saveThumbnail(
      "vat-passed",
      sampleThumbnailReport("vat-passed", true),
    );

    const response = await getQa("vat-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ConsolidatedQaReport;
    expect(report.video?.passed).toBe(true);
    expect(report.audio?.passed).toBe(true);
    expect(report.thumbnail?.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("retorna seção de thumbnail quando só thumbnail existe", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveThumbnail(
      "thumb-only",
      sampleThumbnailReport("thumb-only", true),
    );

    const response = await getQa("thumb-only");
    expect(response.status).toBe(200);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ThumbnailQaReport;
    expect(report.passed).toBe(true);
    expect(report.dimensions.width).toBe(1280);
    expect(report.details.format).toBe("jpeg");
  });
});

describe("Endpoint POST /uploads/:id/qa/thumbnail", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function postQaThumbnail(
    uploadId: string,
    token: string = TEST_TOKEN,
    body?: Record<string, unknown>,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
    }
    return rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/${uploadId}/qa/thumbnail`,
      headers,
      payload,
    );
  }

  function writeThumbFile(
    uploadId: string,
    bytes: Buffer,
    ext = "jpg",
  ): void {
    fs.writeFileSync(
      path.join(ctx.config.storageDir, `${uploadId}.thumbnail.${ext}`),
      bytes,
    );
  }

  async function createUploadId(): Promise<string> {
    const location = await createUpload(
      ctx,
      100,
      { filename: "video.mp4", filetype: "video/mp4" },
      TEST_TOKEN,
    );
    return location.split("/").pop() as string;
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/any-id/qa/thumbnail`,
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente sem thumbnail", async () => {
    const response = await postQaThumbnail("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("retorna 404 quando o upload existe mas não há thumbnail", async () => {
    const uploadId = await createUploadId();

    const response = await postQaThumbnail(uploadId);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("reprova thumbnail com magic bytes inválidos com 422 e persiste relatório", async () => {
    const uploadId = await createUploadId();
    writeThumbFile(uploadId, Buffer.from("this is not an image", "utf8"));

    const response = await postQaThumbnail(uploadId);
    expect(response.status).toBe(422);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ThumbnailQaReport;
    expect(report.uploadId).toBe(uploadId);
    expect(report.passed).toBe(false);
    expect(report.details.format).toBeNull();
    expect(report.dimensions.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);

    const reportPath = path.join(ctx.config.storageDir, `${uploadId}.qa.json`);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it("respeita caminho fornecido no payload { filePath }", async () => {
    const uploadId = await createUploadId();
    fs.writeFileSync(
      path.join(ctx.config.storageDir, "custom-fake.jpg"),
      "nope, still not an image",
    );

    const response = await postQaThumbnail(uploadId, TEST_TOKEN, {
      filePath: "custom-fake.jpg",
    });
    expect(response.status).toBe(422);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ThumbnailQaReport;
    expect(report.uploadId).toBe(uploadId);
    expect(report.passed).toBe(false);
    expect(report.details.format).toBeNull();
  });

  describe.runIf(hasFfmpeg)("com imagens geradas pelo ffmpeg", () => {
    it("valida thumbnail JPEG 1280x720 válida, persiste e responde 200", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-sample-"));
      try {
        const good = generateImage(
          sampleDir,
          "good.jpg",
          "testsrc2=size=1280x720:rate=1:duration=1",
          ["-q:v", "2"],
        );
        const uploadId = await createUploadId();
        writeThumbFile(uploadId, good, "jpg");

        const response = await postQaThumbnail(uploadId);
        expect(response.status).toBe(200);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as ThumbnailQaReport;
        expect(report.uploadId).toBe(uploadId);
        expect(report.passed).toBe(true);
        expect(report.checkedAt).toEqual(expect.any(String));
        expect(report.dimensions.width).toBe(1280);
        expect(report.dimensions.height).toBe(720);
        expect(report.dimensions.aspectRatio).toBe("16:9");
        expect(report.fileSize.fileSizeBytes).toBeLessThan(2_097_152);
        expect(report.format.detectedFormat).toBe("jpeg");
        expect(report.contrast.luminanceRange).toBeGreaterThanOrEqual(20);
        expect(report.details.format).toBe("jpeg");
        expect(report.failureReasons).toHaveLength(0);

        const getResponse = await rawRequest(
          ctx.baseUrl,
          "GET",
          `${UPLOAD_PATH}/${uploadId}/qa/thumbnail`,
          { authorization: `Bearer ${TEST_TOKEN}` },
        );
        expect(getResponse.status).toBe(200);
        expect(
          JSON.parse(getResponse.body.toString("utf8")).uploadId,
        ).toBe(uploadId);
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });

    it("reprova imagem preta com 422 e motivo de contraste", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-black-"));
      try {
        const black = generateImage(
          sampleDir,
          "black.jpg",
          "color=c=black:size=1280x720:rate=1:duration=1",
          ["-q:v", "2"],
        );
        const uploadId = await createUploadId();
        writeThumbFile(uploadId, black, "jpg");

        const response = await postQaThumbnail(uploadId);
        expect(response.status).toBe(422);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as ThumbnailQaReport;
        expect(report.contrast.passed).toBe(false);
        expect(report.contrast.luminanceRange).toBeLessThan(20);
        expect(report.passed).toBe(false);
        expect(
          report.failureReasons.some((reason) =>
            reason.toLowerCase().includes("lacks basic contrast"),
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });

    it("reprova dimensão incorreta (640x360) com 422", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-small-"));
      try {
        const small = generateImage(
          sampleDir,
          "small.jpg",
          "testsrc2=size=640x360:rate=1:duration=1",
          ["-q:v", "2"],
        );
        const uploadId = await createUploadId();
        writeThumbFile(uploadId, small, "jpg");

        const response = await postQaThumbnail(uploadId);
        expect(response.status).toBe(422);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as ThumbnailQaReport;
        expect(report.dimensions.passed).toBe(false);
        expect(report.dimensions.width).toBe(640);
        expect(report.dimensions.height).toBe(360);
        expect(report.passed).toBe(false);
        expect(report.failureReasons).toContain(
          "Dimension 640x360 does not match required 1280x720",
        );
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });

    it("reprova arquivo PNG acima de 2MB com 422", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-big-"));
      try {
        const big = generateImage(
          sampleDir,
          "big.png",
          "nullsrc=size=1280x720:rate=1:duration=1,geq=random(1)*255:random(2)*255:random(3)*255",
        );
        expect(big.length).toBeGreaterThan(2_097_152);
        const uploadId = await createUploadId();
        writeThumbFile(uploadId, big, "png");

        const response = await postQaThumbnail(uploadId);
        expect(response.status).toBe(422);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as ThumbnailQaReport;
        expect(report.fileSize.passed).toBe(false);
        expect(report.fileSize.fileSizeBytes).toBeGreaterThan(2_097_152);
        expect(report.passed).toBe(false);
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });

    it("valida thumbnail válida resolvida via payload { filePath }", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-fp-"));
      try {
        const good = generateImage(
          sampleDir,
          "custom.jpg",
          "testsrc2=size=1280x720:rate=1:duration=1",
          ["-q:v", "2"],
        );
        fs.writeFileSync(
          path.join(ctx.config.storageDir, "custom-good.jpg"),
          good,
        );
        const uploadId = await createUploadId();

        const response = await postQaThumbnail(uploadId, TEST_TOKEN, {
          filePath: "custom-good.jpg",
        });
        expect(response.status).toBe(200);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as ThumbnailQaReport;
        expect(report.passed).toBe(true);
        expect(report.details.format).toBe("jpeg");
        expect(report.failureReasons).toHaveLength(0);
      } finally {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    });
  });
});
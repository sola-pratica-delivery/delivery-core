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
import type {
  AudioQaReport,
  ConsolidatedQaReport,
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

function generateSampleMp4(directory: string, durationSeconds = 3): Buffer {
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
      `sine=frequency=1000:duration=${durationSeconds}`,
      "-af",
      "volume=+7.1dB",
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

describe("QaStore - persistência de áudio e consolidação", () => {
  it("salva e lê relatório de áudio via saveAudio/readAudio", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-audio-"));
    try {
      const store = new QaStore(dir);
      await store.saveAudio(
        "upload-audio-1",
        sampleAudioReport("upload-audio-1", true),
      );

      const read = await store.readAudio("upload-audio-1");
      expect(read?.passed).toBe(true);
      expect(read?.loudness.integratedLoudness).toBe(-14.2);
      expect(read?.details.sampleRate).toBe(48000);
      expect(await store.readAudio("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge vídeo e áudio no relatório consolidado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-both-"));
    try {
      const store = new QaStore(dir);
      await store.save(
        "upload-both",
        sampleVideoReport("upload-both", true),
      );
      await store.saveAudio(
        "upload-both",
        sampleAudioReport("upload-both", true),
      );

      const consolidated = await store.readConsolidated("upload-both");
      expect(consolidated).not.toBeNull();
      expect(consolidated?.uploadId).toBe("upload-both");
      expect(consolidated?.passed).toBe(true);
      expect(consolidated?.video?.uploadId).toBe("upload-both");
      expect(consolidated?.audio?.uploadId).toBe("upload-both");

      const read = await store.read("upload-both");
      expect(read?.blackScreen.passed).toBe(true);
      const readAudio = await store.readAudio("upload-both");
      expect(readAudio?.details.sampleRate).toBe(48000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva seção existente ao salvar a outra (ordem inversa)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-inverse-"));
    try {
      const store = new QaStore(dir);
      await store.saveAudio(
        "upload-inverse",
        sampleAudioReport("upload-inverse", true),
      );
      await store.save(
        "upload-inverse",
        sampleVideoReport("upload-inverse", true),
      );

      const consolidated = await store.readConsolidated("upload-inverse");
      expect(consolidated?.video?.passed).toBe(true);
      expect(consolidated?.audio?.passed).toBe(true);
      expect(consolidated?.passed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readConsolidated retorna null para upload inexistente", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-missing-"));
    try {
      const store = new QaStore(dir);
      expect(await store.readConsolidated("missing")).toBeNull();
      expect(await store.read("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read mantém compatibilidade retornando a seção de vídeo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-store-compat-"));
    try {
      const store = new QaStore(dir);
      await store.save(
        "upload-compat",
        sampleVideoReport("upload-compat", true),
      );

      const read = await store.read("upload-compat");
      expect(read?.passed).toBe(true);
      expect(read?.blackScreen.passed).toBe(true);
      expect(read?.details.totalDuration).toBe(10);

      const reportPath = path.join(dir, "upload-compat.qa.json");
      const persisted = JSON.parse(
        fs.readFileSync(reportPath, "utf8"),
      ) as ConsolidatedQaReport;
      expect(persisted.uploadId).toBe("upload-compat");
      expect(persisted.video?.uploadId).toBe("upload-compat");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Endpoint GET /uploads/:id/qa/audio", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function getQaAudio(
    uploadId: string,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/qa/audio`,
      { authorization: `Bearer ${token}` },
    );
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa/audio`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/qa/audio`,
      { authorization: "Bearer invalid-token" },
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para relatório inexistente", async () => {
    const response = await getQaAudio("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("retorna 200 com o relatório de áudio aprovado", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveAudio(
      "audio-passed",
      sampleAudioReport("audio-passed", true),
    );

    const response = await getQaAudio("audio-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(response.body.toString("utf8")) as AudioQaReport;
    expect(report.uploadId).toBe("audio-passed");
    expect(report.passed).toBe(true);
    expect(report.loudness.passed).toBe(true);
    expect(report.truePeak.passed).toBe(true);
    expect(report.voicePresence.passed).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
  });

  it("retorna 422 com failureReasons quando o relatório reprova", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveAudio(
      "audio-failed",
      sampleAudioReport("audio-failed", false),
    );

    const response = await getQaAudio("audio-failed");
    expect(response.status).toBe(422);
    const report = JSON.parse(response.body.toString("utf8")) as AudioQaReport;
    expect(report.passed).toBe(false);
    expect(report.loudness.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);
  });
});

describe("Endpoint GET /uploads/:id/qa (relatório consolidado)", () => {
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

  it("retorna relatório consolidado quando há vídeo e áudio", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save(
      "both-passed",
      sampleVideoReport("both-passed", true),
    );
    await store.saveAudio(
      "both-passed",
      sampleAudioReport("both-passed", true),
    );

    const response = await getQa("both-passed");
    expect(response.status).toBe(200);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ConsolidatedQaReport;
    expect(report.uploadId).toBe("both-passed");
    expect(report.passed).toBe(true);
    expect(report.video?.passed).toBe(true);
    expect(report.video?.blackScreen.passed).toBe(true);
    expect(report.audio?.passed).toBe(true);
    expect(report.audio?.loudness.passed).toBe(true);
  });

  it("reprova consolidado com 422 quando a seção de áudio falha", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save(
      "audio-bad-video-ok",
      sampleVideoReport("audio-bad-video-ok", true),
    );
    await store.saveAudio(
      "audio-bad-video-ok",
      sampleAudioReport("audio-bad-video-ok", false),
    );

    const response = await getQa("audio-bad-video-ok");
    expect(response.status).toBe(422);
    const report = JSON.parse(
      response.body.toString("utf8"),
    ) as ConsolidatedQaReport;
    expect(report.video?.passed).toBe(true);
    expect(report.audio?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("retorna seção de vídeo quando só vídeo existe (back-compat)", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.save("video-only", sampleVideoReport("video-only", true));

    const response = await getQa("video-only");
    expect(response.status).toBe(200);
    const report = JSON.parse(response.body.toString("utf8")) as VideoQaReport;
    expect(report.passed).toBe(true);
    expect(report.blackScreen.passed).toBe(true);
  });

  it("retorna seção de áudio quando só áudio existe", async () => {
    const store = new QaStore(ctx.config.storageDir);
    await store.saveAudio(
      "audio-only",
      sampleAudioReport("audio-only", true),
    );

    const response = await getQa("audio-only");
    expect(response.status).toBe(200);
    const report = JSON.parse(response.body.toString("utf8")) as AudioQaReport;
    expect(report.passed).toBe(true);
    expect(report.loudness.passed).toBe(true);
  });

  it("retorna 404 para relatório inexistente", async () => {
    const response = await getQa("does-not-exist");
    expect(response.status).toBe(404);
  });
});

describe("Endpoint POST /uploads/:id/qa/audio", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function postQaAudio(
    uploadId: string,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/${uploadId}/qa/audio`,
      { authorization: `Bearer ${token}` },
    );
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/any-id/qa/audio`,
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await postQaAudio("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("reprova arquivo não-mídia com 422 e persiste o relatório", async () => {
    const payload = Buffer.from(
      "this is definitely not an audio or video container",
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

    const response = await postQaAudio(uploadId);
    expect(response.status).toBe(422);
    const report = JSON.parse(response.body.toString("utf8")) as AudioQaReport;
    expect(report.uploadId).toBe(uploadId);
    expect(report.passed).toBe(false);
    expect(report.failureReasons.length).toBeGreaterThan(0);

    const reportPath = path.join(ctx.config.storageDir, `${uploadId}.qa.json`);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  describe.runIf(hasFfmpeg)("com um arquivo de vídeo válido", () => {
    it("executa a verificação de áudio, aprova, persiste e responde com 200", async () => {
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-sample-"));
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

        const response = await postQaAudio(uploadId);
        expect(response.status).toBe(200);
        const report = JSON.parse(
          response.body.toString("utf8"),
        ) as AudioQaReport;
        expect(report.uploadId).toBe(uploadId);
        expect(report.passed).toBe(true);
        expect(report.checkedAt).toEqual(expect.any(String));
        expect(report.loudness.passed).toBe(true);
        expect(
          report.loudness.integratedLoudness,
        ).toBeGreaterThanOrEqual(-14.5);
        expect(
          report.loudness.integratedLoudness,
        ).toBeLessThanOrEqual(-13.5);
        expect(report.truePeak.passed).toBe(true);
        expect(report.truePeak.truePeak).toBeLessThan(-1.0);
        expect(report.voicePresence.passed).toBe(true);
        expect(report.details.duration).toBeGreaterThan(0);
        expect(report.failureReasons).toHaveLength(0);

        const getResponse = await rawRequest(
          ctx.baseUrl,
          "GET",
          `${UPLOAD_PATH}/${uploadId}/qa/audio`,
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
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runFfmpeg, FfmpegError } from "../src/qa/ffmpeg-runner.js";
import { runFfprobe, FfprobeError } from "../src/probe/ffprobe.js";
import {
  verifyThumbnail,
  detectImageMagicBytes,
  parseSignalStatsOutput,
  DEFAULT_THUMBNAIL_QA_OPTIONS,
} from "../src/qa/thumbnail-verifier.js";
import type { RawFfprobeOutput } from "../src/probe/types.js";

vi.mock("../src/qa/ffmpeg-runner.js", () => {
  class MockFfmpegError extends Error {
    kind: "timeout" | "not-found" | "execution";
    stderr: string;
    constructor(
      kind: "timeout" | "not-found" | "execution",
      message: string,
      stderr = "",
    ) {
      super(message);
      this.name = "FfmpegError";
      this.kind = kind;
      this.stderr = stderr;
    }
  }
  return {
    FfmpegError: MockFfmpegError,
    DEFAULT_FFMPEG_TIMEOUT_MS: 15_000,
    runFfmpeg: vi.fn(),
  };
});

vi.mock("../src/probe/ffprobe.js", () => {
  class MockFfprobeError extends Error {
    kind: "timeout" | "not-found" | "execution";
    stderr: string;
    constructor(
      kind: "timeout" | "not-found" | "execution",
      message: string,
      stderr = "",
    ) {
      super(message);
      this.name = "FfprobeError";
      this.kind = kind;
      this.stderr = stderr;
    }
  }
  return {
    FfprobeError: MockFfprobeError,
    runFfprobe: vi.fn(),
  };
});

const runFfmpegMock = vi.mocked(runFfmpeg);
const runFfprobeMock = vi.mocked(runFfprobe);

let qaDir: string;

beforeEach(() => {
  qaDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-qa-"));
  runFfmpegMock.mockReset();
  runFfprobeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(qaDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.from("RIFF0000WEBP", "latin1");
const GIF = Buffer.from("GIF89a", "latin1");
const BMP = Buffer.from("BMxxxx", "latin1");

function tmpImage(name: string, bytes: Buffer): string {
  const filePath = path.join(qaDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function validJpegFile(): string {
  return tmpImage(
    `thumb-${randomUUID()}.jpg`,
    Buffer.concat([JPEG_MAGIC, Buffer.from("fake-jpeg-body")]),
  );
}

function validPngFile(): string {
  return tmpImage(
    `thumb-${randomUUID()}.png`,
    Buffer.concat([PNG_MAGIC, Buffer.from("fake-png-body")]),
  );
}

function installProbe(
  overrides: {
    width?: number;
    height?: number;
    codecName?: string;
    streams?: Array<Record<string, unknown>>;
  } = {},
): void {
  const {
    width = 1280,
    height = 720,
    codecName = "mjpeg",
    streams,
  } = overrides;
  runFfprobeMock.mockResolvedValue({
    streams:
      streams ??
      [{ index: 0, codec_name: codecName, codec_type: "video", width, height }],
    format: {},
  } as unknown as RawFfprobeOutput);
}

function installSignalStats(output: string): void {
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    if (args.some((arg) => arg.includes("signalstats"))) {
      return { stdout: output, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

function filterArgs(prefix: string): string[] | null {
  for (const call of runFfmpegMock.mock.calls) {
    const args = call[0];
    if (args.some((arg) => arg.includes(prefix))) {
      return args;
    }
  }
  return null;
}

const STATS_GOOD = [
  "frame:0    pts:0       pts_time:0",
  "lavfi.signalstats.YMIN=16",
  "lavfi.signalstats.YMAX=235",
  "lavfi.signalstats.YAVG=128.051",
].join("\n");

const STATS_BLACK = [
  "frame:0    pts:0       pts_time:0",
  "lavfi.signalstats.YMIN=16",
  "lavfi.signalstats.YMAX=16",
  "lavfi.signalstats.YAVG=16",
].join("\n");

const STATS_WHITE = [
  "frame:0    pts:0       pts_time:0",
  "lavfi.signalstats.YMIN=235",
  "lavfi.signalstats.YMAX=235",
  "lavfi.signalstats.YAVG=235",
].join("\n");

describe("detectImageMagicBytes", () => {
  it("detecta JPEG pelos bytes FF D8 FF", () => {
    const buffer = Buffer.concat([JPEG_MAGIC, Buffer.alloc(8)]);
    expect(detectImageMagicBytes(buffer)).toBe("jpeg");
  });

  it("detecta PNG pelos bytes 89 50 4E 47 0D 0A 1A 0A", () => {
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.alloc(8)]);
    expect(detectImageMagicBytes(buffer)).toBe("png");
  });

  it("detecta PNG mesmo com conteúdo extra após o magic", () => {
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("IHDRrest")]);
    expect(detectImageMagicBytes(buffer)).toBe("png");
  });

  it("retorna null para WebP (RIFF....WEBP)", () => {
    expect(detectImageMagicBytes(WEBP)).toBeNull();
  });

  it("retorna null para GIF", () => {
    expect(detectImageMagicBytes(GIF)).toBeNull();
  });

  it("retorna null para BMP", () => {
    expect(detectImageMagicBytes(BMP)).toBeNull();
  });

  it("retorna null para texto comum", () => {
    expect(detectImageMagicBytes(Buffer.from("hello world", "utf8"))).toBeNull();
  });

  it("retorna null para buffer vazio", () => {
    expect(detectImageMagicBytes(Buffer.alloc(0))).toBeNull();
  });

  it("retorna null para JPEG truncado com apenas FF D8", () => {
    expect(detectImageMagicBytes(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe("parseSignalStatsOutput", () => {
  it("parseia YMIN, YMAX e YAVG da saída típica", () => {
    expect(parseSignalStatsOutput(STATS_GOOD)).toEqual({
      yMin: 16,
      yMax: 235,
      yAvg: 128.051,
    });
  });

  it("parseia imagem preta (YMIN=16, YMAX=16)", () => {
    expect(parseSignalStatsOutput(STATS_BLACK)).toEqual({
      yMin: 16,
      yMax: 16,
      yAvg: 16,
    });
  });

  it("parseia imagem branca (YMIN=235, YMAX=235)", () => {
    expect(parseSignalStatsOutput(STATS_WHITE)).toEqual({
      yMin: 235,
      yMax: 235,
      yAvg: 235,
    });
  });

  it("aceita linhas com prefixo de log do stderr", () => {
    const output = [
      "[Parsed_metadata_0 @ 0x2b1] frame:0    pts:0       pts_time:0",
      "[Parsed_metadata_0 @ 0x2b1] lavfi.signalstats.YMIN=10",
      "[Parsed_metadata_0 @ 0x2b1] lavfi.signalstats.YMAX=233",
      "[Parsed_metadata_0 @ 0x2b1] lavfi.signalstats.YAVG=125.4",
    ].join("\n");
    expect(parseSignalStatsOutput(output)).toEqual({
      yMin: 10,
      yMax: 233,
      yAvg: 125.4,
    });
  });

  it("usa a última ocorrência quando o valor se repete", () => {
    const output = [
      "lavfi.signalstats.YMIN=100",
      "frame:0",
      "lavfi.signalstats.YMIN=16",
      "lavfi.signalstats.YMAX=235",
      "lavfi.signalstats.YAVG=120",
    ].join("\n");
    expect(parseSignalStatsOutput(output)).toEqual({
      yMin: 16,
      yMax: 235,
      yAvg: 120,
    });
  });

  it("retorna 0 para chaves ausentes", () => {
    expect(parseSignalStatsOutput("frame=0 q=1.0 size=N/A")).toEqual({
      yMin: 0,
      yMax: 0,
      yAvg: 0,
    });
  });
});

describe("verifyThumbnail", () => {
  async function cleanReport(customOptions = {}) {
    installSignalStats(STATS_GOOD);
    installProbe();
    return verifyThumbnail(validJpegFile(), customOptions);
  }

  it("CA-1: aprova thumbnail JPEG válido 1280x720 com todos os checks passed", async () => {
    const filePath = validJpegFile();
    const size = fs.statSync(filePath).size;
    const report = await cleanReport();

    expect(report.passed).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(report.dimensions).toMatchObject({
      passed: true,
      width: 1280,
      height: 720,
      expectedWidth: DEFAULT_THUMBNAIL_QA_OPTIONS.expectedWidth,
      expectedHeight: DEFAULT_THUMBNAIL_QA_OPTIONS.expectedHeight,
      aspectRatio: "16:9",
    });
    expect(report.fileSize).toMatchObject({
      passed: true,
      fileSizeBytes: size,
      maxAllowedBytes: DEFAULT_THUMBNAIL_QA_OPTIONS.maxFileSizeBytes,
    });
    expect(report.format).toMatchObject({
      passed: true,
      detectedFormat: "jpeg",
      mimeType: "image/jpeg",
    });
    expect(report.contrast).toMatchObject({
      passed: true,
      yMin: 16,
      yMax: 235,
      yAvg: 128.051,
      luminanceRange: 219,
      minAllowedRange: DEFAULT_THUMBNAIL_QA_OPTIONS.minContrastRange,
    });
    expect(report.details).toEqual({
      width: 1280,
      height: 720,
      fileSizeBytes: size,
      format: "jpeg",
    });
    expect(report.failureReasons).toHaveLength(0);

    const args = filterArgs("signalstats");
    expect(args?.join(" ")).toContain("signalstats,metadata=print:file=-");
  });

  it("CA-1: aprova thumbnail PNG válido 1280x720", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ codecName: "png" });

    const report = await verifyThumbnail(validPngFile());

    expect(report.passed).toBe(true);
    expect(report.format).toMatchObject({
      passed: true,
      detectedFormat: "png",
      mimeType: "image/png",
    });
    expect(report.details.format).toBe("png");
  });

  it("CA-2: reprova dimensão 640x360 com mensagem explícita", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ width: 640, height: 360 });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.dimensions.passed).toBe(false);
    expect(report.dimensions.aspectRatio).toBe("16:9");
    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      "Dimension 640x360 does not match required 1280x720",
    );
  });

  it("CA-2: reprova dimensão 1280x721 (próxima mas incorreta)", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ width: 1280, height: 721 });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.dimensions.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      "Dimension 1280x721 does not match required 1280x720",
    );
  });

  it("CA-2: reprova dimensão 1920x1080", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ width: 1920, height: 1080 });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.dimensions.passed).toBe(false);
    expect(report.dimensions.aspectRatio).toBe("16:9");
    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      "Dimension 1920x1080 does not match required 1280x720",
    );
  });

  it("CA-2: reprova arquivo de 2_097_153 bytes acima do limite de 2MB", async () => {
    const big = Buffer.alloc(2_097_153);
    JPEG_MAGIC.copy(big, 0, 0, 3);
    installSignalStats(STATS_GOOD);
    installProbe();

    const report = await verifyThumbnail(tmpImage("big-thumb.jpg", big));

    expect(report.fileSize.passed).toBe(false);
    expect(report.fileSize.fileSizeBytes).toBe(2_097_153);
    expect(report.fileSize.maxAllowedBytes).toBe(2_097_152);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("2097153")),
    ).toBe(true);
  });

  it("CA-2: reprova arquivo exatamente no limite de 2_097_152 bytes (critério estrito)", async () => {
    const exact = Buffer.alloc(2_097_152);
    JPEG_MAGIC.copy(exact, 0, 0, 3);
    installSignalStats(STATS_GOOD);
    installProbe();

    const report = await verifyThumbnail(tmpImage("exact-thumb.jpg", exact));

    expect(report.fileSize.passed).toBe(false);
    expect(report.fileSize.fileSizeBytes).toBe(2_097_152);
    expect(report.passed).toBe(false);
  });

  it("CA-2: aprova arquivo de 2_097_151 bytes logo abaixo do limite", async () => {
    const below = Buffer.alloc(2_097_151);
    JPEG_MAGIC.copy(below, 0, 0, 3);
    installSignalStats(STATS_GOOD);
    installProbe();

    const report = await verifyThumbnail(tmpImage("below-thumb.jpg", below));

    expect(report.fileSize.passed).toBe(true);
    expect(report.fileSize.fileSizeBytes).toBe(2_097_151);
    expect(report.passed).toBe(true);
  });

  it("CA-3: reprova arquivo com magic bytes inválidos sem decodificar", async () => {
    const filePath = tmpImage(
      "not-image.jpg",
      Buffer.from("this is definitely not an image", "utf8"),
    );

    const report = await verifyThumbnail(filePath);

    expect(report.format.passed).toBe(false);
    expect(report.format.detectedFormat).toBeNull();
    expect(report.dimensions.passed).toBe(false);
    expect(report.contrast.passed).toBe(false);
    expect(report.details).toEqual({
      width: 0,
      height: 0,
      fileSizeBytes: Buffer.byteLength("this is definitely not an image"),
      format: null,
    });
    expect(report.fileSize.passed).toBe(true);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("magic bytes")),
    ).toBe(true);
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("CA-3: reprova WebP renomeado como .jpg pelos magic bytes", async () => {
    const report = await verifyThumbnail(
      tmpImage("fake.jpg", WEBP),
    );

    expect(report.format.passed).toBe(false);
    expect(report.format.detectedFormat).toBeNull();
    expect(report.passed).toBe(false);
    expect(runFfprobeMock).not.toHaveBeenCalled();
  });

  it("CA-3: reprova divergência entre magic bytes e codec detectado", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ codecName: "webp" });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.format.passed).toBe(false);
    expect(report.format.detectedFormat).toBe("jpeg");
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("webp")),
    ).toBe(true);
  });

  it("CA-3: aprova ffprobe reportando mjpeg para arquivo JPEG", async () => {
    installSignalStats(STATS_GOOD);
    installProbe({ codecName: "mjpeg" });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.format.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("CA-4: reprova imagem preta (YMIN=16, YMAX=16)", async () => {
    installSignalStats(STATS_BLACK);
    installProbe();

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.passed).toBe(false);
    expect(report.contrast.luminanceRange).toBe(0);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("lacks basic contrast"),
      ),
    ).toBe(true);
  });

  it("CA-4: reprova imagem branca (YMIN=235, YMAX=235)", async () => {
    installSignalStats(STATS_WHITE);
    installProbe();

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.passed).toBe(false);
    expect(report.contrast.luminanceRange).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("CA-4: aprova contraste no limiar exato (luminanceRange 20)", async () => {
    installSignalStats(
      [
        "frame:0",
        "lavfi.signalstats.YMIN=235",
        "lavfi.signalstats.YMAX=255",
        "lavfi.signalstats.YAVG=240",
      ].join("\n"),
    );
    installProbe();

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.luminanceRange).toBe(20);
    expect(report.contrast.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("CA-4: reprova contraste sutil (luminanceRange 19)", async () => {
    installSignalStats(
      [
        "frame:0",
        "lavfi.signalstats.YMIN=135",
        "lavfi.signalstats.YMAX=154",
        "lavfi.signalstats.YAVG=144",
      ].join("\n"),
    );
    installProbe();

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.luminanceRange).toBe(19);
    expect(report.contrast.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.includes("luminance range 19"),
      ),
    ).toBe(true);
  });

  it("CA-5: arquivo inexistente reprova sem invocar ferramentas", async () => {
    const report = await verifyThumbnail(
      path.join(qaDir, "does-not-exist.jpg"),
    );

    expect(report.passed).toBe(false);
    expect(report.fileSize.fileSizeBytes).toBe(0);
    expect(report.details).toEqual({
      width: 0,
      height: 0,
      fileSizeBytes: 0,
      format: null,
    });
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("not found or unreadable"),
      ),
    ).toBe(true);
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("edge 6: falha do ffprobe em arquivo corrompido reprova com motivo de decodificação", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError(
        "execution",
        "could not find codec parameters",
        "Invalid data found when processing input",
      ),
    );

    const report = await verifyThumbnail(validJpegFile());

    expect(report.passed).toBe(false);
    expect(report.details.format).toBe("jpeg");
    expect(
      report.failureReasons.some((reason) => reason.includes("Probing failed")),
    ).toBe(true);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("edge 6: ausência de stream de imagem no probe reprova", async () => {
    installProbe({ streams: [] });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.includes("No image/video stream"),
      ),
    ).toBe(true);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("edge 6: falha do ffmpeg no signalstats reprova contraste sem lançar", async () => {
    installProbe();
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args.some((arg) => arg.includes("signalstats"))) {
        throw new FfmpegError(
          "execution",
          "signalstats filter failed",
          "signalstats filter failed",
        );
      }
      return { stdout: "", stderr: "" };
    });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.includes("signalstats filter failed"),
      ),
    ).toBe(true);
  });

  it("edge 6: timeout do ffmpeg no signalstats reprova com motivo de timeout", async () => {
    installProbe();
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args.some((arg) => arg.includes("signalstats"))) {
        throw new FfmpegError("timeout", "ffmpeg timed out after 15000ms");
      }
      return { stdout: "", stderr: "" };
    });

    const report = await verifyThumbnail(validJpegFile());

    expect(report.contrast.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("timed out"),
      ),
    ).toBe(true);
  });

  it("edge: respeita opções customizadas de dimensão, tamanho e contraste", async () => {
    installSignalStats(
      [
        "frame:0",
        "lavfi.signalstats.YMIN=20",
        "lavfi.signalstats.YMAX=44",
        "lavfi.signalstats.YAVG=32",
      ].join("\n"),
    );
    installProbe({ width: 1920, height: 1080 });

    const filePath = tmpImage(
      "custom-thumb.jpg",
      Buffer.concat([JPEG_MAGIC, Buffer.alloc(32)]),
    );

    const report = await verifyThumbnail(filePath, {
      expectedWidth: 1920,
      expectedHeight: 1080,
      maxFileSizeBytes: 64,
      minContrastRange: 25,
    });

    expect(report.dimensions).toMatchObject({
      passed: true,
      expectedWidth: 1920,
      expectedHeight: 1080,
      width: 1920,
      height: 1080,
    });
    expect(report.fileSize.maxAllowedBytes).toBe(64);
    expect(report.fileSize.passed).toBe(true);
    expect(report.contrast.minAllowedRange).toBe(25);
    expect(report.contrast.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("exporta defaults consistentes com a spec", () => {
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.expectedWidth).toBe(1280);
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.expectedHeight).toBe(720);
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.maxFileSizeBytes).toBe(2_097_152);
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.minContrastRange).toBe(20);
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.allowedFormats).toEqual([
      "jpeg",
      "png",
    ]);
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.ffmpegPath).toBe("ffmpeg");
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.ffprobePath).toBe("ffprobe");
    expect(DEFAULT_THUMBNAIL_QA_OPTIONS.timeoutMs).toBe(15_000);
  });
});
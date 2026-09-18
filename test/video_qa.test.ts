import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runFfmpeg, FfmpegError } from "../src/qa/ffmpeg-runner.js";
import { runFfprobe, FfprobeError } from "../src/probe/ffprobe.js";
import {
  verifyVideoQuality,
  parseBlackDetectLog,
  parseFreezeDetectLog,
  DEFAULT_QA_OPTIONS,
} from "../src/qa/video-verifier.js";
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
    DEFAULT_FFMPEG_TIMEOUT_MS: 30_000,
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
  qaDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-qa-"));
  runFfmpegMock.mockReset();
  runFfprobeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(qaDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmpVideo(name = `sample-${randomUUID()}.mp4`): string {
  return path.join(qaDir, name);
}

function installFfmpegLogs(logs: { black?: string; freeze?: string }): void {
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    const filter = args.find(
      (arg) =>
        arg.startsWith("blackdetect=") || arg.startsWith("freezedetect="),
    );
    if (filter !== undefined && filter.startsWith("blackdetect=")) {
      return { stdout: "", stderr: logs.black ?? "" };
    }
    if (filter !== undefined && filter.startsWith("freezedetect=")) {
      return { stdout: "", stderr: logs.freeze ?? "" };
    }
    return { stdout: "", stderr: "" };
  });
}

function installProbe(
  overrides: {
    hasAudio?: boolean;
    videoDuration?: string;
    audioDuration?: string;
    videoCodec?: string;
    audioCodec?: string;
  } = {},
): void {
  const {
    hasAudio = true,
    videoDuration = "10",
    audioDuration = "10",
    videoCodec = "h264",
    audioCodec = "aac",
  } = overrides;
  const streams: Array<Record<string, unknown>> = [
    {
      index: 0,
      codec_name: videoCodec,
      codec_type: "video",
      duration: videoDuration,
    },
  ];
  if (hasAudio) {
    streams.push({
      index: 1,
      codec_name: audioCodec,
      codec_type: "audio",
      ...(audioDuration !== undefined ? { duration: audioDuration } : {}),
    });
  }
  runFfprobeMock.mockResolvedValue({
    streams,
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: videoDuration },
  } as unknown as RawFfprobeOutput);
}

function filterArgs(prefix: string): string[] | null {
  for (const call of runFfmpegMock.mock.calls) {
    const args = call[0];
    if (args.some((arg) => arg.startsWith(prefix))) {
      return args;
    }
  }
  return null;
}

describe("parseBlackDetectLog", () => {
  it("retorna [] quando não há telas pretas detectadas", () => {
    const stderr = [
      "ffmpeg version 6.0",
      "[Parsed_blackdetect_0 @ 0x0] frame= 100 fps= 30 q=-1.0 size=N/A",
    ].join("\n");
    expect(parseBlackDetectLog(stderr)).toEqual([]);
  });

  it("parseia um intervalo único de tela preta", () => {
    const stderr =
      "[Parsed_blackdetect_0 @ 0x1] black_start:1.5 black_end:3.0 black_duration:1.5";
    expect(parseBlackDetectLog(stderr)).toEqual([
      { start: 1.5, end: 3, duration: 1.5 },
    ]);
  });

  it("acumula múltiplos intervalos consecutivos", () => {
    const stderr = [
      "[Parsed_blackdetect_0 @ 0x1] black_start:1.5 black_end:3.0 black_duration:1.5",
      "[Parsed_blackdetect_0 @ 0x1] black_start:8.0 black_end:9.5 black_duration:1.5",
    ].join("\n");
    const intervals = parseBlackDetectLog(stderr);
    expect(intervals).toHaveLength(2);
    expect(intervals[1]).toEqual({ start: 8, end: 9.5, duration: 1.5 });
  });

  it("detecta tela preta iniciando em t=0 (edge 1)", () => {
    const stderr =
      "[Parsed_blackdetect_0 @ 0x1] black_start:0 black_end:0.5 black_duration:0.5";
    expect(parseBlackDetectLog(stderr)).toEqual([
      { start: 0, end: 0.5, duration: 0.5 },
    ]);
  });

  it("detecta tela preta terminando na duração total sem duração negativa (edge 1)", () => {
    const stderr =
      "[Parsed_blackdetect_0 @ 0x1] black_start:9.5 black_end:10 black_duration:0.5";
    expect(parseBlackDetectLog(stderr)).toEqual([
      { start: 9.5, end: 10, duration: 0.5 },
    ]);
  });
});

describe("parseFreezeDetectLog", () => {
  it("retorna [] quando não há freezes detectados", () => {
    const stderr = [
      "ffmpeg version 6.0",
      "[Parsed_freezedetect_0 @ 0x0] frame= 100 fps= 30 q=-1.0 size=N/A",
    ].join("\n");
    expect(parseFreezeDetectLog(stderr, 10)).toEqual([]);
  });

  it("parseia freeze temporário no formato antigo", () => {
    const stderr = [
      "[Parsed_freezedetect_0 @ 0x1] freeze_start: 2.0",
      "[Parsed_freezedetect_0 @ 0x1] freeze_end: 4.0 | freeze_duration: 2.0",
    ].join("\n");
    expect(parseFreezeDetectLog(stderr, 10)).toEqual([
      { start: 2, end: 4, duration: 2 },
    ]);
  });

  it("parseia freeze temporário no formato novo (lavfi.freezedetect.*)", () => {
    const stderr = [
      "[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 2",
      "[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 2",
      "[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 4",
    ].join("\n");
    expect(parseFreezeDetectLog(stderr, 10)).toEqual([
      { start: 2, end: 4, duration: 2 },
    ]);
  });

  it("fecha freeze em aberto até o EOF usando a duração total (edge 2)", () => {
    const stderr = "[Parsed_freezedetect_0 @ 0x1] freeze_start: 7.0";
    expect(parseFreezeDetectLog(stderr, 10)).toEqual([
      { start: 7, end: 10, duration: 3 },
    ]);
  });

  it("não cria intervalo quando totalDuration não ultrapassa o start", () => {
    const stderr = "[Parsed_freezedetect_0 @ 0x1] freeze_start: 8.0";
    expect(parseFreezeDetectLog(stderr, 8)).toEqual([]);
  });

  it("mistura freezes fechados com freeze aberto no fim (edge 3)", () => {
    const stderr = [
      "[Parsed_freezedetect_0 @ 0x1] freeze_start: 1.0",
      "[Parsed_freezedetect_0 @ 0x1] freeze_end: 2.0 | freeze_duration: 1.0",
      "[Parsed_freezedetect_0 @ 0x1] freeze_start: 5.0",
    ].join("\n");
    const intervals = parseFreezeDetectLog(stderr, 10);
    expect(intervals).toEqual([
      { start: 1, end: 2, duration: 1 },
      { start: 5, end: 10, duration: 5 },
    ]);
  });
});

describe("verifyVideoQuality", () => {
  async function cleanReport(
    overrides: {
      hasAudio?: boolean;
      videoDuration?: string;
      audioDuration?: string;
    } = {},
  ) {
    installFfmpegLogs({});
    installProbe(overrides);
    return verifyVideoQuality(tmpVideo());
  }

  it("aprova vídeo sem defeitos com todos os checks passed", async () => {
    const report = await cleanReport();

    expect(report.passed).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(report.blackScreen).toMatchObject({
      passed: true,
      maxAllowedDuration: DEFAULT_QA_OPTIONS.blackDetectMinDuration,
      detectedIntervals: [],
    });
    expect(report.freezeFrame).toMatchObject({
      passed: true,
      maxAllowedDuration: DEFAULT_QA_OPTIONS.freezeDetectMinDuration,
      detectedIntervals: [],
    });
    expect(report.avSync).toMatchObject({
      passed: true,
      videoDuration: 10,
      audioDuration: 10,
      diffSeconds: 0,
      maxAllowedDiffSeconds: DEFAULT_QA_OPTIONS.maxAvDiffSeconds,
    });
    expect(report.details).toMatchObject({
      totalDuration: 10,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    expect(report.failureReasons).toHaveLength(0);
  });

  it("CA-1: reprova tela preta com duração superior a 1s", async () => {
    installFfmpegLogs({
      black:
        "[Parsed_blackdetect_0 @ 0x1] black_start:2.0 black_end:5.0 black_duration:3.0",
    });
    installProbe();

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.blackScreen.passed).toBe(false);
    expect(report.blackScreen.detectedIntervals[0]?.duration).toBe(3);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.toLowerCase().includes("black")),
    ).toBe(true);
  });

  it("aprova tela preta dentro do limiar customizado", async () => {
    installFfmpegLogs({
      black:
        "[Parsed_blackdetect_0 @ 0x1] black_start:2.0 black_end:4.0 black_duration:2.0",
    });
    installProbe();

    const report = await verifyVideoQuality(tmpVideo(), {
      blackDetectMinDuration: 3.0,
    });

    expect(report.blackScreen.passed).toBe(true);
    expect(report.blackScreen.maxAllowedDuration).toBe(3.0);
    expect(report.passed).toBe(true);
    const args = filterArgs("blackdetect=");
    expect(args?.join(" ")).toContain("blackdetect=d=3");
  });

  it("CA-2: reprova congelamento de frames superior a 2s", async () => {
    installFfmpegLogs({
      freeze: [
        "[Parsed_freezedetect_0 @ 0x1] freeze_start: 2.0",
        "[Parsed_freezedetect_0 @ 0x1] freeze_end: 6.0 | freeze_duration: 4.0",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.freezeFrame.passed).toBe(false);
    expect(report.freezeFrame.detectedIntervals[0]?.duration).toBe(4);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.toLowerCase().includes("freeze")),
    ).toBe(true);
  });

  it("edge 2: reprova freeze aberto até o EOF usando a duração do probe", async () => {
    installFfmpegLogs({
      freeze: "[Parsed_freezedetect_0 @ 0x1] freeze_start: 7.0",
    });
    installProbe({ videoDuration: "10", audioDuration: "10" });

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.freezeFrame.detectedIntervals).toEqual([
      { start: 7, end: 10, duration: 3 },
    ]);
    expect(report.passed).toBe(false);
  });

  it("edge 4: reprova vídeo sem fluxo de áudio quando requireAudio", async () => {
    installFfmpegLogs({});
    installProbe({ hasAudio: false });

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.avSync.passed).toBe(false);
    expect(report.avSync.audioDuration).toBeNull();
    expect(report.avSync.diffSeconds).toBeNull();
    expect(report.failureReasons).toContain("Missing audio stream");
    expect(report.passed).toBe(false);
  });

  it("edge 4: ignora a checagem de áudio quando requireAudio=false", async () => {
    installFfmpegLogs({});
    installProbe({ hasAudio: false });

    const report = await verifyVideoQuality(tmpVideo(), {
      requireAudio: false,
    });

    expect(report.avSync.passed).toBe(true);
    expect(report.avSync.audioDuration).toBeNull();
    expect(report.passed).toBe(true);
    expect(report.failureReasons).toHaveLength(0);
  });

  it("CA-3: reprova divergência A/V acima da tolerância", async () => {
    installFfmpegLogs({});
    installProbe({ videoDuration: "10", audioDuration: "13" });

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.avSync.passed).toBe(false);
    expect(report.avSync.diffSeconds).toBeCloseTo(3, 3);
    expect(report.avSync.maxAllowedDiffSeconds).toBe(1.0);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("AV sync")),
    ).toBe(true);
  });

  it("edge 5: tolera divergência milimétrica padrão de muxing", async () => {
    installFfmpegLogs({});
    installProbe({ videoDuration: "10", audioDuration: "10.4" });

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.avSync.passed).toBe(true);
    expect(report.avSync.diffSeconds).toBeCloseTo(0.4, 3);
    expect(report.passed).toBe(true);
  });

  it("respeita maxAvDiffSeconds customizado", async () => {
    installFfmpegLogs({});
    installProbe({ videoDuration: "10", audioDuration: "10.8" });

    const report = await verifyVideoQuality(tmpVideo(), {
      maxAvDiffSeconds: 1.0,
    });

    expect(report.avSync.passed).toBe(true);
    expect(report.avSync.maxAllowedDiffSeconds).toBe(1.0);
  });

  it("edge 6: erro fatal do ffmpeg reprova com motivo claro e sem lançar", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      const filter = args.find((arg) => arg.startsWith("blackdetect="));
      if (filter !== undefined) {
        throw new FfmpegError("execution", "blackdetect failed", "blackdetect failed");
      }
      return { stdout: "", stderr: "" };
    });
    installProbe();

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.blackScreen.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("blackdetect failed")),
    ).toBe(true);
  });

  it("edge 7: timeout do ffmpeg reprova com motivo de timeout", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      const filter = args.find((arg) => arg.startsWith("freezedetect="));
      if (filter !== undefined) {
        throw new FfmpegError("timeout", "ffmpeg timed out after 30000ms");
      }
      return { stdout: "", stderr: "" };
    });
    installProbe();

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.freezeFrame.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("timed out"),
      ),
    ).toBe(true);
  });

  it("edge 6: falha do ffprobe reprova sem invocar ffmpeg", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError("not-found", "ffprobe binary not found"),
    );

    const report = await verifyVideoQuality(tmpVideo());

    expect(report.passed).toBe(false);
    expect(report.avSync.passed).toBe(false);
    expect(runFfmpegMock).not.toHaveBeenCalled();
    expect(
      report.failureReasons.some((reason) => reason.includes("ffprobe")),
    ).toBe(true);
  });

  it("exporta defaults de QA consistentes com a spec", () => {
    expect(DEFAULT_QA_OPTIONS.blackDetectMinDuration).toBe(1.0);
    expect(DEFAULT_QA_OPTIONS.blackDetectPicTh).toBe(0.98);
    expect(DEFAULT_QA_OPTIONS.blackDetectPixTh).toBe(0.1);
    expect(DEFAULT_QA_OPTIONS.freezeDetectMinDuration).toBe(2.0);
    expect(DEFAULT_QA_OPTIONS.freezeDetectNoise).toBe(0.001);
    expect(DEFAULT_QA_OPTIONS.maxAvDiffSeconds).toBe(1.0);
    expect(DEFAULT_QA_OPTIONS.requireAudio).toBe(true);
    expect(DEFAULT_QA_OPTIONS.ffmpegPath).toBe("ffmpeg");
    expect(DEFAULT_QA_OPTIONS.ffprobePath).toBe("ffprobe");
    expect(DEFAULT_QA_OPTIONS.timeoutMs).toBe(30_000);
  });
});
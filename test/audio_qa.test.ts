import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runFfmpeg, FfmpegError } from "../src/qa/ffmpeg-runner.js";
import { runFfprobe, FfprobeError } from "../src/probe/ffprobe.js";
import {
  verifyAudioQuality,
  parseEbur128Log,
  parseSilenceDetectLog,
  DEFAULT_AUDIO_QA_OPTIONS,
} from "../src/qa/audio-verifier.js";
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
  qaDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-qa-"));
  runFfmpegMock.mockReset();
  runFfprobeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(qaDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmpFile(name = `sample-${randomUUID()}.mp4`): string {
  return path.join(qaDir, name);
}

function installFfmpegLogs(logs: { ebur128?: string; silence?: string }): void {
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    const filter = args.find(
      (arg) => arg.includes("ebur128") || arg.includes("silencedetect"),
    );
    if (filter !== undefined && filter.includes("ebur128")) {
      return { stdout: "", stderr: logs.ebur128 ?? "" };
    }
    if (filter !== undefined && filter.includes("silencedetect")) {
      return { stdout: "", stderr: logs.silence ?? "" };
    }
    return { stdout: "", stderr: "" };
  });
}

function installProbe(
  overrides: {
    hasAudio?: boolean;
    duration?: string;
    sampleRate?: string;
    channels?: number;
    audioCodec?: string;
  } = {},
): void {
  const {
    hasAudio = true,
    duration = "10",
    sampleRate = "48000",
    channels = 2,
    audioCodec = "aac",
  } = overrides;
  const streams: Array<Record<string, unknown>> = [];
  if (hasAudio) {
    streams.push({
      index: 0,
      codec_name: audioCodec,
      codec_type: "audio",
      sample_rate: sampleRate,
      channels,
      duration,
    });
  }
  runFfprobeMock.mockResolvedValue({
    streams,
    format: { duration },
  } as unknown as RawFfprobeOutput);
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

const EBUR128_CONFORMING = [
  "[Parsed_ebur128_0 @ 0x1] frms: 480000 Summary:",
  "",
  "  Integrated loudness:",
  "    I:         -14.0 LUFS",
  "    LRA:        5.0 LU",
  "    Threshold: -24.0 LUFS",
  "",
  "  True peak:",
  "    Peak:       -1.5 dBTP",
].join("\n");

const EBUR128_LOUDNESS_LOW = [
  "[Parsed_ebur128_0 @ 0x1] frms: 480000 Summary:",
  "  Integrated loudness:",
  "    I:         -14.6 LUFS",
  "    LRA:        5.0 LU",
  "  True peak:",
  "    Peak:       -1.5 dBTP",
].join("\n");

const EBUR128_LOUDNESS_HIGH = [
  "[Parsed_ebur128_0 @ 0x1] frms: 480000 Summary:",
  "  Integrated loudness:",
  "    I:         -13.4 LUFS",
  "    LRA:        5.0 LU",
  "  True peak:",
  "    Peak:       -1.5 dBTP",
].join("\n");

const EBUR128_TRUEPEAK_EXACT = [
  "[Parsed_ebur128_0 @ 0x1] frms: 480000 Summary:",
  "  Integrated loudness:",
  "    I:         -14.0 LUFS",
  "    LRA:        5.0 LU",
  "  True peak:",
  "    Peak:       -1.0 dBTP",
].join("\n");

const EBUR128_SILENT = [
  "[Parsed_ebur128_0 @ 0x1] frms: 480000 Summary:",
  "  Integrated loudness:",
  "    I:        -inf LUFS",
  "    LRA:        0.0 LU",
  "  True peak:",
  "    Peak:       -inf dBTP",
].join("\n");

describe("parseEbur128Log", () => {
  it("parseia loudness, true peak e loudness range do log típico", () => {
    expect(parseEbur128Log(EBUR128_CONFORMING)).toEqual({
      integratedLoudness: -14.0,
      truePeak: -1.5,
      loudnessRange: 5.0,
    });
  });

  it("parseia -inf como Number.NEGATIVE_INFINITY sem NaN", () => {
    const parsed = parseEbur128Log(EBUR128_SILENT);
    expect(parsed.integratedLoudness).toBe(Number.NEGATIVE_INFINITY);
    expect(parsed.truePeak).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(parsed.integratedLoudness)).toBe(false);
    expect(parsed.loudnessRange).toBe(0.0);
  });

  it("retorna null para todos os campos quando não há resumo no log", () => {
    const stderr = "frame= 100 fps= 30 q=-1.0 size=N/A";
    expect(parseEbur128Log(stderr)).toEqual({
      integratedLoudness: null,
      truePeak: null,
      loudnessRange: null,
    });
  });

  it("retorna null para loudnessRange quando LRA não está presente", () => {
    const stderr = [
      "  Integrated loudness:",
      "    I:         -14.1 LUFS",
      "    Threshold: -24.3 LUFS",
      "  True peak:",
      "    Peak:       -1.5 dBTP",
    ].join("\n");
    expect(parseEbur128Log(stderr)).toEqual({
      integratedLoudness: -14.1,
      truePeak: -1.5,
      loudnessRange: null,
    });
  });

  it("parseia apenas o resumo Summary, ignorando estatísticas por frame", () => {
    const stderr = [
      "[Parsed_ebur128_0 @ 0x1] t: 0.399977 TARGET:-23 LUFS M: -120.7 S:-120.7 I: -70.0 LUFS LRA: 0.0 LU FTPK: -28.8 dBFS TPK: -28.3 dBFS",
      "[Parsed_ebur128_0 @ 0x1] frms: 144000 Summary:",
      "",
      "  Integrated loudness:",
      "    I:         -14.0 LUFS",
      "    LRA:         0.0 LU",
      "    Threshold: -24.0 LUFS",
      "",
      "  True peak:",
      "    Peak:       -9.9 dBFS",
    ].join("\n");
    expect(parseEbur128Log(stderr)).toEqual({
      integratedLoudness: -14.0,
      truePeak: -9.9,
      loudnessRange: 0.0,
    });
  });
});

describe("parseSilenceDetectLog", () => {
  it("retorna [] quando não há silêncio detectado", () => {
    const stderr = "frame= 100 fps= 30 q=-1.0 size=N/A";
    expect(parseSilenceDetectLog(stderr, 10)).toEqual([]);
  });

  it("parseia um intervalo único de silêncio", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 2.0",
      "[silencedetect @ 0x1] silence_end: 4.0 | silence_duration: 2.0",
    ].join("\n");
    expect(parseSilenceDetectLog(stderr, 10)).toEqual([
      { start: 2, end: 4, duration: 2 },
    ]);
  });

  it("acumula múltiplos intervalos consecutivos", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.0",
      "[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 1.0",
      "[silencedetect @ 0x1] silence_start: 5.0",
      "[silencedetect @ 0x1] silence_end: 6.0 | silence_duration: 1.0",
    ].join("\n");
    expect(parseSilenceDetectLog(stderr, 10)).toEqual([
      { start: 1, end: 2, duration: 1 },
      { start: 5, end: 6, duration: 1 },
    ]);
  });

  it("edge 1: fecha silêncio em aberto até o EOF usando a duração total", () => {
    const stderr = "[silencedetect @ 0x1] silence_start: 8.0";
    expect(parseSilenceDetectLog(stderr, 10)).toEqual([
      { start: 8, end: 10, duration: 2 },
    ]);
  });

  it("não cria intervalo quando totalDuration não ultrapassa o start", () => {
    const stderr = "[silencedetect @ 0x1] silence_start: 8.0";
    expect(parseSilenceDetectLog(stderr, 8)).toEqual([]);
  });

  it("edge 1: mistura intervalos fechados com aberto no fim", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.0",
      "[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 1.0",
      "[silencedetect @ 0x1] silence_start: 5.0",
    ].join("\n");
    expect(parseSilenceDetectLog(stderr, 10)).toEqual([
      { start: 1, end: 2, duration: 1 },
      { start: 5, end: 10, duration: 5 },
    ]);
  });
});

describe("verifyAudioQuality", () => {
  async function cleanReport(
    overrides: {
      hasAudio?: boolean;
      duration?: string;
      sampleRate?: string;
      channels?: number;
      audioCodec?: string;
    } = {},
  ) {
    installFfmpegLogs({ ebur128: EBUR128_CONFORMING });
    installProbe(overrides);
    return verifyAudioQuality(tmpFile());
  }

  it("CA-1: aprova áudio em conformidade com todos os checks passed", async () => {
    const report = await cleanReport();

    expect(report.passed).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(report.loudness).toMatchObject({
      passed: true,
      integratedLoudness: -14.0,
      minAllowedLufs: DEFAULT_AUDIO_QA_OPTIONS.minIntegratedLufs,
      maxAllowedLufs: DEFAULT_AUDIO_QA_OPTIONS.maxIntegratedLufs,
    });
    expect(report.truePeak).toMatchObject({
      passed: true,
      truePeak: -1.5,
      maxAllowedTruePeak: DEFAULT_AUDIO_QA_OPTIONS.maxTruePeakDb,
    });
    expect(report.voicePresence).toMatchObject({
      passed: true,
      maxAllowedSilenceDuration: DEFAULT_AUDIO_QA_OPTIONS.maxSilenceDuration,
      detectedSilenceIntervals: [],
      totalSilenceDuration: 0,
      silencePercentage: 0,
    });
    expect(report.details).toMatchObject({
      duration: 10,
      sampleRate: 48000,
      channels: 2,
      audioCodec: "aac",
    });
    expect(report.failureReasons).toHaveLength(0);
  });

  it("CA-2: reprova por loudness abaixo de -14.5 LUFS", async () => {
    installFfmpegLogs({ ebur128: EBUR128_LOUDNESS_LOW });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.loudness.integratedLoudness).toBe(-14.6);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("-14.6")),
    ).toBe(true);
  });

  it("CA-2: reprova por loudness acima de -13.5 LUFS", async () => {
    installFfmpegLogs({ ebur128: EBUR128_LOUDNESS_HIGH });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.loudness.integratedLoudness).toBe(-13.4);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("-13.4")),
    ).toBe(true);
  });

  it("CA-3: aprova loudness no limiar inferior exato -14.5 LUFS", async () => {
    installFfmpegLogs({
      ebur128: [
        "  Integrated loudness:",
        "    I:         -14.5 LUFS",
        "  True peak:",
        "    Peak:       -1.5 dBTP",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("CA-3: aprova loudness no limiar superior exato -13.5 LUFS", async () => {
    installFfmpegLogs({
      ebur128: [
        "  Integrated loudness:",
        "    I:         -13.5 LUFS",
        "  True peak:",
        "    Peak:       -1.5 dBTP",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("CA-4: reprova por True Peak exatamente -1.0 dBTP (critério estrito)", async () => {
    installFfmpegLogs({ ebur128: EBUR128_TRUEPEAK_EXACT });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.truePeak.passed).toBe(false);
    expect(report.truePeak.truePeak).toBe(-1.0);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) => reason.includes("-1.0")),
    ).toBe(true);
  });

  it("CA-4: aprova True Peak logo abaixo de -1.0 dBTP", async () => {
    installFfmpegLogs({
      ebur128: [
        "  Integrated loudness:",
        "    I:         -14.0 LUFS",
        "  True peak:",
        "    Peak:       -1.01 dBTP",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.truePeak.passed).toBe(true);
    expect(report.truePeak.truePeak).toBe(-1.01);
    expect(report.passed).toBe(true);
  });

  it("CA-5: reprova por silêncio prolongado acima de 3.0s", async () => {
    installFfmpegLogs({
      ebur128: EBUR128_CONFORMING,
      silence: [
        "[silencedetect @ 0x1] silence_start: 2.0",
        "[silencedetect @ 0x1] silence_end: 7.0 | silence_duration: 5.0",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.voicePresence.passed).toBe(false);
    expect(report.voicePresence.totalSilenceDuration).toBe(5.0);
    expect(report.voicePresence.silencePercentage).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("silence detected"),
      ),
    ).toBe(true);
  });

  it("CA-5: aprova silêncio curto dentro do limiar configurado", async () => {
    installFfmpegLogs({
      ebur128: EBUR128_CONFORMING,
      silence: [
        "[silencedetect @ 0x1] silence_start: 2.0",
        "[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 0.5",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.voicePresence.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("edge 1: reprova por ausência de trilha de áudio sem invocar ffmpeg", async () => {
    installFfmpegLogs({});
    installProbe({ hasAudio: false });

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.truePeak.passed).toBe(false);
    expect(report.voicePresence.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      "Missing audio stream in media file",
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("edge 2: 100% de silêncio reprova loudness e voicePresence", async () => {
    installFfmpegLogs({
      ebur128: EBUR128_SILENT,
      silence: "[silencedetect @ 0x1] silence_start: 0",
    });
    installProbe({ duration: "10" });

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.voicePresence.passed).toBe(false);
    expect(report.voicePresence.detectedSilenceIntervals).toEqual([
      { start: 0, end: 10, duration: 10 },
    ]);
    expect(report.passed).toBe(false);
  });

  it("edge 3: reprova loudness não mensurável com motivo claro", async () => {
    installFfmpegLogs({ ebur128: "frame= 100 fps= 30" });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.truePeak.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.includes("could not be measured"),
      ),
    ).toBe(true);
  });

  it("edge 4: respeita opções customizadas de thresholds", async () => {
    installFfmpegLogs({
      ebur128: [
        "  Integrated loudness:",
        "    I:         -14.6 LUFS",
        "  True peak:",
        "    Peak:       -0.9 dBTP",
      ].join("\n"),
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile(), {
      minIntegratedLufs: -15.0,
      maxTruePeakDb: -0.5,
    });

    expect(report.loudness.passed).toBe(true);
    expect(report.loudness.minAllowedLufs).toBe(-15.0);
    expect(report.truePeak.passed).toBe(true);
    expect(report.truePeak.maxAllowedTruePeak).toBe(-0.5);
    expect(report.passed).toBe(true);

    const args = filterArgs("ebur128");
    expect(args?.join(" ")).toContain("ebur128=peak=true");
  });

  it("edge 5: usam silenceNoiseThresholdDb e maxSilenceDuration nos args", async () => {
    installFfmpegLogs({ ebur128: EBUR128_CONFORMING });
    installProbe();

    const report = await verifyAudioQuality(tmpFile(), {
      silenceNoiseThresholdDb: -45,
      maxSilenceDuration: 2.5,
    });

    expect(report.voicePresence.passed).toBe(true);
    const args = filterArgs("silencedetect");
    expect(args?.join(" ")).toContain("silencedetect=noise=-45dB:d=2.5");
    expect(report.voicePresence.maxAllowedSilenceDuration).toBe(2.5);
  });

  it("edge 6: timeout do ffmpeg reprova com motivo de timeout", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args.some((arg) => arg.includes("ebur128"))) {
        throw new FfmpegError("timeout", "ffmpeg timed out after 30000ms");
      }
      return { stdout: "", stderr: "" };
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.toLowerCase().includes("timed out"),
      ),
    ).toBe(true);
  });

  it("edge 6: falha do ffmpeg reprova com motivo claro e sem lançar", async () => {
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      if (args.some((arg) => arg.includes("ebur128"))) {
        throw new FfmpegError(
          "execution",
          "ebur128 filter failed",
          "ebur128 filter failed",
        );
      }
      return { stdout: "", stderr: "" };
    });
    installProbe();

    const report = await verifyAudioQuality(tmpFile());

    expect(report.loudness.passed).toBe(false);
    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((reason) =>
        reason.includes("ebur128 filter failed"),
      ),
    ).toBe(true);
  });

  it("edge 7: falha do ffprobe reprova sem invocar ffmpeg", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError("not-found", "ffprobe binary not found"),
    );

    const report = await verifyAudioQuality(tmpFile());

    expect(report.passed).toBe(false);
    expect(report.loudness.passed).toBe(false);
    expect(report.truePeak.passed).toBe(false);
    expect(report.voicePresence.passed).toBe(false);
    expect(runFfmpegMock).not.toHaveBeenCalled();
    expect(
      report.failureReasons.some((reason) => reason.includes("ffprobe")),
    ).toBe(true);
  });

  it("exporta defaults consistentes com a spec", () => {
    expect(DEFAULT_AUDIO_QA_OPTIONS.minIntegratedLufs).toBe(-14.5);
    expect(DEFAULT_AUDIO_QA_OPTIONS.maxIntegratedLufs).toBe(-13.5);
    expect(DEFAULT_AUDIO_QA_OPTIONS.maxTruePeakDb).toBe(-1.0);
    expect(DEFAULT_AUDIO_QA_OPTIONS.maxSilenceDuration).toBe(3.0);
    expect(DEFAULT_AUDIO_QA_OPTIONS.silenceNoiseThresholdDb).toBe(-50);
    expect(DEFAULT_AUDIO_QA_OPTIONS.ffmpegPath).toBe("ffmpeg");
    expect(DEFAULT_AUDIO_QA_OPTIONS.ffprobePath).toBe("ffprobe");
    expect(DEFAULT_AUDIO_QA_OPTIONS.timeoutMs).toBe(30_000);
  });
});
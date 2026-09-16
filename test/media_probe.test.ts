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
import { detectMagicBytes } from "../src/probe/magic-bytes.js";
import { validateMedia } from "../src/probe/validator.js";
import { runFfprobe, FfprobeError } from "../src/probe/ffprobe.js";
import type { RawFfprobeOutput } from "../src/probe/types.js";

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

const runFfprobeMock = vi.mocked(runFfprobe);

const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

let probeDir: string;

beforeEach(() => {
  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-probe-"));
  runFfprobeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(probeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tmpFile(name: string, content: Buffer | string): string {
  const filePath = path.join(probeDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function webmHeader(): Buffer {
  return Buffer.concat([
    EBML_HEADER,
    Buffer.from("webm", "latin1"),
    Buffer.alloc(28, 0),
  ]);
}

function mp4Header(brand = "isom"): Buffer {
  const header = Buffer.alloc(64, 0);
  header.writeUInt32BE(0x18, 0);
  header.write("ftyp", 4, "latin1");
  header.write(brand, 8, 8, "latin1");
  return header;
}

function riffAviHeader(): Buffer {
  const header = Buffer.alloc(64, 0);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(0x78, 4);
  header.write("AVI ", 8, "latin1");
  return header;
}

function videoStream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    codec_name: "h264",
    codec_type: "video",
    width: 1920,
    height: 1080,
    duration: "120.5",
    pix_fmt: "yuv420p",
    avg_frame_rate: "24000/1001",
    bit_rate: "8000000",
    ...overrides,
  };
}

function audioStream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    codec_name: "aac",
    codec_type: "audio",
    channels: 2,
    duration: "120.5",
    ...overrides,
  };
}

function probeOutput(
  streams: Array<Record<string, unknown>>,
  format: Record<string, unknown> = {},
): RawFfprobeOutput {
  return {
    streams: streams as RawFfprobeOutput["streams"],
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "120.5",
      bit_rate: "8500000",
      ...format,
    },
  };
}

describe("detectMagicBytes", () => {
  it("reconhece MP4 ISO BMFF com caixa ftyp", async () => {
    const file = tmpFile("sample.mp4", mp4Header("isom"));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(true);
    expect(result.signature).toBe("mp4");
  });

  it("reconhece MOV QuickTime quando o major brand é 'qt'", async () => {
    const file = tmpFile("sample.mov", mp4Header("qt  "));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(true);
    expect(result.signature).toBe("mov");
  });

  it("reconhece WebM/Matroska via EBML", async () => {
    const file = tmpFile("sample.webm", webmHeader());
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(true);
    expect(result.signature).toBe("webm");
  });

  it("reconhece Matroska via EBML sem marca webm", async () => {
    const file = tmpFile("sample.mkv", Buffer.concat([EBML_HEADER, Buffer.alloc(32, 0)]));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(true);
    expect(result.signature).toBe("matroska");
  });

  it("reconhece AVI RIFF", async () => {
    const file = tmpFile("sample.avi", riffAviHeader());
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(true);
    expect(result.signature).toBe("avi");
  });

  it("rejeita executáveis MZ", async () => {
    const file = tmpFile("fake.exe", Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Buffer.alloc(32, 0)]));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("INVALID_MAGIC_BYTES");
  });

  it("rejeita executáveis ELF", async () => {
    const file = tmpFile("fake.elf", Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Buffer.alloc(32, 0)]));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
  });

  it("rejeita arquivos ZIP", async () => {
    const file = tmpFile("fake.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(32, 0)]));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("INVALID_MAGIC_BYTES");
  });

  it("rejeita arquivos RAR", async () => {
    const file = tmpFile("fake.rar", Buffer.from([0x52, 0x61, 0x72, 0x21, ...Buffer.alloc(32, 0)]));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
  });

  it("rejeita documentos PDF", async () => {
    const file = tmpFile("fake.pdf", Buffer.from("%PDF-1.4\n".padEnd(32, "x")));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("INVALID_MAGIC_BYTES");
  });

  it("rejeita documentos HTML", async () => {
    const file = tmpFile("fake.html", Buffer.from("<!DOCTYPE html><html>".padEnd(32, "x")));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
  });

  it("rejeita arquivos vazios com mensagem amigável", async () => {
    const file = tmpFile("empty.bin", Buffer.alloc(0));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("INVALID_MAGIC_BYTES");
    expect(result.error?.message).toContain("too small to be a valid video container");
  });

  it("rejeita arquivos com menos de 16 bytes", async () => {
    const file = tmpFile("tiny.bin", Buffer.alloc(8, 0));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("INVALID_MAGIC_BYTES");
  });

  it("rejeita conteúdo binário arbitrário", async () => {
    const file = tmpFile("random.bin", Buffer.alloc(256, 7));
    const result = await detectMagicBytes(file);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain("does not match a known video container");
  });
});

describe("validateMedia", () => {
  function sampleFile(): string {
    return tmpFile(`sample-${randomUUID()}.webm`, webmHeader());
  }

  it("valida vídeo H.264 com áudio AAC e extrai metadados", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream(), audioStream()]),
    );
    const file = sampleFile();
    const result = await validateMedia(file);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata).toMatchObject({
        duration: 120.5,
        resolution: { width: 1920, height: 1080 },
        framerate: 23.976,
        audioChannels: 2,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
        containerFormat: "mov,mp4,m4a,3gp,3g2,mj2",
        bitrate: 8500000,
        pixelFormat: "yuv420p",
      });
      expect(result.metadata.fileSizeBytes).toBe(fs.statSync(file).size);
    }
  });

  it("normaliza framerate 30/1 -> 30", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ avg_frame_rate: "30/1" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.framerate).toBe(30);
    }
  });

  it("normaliza framerate 30000/1001 -> 29.97", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ avg_frame_rate: "30000/1001" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.framerate).toBe(29.97);
    }
  });

  it("normaliza framerate 60000/1001 -> 59.94", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ avg_frame_rate: "60000/1001" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.framerate).toBe(59.94);
    }
  });

  it("mapeia HEVC para o codec normalizado h265", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ codec_name: "hevc" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.videoCodec).toBe("h265");
    }
  });

  it("aceita codec Apple ProRes", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ codec_name: "prores" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.videoCodec).toBe("prores");
    }
  });

  it("rejeita codec de vídeo não suportado (VP9)", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ codec_name: "vp9" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("UNSUPPORTED_VIDEO_CODEC");
      expect(result.error.message).toContain("vp9");
      expect(result.error.message).toContain("h264, h265, prores");
    }
  });

  it("rejeita codec de vídeo não suportado (AV1)", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ codec_name: "av1" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("UNSUPPORTED_VIDEO_CODEC");
    }
  });

  it("rejeita arquivo sem stream de vídeo", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([audioStream({ codec_name: "mp3" })]),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("MISSING_VIDEO_STREAM");
      expect(result.error.message).toBe("No video stream found in container");
    }
  });

  it("rejeita vídeo sem resolução válida (width 0)", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ width: 0 })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("MISSING_VIDEO_STREAM");
    }
  });

  it("permite vídeo sem áudio registrando canais zerados", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream()], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.hasAudio).toBe(false);
      expect(result.metadata.audioChannels).toBe(0);
      expect(result.metadata.audioCodec).toBeNull();
    }
  });

  it("rejeita stream de áudio com canais inválidos", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream(), audioStream({ channels: 0 })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("CORRUPTED_STREAM");
      expect(result.error.details?.channels).toBe(0);
    }
  });

  it("rejeita stream de áudio com codec não suportado", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream(), audioStream({ codec_name: "vorbis" })], { duration: "10" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("CORRUPTED_STREAM");
    }
  });

  it("rejeita vídeo sem duração mensurável", async () => {
    runFfprobeMock.mockResolvedValue(
      probeOutput([videoStream({ duration: "N/A" })], { duration: "N/A" }),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("CORRUPTED_STREAM");
    }
  });

  it("rejeita container corrompido quando ffprobe falha", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError("execution", "moov atom not found"),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("CORRUPTED_CONTAINER");
    }
  });

  it("retorna PROBE_TIMEOUT quando ffprobe estoura o timeout", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError("timeout", "ffprobe timed out after 15000ms"),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("PROBE_TIMEOUT");
    }
  });

  it("retorna PROBE_ERROR quando o binário ffprobe não existe", async () => {
    runFfprobeMock.mockRejectedValue(
      new FfprobeError("not-found", "ffprobe binary not found"),
    );
    const result = await validateMedia(sampleFile());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("PROBE_ERROR");
    }
  });

  it("rejeita magic bytes inválidos sem invocar ffprobe", async () => {
    const file = tmpFile("not-media.bin", Buffer.from("plain text content here", "utf8"));
    const result = await validateMedia(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("INVALID_MAGIC_BYTES");
    }
    expect(runFfprobeMock).not.toHaveBeenCalled();
  });
});

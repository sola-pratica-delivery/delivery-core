import { open } from "node:fs/promises";
import type { MagicBytesResult, MagicBytesSignature } from "./types.js";

const HEADER_BYTES = 512;
const MIN_VIDEO_SIZE = 16;
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const ISO_BMFF_BOXES = new Set([
  "ftyp",
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
  "pnot",
  "sidx",
  "styp",
  "moof",
  "mfhd",
]);

interface InvalidSignature {
  label: string;
  match(header: Buffer): boolean;
}

const INVALID_SIGNATURES: InvalidSignature[] = [
  {
    label: "a Windows executable (MZ)",
    match: (h) => h.length >= 2 && h[0] === 0x4d && h[1] === 0x5a,
  },
  {
    label: "an ELF executable",
    match: (h) =>
      h.length >= 4 &&
      h[0] === 0x7f &&
      h.toString("latin1", 1, 4) === "ELF",
  },
  {
    label: "a ZIP archive",
    match: (h) => h.length >= 2 && h[0] === 0x50 && h[1] === 0x4b,
  },
  {
    label: "a RAR archive",
    match: (h) =>
      h.length >= 4 &&
      h[0] === 0x52 &&
      h[1] === 0x61 &&
      h[2] === 0x72 &&
      h[3] === 0x21,
  },
  {
    label: "a PDF document",
    match: (h) => h.length >= 4 && h.toString("latin1", 0, 4) === "%PDF",
  },
  {
    label: "an HTML document",
    match: (h) => {
      const head = h.toString("latin1", 0, h.length).toLowerCase();
      return head.includes("<html") || head.includes("<!doctype");
    },
  },
];

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isIsoBmff(header: Buffer): boolean {
  for (let offset = 0; offset + 4 <= header.length; offset += 4) {
    const boxType = header.toString("latin1", offset, offset + 4);
    if (ISO_BMFF_BOXES.has(boxType)) {
      return true;
    }
  }
  return false;
}

function isMatroskaHeader(header: Buffer): boolean {
  return header.length >= 4 && header.subarray(0, 4).equals(EBML_MAGIC);
}

export async function detectMagicBytes(
  filePath: string,
): Promise<MagicBytesResult> {
  const header = await readHeader(filePath);

  if (header.length < MIN_VIDEO_SIZE) {
    return toInvalid("File is empty or too small to be a valid video container");
  }

  for (const signature of INVALID_SIGNATURES) {
    if (signature.match(header)) {
      return toInvalid(`File starts like ${signature.label}; only media containers are allowed`);
    }
  }

  if (isMatroskaHeader(header)) {
    const head = header.toString("latin1");
    const signature: MagicBytesSignature = head.includes("webm")
      ? "webm"
      : "matroska";
    return { valid: true, signature, error: null };
  }

  if (
    header.length >= 12 &&
    header.toString("latin1", 0, 4) === "RIFF" &&
    header.toString("latin1", 8, 12) === "AVI "
  ) {
    return { valid: true, signature: "avi", error: null };
  }

  if (isIsoBmff(header)) {
    const majorBrand =
      header.length >= 12 ? header.toString("latin1", 8, 12) : "";
    const signature: MagicBytesSignature =
      majorBrand === "qt  " ? "mov" : "mp4";
    return { valid: true, signature, error: null };
  }

  return toInvalid("File signature does not match a known video container");
}

function toInvalid(message: string): MagicBytesResult {
  return {
    valid: false,
    signature: null,
    error: {
      code: "INVALID_MAGIC_BYTES",
      message,
    },
  };
}
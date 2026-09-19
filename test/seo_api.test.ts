import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startServer,
  stopServer,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";
import { SeoStore } from "../src/seo/store.js";
import type {
  WhisperTranscription,
  YouTubeSeoMetadata,
} from "../src/seo/types.js";

function sampleTranscription(): WhisperTranscription {
  return {
    language: "pt",
    duration: 60,
    text: [
      "Olá, bem-vindos ao canal. Hoje vamos falar sobre receitas fáceis.",
      "Primeiro reunimos farinha, ovos e leite para a massa.",
      "Depois misturamos tudo e levamos ao forno por trinta minutos.",
    ].join(" "),
    segments: [
      { start: 0, end: 4, text: "Olá, bem-vindos ao canal. Hoje vamos falar sobre receitas fáceis." },
      { start: 5, end: 9, text: "Primeiro reunimos farinha, ovos e leite para a massa." },
      { start: 45, end: 49, text: "Depois misturamos tudo e levamos ao forno por trinta minutos." },
    ],
  };
}

function sampleMetadata(uploadId: string): YouTubeSeoMetadata {
  return {
    uploadId,
    title: "Receitas fáceis para o dia a dia",
    description: [
      "Resumo do conteúdo do vídeo.",
      "",
      "Tópicos principais:",
      "- receitas",
      "- culinária",
      "",
      "Capítulos:",
      "00:00 Introdução",
    ].join("\n"),
    tags: ["receitas", "culinária"],
    chapters: [{ seconds: 0, timestamp: "00:00", title: "Introdução" }],
    summary: "Resumo do conteúdo do vídeo.",
    topics: ["receitas", "culinária"],
    synthesizedAt: new Date().toISOString(),
  };
}

describe("SeoStore - persistência de metadados SEO", () => {
  it("salva e lê metadados via save/read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-store-"));
    try {
      const store = new SeoStore(dir);
      await store.save("upload-seo-1", sampleMetadata("upload-seo-1"));

      const read = await store.read("upload-seo-1");
      expect(read?.uploadId).toBe("upload-seo-1");
      expect(read?.title).toBe("Receitas fáceis para o dia a dia");
      expect(read?.chapters[0]?.timestamp).toBe("00:00");
      expect(read?.tags).toEqual(["receitas", "culinária"]);

      const reportPath = path.join(dir, "upload-seo-1.seo.json");
      expect(fs.existsSync(reportPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read retorna null para upload sem metadados", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-store-miss-"));
    try {
      const store = new SeoStore(dir);
      expect(await store.read("missing")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sobrescreve metadados já salvos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-store-over-"));
    try {
      const store = new SeoStore(dir);
      await store.save("upload-seo-2", sampleMetadata("upload-seo-2"));
      const updated = { ...sampleMetadata("upload-seo-2"), title: "Título novo" };
      await store.save("upload-seo-2", updated);

      const read = await store.read("upload-seo-2");
      expect(read?.title).toBe("Título novo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Endpoint POST /uploads/:id/seo/synthesize", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function postSynthesize(
    uploadId: string,
    body: unknown,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/${uploadId}/seo/synthesize`,
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      Buffer.from(JSON.stringify(body)),
    );
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/any-id/seo/synthesize`,
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ transcription: sampleTranscription() })),
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia acesso com token inválido com 401", async () => {
    const response = await postSynthesize(
      "any-id",
      { transcription: sampleTranscription() },
      "invalid-token",
    );
    expect(response.status).toBe(401);
  });

  it("retorna 400 para payload inválido (sem transcription)", async () => {
    const response = await postSynthesize("any-id", {});
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body.toString("utf8"));
    expect(body.code).toBe("INVALID_PAYLOAD");
  });

  it("retorna 400 para transcription com segmentos inválidos", async () => {
    const response = await postSynthesize("any-id", {
      transcription: {
        text: "conteúdo",
        segments: [{ start: "zero", text: "inválido" }],
      },
    });
    expect(response.status).toBe(400);
  });

  it("sintetiza, persiste e retorna 200 com metadados dentro dos limites", async () => {
    const response = await postSynthesize("upload-video-1", {
      transcription: sampleTranscription(),
    });
    expect(response.status).toBe(200);
    const metadata = JSON.parse(
      response.body.toString("utf8"),
    ) as YouTubeSeoMetadata;
    expect(metadata.uploadId).toBe("upload-video-1");
    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.description).toContain("00:00 Introdução");
    expect(metadata.description).toContain("Tópicos principais:");
    expect(metadata.description.length).toBeLessThanOrEqual(5_000);
    expect(metadata.tags.join(", ").length).toBeLessThanOrEqual(500);
    expect(metadata.chapters[0]?.timestamp).toBe("00:00");
    expect(Number.isNaN(Date.parse(metadata.synthesizedAt))).toBe(false);

    const getResponse = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/upload-video-1/seo`,
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(getResponse.status).toBe(200);
    expect(
      JSON.parse(getResponse.body.toString("utf8")).title,
    ).toBe(metadata.title);
  });

  it("sintetiza considerando options customizadas (customHook e channelCallToAction)", async () => {
    const response = await postSynthesize("upload-video-2", {
      transcription: sampleTranscription(),
      options: {
        customHook: "Como fazer",
        channelCallToAction: "Inscreva-se no canal!",
      },
    });
    expect(response.status).toBe(200);
    const metadata = JSON.parse(
      response.body.toString("utf8"),
    ) as YouTubeSeoMetadata;
    expect(metadata.uploadId).toBe("upload-video-2");
    expect(metadata.title.startsWith("Como fazer")).toBe(true);
    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.description).toContain("Inscreva-se no canal!");
  });
});

describe("Endpoint GET /uploads/:id/seo", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function getSeo(uploadId: string, token: string = TEST_TOKEN): Promise<RawResponse> {
    return rawRequest(ctx.baseUrl, "GET", `${UPLOAD_PATH}/${uploadId}/seo`, {
      authorization: `Bearer ${token}`,
    });
  }

  it("bloqueia acesso sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/any-id/seo`,
    );
    expect(response.status).toBe(401);
  });

  it("retorna 404 para metadados não sintetizados", async () => {
    const response = await getSeo("does-not-exist");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body.toString("utf8")).status).toBe(
      "NOT_FOUND",
    );
  });

  it("retorna 200 com metadados persistidos", async () => {
    const store = new SeoStore(ctx.config.storageDir);
    await store.save("saved-seo", sampleMetadata("saved-seo"));

    const response = await getSeo("saved-seo");
    expect(response.status).toBe(200);
    const metadata = JSON.parse(
      response.body.toString("utf8"),
    ) as YouTubeSeoMetadata;
    expect(metadata.uploadId).toBe("saved-seo");
    expect(metadata.title).toBe("Receitas fáceis para o dia a dia");
    expect(metadata.chapters[0]?.timestamp).toBe("00:00");
  });
});
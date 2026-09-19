import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  extractChapters,
  extractTags,
  synthesizeSeoMetadata,
  DEFAULT_SEO_OPTIONS,
} from "../src/seo/synthesizer.js";
import type {
  WhisperSegment,
  WhisperTranscription,
} from "../src/seo/types.js";

function segment(
  start: number,
  text: string,
  end?: number,
): WhisperSegment {
  return { start, ...(end !== undefined ? { end } : {}), text };
}

function transcription(
  segments: WhisperSegment[],
  text?: string,
): WhisperTranscription {
  return {
    language: "pt",
    duration: segments.length > 0 ? segments[segments.length - 1]?.end ?? 0 : 0,
    text: text ?? segments.map((item) => item.text).join(" "),
    segments,
  };
}

describe("formatTimestamp", () => {
  it("formata 0 como 00:00", () => {
    expect(formatTimestamp(0)).toBe("00:00");
  });

  it("formata segundos com mm:ss", () => {
    expect(formatTimestamp(5)).toBe("00:05");
    expect(formatTimestamp(65)).toBe("01:05");
    expect(formatTimestamp(330)).toBe("05:30");
  });

  it("formata durações acima de 1 hora com hh:mm:ss", () => {
    expect(formatTimestamp(3600)).toBe("01:00:00");
    expect(formatTimestamp(3725)).toBe("01:02:05");
    expect(formatTimestamp(43500)).toBe("12:05:00");
  });

  it("arredonda para baixo segundos fracionários", () => {
    expect(formatTimestamp(5.9)).toBe("00:05");
    expect(formatTimestamp(65.4)).toBe("01:05");
  });

  it("clampa valores negativos em 00:00", () => {
    expect(formatTimestamp(-10)).toBe("00:00");
  });
});

describe("extractChapters", () => {
  it("edge 1: com um único segmento garante o capítulo 00:00 Introdução", () => {
    const chapters = extractChapters([segment(0, "Olá a todos")]);
    expect(chapters).toEqual([
      { seconds: 0, timestamp: "00:00", title: "Introdução" },
    ]);
  });

  it("edge 1: com segmento único depois do zero força o marco 00:00", () => {
    const chapters = extractChapters([segment(120, "Conteúdo")]);
    expect(chapters[0]).toEqual({
      seconds: 0,
      timestamp: "00:00",
      title: "Introdução",
    });
    expect(chapters[1]).toMatchObject({ seconds: 120, timestamp: "02:00" });
  });

  it("edge 1: segmentos vazios resultam no capítulo 00:00 Introdução", () => {
    const chapters = extractChapters([]);
    expect(chapters).toEqual([
      { seconds: 0, timestamp: "00:00", title: "Introdução" },
    ]);
  });

  it("cria novo capítulo quando a pausa atinge minChapterIntervalSeconds (30s)", () => {
    const chapters = extractChapters([
      segment(0, "Introdução ao tema"),
      segment(5, "Contexto"),
      segment(40, "Conteúdo principal"),
      segment(45, "Detalhes adicionais"),
    ]);
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([0, 40]);
    expect(chapters[0]).toEqual({
      seconds: 0,
      timestamp: "00:00",
      title: "Introdução",
    });
    expect(chapters[1]).toMatchObject({ seconds: 40, timestamp: "00:40" });
  });

  it("mantém segmentos no mesmo capítulo quando a pausa é menor que 30s", () => {
    const chapters = extractChapters([
      segment(0, "Início"),
      segment(20, "Continuação"),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.timestamp).toBe("00:00");
  });

  it("cria capítulo para pausa exatamente em 30s", () => {
    const chapters = extractChapters([
      segment(0, "Início"),
      segment(30, "Segunda parte"),
    ]);
    expect(chapters).toHaveLength(2);
    expect(chapters[1]?.seconds).toBe(30);
    expect(chapters[1]?.timestamp).toBe("00:30");
  });

  it("edge 5: ordena segmentos fora de ordem cronológica por start", () => {
    const chapters = extractChapters([
      segment(60, "Terceira parte"),
      segment(0, "Primeira parte"),
      segment(30, "Segunda parte"),
    ]);
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([0, 30, 60]);
  });

  it("respeita minChapterIntervalSeconds customizado", () => {
    const chapters = extractChapters(
      [
        segment(0, "Início"),
        segment(50, "Meio"),
        segment(120, "Fim"),
      ],
      { minChapterIntervalSeconds: 60 },
    );
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([0, 120]);
  });

  it("limpa títulos: remove tokens entre colchetes e colapsa espaços", () => {
    const chapters = extractChapters([
      segment(0, "Abertura"),
      segment(40, "[Música]  conteudo    incrivel!"),
    ]);
    expect(chapters[1]?.title).toBe("Conteudo incrivel");
  });

  it("formata timestamps acima de 1 hora com hh:mm:ss", () => {
    const chapters = extractChapters([
      segment(3600, "Capítulo de uma hora"),
      segment(3725, "Capítulo seguinte"),
    ], { minChapterIntervalSeconds: 60 });
    expect(chapters[0]?.timestamp).toBe("00:00");
    expect(chapters[1]?.timestamp).toBe("01:00:00");
    expect(chapters[2]?.timestamp).toBe("01:02:05");
  });
});

describe("extractTags", () => {
  it("filtra stopwords do conteúdo falado", () => {
    const tags = extractTags(
      "Elas se amam de verdade, o céu é azul no verão",
    );
    expect(tags).toEqual(expect.arrayContaining(["amam", "verdade", "céu", "azul", "verão"]));
    for (const stopword of ["elas", "se", "de", "o", "é", "no"]) {
      expect(tags).not.toContain(stopword);
    }
  });

  it("ordena por frequência de relevância", () => {
    const tags = extractTags("vida vida vida canal canal amor receita");
    expect(tags).toEqual(["vida", "canal", "amor", "receita"]);
  });

  it("deduplica palavras com variação de maiúsculas", () => {
    const tags = extractTags("Vida VIDA vida canal Canal");
    expect(tags).toEqual(["vida", "canal"]);
  });

  it("edge 3: soma total dos caracteres nunca excede 500 incluindo separadores", () => {
    const text = Array.from(
      { length: 200 },
      (_, index) => `palavra${index + 1}`,
    ).join(" ");
    const tags = extractTags(text);
    const joined = tags.join(", ");
    expect(joined.length).toBeLessThanOrEqual(500);
    expect(tags.length).toBeLessThan(200);
  });

  it("edge 3: respeita maxTagsLength customizado", () => {
    const text = "receita receita massa massa forno forno panela panela",
    tags = extractTags(text, { maxTagsLength: 20 });
    expect(tags.join(", ").length).toBeLessThanOrEqual(20);
  });

  it("edge 6: texto vazio produz lista vazia", () => {
    expect(extractTags("")).toEqual([]);
  });

  it("edge 6: texto apenas com stopwords produz lista vazia", () => {
    expect(extractTags("o a de em e que um")).toEqual([]);
  });
});

describe("synthesizeSeoMetadata", () => {
  it("CA: sintetiza título, descrição, tags e capítulos dentro dos limites do YouTube", () => {
    const transcript = transcription([
      segment(0, "Olá, bem-vindos ao canal. Hoje vamos falar sobre receitas fáceis e rápidas para o dia a dia.", 4),
      segment(5, "Primeiro reunimos farinha, ovos e leite para a massa.", 9),
      segment(40, "Depois misturamos tudo e levamos ao forno por trinta minutos.", 44),
    ]);

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.summary.length).toBeGreaterThan(0);
    expect(metadata.description.length).toBeLessThanOrEqual(5_000);
    expect(metadata.description).toContain("Tópicos principais:");
    expect(metadata.description).toContain("Capítulos:");
    expect(metadata.description).toContain("00:00 Introdução");
    expect(metadata.tags.join(", ").length).toBeLessThanOrEqual(500);
    expect(metadata.tags.length).toBeGreaterThan(0);
    expect(metadata.topics.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(metadata.synthesizedAt))).toBe(false);

    const firstChapter = metadata.chapters[0];
    expect(firstChapter).toBeDefined();
    expect(firstChapter?.seconds).toBe(0);
    expect(firstChapter?.timestamp).toBe("00:00");

    for (let index = 1; index < metadata.chapters.length; index += 1) {
      const previous = metadata.chapters[index - 1];
      const current = metadata.chapters[index];
      expect(current?.seconds).toBeGreaterThan(previous?.seconds ?? -1);
    }
  });

  it("edge 1: transcrição curta mantém estrutura com capítulo 00:00", () => {
    const transcript = transcription([
      segment(0, "Apenas um segmento curto sobre o assunto.", 3),
    ]);

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.chapters).toEqual([
      { seconds: 0, timestamp: "00:00", title: "Introdução" },
    ]);
    expect(metadata.description).toContain("00:00 Introdução");
  });

  it("edge 2: título longo é truncado na última palavra completa sem ultrapassar 100", () => {
    const longText = "palavra ".repeat(40).trim();
    const transcript = transcription([segment(0, `${longText}.`, 10)]);

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.title.endsWith("palavra...")).toBe(true);
  });

  it("edge 2: título respeita maxTitleLength customizado", () => {
    const transcript = transcription([
      segment(0, "Um conteúdo muito extenso sobre culinária saudável.", 5),
    ]);

    const metadata = synthesizeSeoMetadata(transcript, {
      maxTitleLength: 40,
    });

    expect(metadata.title.length).toBeLessThanOrEqual(40);
  });

  it("edge 3: tags acumuladas respeitam o teto de 500 caracteres", () => {
    const words = Array.from(
      { length: 150 },
      (_, index) => `assuntotanquerelevante${index + 1}`,
    ).join(" ");
    const transcript = transcription([
      segment(0, `${words} sobre temas variados.`, 60),
    ]);

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.tags.join(", ").length).toBeLessThanOrEqual(500);
  });

  it("edge 6: transcrição vazia usa fallback seguro sem lançar erro", () => {
    const transcript = transcription([], "");

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.title.length).toBeLessThanOrEqual(100);
    expect(metadata.description.length).toBeGreaterThan(0);
    expect(metadata.description).toContain("00:00 Introdução");
    expect(metadata.tags).toEqual([]);
    expect(metadata.chapters).toEqual([
      { seconds: 0, timestamp: "00:00", title: "Introdução" },
    ]);
  });

  it("edge 6: segmentos sem texto são ignorados sem erro", () => {
    const transcript: WhisperTranscription = {
      language: "pt",
      text: "Conteúdo completo ainda por transcrever",
      segments: [
        { start: 0, end: 1, text: "" },
        { start: 2, end: 3, text: "  " },
      ],
    };

    const metadata = synthesizeSeoMetadata(transcript);

    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.chapters).toEqual([
      { seconds: 0, timestamp: "00:00", title: "Introdução" },
    ]);
  });

  it("edge: customHook é incorporado ao título", () => {
    const transcript = transcription([
      segment(0, "aprenda a fazer pão caseiro perfeito em casa", 10),
    ]);

    const metadata = synthesizeSeoMetadata(transcript, {
      customHook: "Como fazer",
    });

    expect(metadata.title.startsWith("Como fazer")).toBe(true);
    expect(metadata.title.length).toBeLessThanOrEqual(100);
  });

  it("edge: channelCallToAction é incluído na descrição", () => {
    const transcript = transcription([
      segment(0, "Conteúdo sobre dicas de organização.", 10),
    ]);

    const metadata = synthesizeSeoMetadata(transcript, {
      channelCallToAction: "Inscreva-se no canal para mais dicas!",
    });

    expect(metadata.description).toContain(
      "Inscreva-se no canal para mais dicas!",
    );
  });

  it("edge: minChapterIntervalSeconds customizado reflete nos capítulos", () => {
    const transcript = transcription([
      segment(0, "Parte inicial.", 4),
      segment(50, "Parte do meio.", 54),
      segment(120, "Parte final.", 124),
    ]);

    const metadata = synthesizeSeoMetadata(transcript, {
      minChapterIntervalSeconds: 60,
    });

    expect(metadata.chapters.map((chapter) => chapter.seconds)).toEqual([
      0, 120,
    ]);
  });

  it("exporta defaults consistentes com a spec", () => {
    expect(DEFAULT_SEO_OPTIONS.maxTitleLength).toBe(100);
    expect(DEFAULT_SEO_OPTIONS.maxTagsLength).toBe(500);
    expect(DEFAULT_SEO_OPTIONS.maxDescriptionLength).toBe(5_000);
    expect(DEFAULT_SEO_OPTIONS.minChapterIntervalSeconds).toBe(30);
    expect(DEFAULT_SEO_OPTIONS.language).toBe("pt");
  });
});
import type {
  SeoSynthesisOptions,
  VideoChapter,
  WhisperSegment,
  WhisperTranscription,
  YouTubeSeoMetadata,
} from "./types.js";

const STOPWORDS_PT = new Set([
  "a", "ao", "aos", "as", "até", "ainda", "antes", "aquela", "aqui",
  "aquilo", "cada", "com", "como", "da", "das", "de", "depois", "do",
  "dos", "e", "ela", "elas", "ele", "eles", "em", "entre", "era", "essa",
  "esse", "esta", "este", "eu", "foi", "foram", "há", "já", "la", "lhe",
  "mais", "mas", "me", "muito", "na", "nas", "nem", "no", "nos", "nós",
  "o", "os", "ou", "para", "pela", "pelo", "pois", "por", "porque",
  "que", "quando", "se", "sem", "ser", "seria", "sendo", "sobre", "sou",
  "são", "também", "tem", "têm", "teu", "tudo", "um", "uma", "você",
  "vocês", "à", "às",
]);

const STOPWORDS_EN = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "not",
  "of", "on", "or", "our", "she", "so", "than", "that", "the", "their",
  "them", "they", "this", "to", "up", "us", "was", "we", "were", "what",
  "when", "which", "will", "with", "you", "your",
]);

const CHAPTER_TITLE_MAX = 60;
const SUMMARY_MAX_LENGTH = 200;
const MAX_TOPICS = 6;
const MAX_TAG_LENGTH = 64;

export const DEFAULT_SEO_OPTIONS: Required<SeoSynthesisOptions> = {
  maxTitleLength: 100,
  maxTagsLength: 500,
  maxDescriptionLength: 5_000,
  minChapterIntervalSeconds: 30,
  language: "pt",
  customHook: "",
  channelCallToAction: "",
};

export function resolveSeoOptions(
  options: SeoSynthesisOptions,
): Required<SeoSynthesisOptions> {
  const resolved: Required<SeoSynthesisOptions> = { ...DEFAULT_SEO_OPTIONS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

export function formatTimestamp(seconds: number): string {
  const total = seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(remainingSeconds).padStart(2, "0");
  if (hours >= 1) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[.,;:!?…]+$/u, "")
    .trim();
}

function capitalizeFirst(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncateEllipsis(text: string, maxLength: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const budget = Math.max(1, maxLength - 3);
  let cut = cleaned.slice(0, budget);
  const boundary = cut.lastIndexOf(" ");
  if (boundary > budget * 0.5) {
    cut = cut.slice(0, boundary);
  }
  cut = cut.replace(/[\s,;:.!?…]+$/u, "").trim();
  if (cut.length === 0) {
    cut = cleaned.slice(0, budget);
  }
  return `${cut}...`;
}

function cleanChapterTitle(text: string): string {
  const cleaned = cleanText(text);
  if (cleaned.length === 0) {
    return "Continuação";
  }
  return capitalizeFirst(truncateEllipsis(cleaned, CHAPTER_TITLE_MAX));
}

export function extractChapters(
  segments: WhisperSegment[],
  options: SeoSynthesisOptions = {},
): VideoChapter[] {
  const resolved = resolveSeoOptions(options);
  const sorted = [...segments]
    .filter(
      (segment) => Number.isFinite(segment.start) && segment.text.trim().length > 0,
    )
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) {
    return [{ seconds: 0, timestamp: "00:00", title: "Introdução" }];
  }

  const groups: Array<{ seconds: number; texts: string[] }> = [
    { seconds: 0, texts: [] },
  ];
  for (const segment of sorted) {
    const current = groups[groups.length - 1];
    if (current === undefined) {
      continue;
    }
    if (segment.start - current.seconds >= resolved.minChapterIntervalSeconds) {
      groups.push({ seconds: segment.start, texts: [segment.text] });
    } else {
      current.texts.push(segment.text);
    }
  }

  groups[0] = { ...(groups[0] ?? { seconds: 0, texts: [] }), seconds: 0 };

  return groups.map((group) => ({
    seconds: group.seconds,
    timestamp: formatTimestamp(group.seconds),
    title:
      group.seconds === 0
        ? "Introdução"
        : cleanChapterTitle(group.texts.join(" ")),
  }));
}

export function extractTags(
  text: string,
  options: SeoSynthesisOptions = {},
): string[] {
  const resolved = resolveSeoOptions(options);
  const stopwords = resolved.language.toLowerCase().startsWith("en")
    ? STOPWORDS_EN
    : STOPWORDS_PT;

  const frequencies = new Map<string, number>();
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    if (token.length < 3 || stopwords.has(token)) {
      continue;
    }
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  const ranked = [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => truncateEllipsis(word, MAX_TAG_LENGTH));

  const tags: string[] = [];
  let used = 0;
  for (const tag of ranked) {
    const separatorCost = tags.length === 0 ? 0 : 2;
    if (used + tag.length + separatorCost > resolved.maxTagsLength) {
      break;
    }
    tags.push(tag);
    used += tag.length + separatorCost;
  }
  return tags;
}

function meaningfulSegments(
  transcription: WhisperTranscription,
): WhisperSegment[] {
  return transcription.segments.filter((item) => item.text.trim().length > 0);
}

function fullText(transcription: WhisperTranscription): string {
  if (transcription.text.trim().length > 0) {
    return transcription.text;
  }
  return meaningfulSegments(transcription)
    .map((item) => item.text)
    .join(" ");
}

function firstMeaningfulText(transcription: WhisperTranscription): string {
  const first = meaningfulSegments(transcription)[0];
  if (first !== undefined) {
    return first.text;
  }
  return transcription.text;
}

function buildTitle(
  resolved: Required<SeoSynthesisOptions>,
  transcription: WhisperTranscription,
): string {
  const base = cleanText(firstMeaningfulText(transcription));
  const hook = resolved.customHook.trim();
  if (base.length === 0) {
    const fallback = hook.length > 0 ? hook : "Vídeo";
    return truncateEllipsis(capitalizeFirst(fallback), resolved.maxTitleLength);
  }
  if (hook.length === 0) {
    return truncateEllipsis(capitalizeFirst(base), resolved.maxTitleLength);
  }
  return truncateEllipsis(`${hook} ${base}`, resolved.maxTitleLength);
}

function buildSummary(
  transcription: WhisperTranscription,
): string {
  const segments = meaningfulSegments(transcription).slice(0, 3);
  const base =
    segments.length > 0
      ? segments.map((item) => item.text).join(" ")
      : transcription.text;
  const cleaned = cleanText(base);
  if (cleaned.length === 0) {
    return "Vídeo com conteúdo diversificado.";
  }
  return truncateEllipsis(capitalizeFirst(cleaned), SUMMARY_MAX_LENGTH);
}

function buildDescription(
  resolved: Required<SeoSynthesisOptions>,
  parts: {
    summary: string;
    topics: string[];
    chapters: VideoChapter[];
  },
): string {
  const blocks: string[] = [];
  if (resolved.customHook.trim().length > 0) {
    blocks.push(resolved.customHook.trim());
  }
  blocks.push(parts.summary);
  if (parts.topics.length > 0) {
    blocks.push(
      `Tópicos principais:\n${parts.topics.map((topic) => `- ${topic}`).join("\n")}`,
    );
  }
  blocks.push(
    `Capítulos:\n${parts.chapters
      .map((chapter) => `${chapter.timestamp} ${chapter.title}`)
      .join("\n")}`,
  );
  if (resolved.channelCallToAction.trim().length > 0) {
    blocks.push(resolved.channelCallToAction.trim());
  }
  const description = blocks.join("\n\n");
  return description.length <= resolved.maxDescriptionLength
    ? description
    : truncateEllipsis(description, resolved.maxDescriptionLength);
}

export function synthesizeSeoMetadata(
  transcription: WhisperTranscription,
  options: SeoSynthesisOptions = {},
): YouTubeSeoMetadata {
  const resolved = resolveSeoOptions(options);
  const segments = meaningfulSegments(transcription);
  const chapters = extractChapters(
    segments.length > 0 ? segments : transcription.segments,
    resolved,
  );
  const tags = extractTags(fullText(transcription), resolved);
  const topics = tags.slice(0, MAX_TOPICS);

  return {
    title: buildTitle(resolved, transcription),
    description: buildDescription(resolved, {
      summary: buildSummary(transcription),
      topics,
      chapters,
    }),
    tags,
    chapters,
    summary: buildSummary(transcription),
    topics,
    synthesizedAt: new Date().toISOString(),
  };
}
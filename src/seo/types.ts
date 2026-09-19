export interface WhisperSegment {
  id?: number | string;
  start: number;
  end?: number;
  text: string;
}

export interface WhisperTranscription {
  language?: string;
  duration?: number;
  text: string;
  segments: WhisperSegment[];
}

export interface VideoChapter {
  seconds: number;
  timestamp: string;
  title: string;
}

export interface YouTubeSeoMetadata {
  uploadId?: string;
  title: string;
  description: string;
  tags: string[];
  chapters: VideoChapter[];
  summary: string;
  topics: string[];
  synthesizedAt: string;
}

export interface SeoSynthesisOptions {
  maxTitleLength?: number;
  maxTagsLength?: number;
  maxDescriptionLength?: number;
  minChapterIntervalSeconds?: number;
  language?: string;
  customHook?: string;
  channelCallToAction?: string;
}
import { readFileSync } from "node:fs";
import { formatTimestamp } from "../youtube.js";
import { oneLine } from "../text.js";

export interface Word {
  t: number;
  end: number;
  text: string;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface Transcript {
  language?: string;
  /** Where the words came from; captions written by people beat automatic ones. */
  source: "captions" | "auto-captions" | "whisper" | "gemini";
  /** Word-level times when the source has them; empty when only segments are known. */
  words: Word[];
  segments: Segment[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** YouTube's json3 caption format; automatic captions carry per-word offsets. */
export function parseJson3(text: string): { words: Word[]; segments: Segment[] } {
  const data = JSON.parse(text) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
  const words: Word[] = [];
  const segments: Segment[] = [];
  for (const event of data.events ?? []) {
    if (!event.segs?.length) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    const end = start + (event.dDurationMs ?? 0) / 1000;
    const content = event.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!content) continue;
    segments.push({ start: round(start), end: round(end), text: content });
    const timed = event.segs.filter((s) => (s.utf8 ?? "").trim());
    if (timed.length > 1 || timed[0]?.tOffsetMs !== undefined) {
      timed.forEach((seg, i) => {
        const t = start + (seg.tOffsetMs ?? 0) / 1000;
        const next = timed[i + 1];
        const wordEnd = next ? start + (next.tOffsetMs ?? 0) / 1000 : end;
        words.push({ t: round(t), end: round(Math.max(t, wordEnd)), text: seg.utf8!.trim() });
      });
    }
  }
  return { words, segments: mergeRolling(segments) };
}

function vttTime(value: string): number {
  const parts = value.trim().split(":").map(Number);
  return round(parts.reduce((acc, part) => acc * 60 + part, 0));
}

/** WebVTT, including YouTube's automatic captions with inline `<00:00:01.500>` word times. */
export function parseVtt(text: string): { words: Word[]; segments: Segment[] } {
  const words: Word[] = [];
  const segments: Segment[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const [from, to] = lines[timing]!.split("-->");
    const start = vttTime(from!);
    const end = vttTime(to!.trim().split(/\s+/)[0]!);
    const textLines = lines.slice(timing + 1);
    const body = textLines.join(" ");
    // An inline time always separates words, even when the caption has no space around it.
    const plain = body.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, " ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    if (!plain) continue;
    segments.push({ start, end, text: plain });
    // Automatic captions repeat the previous line above the new one; only lines with inline times are new words.
    for (const line of textLines.filter((l) => /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(l))) {
      // Text before the first inline time starts at the cue start; each inline time starts the next word group.
      const pieces = line.split(/<(\d{2}:\d{2}:\d{2}\.\d{3})>/);
      let t = start;
      for (let i = 0; i < pieces.length; i++) {
        if (i % 2 === 1) {
          t = vttTime(pieces[i]!);
          continue;
        }
        const chunk = pieces[i]!.replace(/<[^>]+>/g, "").trim();
        if (!chunk) continue;
        const nextTime = pieces[i + 1] !== undefined ? vttTime(pieces[i + 1]!) : end;
        for (const word of chunk.split(/\s+/)) words.push({ t, end: Math.max(t, nextTime), text: word });
      }
    }
  }
  return { words: dedupeWords(words), segments: mergeRolling(segments) };
}

/** Automatic captions repeat the previous line while the next one rolls in; keep each phrase once. */
function mergeRolling(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (previous && segment.text.startsWith(previous.text) && segment.start - previous.end < 0.5) {
      const added = segment.text.slice(previous.text.length).trim();
      if (!added) {
        previous.end = Math.max(previous.end, segment.end);
        continue;
      }
      result.push({ start: segment.start, end: segment.end, text: added });
    } else if (!previous || previous.text !== segment.text) {
      result.push({ ...segment });
    }
  }
  return result;
}

function dedupeWords(words: Word[]): Word[] {
  const seen = new Set<string>();
  return words.filter((w) => {
    const key = `${w.t}|${w.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Reads a caption file in json3 or VTT format. */
export function readCaptions(path: string): { words: Word[]; segments: Segment[] } {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json3") || text.trimStart().startsWith("{") ? parseJson3(text) : parseVtt(text);
}

/** The words spoken around a moment, for labels under frames. */
export function wordsAt(transcript: Transcript, t: number, window = 0.6): string {
  if (transcript.words.length) {
    const active = transcript.words.filter((w) => w.t <= t && w.end > t);
    const near = active.length ? active : transcript.words.filter((w) => w.t <= t + window / 2 && w.end >= t - window / 2);
    if (near.length) return near.map((w) => w.text).join(" ");
  }
  return transcript.segments.find((s) => s.start <= t && s.end >= t)?.text ?? "";
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The time range of the n-th occurrence of a phrase, or undefined when it is not in the transcript. */
export function findPhrase(transcript: Transcript, phrase: string, occurrence = 1): { start: number; end: number } | undefined {
  const target = normalize(phrase).split(" ").filter(Boolean);
  if (!target.length) return undefined;
  let seen = 0;
  if (transcript.words.length) {
    const tokens = transcript.words.map((w) => normalize(w.text));
    for (let i = 0; i + target.length <= tokens.length; i++) {
      if (target.every((word, j) => tokens[i + j] === word) && ++seen === occurrence) {
        return { start: transcript.words[i]!.t, end: transcript.words[i + target.length - 1]!.end };
      }
    }
  }
  // Captions can mix word-timed and plain cues, so phrases are also looked for in the segments.
  seen = 0;
  for (const segment of transcript.segments) {
    if (normalize(segment.text).includes(target.join(" ")) && ++seen === occurrence) return { start: segment.start, end: segment.end };
  }
  return undefined;
}

/** How many times `findPhrase` can find a phrase: occurrences 1 to this number exist. */
export function countPhrase(transcript: Transcript, phrase: string): number {
  const target = normalize(phrase).split(" ").filter(Boolean);
  if (!target.length) return 0;
  const tokens = transcript.words.map((w) => normalize(w.text));
  let inWords = 0;
  for (let i = 0; i + target.length <= tokens.length; i++) if (target.every((word, j) => tokens[i + j] === word)) inWords++;
  // findPhrase counts segments separately, once per segment that holds the phrase.
  const inSegments = transcript.segments.filter((s) => normalize(s.text).includes(target.join(" "))).length;
  return Math.max(inWords, inSegments);
}

/** A readable transcript with [m:ss] marks. */
export function toMarkdown(transcript: Transcript, title?: string): string {
  const lines = [`# Transcript${title ? `: ${oneLine(title)}` : ""}`, "", `Source: ${transcript.source}${transcript.language ? `, language ${transcript.language}` : ""}.`, ""];
  for (const s of transcript.segments) lines.push(`[${formatTimestamp(s.start)}]${s.speaker ? ` **${s.speaker}:**` : ""} ${s.text}`);
  return `${lines.join("\n")}\n`;
}

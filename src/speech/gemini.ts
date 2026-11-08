import type { VideoAnalyzer } from "../analyzer.js";
import type { TranscriptFallback } from "../engine.js";
import { TRANSCRIPT_SCHEMA, transcriptPrompt } from "../prompts.js";
import { parseVideoRef } from "../youtube.js";
import type { Segment, Transcript } from "./transcript.js";

/** For YouTube sources without captions: Gemini listens to the video. Segment times only, no word times. */
export function geminiTranscriptFallback(analyzer: VideoAnalyzer): TranscriptFallback {
  return async (record) => {
    if (record.kind !== "youtube") return undefined;
    const video = parseVideoRef(record.url ?? record.input);
    const result = await analyzer.analyze({
      video,
      prompt: transcriptPrompt(false, undefined),
      detail: "default",
      responseJsonSchema: TRANSCRIPT_SCHEMA,
    });
    const parsed = JSON.parse(result.text) as { language?: string; segments?: { seconds: number; kind?: string; speaker?: string; text: string }[] };
    const speech = (parsed.segments ?? []).filter((s) => s.kind !== "on_screen" && s.text?.trim()).sort((a, b) => a.seconds - b.seconds);
    const segments: Segment[] = speech.map((s, i) => ({
      start: s.seconds,
      end: speech[i + 1]?.seconds ?? s.seconds + 5,
      text: s.text.trim(),
      ...(s.speaker?.trim() && { speaker: s.speaker.trim() }),
    }));
    const transcript: Transcript = { source: "gemini", words: [], segments };
    if (parsed.language) transcript.language = parsed.language;
    return transcript;
  };
}

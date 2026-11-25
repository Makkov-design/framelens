import type { VideoAnalyzer } from "../analyzer.js";
import { AnalyzerError } from "../errors.js";
import type { TranscriptFallback } from "../engine.js";
import { TRANSCRIPT_SCHEMA, transcriptPrompt } from "../prompts.js";
import { oneLine } from "../text.js";
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
    let parsed: { language?: string; segments?: { seconds: number; kind?: string; speaker?: string; text: string }[] };
    try {
      parsed = JSON.parse(result.text) as typeof parsed;
    } catch {
      throw new AnalyzerError("bad_response", "Gemini answered the transcript request with text that is not the expected JSON.");
    }
    const speech = (parsed.segments ?? []).filter((s) => s.kind !== "on_screen" && s.text?.trim()).sort((a, b) => a.seconds - b.seconds);
    const segments: Segment[] = speech.map((s, i) => ({
      start: s.seconds,
      end: speech[i + 1]?.seconds ?? s.seconds + 5,
      // Gemini's answer repeats what is said in a third-party video: one line each, so a line break in it cannot start a
      // heading or a new line of its own in TRANSCRIPT.md.
      text: oneLine(s.text, 4000),
      ...(oneLine(s.speaker, 60) && { speaker: oneLine(s.speaker, 60) }),
    }));
    const transcript: Transcript = { source: "gemini", words: [], segments };
    if (parsed.language) transcript.language = oneLine(parsed.language, 40);
    return transcript;
  };
}

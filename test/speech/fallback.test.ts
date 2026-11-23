import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, type TranscriptFallback } from "../../src/engine.js";
import { AnalyzerError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import { readCaptions, type Transcript } from "../../src/speech/transcript.js";
import type { CaptionTrack, SourceRecord } from "../../src/sources/types.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();

describe("caption files", () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads SubRip times with the decimal comma", () => {
    const file = join(dir, "source.en.srt");
    writeFileSync(file, "1\r\n00:00:01,500 --> 00:00:03,250\r\nHello there\r\n\r\n2\r\n00:01:02,000 --> 00:01:04,000\r\nSecond line\r\n");
    const { segments } = readCaptions(file);
    expect(segments).toEqual([
      { start: 1.5, end: 3.25, text: "Hello there" },
      { start: 62, end: 64, text: "Second line" },
    ]);
  });

  it("skips formats it does not read (TTML, ASS, LRC) instead of returning NaN times", () => {
    const ttml = join(dir, "source.en.ttml");
    writeFileSync(ttml, '<?xml version="1.0"?><tt><body><p begin="00:00:01.000" end="00:00:02.000">Hi --> there</p></body></tt>');
    const ass = join(dir, "source.en.ass");
    writeFileSync(ass, "[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n");
    const lrc = join(dir, "source.en.lrc");
    writeFileSync(lrc, "[00:01.00]Hi\n");
    for (const file of [ttml, ass, lrc]) expect(readCaptions(file)).toEqual({ words: [], segments: [] });
  });

  it("keeps cues apart when the separator line holds only spaces", () => {
    const file = join(dir, "spaces.en.srt");
    writeFileSync(file, "1\n00:00:01,000 --> 00:00:02,000\nA\n  \n2\n00:00:03,000 --> 00:00:04,000\nB\n");
    expect(readCaptions(file).segments.map((s) => s.text)).toEqual(["A", "B"]);
  });

  it("treats a broken json3 file as no captions", () => {
    const file = join(dir, "source.en.json3");
    writeFileSync(file, "{ not json");
    expect(readCaptions(file).segments).toEqual([]);
  });
});

describe.skipIf(!tools)("the Gemini transcript fallback", () => {
  let dir: string;
  let media: string;
  let captionDir: string;
  const geminiTranscript: Transcript = { source: "gemini", language: "en", words: [], segments: [{ start: 0, end: 1, text: "spoken" }] };

  beforeAll(() => {
    dir = tempDir();
    media = join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x64:r=10:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", media]);
    captionDir = join(dir, "captions");
    mkdirSync(captionDir);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function engineWith(fallback: TranscriptFallback, id: string, captions: CaptionTrack[] = []): Engine {
    const record: SourceRecord = { id, kind: "youtube", input: "https://youtu.be/aaaaaaaaaaa", url: "https://youtu.be/aaaaaaaaaaa", mediaPath: media, captions, fetchedAt: new Date().toISOString(), tools: {} };
    return new Engine({ tools: tools!, resolve: async () => record, root: join(dir, ".framelens"), logger: silentLogger, transcriptFallback: fallback });
  }

  it("is not called for frame labels, plan or style; only when the transcript is required", async () => {
    let calls = 0;
    const engine = engineWith(async () => {
      calls++;
      return geminiTranscript;
    }, "yt-optional");
    await engine.frames("x", { at: [0.5] });
    await engine.plan("x", {});
    await engine.style("x", { version: "test" });
    expect(calls).toBe(0);
    const { transcript } = await engine.transcript("x", { required: true });
    expect(transcript?.source).toBe("gemini");
    expect(calls).toBe(1);
  });

  it("remembers a failure that would repeat (the day's quota) for the session, in any language", async () => {
    let calls = 0;
    const engine = engineWith(async () => {
      calls++;
      throw new AnalyzerError("quota", "daily quota exceeded", 429, { scope: "day" });
    }, "yt-failing");
    await expect(engine.transcript("x", { required: true })).rejects.toThrow(/daily quota exceeded.*not tried again/);
    await expect(engine.frames("x", { around: "hello" })).rejects.toThrow(/daily quota exceeded/);
    // The fallback ignores the language, so another language is the same request.
    await expect(engine.transcript("x", { required: true, language: "en" })).rejects.toThrow(/daily quota exceeded/);
    // Optional readers still work: they never needed Gemini.
    await expect(engine.frames("x", { at: [0.5] })).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  it("tries again after a transient failure (overload, timeout, per-minute quota)", async () => {
    const failures = [
      new AnalyzerError("unavailable", "model overloaded", 503),
      new AnalyzerError("timeout", "timed out"),
      new AnalyzerError("quota", "per-minute quota", 429, { scope: "minute" }),
      new Error("socket hang up"),
    ];
    let calls = 0;
    const engine = engineWith(async () => {
      const failure = failures[calls++];
      if (failure) throw failure;
      return geminiTranscript;
    }, "yt-transient");
    for (const failure of failures) {
      const error = await engine.transcript("x", { required: true }).catch((e: Error) => e);
      expect((error as Error).message).toBe(failure.message);
    }
    expect((await engine.transcript("x", { required: true })).transcript?.source).toBe("gemini");
    expect(calls).toBe(5);
  });

  it("rebuilds a cached transcript when captions in the asked language exist", async () => {
    const en = join(captionDir, "source.en.vtt");
    writeFileSync(en, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n");
    const de = join(captionDir, "source.de.vtt");
    writeFileSync(de, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhallo\n");
    const engine = engineWith(async () => undefined, "yt-languages", [
      { path: en, language: "en", auto: false },
      { path: de, language: "de", auto: false },
    ]);
    expect((await engine.transcript("x", { language: "en" })).transcript?.segments[0]?.text).toBe("hello");
    expect((await engine.transcript("x", { language: "de" })).transcript?.segments[0]?.text).toBe("hallo");
    // No language asked: the cached one is kept.
    expect((await engine.transcript("x")).transcript?.language).toBe("de");
    // A language without captions keeps the cache rather than rebuilding to the same result.
    expect((await engine.transcript("x", { language: "fr" })).transcript?.language).toBe("de");
  });
});

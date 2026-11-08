import { describe, expect, it } from "vitest";
import { findPhrase, parseJson3, parseVtt, toMarkdown, wordsAt, type Transcript } from "../../src/speech/transcript.js";

const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "hello" }, { utf8: " big", tOffsetMs: 600 }, { utf8: " world", tOffsetMs: 1200 }] },
    { tStartMs: 2000, dDurationMs: 10, segs: [{ utf8: "\n" }] },
    { tStartMs: 2500, dDurationMs: 1500, segs: [{ utf8: "Second line." }] },
  ],
});

const autoVtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000 align:start position:0%
we<00:00:01.400><c> make</c><00:00:01.900><c> videos</c>

00:00:03.000 --> 00:00:03.010 align:start position:0%
we make videos

00:00:03.010 --> 00:00:05.000 align:start position:0%
we make videos
faster<00:00:03.600><c> now</c>
`;

describe("caption parsing", () => {
  it("reads json3 word offsets and plain segments", () => {
    const { words, segments } = parseJson3(json3);
    expect(words).toEqual([
      { t: 0, end: 0.6, text: "hello" },
      { t: 0.6, end: 1.2, text: "big" },
      { t: 1.2, end: 2, text: "world" },
    ]);
    expect(segments.map((s) => s.text)).toEqual(["hello big world", "Second line."]);
  });

  it("reads YouTube's automatic VTT with inline word times and drops rolling repeats", () => {
    const { words, segments } = parseVtt(autoVtt);
    expect(words.map((w) => `${w.t}:${w.text}`)).toEqual(["1:we", "1.4:make", "1.9:videos", "3.01:faster", "3.6:now"]);
    expect(segments.map((s) => s.text)).toEqual(["we make videos", "faster now"]);
  });
});

describe("using a transcript", () => {
  const transcript: Transcript = { source: "auto-captions", ...parseJson3(json3) };

  it("finds what is said at a moment", () => {
    expect(wordsAt(transcript, 0.7)).toBe("big");
    expect(wordsAt({ ...transcript, words: [] }, 3)).toBe("Second line.");
  });

  it("finds a phrase and its n-th occurrence", () => {
    expect(findPhrase(transcript, "Big, world!")).toEqual({ start: 0.6, end: 2 });
    expect(findPhrase(transcript, "big world", 2)).toBeUndefined();
    expect(findPhrase({ ...transcript, words: [] }, "second line")).toEqual({ start: 2.5, end: 4 });
  });

  it("renders markdown with time marks", () => {
    expect(toMarkdown(transcript, "Demo")).toContain("[0:00] hello big world");
  });
});

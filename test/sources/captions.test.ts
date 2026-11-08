import { describe, expect, it } from "vitest";
import { pickCaptionLanguages, platformName } from "../../src/sources/ytdlp.js";

const tracks = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, [{}]]));

describe("pickCaptionLanguages", () => {
  it("takes the original-language automatic track once", () => {
    expect(pickCaptionLanguages({ language: "en", automatic_captions: tracks("en-orig", "en", "de", "fr") })).toEqual(["en-orig"]);
  });

  it("finds the video's language from the -orig track when the language is unknown", () => {
    expect(pickCaptionLanguages({ automatic_captions: tracks("ru-orig", "ru", "en") })).toEqual(["ru-orig"]);
  });

  it("prefers a person's captions in the video's language and adds English captions a person wrote", () => {
    expect(pickCaptionLanguages({ language: "ru", subtitles: tracks("ru", "en"), automatic_captions: tracks("ru-orig", "ru", "en") })).toEqual(["ru", "en"]);
  });

  it("never asks for machine translations", () => {
    expect(pickCaptionLanguages({ language: "ru", automatic_captions: tracks("ru", "en", "de") })).toEqual(["ru"]);
  });

  it("asks for nothing when the video has no captions", () => {
    expect(pickCaptionLanguages({ language: "en" })).toEqual([]);
  });
});

describe("platformName", () => {
  it("names common platforms and falls back to the host", () => {
    expect(platformName("https://www.instagram.com/reel/x")).toBe("Instagram");
    expect(platformName("https://vm.tiktok.com/abc")).toBe("TikTok");
    expect(platformName("https://x.com/a/status/1")).toBe("X (Twitter)");
    expect(platformName("https://video.example.org/v")).toBe("video.example.org");
    expect(platformName("nonsense")).toBe("this site");
  });
});

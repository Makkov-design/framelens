import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";

const fake = resolve("test/fixtures/fake-ytdlp.mjs");

describe("doctor", () => {
  it("lists found and missing tools with what they unlock, and never touches stdout", async () => {
    const lines: string[] = [];
    const code = await runDoctor({
      env: { FRAMELENS_FFMPEG: fake, FRAMELENS_YTDLP: fake, PATH: "", FRAMELENS_HOME: resolve("test/fixtures/no-home"), FRAMELENS_COOKIES_FROM_BROWSER: "firefox" },
      write: (l) => lines.push(l),
    });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/\[ok\]\s+ffmpeg 0\.0-fake via env/);
    expect(text).toMatch(/\[ok\]\s+yt-dlp 0\.0\.0-fake via env/);
    expect(text).toMatch(/\[missing\] ffprobe/);
    expect(text).toContain("Cookies (opt-in): browser profile");
    expect(text).toContain("Gemini key: not set");
  });

  it("reports a wrong override as a problem instead of crashing", async () => {
    const lines: string[] = [];
    await runDoctor({ env: { FRAMELENS_FFMPEG: "/nope/ffmpeg", PATH: "" }, write: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/\[problem\] ffmpeg: FRAMELENS_FFMPEG points to/);
  });
});

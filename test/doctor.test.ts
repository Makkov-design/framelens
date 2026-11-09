import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";

const fake = resolve("test/fixtures/fake-ytdlp.mjs");

describe("doctor", () => {
  it("lists found and missing tools with what they unlock", async () => {
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
    // FRAMELENS_HOME moves the downloaded tools and fallback workspaces: 2.1.0 left it out of the overrides.
    expect(text).toContain(`Overrides: FRAMELENS_HOME=${resolve("test/fixtures/no-home")}, FRAMELENS_FFMPEG=${fake}, FRAMELENS_YTDLP=${fake}`);
  });

  it("prints its report to stdout, like any command (2.1.0 wrote all of it to stderr)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
    try {
      await runDoctor({ env: { FRAMELENS_FFMPEG: fake, FRAMELENS_YTDLP: fake, PATH: "", FRAMELENS_HOME: resolve("test/fixtures/no-home") } });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(out.join("")).toMatch(/^Frame Lens tools\n/);
    expect(out.join("")).toContain("Workspace folder:");
    expect(err).toEqual([]);
  });

  it("--prepare fetches the pinned ffmpeg only when ffmpeg or ffprobe is missing", async () => {
    const calls: string[] = [];
    const prepareYtDlp = async () => (calls.push("yt-dlp"), { path: "/x/yt-dlp", version: "1", downloaded: true });
    const prepareFfmpeg = async () => (calls.push("ffmpeg"), { ffmpeg: "/x/ffmpeg", ffprobe: "/x/ffprobe", version: "9.0.2", source: "test", downloaded: true });
    const lines: string[] = [];
    await runDoctor({ prepare: true, env: { PATH: "", FRAMELENS_HOME: resolve("test/fixtures/no-home") }, write: (l) => lines.push(l), prepareYtDlp, prepareFfmpeg });
    expect(calls).toEqual(["yt-dlp", "ffmpeg"]);
    expect(lines.join("\n")).toContain("FFmpeg 9.0.2 (test) installed and verified.");
    calls.length = 0;
    await runDoctor({ prepare: true, env: { PATH: "", FRAMELENS_FFMPEG: fake, FRAMELENS_FFPROBE: fake }, write: () => {}, prepareYtDlp, prepareFfmpeg });
    expect(calls).toEqual(["yt-dlp"]);
  });

  it("reports a wrong override as a problem instead of crashing", async () => {
    const lines: string[] = [];
    await runDoctor({ env: { FRAMELENS_FFMPEG: "/nope/ffmpeg", PATH: "" }, write: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/\[problem\] ffmpeg: FRAMELENS_FFMPEG points to/);
  });
});

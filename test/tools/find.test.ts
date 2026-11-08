import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findTool, readToolVersion, requireTool } from "../../src/tools/find.js";
import { ytDlpPinnedPath, YTDLP_PIN } from "../../src/tools/ytdlp.js";

const root = mkdtempSync(join(tmpdir(), "framelens-find-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const win = process.platform === "win32";
const exe = (name: string) => (win ? `${name}.exe` : name);

function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, exe(name));
  writeFileSync(path, "x");
  if (!win) chmodSync(path, 0o755);
  return path;
}

describe("findTool", () => {
  it("prefers the FRAMELENS_* override and complains when it is wrong", () => {
    const path = fakeBinary(join(root, "env"), "ffmpeg");
    expect(findTool("ffmpeg", { env: { FRAMELENS_FFMPEG: path, PATH: "" } })).toEqual({ name: "ffmpeg", path, source: "env" });
    expect(() => findTool("ffmpeg", { env: { FRAMELENS_FFMPEG: join(root, "missing") } })).toThrow(/FRAMELENS_FFMPEG/);
  });

  it("reads the legacy YTLENS_ name", () => {
    const path = fakeBinary(join(root, "legacy"), "ffprobe");
    expect(findTool("ffprobe", { env: { YTLENS_FFPROBE: path } })?.source).toBe("env");
  });

  it("finds a tool on the PATH, with quotes and empty entries", () => {
    const dir = join(root, "onpath");
    const path = fakeBinary(dir, "ffmpeg");
    const sep = win ? ";" : ":";
    expect(findTool("ffmpeg", { env: { PATH: `${sep}"${dir}"${sep}` } })).toEqual({ name: "ffmpeg", path, source: "path" });
    expect(findTool("ffmpeg", { env: { PATH: join(root, "empty") } })).toBeUndefined();
  });

  it("uses the pinned yt-dlp before the PATH", () => {
    const home = join(root, "home");
    const pinned = ytDlpPinnedPath(home)!;
    const dir = join(pinned, "..");
    fakeBinary(dir, "yt-dlp");
    const other = fakeBinary(join(root, "other"), "yt-dlp");
    const location = findTool("yt-dlp", { env: { FRAMELENS_HOME: home, PATH: join(root, "other") } });
    expect(location).toEqual({ name: "yt-dlp", path: pinned, source: "pinned" });
    expect(other).not.toBe(pinned);
    expect(pinned).toContain(YTDLP_PIN.version);
  });

  it("looks in WinGet's link and package folders on Windows", () => {
    const local = join(root, "local");
    const pkg = join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_x", "ffmpeg-9.0-full_build", "bin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "ffmpeg.exe"), "x");
    const found = findTool("ffmpeg", { env: { PATH: "", LOCALAPPDATA: local }, platform: "win32" });
    expect(found?.source).toBe("winget");
    expect(found?.path).toBe(join(pkg, "ffmpeg.exe"));
    writeFileSync(join(local, "Microsoft", "WinGet", "Packages", "link.txt"), "");
    mkdirSync(join(local, "Microsoft", "WinGet", "Links"), { recursive: true });
    writeFileSync(join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"), "x");
    expect(findTool("ffmpeg", { env: { PATH: "", LOCALAPPDATA: local }, platform: "win32" })?.path).toContain("Links");
  });

  it("requireTool explains how to get a missing tool", () => {
    expect(() => requireTool("yt-dlp", { env: { PATH: "", FRAMELENS_HOME: join(root, "nohome") }, platform: "linux" })).toThrow(/doctor --prepare/);
    expect(() => requireTool("ffmpeg", { env: { PATH: "" }, platform: "linux" })).toThrow(/FRAMELENS_FFMPEG/);
  });

  it("reads a version from a script standing in for yt-dlp", async () => {
    const script = join(root, "fake-ytdlp.mjs");
    writeFileSync(script, "console.log('2099.01.01')");
    expect(await readToolVersion({ name: "yt-dlp", path: script, source: "env" })).toBe("2099.01.01");
  });
});

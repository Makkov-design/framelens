import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegAsset, FFMPEG_PIN, prepareFfmpeg } from "../../src/tools/ffmpeg.js";

// The real pinned download (100+ MB): only on request, FRAMELENS_REAL_DOWNLOAD=1, never in CI's normal run.
const enabled = Boolean(process.env.FRAMELENS_REAL_DOWNLOAD && ffmpegAsset());

describe.skipIf(!enabled)("the real pinned ffmpeg for this computer", () => {
  it("downloads, verifies and unpacks a working ffmpeg and ffprobe into a temporary home", async () => {
    const home = mkdtempSync(join(tmpdir(), "framelens-real-ffmpeg-"));
    try {
      const lines: string[] = [];
      const result = await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, log: (l) => lines.push(l) });
      expect(result.downloaded).toBe(true);
      expect(lines.join("\n")).toContain(`ffmpeg ${FFMPEG_PIN.version}`);
      // Running the downloaded program happens only here, in the test, after both hashes matched.
      expect(execFileSync(result.ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true })).toContain(`ffmpeg version ${FFMPEG_PIN.version}`);
      expect(execFileSync(result.ffprobe, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true })).toContain(`ffprobe version ${FFMPEG_PIN.version}`);
      expect((await prepareFfmpeg({ env: { FRAMELENS_HOME: home } })).downloaded).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 600_000);
});

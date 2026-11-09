// Regressions found by measuring Frame Lens's own HyperFrames demo (origin/demo/2.1, scripts/demo/CHECK.md).
// Each test failed before its fix.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLoudnessLog } from "../src/audio/analyze.js";
import { parseSsim } from "../src/compare/compare.js";
import { Engine, localFileResolver } from "../src/engine.js";
import { silentLogger } from "../src/logger.js";
import { parseSceneScores } from "../src/media/boundaries.js";
import { parseShowinfo } from "../src/media/frames.js";
import { classifyChanges, energySpikeCuts, parseEnergy, parseFrameTimes, type PictureFrames } from "../src/style/motion.js";
import { mediaTools, tempDir } from "./media/fixtures.js";

describe("bug 1: ffmpeg numbers in scientific notation", () => {
  it("reads signalstats averages like 6.94444e-05 as tiny, not as 6.9", () => {
    const text = "frame:0 pts:1 pts_time:11.8\nlavfi.signalstats.YAVG=6.94444e-05\nlavfi.signalstats.UAVG=0\nlavfi.signalstats.VAVG=1.38889e-04\n";
    const [sample] = parseEnergy(text);
    expect(sample!.t).toBe(11.8);
    expect(sample!.energy).toBeLessThan(0.001);
    // Six such frames in a still film were six false cuts.
    const still = Array.from({ length: 60 }, (_, i) => ({ t: i / 30, energy: 0.0001 }));
    still[30] = { t: 1, energy: parseEnergy(text)[0]!.energy };
    expect(energySpikeCuts(still)).toEqual([]);
  });

  it("reads exponents in every ffmpeg log Frame Lens parses", () => {
    expect(parseSceneScores("frame:1 pts:2 pts_time:1e-01\nlavfi.scene_score=3.2e-05\n")).toEqual([{ t: 0.1, score: 0.000032 }]);
    expect(parseFrameTimes("frame:0 pts:0 pts_time:2.5e+00\n")).toEqual([2.5]);
    expect(parseShowinfo("[Parsed_showinfo_1 @ 0x1] n:0 pts:1 pts_time:1.5e-02 duration:1\n")).toEqual([0.015]);
    expect(parseSsim("n:1 Y:0.9 U:0.9 V:0.9 All:9.5e-01 (13.0)", 1)).toEqual([{ t: 0, ssim: 0.95 }]);
    const loud = parseLoudnessLog("[Parsed_ebur128_0 @ 0x1] t: 1e-01 TARGET:-23 LUFS M: -2.35e+01 S:-120.7\n[silencedetect @ 0x2] silence_start: 1.2e+00\n[silencedetect @ 0x2] silence_end: 2.5e+00 | silence_duration: 1.3\n", 0);
    expect(loud.loudness).toEqual([{ t: 0.1, lufs: -23.5 }]);
    expect(loud.silences).toEqual([{ start: 1.2, end: 2.5 }]);
  });
});

/** Tiny frames: one flat grey level per frame (enough to tell pictures apart). */
function flatFrames(levels: number[], fps: number): PictureFrames {
  const size = 64 * 36 * 3;
  const data = new Uint8Array(levels.length * size);
  levels.forEach((v, k) => data.fill(v, k * size, (k + 1) * size));
  return { width: 64, height: 36, times: levels.map((_, k) => Math.round((k / fps) * 1000) / 1000), data };
}

describe("bug 2: a 2–3 frame shot between two cuts is not a flash", () => {
  const fps = 30;
  // Two isolated spikes three frames apart (frames 10 and 13), as in the demo's montage (energy 38.9 and 22.6).
  const energy = Array.from({ length: 30 }, (_, i) => ({ t: Math.round((i / fps) * 1000) / 1000, energy: i === 10 ? 38.9 : i === 13 ? 22.6 : 0.1 }));
  const candidates = [{ t: energy[10]!.t, score: 0.9 }, { t: energy[13]!.t, score: 0.6 }];

  it("calls them two cuts when the picture after them is a third one", () => {
    // Shot A (frames 0–9), a three-frame shot B (10–12), shot C (13–).
    const frames = flatFrames(Array.from({ length: 30 }, (_, i) => (i < 10 ? 40 : i < 13 ? 120 : 200)), fps);
    // The 10 Hz samples of both cuts point at the larger spike; the second cut comes from the per-frame spikes.
    expect(classifyChanges(candidates, energy, fps, 0.1, frames).map((c) => c.kind)).toEqual(["cut"]);
    expect(energySpikeCuts(energy, 6, frames).map((c) => Math.round(c.t * fps))).toEqual([10, 13]);
  });

  it("still calls them a flash when the picture comes back", () => {
    const frames = flatFrames(Array.from({ length: 30 }, (_, i) => (i >= 10 && i < 13 ? 250 : 40)), fps);
    expect(classifyChanges(candidates, energy, fps, 0.1, frames).map((c) => c.kind)).toEqual(["flash"]);
    expect(energySpikeCuts(energy, 6, frames)).toEqual([]);
  });
});

const tools = mediaTools();

describe.skipIf(!tools)("bug 2 on encoded video: a montage of 2–3 frame shots, and flashes", () => {
  let dir: string;
  let video: string;

  beforeAll(() => {
    dir = tempDir();
    video = join(dir, "montage.mp4");
    // 30 fps: red 1 s, then shots of 3, 2, 3 and 2 frames, then grey 1 s with a 2-frame white flash in it, then blue.
    const shot = (colour: string, frames: number) => `color=c=${colour}:s=320x180:r=30:d=${frames / 30}`;
    const parts = [shot("0xE0402F", 30), shot("0x2F6FE0", 3), shot("0x2FE07A", 2), shot("0xE0C02F", 3), shot("0x8F2FE0", 2), shot("0x808080", 15), shot("0xFFFFFF", 2), shot("0x808080", 15), shot("0x2040A0", 30)];
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      ...parts.flatMap((p) => ["-f", "lavfi", "-i", p]),
      "-filter_complex", `${parts.map((_, i) => `[${i}:v]`).join("")}concat=n=${parts.length}:v=1:a=0,format=yuv420p[v]`,
      "-map", "[v]", "-c:v", "libx264", "-qp", "8", "-pix_fmt", "yuv420p", video,
    ], { windowsHide: true, timeout: 60_000 });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds every montage cut on its frame and does not call the flash a cut", async () => {
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const { spec } = await engine.style(video, { version: "test" });
    // Shot starts: 30, 33, 35, 38, then grey at 40; the flash at 55–56 is not a cut; blue at 72.
    expect(spec.anchors.cuts.map((c) => Math.round(c.t * 30))).toEqual([30, 33, 35, 38, 40, 72]);
  }, 60_000);
});

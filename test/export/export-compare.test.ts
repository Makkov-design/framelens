import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchCuts, paletteDistance, parseSsim } from "../../src/compare/compare.js";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { cutsVideo, mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();

describe("compare helpers", () => {
  it("matches cuts within a tolerance and reports offsets", () => {
    expect(matchCuts([2, 4, 6], [2.04, 4.4, 8], 25, 3)).toEqual({
      matched: [{ reference: 2, render: 2.04, offsetFrames: 1 }, { reference: 4 }, { reference: 6 }],
      missing: [4, 6],
      extra: [4.4, 8],
    });
  });

  it("measures palette distance and parses ssim stats", () => {
    const red = { hex: "#FF0000", share: 1, lightness: 0.6, chroma: 0.25 };
    expect(paletteDistance([red], [red])).toBe(0);
    expect(paletteDistance([red], [{ ...red, hex: "#0000FF" }])).toBeGreaterThan(0.3);
    expect(parseSsim("n:1 Y:0.9 U:0.9 V:0.9 All:0.95 (13.0)\nn:2 Y:0.5 U:0.5 V:0.5 All:0.4 (2.2)", 4)).toEqual([
      { t: 0, ssim: 0.95 },
      { t: 0.25, ssim: 0.4 },
    ]);
  });
});

describe.skipIf(!tools)("export and compare on real files", () => {
  let dir: string;
  let reference: string;
  let shifted: string;
  let engine: Engine;

  beforeAll(() => {
    dir = tempDir();
    reference = cutsVideo(dir);
    // The same three cards, but the first cut lands 0.4 s late and the last card is a different green.
    shifted = join(dir, "render.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0xE0402F:s=320x180:r=25:d=2.4",
      "-f", "lavfi", "-i", "color=c=0x2F6FE0:s=320x180:r=25:d=1.6",
      "-f", "lavfi", "-i", "color=c=0x1F8040:s=320x180:r=25:d=2",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", shifted,
    ], { windowsHide: true });
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes starter projects for every renderer with the measured timing", async () => {
    const hf = await engine.export(reference, "hyperframes", "test");
    const index = readFileSync(hf.files.find((f) => f.endsWith("index.html"))!, "utf8");
    expect(index).toContain('data-composition-src="compositions/shot-2.html"');
    expect(index).toMatch(/id="shot-2"[\s\S]*?data-start="2"/);
    const scene = readFileSync(hf.files.find((f) => f.endsWith("shot-1.html"))!, "utf8");
    expect(scene).toContain('window.__timelines["shot-1"] = tl;');
    expect(scene).toMatch(/class="clip" data-start="[\d.]+" data-duration="[\d.]+"/);

    const remotion = await engine.export(reference, "remotion", "test");
    const timing = readFileSync(remotion.files.find((f) => f.endsWith("timing.ts"))!, "utf8");
    expect(timing).toContain("export const FPS = 25;");
    expect(timing).toContain("export const CUTS = [50,100];");

    const css = await engine.export(reference, "css", "test");
    expect(css.files.every((f) => existsSync(f))).toBe(true);
    expect(readFileSync(css.files.find((f) => f.endsWith("tokens.css"))!, "utf8")).toMatch(/--fl-color-1: #/);
  });

  it("finds nothing wrong when a video is compared with itself", async () => {
    const { comparison } = await engine.compare(reference, reference, "test");
    expect(comparison.cuts.missing).toEqual([]);
    expect(comparison.cuts.extra).toEqual([]);
    expect(comparison.similarity.mean).toBeGreaterThan(0.97);
    expect(comparison.verdict).toEqual(["Structure, timing and colour match the reference within tolerance."]);
    // Two full style passes and a similarity pass on real files: about 4 s, more on a busy machine.
  }, 30_000);

  it("names the late cut and the colour drift of a render", async () => {
    const { comparison, files, sheet } = await engine.compare(reference, shifted, "test");
    expect(comparison.cuts.missing).toEqual([2]);
    expect(comparison.cuts.extra.map((t) => Math.round(t * 10) / 10)).toEqual([2.4]);
    expect(comparison.similarity.worst[0]!.t).toBeGreaterThanOrEqual(2);
    expect(comparison.verdict.join(" ")).toMatch(/Missing cuts at 2\.00 s/);
    expect(existsSync(files.report!)).toBe(true);
    expect(sheet && existsSync(sheet.file)).toBe(true);
  }, 30_000);
});

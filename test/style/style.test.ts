import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { classifyChanges, easingFromProfile, motionEvents, parseEnergy } from "../../src/style/motion.js";
import { mergePalettes, oklabToHex, palette, rgbToOklab } from "../../src/style/palette.js";
import { shotsFromCuts } from "../../src/style/spec.js";
import { cutsVideo, mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();

function solid(r: number, g: number, b: number, n: number): number[] {
  return Array.from({ length: n }, () => [r, g, b]).flat();
}

describe("palette", () => {
  it("round-trips sRGB through OKLab", () => {
    expect(oklabToHex(rgbToOklab(0xe0, 0x40, 0x2f))).toBe("#E0402F");
    expect(oklabToHex(rgbToOklab(255, 255, 255))).toBe("#FFFFFF");
  });

  it("finds dominant colours with their shares and merges near-duplicates", () => {
    const pixels = Buffer.from([...solid(14, 15, 26, 60), ...solid(242, 233, 78, 30), ...solid(243, 233, 79, 10)]);
    const swatches = palette(pixels, 4);
    expect(swatches.map((s) => s.hex)).toEqual(["#0E0F1A", expect.stringMatching(/^#F2E9/)]);
    expect(swatches[0]!.share).toBeCloseTo(0.6, 2);
    expect(swatches[1]!.share).toBeCloseTo(0.4, 2);
    expect(swatches[0]!.chroma).toBeLessThan(0.05);
  });

  it("weights shot palettes by screen time", () => {
    const merged = mergePalettes([
      { swatches: [{ hex: "#FF0000", share: 1, lightness: 0.6, chroma: 0.25 }], weight: 3 },
      { swatches: [{ hex: "#0000FF", share: 1, lightness: 0.45, chroma: 0.3 }], weight: 1 },
    ]);
    expect(merged.map((m) => [m.hex, m.share])).toEqual([["#FF0000", 0.75], ["#0000FF", 0.25]]);
  });
});

describe("motion", () => {
  it("reads the easing family from where a move is fastest", () => {
    expect(easingFromProfile([1, 9, 7, 5, 3, 2, 1]).easing).toBe("ease-out");
    expect(easingFromProfile([1, 2, 3, 5, 7, 9, 1]).easing).toBe("ease-in");
    expect(easingFromProfile([1, 3, 7, 9, 7, 3, 1]).easing).toBe("ease-in-out");
    expect(easingFromProfile([5, 5.2, 4.9, 5.1, 5]).easing).toBe("linear");
  });

  it("finds moves and leaves cut spikes out", () => {
    const quiet = (t: number) => ({ t, energy: 0.1 });
    const samples = [
      ...[0, 1, 2, 3].map((i) => quiet(i / 25)),
      { t: 0.16, energy: 40 }, // a cut: one frame
      ...[5, 6, 7].map((i) => quiet(i / 25)),
      ...[4, 10, 6, 3, 1.5, 1].map((energy, i) => ({ t: (8 + i) / 25, energy })),
      ...[14, 15, 16, 17].map((i) => quiet(i / 25)),
    ];
    const events = motionEvents(samples, [0.16], 25);
    expect(events).toHaveLength(1);
    // The first changed frame is 0.32 s, so the move began on the frame before it.
    expect(events[0]).toMatchObject({ start: 0.28, frames: 6, easing: "ease-out", suggestion: "cubic-bezier(0.16, 1, 0.3, 1)" });
  });

  it("tells cuts from fast motion and flashes", () => {
    const f = (i: number) => i / 25;
    const energy = Array.from({ length: 60 }, (_, i) => ({ t: f(i), energy: 0.1 }));
    energy[10]!.energy = 80; // cut: one spike
    for (const i of [30, 31, 32, 33]) energy[i]!.energy = 30; // motion: several frames
    energy[50]!.energy = 60; // flash: in and out
    energy[52]!.energy = 60;
    const kinds = classifyChanges(
      [{ t: f(11), score: 0.9 }, { t: f(31), score: 0.5 }, { t: f(50), score: 0.6 }, { t: f(53), score: 0.6 }],
      energy,
      25,
    ).map((c) => `${c.kind}@${Math.round(c.t * 25)}`);
    expect(kinds).toEqual(["cut@10", "motion@31", "flash@50", "flash@52"]);
  });

  it("parses signalstats output", () => {
    expect(parseEnergy("frame:1 pts:1 pts_time:0.04\nlavfi.signalstats.YAVG=3.5\n")).toEqual([{ t: 0.04, energy: 3.5 }]);
  });

  it("splits shots at cuts and merges slivers", () => {
    expect(shotsFromCuts([2, 2.02, 4], { start: 0, end: 6 }, 25)).toEqual([
      { start: 0, end: 2.02 },
      { start: 2.02, end: 4 },
      { start: 4, end: 6 },
    ]);
  });
});

describe.skipIf(!tools)("style on a real video", () => {
  let dir: string;
  let video: string;

  beforeAll(() => {
    dir = tempDir();
    const cuts = cutsVideo(dir);
    // Append 2 s of a white box sliding across black with a decelerating move, so there is motion to find.
    const slide = join(dir, "slide.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "color=c=white:s=60x60:r=25:d=2",
      "-filter_complex", "[0][1]overlay=x='if(lt(t,0.2),0,if(lt(t,1.2),260*(1-pow(1-(t-0.2),3)),260))':y=60:eval=frame",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", slide,
    ], { windowsHide: true });
    video = join(dir, "reference.mp4");
    const list = join(dir, "list.txt");
    writeFileSync(list, `file '${cuts.replaceAll("\\", "/")}'\nfile '${slide.replaceAll("\\", "/")}'\n`);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { windowsHide: true });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a spec with cuts, palette and an eased move, and keeps hand-written text on re-run", async () => {
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const { spec, files } = await engine.style(video, { version: "test" });

    expect(spec.anchors.cuts.map((c) => Math.round(c.t))).toEqual([2, 4, 6]);
    expect(spec.shots).toHaveLength(4);
    // The red card survives compression within a small OKLab distance.
    const red = rgbToOklab(0xe0, 0x40, 0x2f);
    const distance = (hex: string) => {
      const lab = rgbToOklab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
      return Math.hypot(lab[0] - red[0], lab[1] - red[1], lab[2] - red[2]);
    };
    expect(Math.min(...spec.palette.map((p) => distance(p.hex)))).toBeLessThan(0.05);
    const move = spec.events.find((e) => e.start >= 6.1 && e.start < 6.5);
    expect(spec.changes.some((c) => c.kind === "motion" && c.t > 6 && c.t < 6.6)).toBe(true);
    expect(move).toBeDefined();
    expect(move!.easing).toBe("ease-out");
    expect(move!.evidence).toBe("derived");

    for (const file of Object.values(files)) expect(existsSync(file)).toBe(true);
    writeFileSync(files.style!, readFileSync(files.style!, "utf8").replace("One sentence on the look and feel (to write after looking at the sheets).", "Flat colour cards, hard cuts."));
    await engine.style(video, { version: "test" });
    const style = readFileSync(files.style!, "utf8");
    expect(style).toContain("Flat colour cards, hard cuts.");
    expect(style.match(/## Measured/g)).toHaveLength(1);
  });
});

// A real film: the Big Buck Bunny trailer (CC BY 3.0, Blender Foundation), 1920×1080 at 25 fps, 33 s, with title
// cards on white that dissolve to and from the film, a montage of dips to black, and a flash to white. Not in the
// repository: set FRAMELENS_REAL_CLIP to its path (or keep it at the default below); skipped when it is absent.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import type { MotionSpec } from "../../src/style/spec.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const clip = process.env.FRAMELENS_REAL_CLIP ?? "D:/RE-work/framelens-site-material/bbb-trailer.mp4";
const tools = mediaTools();
const frame = 0.04;
const near = (a: number, b: number, frames = 1) => Math.abs(a - b) <= frames * frame + 1e-6;

describe.skipIf(!tools || !existsSync(clip))("style on the Big Buck Bunny trailer", () => {
  let dir: string;
  let engine: Engine;
  let spec: MotionSpec;

  beforeAll(async () => {
    dir = tempDir();
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    spec = (await engine.style(clip, { version: "test" })).spec;
  }, 120_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the hard cuts exactly where 2.0 found them", () => {
    expect(spec.anchors.cuts.map((c) => c.t)).toEqual([9.08, 11.2, 13.2, 13.88, 15, 16, 16.6, 24.92, 26, 29.96, 31.04]);
  });

  it("lists every move once and none across a transition", () => {
    const keys = spec.events.map((e) => `${e.start}|${e.end}|${e.frames}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of spec.transitions!.filter((t) => t.kind !== "cut")) {
      expect(spec.events.filter((e) => e.start < x.end - frame / 2 && e.end > x.start + frame / 2)).toEqual([]);
    }
  });

  it("reads the title cards' dissolves and the montage's dips to black as transitions, not moves", () => {
    const gradual = spec.transitions!.filter((x) => x.kind !== "cut");
    const dissolves = gradual.filter((x) => x.kind === "dissolve");
    expect(dissolves).toHaveLength(2);
    expect(near(dissolves[0]!.start, 3.48) && near(dissolves[0]!.end, 4.44)).toBe(true);
    expect(near(dissolves[1]!.start, 6.24) && near(dissolves[1]!.end, 7.12)).toBe(true);
    const dips = gradual.filter((x) => x.kind === "dip" && x.via === "black");
    expect(dips.map((x) => x.at)).toEqual([18.88, 19.88, 20.88, 21.88, 22.88]);
    for (const x of gradual) expect(x.evidence).toBe("derived");
  });

  it("finds the opening title's fade from white and the end card's fade to white, without splitting those shots", () => {
    const gradual = spec.transitions!.filter((x) => x.kind !== "cut");
    const opening = gradual.find((x) => x.kind === "fade-in" && x.via === "white");
    expect(opening).toBeDefined();
    expect(opening!.start).toBe(0);
    expect(near(opening!.end, 0.84, 2)).toBe(true);
    const ending = gradual.find((x) => x.kind === "fade-out" && x.via === "white");
    expect(ending).toBeDefined();
    expect(near(ending!.start, 32.04, 1)).toBe(true);
    // Neither starts a shot: 20 shots, as with the dissolves, dips and cuts alone.
    expect(spec.shots).toHaveLength(20);
  });

  it("splits the shots at them, so the title cards are shots of their own, white", () => {
    const starts = spec.shots.map((s) => s.start);
    for (const t of [3.92, 6.76, 18.88, 19.88, 20.88, 21.88, 22.88]) expect(starts.some((s) => near(s, t))).toBe(true);
    const white = (hex: string) => [1, 3, 5].every((i) => parseInt(hex.slice(i, i + 2), 16) >= 0xf0);
    // The opening card, "ONE BIG RABBIT", "AND ONE GIANT PAYBACK" and "GET READY": white backgrounds.
    for (const t of [1, 8, 17.5, 24]) expect(white(spec.shots.find((s) => t >= s.start && t < s.end)!.palette[0]!)).toBe(true);
    // The forest between the two dissolves is not.
    expect(white(spec.shots.find((s) => 5 >= s.start && 5 < s.end)!.palette[0]!)).toBe(false);
  });

  it("25.9–27.1 s: the cut to the rabbit, its flash to white, the logo's scale-in, apart", () => {
    // Checked frame by frame: cut at 26.00 s, the rabbit shot goes white at 26.68–26.76 s (f667 partly white, f668–f669
    // white), the logo scales in from 26.80 s and rests at about 26.92 s.
    expect(spec.anchors.cuts.some((c) => c.t === 26)).toBe(true);
    const flash = spec.transitions!.find((x) => x.via === "white" && x.start > 26 && x.end < 27);
    expect(flash).toBeDefined();
    expect(flash!.at).toBeGreaterThanOrEqual(26.72);
    expect(flash!.at).toBeLessThanOrEqual(26.76);
    expect(spec.shots.some((s) => near(s.start, flash!.at, 0))).toBe(true);
    const around = spec.events.filter((e) => e.end > 25.9 && e.start < 27.1);
    // No single move across the flash, as 2.0 reported (26.04–26.96 s, ease-in).
    expect(around.some((e) => e.start < 26.68 && e.end > 26.76)).toBe(false);
    expect(around.some((e) => e.start >= 26.76 && e.end <= 27)).toBe(true);
  });

  it("plans the style analysis within bounds", async () => {
    const { plan } = await engine.plan(clip, { goal: "style" });
    expect(plan.estimate.frames).toBeLessThan(350);
    expect(plan.estimate.imageTokens).toBeLessThan(35_000);
    const dense = plan.steps.filter((s) => s.args.every_frame).map((s) => [s.args.start as number, s.args.end as number]);
    for (let i = 1; i < dense.length; i++) expect(dense[i]![0]).toBeGreaterThan(dense[i - 1]![1]!);
    const tracked = plan.steps.filter((s) => s.tool === "track").map((s) => s.args.move);
    expect(new Set(tracked).size).toBe(tracked.length);
  }, 60_000);

  it("exports the transitions and animates titles only where a move was measured", async () => {
    const { files } = await engine.export(clip, "css", "test");
    const css = readFileSync(files.find((f) => f.endsWith("motion.css"))!, "utf8");
    expect(css).toContain("#shot-1 h1 { color:");
    expect(css).not.toMatch(/#shot-1 h1 \{[^}]*animation/);
    expect(css).toMatch(/@keyframes fl-show-2 [^\n]*\/\* dissolve, derived from the reference \*\//);
    expect(css).toMatch(/#shot-11 \.fl-veil-in \{ background: #000000;/);
    expect(css).toMatch(/#shot-11 \.fl-veil-out \{ background: #000000;/);
    const moving = spec.shots.filter((s) => spec.events.some((e) => e.start >= s.start && e.start < s.end)).length;
    expect(css.match(/animation: fl-enter/g)?.length ?? 0).toBe(moving);
  }, 60_000);
});

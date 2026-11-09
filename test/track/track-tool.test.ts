import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bezierAt, clipFrames, encode, springAt } from "../../scripts/synth.mjs";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import type { MotionSpec } from "../../src/style/spec.js";
import type { TrackedMove } from "../../src/track/run.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();
const FPS = 30;
const CUSTOM: [number, number, number, number] = [0.7, 0.1, 0.2, 0.95];

describe.skipIf(!tools)("track end to end", () => {
  let dir: string;
  let bezierClip: string;
  let springClip: string;
  let engine: Engine;

  beforeAll(async () => {
    dir = tempDir();
    // 2.4 s: rest, a 24-frame move with a custom bezier from frame 15, rest.
    bezierClip = await encode(join(dir, "bezier.mp4"), clipFrames({ width: 320, height: 180, total: 72, size: 36, from: [60, 90], to: [260, 90], progress: (i) => bezierAt(CUSTOM, (i - 15) / 24) }), {
      width: 320,
      height: 180,
      fps: FPS,
      timeoutMs: 30_000,
    });
    // 2 s: a bouncy spring (stiffness 200, damping 14) moving down, starting at frame 9.
    springClip = await encode(join(dir, "spring.mp4"), clipFrames({ width: 320, height: 180, total: 60, size: 30, from: [160, 40], to: [160, 120], progress: (i) => springAt(200, 14, (i - 9) / FPS) }), {
      width: 320,
      height: 180,
      fps: FPS,
      timeoutMs: 30_000,
    });
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the element, fits the bezier and writes the report", async () => {
    const { track, files } = await engine.track(bezierClip, { start: 0, end: 2.4 });
    expect(track.element.auto).toBe(true);
    const x = track.properties.find((p) => p.property === "x")!;
    expect(track.primary).toBe("x");
    expect(x.curve.kind).toBe("bezier");
    if (x.curve.kind === "bezier") x.curve.bezier.forEach((c, i) => expect(Math.abs(c - CUSTOM[i]!), `control ${i}`).toBeLessThan(0.05));
    expect(Math.abs(x.frames - 24)).toBeLessThan(1);
    expect(Math.abs(x.start - 15 / FPS)).toBeLessThan(1 / FPS);
    expect(x.from).toBeCloseTo(60, 0);
    expect(x.to).toBeCloseTo(260, 0);
    expect(track.properties.map((p) => p.property)).toEqual(["x"]); // y, scale and opacity do not change
    expect(track.evidence).toBe("measured");
    expect(x.evidence).toBe("derived");
    for (const f of [files.tracks, files.svg, files.report]) expect(existsSync(f!)).toBe(true);
    const md = readFileSync(files.report!, "utf8");
    expect(md).toContain("cubic-bezier(");
    expect(md).toMatch(/\| x \(primary\) \|/);
    expect(readFileSync(files.svg!, "utf8")).toMatch(/^<svg/);
  }, 60_000);

  it("reads a spring, and style + track + export carry the curve through", async () => {
    await engine.style(springClip, { version: "test" });
    const { track, files, note } = await engine.track(springClip, { move: 1 });
    expect(note).toMatch(/style move 1/);
    const y = track.properties.find((p) => p.property === "y")!;
    expect(y.curve.kind).toBe("spring");
    if (y.curve.kind === "spring") {
      expect(Math.abs(y.curve.stiffness - 200) / 200).toBeLessThan(0.1);
      expect(Math.abs(y.curve.damping - 14) / 14).toBeLessThan(0.1);
    }
    const spec = JSON.parse(readFileSync(files.spec!, "utf8")) as MotionSpec;
    expect(spec.tracks?.map((t) => t.id)).toEqual([track.id]);
    expect(spec.events[0]!.track).toBe(track.id);
    expect(spec.events[0]!.curve).toMatch(/^linear\(/);
    // A new style pass keeps the tracks.
    await engine.style(springClip, { version: "test" });
    const again = JSON.parse(readFileSync(files.spec!, "utf8")) as MotionSpec;
    expect(again.tracks?.length).toBe(1);
    // Tracking the same window again replaces the track instead of adding one.
    await engine.track(springClip, { move: 1 });
    const tracks = JSON.parse(readFileSync(files.tracks!, "utf8")) as TrackedMove[];
    expect(tracks).toHaveLength(1);
    const { files: exported } = await engine.export(springClip, "remotion", "test");
    const timing = readFileSync(exported.find((f) => f.endsWith("timing.ts"))!, "utf8");
    expect(timing).toMatch(/"spring": \{\s*"stiffness"/);
  }, 90_000);

  it("refuses empty windows, missing moves and tiny boxes", async () => {
    await expect(engine.track(bezierClip, { start: 5, end: 6 })).rejects.toThrow(/empty or outside/);
    await expect(engine.track(bezierClip, { move: 1 })).rejects.toThrow(/Pass start and end|style/);
    await expect(engine.track(bezierClip, { start: 0, end: 1, box: { x: 10, y: 10, w: 1, h: 1 } })).rejects.toThrow(/too small/);
    await expect(engine.track(bezierClip, { start: 0, end: 0.5 })).rejects.toThrow(/Nothing moves/);
  }, 60_000);

  it("tracks from a box given in fractions of the frame", async () => {
    const { track } = await engine.track(bezierClip, { start: 0.2, end: 2.2, box: { x: 42 / 320, y: 72 / 180, w: 36 / 320, h: 36 / 180 } });
    expect(track.element.auto).toBe(false);
    const x = track.properties.find((p) => p.property === "x")!;
    expect(Math.abs(x.frames - 24)).toBeLessThan(1);
  }, 60_000);
});

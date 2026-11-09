// `track move:n` padded the style move by 0.3 s and 0.4 s without looking at the cuts: the trailer's move 1
// (13.24–13.80 s) was read over 12.94–14.20 s, across the cuts at 13.20 and 13.88, and `auto` said "Nothing moves".
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bezierAt, clipFrames, encode } from "../../scripts/synth.mjs";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();
const W = 320;
const H = 180;

/** 4 s at 30 fps: a flat shot, a shot where a square moves from 1.1 s, another flat shot from 3 s. */
function* threeShots(): Generator<Uint8Array> {
  for (let i = 0; i < 30; i++) yield new Uint8Array(W * H).fill(200);
  yield* clipFrames({ width: W, height: H, total: 60, size: 36, from: [60, 90], to: [260, 90], progress: (i: number) => bezierAt([0.22, 1, 0.36, 1], (i - 3) / 48) });
  for (let i = 0; i < 30; i++) yield new Uint8Array(W * H).fill(120);
}

describe.skipIf(!tools)("track windows stay inside their shot", () => {
  let dir: string;
  let clip: string;
  let engine: Engine;

  beforeAll(async () => {
    dir = tempDir();
    clip = await encode(join(dir, "three-shots.mp4"), threeShots(), { width: W, height: H, fps: 30, timeoutMs: 30_000 });
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("clamps a style move's window to its shot and finds the element automatically", async () => {
    const { spec } = await engine.style(clip, { version: "test" });
    expect(spec.anchors.cuts.map((c) => Math.round(c.t * 30))).toEqual([30, 90]);
    const index = spec.events.findIndex((e) => e.start >= 1 && e.start < 1.3);
    expect(index).toBeGreaterThanOrEqual(0);
    // A square on a still background changes a small share of the picture: `auto` can pick it.
    expect(spec.events[index]!.area).toBeLessThan(0.2);
    const { track, note } = await engine.track(clip, { move: index + 1 });
    expect(note).toMatch(/kept inside its shot \(1\.000–3\.000 s\)/);
    expect(track.window.start).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(track.window.end).toBeLessThan(3);
    expect(track.element.auto).toBe(true);
    expect(track.element.box.w).toBeLessThan(60);
    const x = track.properties.find((p) => p.property === "x")!;
    expect(x.from).toBeCloseTo(60, 0);
    expect(x.to).toBeCloseTo(260, 0);
  }, 120_000);

  it("asks for a box when style measured that the move changes most of the picture", async () => {
    const { spec, files } = await engine.style(clip, { version: "test" });
    const index = spec.events.findIndex((e) => e.start >= 1 && e.start < 1.3);
    spec.events[index]!.area = 0.66;
    writeFileSync(files.spec!, JSON.stringify(spec));
    await expect(engine.track(clip, { move: index + 1 })).rejects.toThrow(/The whole picture moves here \(a camera or character move\): pass a box around the element to track.*66% of the picture/);
    // With a box it tracks.
    const { track } = await engine.track(clip, { move: index + 1, box: { x: 42, y: 72, w: 36, h: 36 }, at: 1.0 });
    expect(track.element.auto).toBe(false);
  }, 120_000);

  it("says when a window given by hand crosses a cut, and still finds the element", async () => {
    const { track, note } = await engine.track(clip, { start: 0.8, end: 2.95 });
    expect(note).toMatch(/crosses the cut at 1\.000 s/);
    expect(track.element.auto).toBe(true);
    expect(track.element.box.w).toBeLessThan(60);
  }, 120_000);
});

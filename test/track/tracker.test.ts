import { describe, expect, it } from "vitest";
import { bezierAt, clipFrames } from "../../scripts/synth.mjs";
import { workSize } from "../../src/track/decode.js";
import { fitProperty } from "../../src/track/fit.js";
import { autoBox, trackElement, type GrayFrames } from "../../src/track/tracker.js";

const W = 320;
const H = 180;

function video(options: Parameters<typeof clipFrames>[0], fps = 30): GrayFrames {
  return { width: W, height: H, frames: [...clipFrames({ width: W, height: H, ...options })].map((data, i) => ({ t: i / fps, data })) };
}

const ease: [number, number, number, number] = [0.42, 0, 0.58, 1];
const progress = (start: number, frames: number, b = ease) => (i: number) => bezierAt(b, (i - start) / frames);

describe("trackElement", () => {
  it("follows a square to a fraction of a pixel", () => {
    const v = video({ total: 40, progress: progress(6, 24), from: [60, 90], to: [250.5, 110.25], size: 36 });
    const points = trackElement(v, { x: 42, y: 72, w: 36, h: 36 }, 0);
    expect(points).toHaveLength(40);
    for (const [i, p] of points.entries()) {
      const u = progress(6, 24)(i);
      expect(Math.abs(p.x - (60 + 190.5 * u)), `frame ${i}`).toBeLessThan(0.06);
      expect(Math.abs(p.y - (90 + 20.25 * u)), `frame ${i}`).toBeLessThan(0.06);
      expect(p.lost).toBe(false);
    }
  });

  it("keeps hold on a busy background with noise", () => {
    const v = video({ total: 40, progress: progress(6, 24), from: [60, 90], to: [250, 90], size: 36, busy: true, noise: 6 });
    const points = trackElement(v, { x: 42, y: 72, w: 36, h: 36 }, 0);
    const errors = points.map((p, i) => Math.abs(p.x - (60 + 190 * progress(6, 24)(i))));
    expect(Math.max(...errors)).toBeLessThan(1);
  });

  it("measures scale and opacity", () => {
    const v = video({
      total: 36,
      progress: () => 0,
      from: [160, 90],
      to: [160, 90],
      size: 40,
      scale: (i) => 1 + 0.5 * bezierAt(ease, (i - 6) / 20),
      opacity: (i) => 0.4 + 0.6 * bezierAt(ease, (i - 6) / 20),
    });
    const points = trackElement(v, { x: 140, y: 70, w: 40, h: 40 }, 0);
    expect(points.at(-1)!.scale).toBeCloseTo(1.5, 1);
    const times = points.map((p) => p.t);
    const scaleFit = fitProperty(times, points.map((p) => p.scale), 30, { minTravel: 0.03 })!;
    expect(Math.abs(scaleFit.frames - 20)).toBeLessThan(1.5);
    const contrast = points.map((p) => p.contrast);
    expect(contrast.at(-1)! / contrast[0]!).toBeGreaterThan(1.8);
  });

  it("tracks backwards from a reference frame in the middle", () => {
    const v = video({ total: 30, progress: progress(4, 20), from: [60, 90], to: [260, 90], size: 30 });
    const mid = 15;
    const cx = 60 + 200 * progress(4, 20)(mid);
    const points = trackElement(v, { x: cx - 15, y: 75, w: 30, h: 30 }, mid);
    expect(Math.abs(points[0]!.x - 60)).toBeLessThan(0.2);
    expect(Math.abs(points.at(-1)!.x - 260)).toBeLessThan(0.2);
  });
});

describe("autoBox", () => {
  it("finds the moving square and ignores the static background", () => {
    const v = video({ total: 40, progress: progress(10, 20), from: [60, 90], to: [250, 90], size: 36, busy: true });
    const found = autoBox(v)!;
    expect(found).toBeDefined();
    expect(found.box.w).toBeGreaterThan(28);
    expect(found.box.w).toBeLessThan(46);
    const cx = found.box.x + found.box.w / 2;
    const expected = 60 + 190 * progress(10, 20)(found.index);
    expect(Math.abs(cx - expected)).toBeLessThan(4);
  });

  it("finds nothing when nothing moves", () => {
    const v = video({ total: 10, progress: () => 0, size: 30 });
    expect(autoBox(v)).toBeUndefined();
  });
});

describe("workSize", () => {
  it("stays under the memory budget and the source size", () => {
    expect(workSize(640, 360, 60)).toEqual({ width: 640, height: 360, factor: 1 });
    const big = workSize(3840, 2160, 900);
    expect(big.width * big.height * 900).toBeLessThanOrEqual(64 * 1024 * 1024 * 1.01);
    expect(big.width).toBeLessThanOrEqual(960);
    expect(big.width % 2).toBe(0);
  });
});

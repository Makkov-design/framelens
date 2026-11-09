// Regressions for the re-verification of PR #19: look-alike twins, fades on busy backgrounds, honest grades, tight boxes.
import { describe, expect, it } from "vitest";
import { bezierAt, busyBackground, random, renderFrame } from "../../scripts/synth.mjs";
import { curveAt } from "../../src/track/curve.js";
import { fitProperty } from "../../src/track/fit.js";
import { autoBox, trackElement, type GrayFrames } from "../../src/track/tracker.js";

const W = 320;
const H = 180;
const video = (total: number, frame: (i: number) => Uint8Array): GrayFrames => ({ width: W, height: H, frames: Array.from({ length: total }, (_, i) => ({ t: i / 30, data: frame(i) })) });
const ease: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

/** A background with an identical static square (the twin) at (60, twinY). */
function withTwin(twinY: number, level = 235): Uint8Array {
  return renderFrame(W, H, { cx: 60, cy: twinY, size: 30, background: 40, level });
}

describe("A: a look-alike static twin does not steal the track", () => {
  for (const frames of [6, 12]) {
    for (const twinY of [20, 40]) {
      it(`${frames}-frame move, twin at y ${twinY}, box and auto`, async () => {
        const twin = Float32Array.from(withTwin(twinY));
        const x = (i: number) => 60 + 200 * bezierAt(ease, (i - 15) / frames);
        const v = video(45, (i) => renderFrame(W, H, { cx: x(i), cy: 130, size: 30, background: twin }));
        const found = (await autoBox(v))!;
        for (const [box, index] of [[{ x: 45, y: 115, w: 30, h: 30 }, 0], [found.box, found.index]] as const) {
          const points = await trackElement(v, box, index);
          points.forEach((p, i) => {
            expect(p.lost, `frame ${i}`).toBe(false);
            expect(Math.abs(p.y - points[0]!.y), `frame ${i}`).toBeLessThan(0.5);
            expect(Math.abs(p.x - points[0]!.x - (x(i) - x(0))), `frame ${i}`).toBeLessThan(0.5);
          });
        }
      }, 60_000);
    }
  }

  it("also with a dimmer twin", async () => {
    const twin = Float32Array.from(withTwin(40, 160));
    const x = (i: number) => 60 + 200 * bezierAt(ease, (i - 15) / 9);
    const v = video(45, (i) => renderFrame(W, H, { cx: x(i), cy: 130, size: 30, background: twin }));
    const points = await trackElement(v, { x: 45, y: 115, w: 30, h: 30 }, 0);
    expect(points.every((p) => !p.lost && Math.abs(p.y - 130) < 1)).toBe(true);
  }, 30_000);
});

describe("B: a fade-out on a busy background is measured against the background it fades over", () => {
  for (const seed of [3, 5, 9]) {
    it(`seed ${seed}: within 2 % of the true curve`, async () => {
      const bg = busyBackground(W, H, seed);
      const rand = random(seed);
      const truth = (i: number) => 1 - bezierAt([0.42, 0, 0.58, 1], (i - 10) / 15);
      const v = video(60, (i) => renderFrame(W, H, { cx: 160, cy: 90, size: 30, background: bg, noise: 2, rand, opacity: truth(i) }));
      const points = await trackElement(v, { x: 145, y: 75, w: 30, h: 30 }, 0);
      expect(points.some((p) => p.basis === "estimated")).toBe(true);
      const fit = fitProperty(points.map((p) => p.t), points.map((p) => p.visibility), 30, { minTravel: 0.15 })!;
      let worst = 0;
      for (let q = 0; q <= 600; q++) {
        const f = q / 10;
        const fitted = fit.from + (fit.to - fit.from) * curveAt(fit.curve, (f / 30 - fit.start) / (fit.end - fit.start));
        worst = Math.max(worst, Math.abs(fitted - truth(f)));
      }
      expect(worst).toBeLessThan(0.02);
    }, 30_000);
  }
});

describe("C: grades account for noise against the travel", () => {
  it("an 8 px move with 0.3 px noise is not exact", () => {
    let seed = 5;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 3.46;
    const t = Array.from({ length: 50 }, (_, i) => i / 30);
    const v = t.map((_, i) => 100 + 8 * bezierAt([0.42, 0, 0.58, 1], (i - 12) / 20) + 0.3 * rand());
    const fit = fitProperty(t, v, 30, { minTravel: 1.5 })!;
    expect(fit.quality).toBe("unreliable");
  });

  it("a short clean move is approximate, not exact", () => {
    const t = Array.from({ length: 30 }, (_, i) => i / 30);
    const v = t.map((_, i) => 100 + 200 * bezierAt(ease, (i - 10) / 6));
    expect(fitProperty(t, v, 30, { minTravel: 1.5 })!.quality).toBe("approximate");
  });
});

describe("D: the automatic box fits the element", () => {
  it("is within 2 px of a 32 px square on a busy background", async () => {
    const bg = busyBackground(W, H, 9);
    const rand = random(5);
    const p = (i: number) => bezierAt(ease, (i - 10) / 15);
    const v = video(60, (i) => renderFrame(W, H, { cx: 60 + 180 * p(i), cy: 40 + 90 * p(i), size: 32, background: bg, noise: 2, rand }));
    const found = (await autoBox(v))!;
    expect(Math.abs(found.box.w - 32)).toBeLessThanOrEqual(2);
    expect(Math.abs(found.box.h - 32)).toBeLessThanOrEqual(2);
    expect(Math.abs(found.box.x + found.box.w / 2 - (60 + 180 * p(found.index)))).toBeLessThan(1.5);
  }, 30_000);
});

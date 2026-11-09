import { describe, expect, it } from "vitest";
import { bezierAt, cssEasing, curveAt, safeCurve, springAt, springCurve, type Bezier } from "../../src/track/curve.js";
import { fitProperty, nelderMead } from "../../src/track/fit.js";

/** Samples of a value going from `from` to `to` with a curve, on frames, with rest before and after. */
function sampled(curve: (u: number) => number, options: { fps: number; startFrame: number; frames: number; total: number; from?: number; to?: number; noise?: number; seed?: number }) {
  const { fps, startFrame, frames, total, from = 100, to = 460, noise = 0 } = options;
  let seed = options.seed ?? 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < total; i++) {
    const u = (i - startFrame) / frames;
    times.push(i / fps);
    values.push(from + (to - from) * curve(u <= 0 ? 0 : u >= 1 ? 1 : u) + noise * random() * 3.46);
  }
  return { times, values };
}

const bez = (b: Bezier) => (u: number) => bezierAt(b, u);

describe("curves", () => {
  it("evaluates cubic-bezier like CSS", () => {
    expect(bezierAt([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5);
    expect(bezierAt([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 5);
    expect(bezierAt([0.25, 0.1, 0.25, 1], 0.5)).toBeCloseTo(0.8024, 3);
    expect(bezierAt([0.34, 1.56, 0.64, 1], 0.5)).toBeGreaterThan(1);
  });

  it("evaluates springs and writes them as CSS linear()", () => {
    expect(springAt(10, 0.5, 0)).toBe(0);
    expect(springAt(10, 1, 5)).toBeCloseTo(1, 4);
    expect(springAt(10, 2, 0.2)).toBeGreaterThan(0);
    const s = springCurve(10, 0.5);
    expect(s.stiffness).toBe(100);
    expect(s.damping).toBe(10);
    expect(s.duration).toBeGreaterThan(0.8);
    const css = cssEasing(s);
    expect(css).toMatch(/^linear\(0, /);
    expect(css.endsWith(", 1)")).toBe(true);
    expect(curveAt(s, 1)).toBe(1);
  });

  it("only lets bounded numbers through safeCurve", () => {
    expect(safeCurve({ kind: "bezier", bezier: [0.2, 0, "1); alert(1", 1] })).toBeUndefined();
    expect(safeCurve({ kind: "bezier", bezier: [2, 0, 0.5, 1] })).toBeUndefined();
    expect(safeCurve({ kind: "steps", steps: 4 })).toEqual({ kind: "steps", steps: 4 });
    expect(safeCurve({ kind: "spring", omega: 10, zeta: 0.5 })?.kind).toBe("spring");
    expect(safeCurve("linear")).toBeUndefined();
  });

  it("minimises with Nelder–Mead", () => {
    const r = nelderMead((x) => (x[0]! - 3) ** 2 + (x[1]! + 1) ** 2, [0, 0], [1, 1]);
    expect(r.x[0]).toBeCloseTo(3, 4);
    expect(r.x[1]).toBeCloseTo(-1, 4);
  });
});

describe("fitProperty", () => {
  const cases: [string, Bezier][] = [
    ["ease", [0.25, 0.1, 0.25, 1]],
    ["ease-in-out", [0.42, 0, 0.58, 1]],
    ["custom", [0.7, 0.1, 0.2, 0.95]],
    ["overshoot", [0.34, 1.56, 0.64, 1]],
  ];
  for (const [name, b] of cases) {
    it(`recovers ${name} exactly from clean samples`, () => {
      const { times, values } = sampled(bez(b), { fps: 30, startFrame: 8, frames: 24, total: 48 });
      const fit = fitProperty(times, values, 30)!;
      expect(fit.curve.kind).toBe("bezier");
      if (fit.curve.kind !== "bezier") return;
      fit.curve.bezier.forEach((c, i) => expect(Math.abs(c - b[i]!), `${name} ${i}`).toBeLessThan(0.03));
      expect(Math.abs(fit.frames - 24)).toBeLessThan(0.5);
      expect(Math.abs(fit.start - 8 / 30)).toBeLessThan(0.5 / 30);
      expect(fit.from).toBeCloseTo(100, 1);
      expect(fit.to).toBeCloseTo(460, 1);
      expect(fit.rmse).toBeLessThan(0.002);
    });
  }

  it("stays close on noisy samples", () => {
    const b: Bezier = [0.42, 0, 0.58, 1];
    const { times, values } = sampled(bez(b), { fps: 30, startFrame: 8, frames: 24, total: 48, noise: 1.5 });
    const fit = fitProperty(times, values, 30)!;
    expect(fit.curve.kind).toBe("bezier");
    if (fit.curve.kind === "bezier") fit.curve.bezier.forEach((c, i) => expect(Math.abs(c - b[i]!)).toBeLessThan(0.12));
    expect(Math.abs(fit.frames - 24)).toBeLessThan(1.5);
  });

  it("reads a spring when the value swings around its target", () => {
    const omega = Math.sqrt(170);
    const zeta = 12 / (2 * omega);
    const fps = 60;
    const times: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < 120; i++) {
      times.push(i / fps);
      values.push(50 + 300 * springAt(omega, zeta, (i - 10) / fps));
    }
    const fit = fitProperty(times, values, fps)!;
    expect(fit.curve.kind).toBe("spring");
    if (fit.curve.kind !== "spring") return;
    expect(Math.abs(fit.curve.stiffness - 170) / 170).toBeLessThan(0.03);
    expect(Math.abs(fit.curve.damping - 12) / 12).toBeLessThan(0.05);
    expect(fit.oscillations).toBeGreaterThanOrEqual(1);
    expect(Math.abs(fit.start - 10 / fps)).toBeLessThan(0.5 / fps);
  });

  it("calls a straight move linear and a stepped one steps", () => {
    const lin = sampled((u) => u, { fps: 24, startFrame: 5, frames: 12, total: 30 });
    expect(fitProperty(lin.times, lin.values, 24)!.curve.kind).toBe("linear");
    const st = sampled((u) => Math.floor(u * 4) / 4, { fps: 24, startFrame: 4, frames: 16, total: 30 });
    const fit = fitProperty(st.times, st.values, 24)!;
    expect(fit.curve).toEqual({ kind: "steps", steps: 4 });
  });

  it("returns nothing for flat, too short or broken input", () => {
    expect(fitProperty([0, 1, 2, 3, 4, 5].map((i) => i / 30), [5, 5, 5, 5, 5, 5], 30)).toBeUndefined();
    expect(fitProperty([0, 0.1], [0, 1], 30)).toBeUndefined();
    expect(fitProperty([0, 1, 2, 3, 4, 5].map((i) => i / 30), [NaN, NaN, NaN, NaN, NaN, NaN], 30)).toBeUndefined();
    expect(fitProperty([0, 1, 2, 3, 4, 5].map((i) => i / 30), [0, 0, 1, 1, 1, 1], 0)).toBeUndefined();
    // Noise alone is not a move.
    const { times, values } = sampled(() => 0, { fps: 30, startFrame: 0, frames: 10, total: 40, noise: 0.5 });
    expect(fitProperty(times, values, 30, { minTravel: 2 })).toBeUndefined();
  });

  it("handles a jump between two frames without crashing", () => {
    const times = Array.from({ length: 20 }, (_, i) => i / 30);
    const values = times.map((_, i) => (i < 10 ? 0 : 100));
    const fit = fitProperty(times, values, 30)!;
    expect(fit.frames).toBeLessThan(1.5);
  });
});

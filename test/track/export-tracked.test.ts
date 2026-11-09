import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSpec, moveCss, scenesFromSpec } from "../../src/export/exporters.js";
import { lottieDocument } from "../../src/export/lottie.js";
import type { MotionSpec } from "../../src/style/spec.js";
import { springCurve, type Curve } from "../../src/track/curve.js";
import { linkTracks } from "../../src/track/link.js";
import type { TrackedMove } from "../../src/track/run.js";

function track(id: string, start: number, seconds: number, curve: Curve): TrackedMove {
  return {
    id,
    window: { start: start - 0.3, end: start + seconds + 0.4 },
    element: { box: { x: 10, y: 10, w: 40, h: 40 }, at: start - 0.3, auto: true },
    start,
    end: start + seconds,
    frames: seconds * 25,
    seconds,
    delay: 0.3,
    primary: "x",
    properties: [
      {
        property: "x",
        from: 100,
        to: 400,
        start,
        end: start + seconds,
        frames: seconds * 25,
        seconds,
        curve: structuredClone(curve),
        rmse: 0.001,
        maxError: 0.003,
        alternatives: [],
        overshoot: 0,
        oscillations: 0,
        noise: 0.0005,
        reason: "test",
        identifiable: true,
        quality: "exact",
        delay: 0,
        css: "",
        evidence: "derived",
      },
    ],
    unfitted: [],
    samples: [],
    evidence: "measured",
    fps: 25,
  };
}

function makeSpec(): MotionSpec {
  const shot = (id: string, start: number, end: number, palette: string[]) => ({ id, start, end, frames: Math.round((end - start) * 25), palette });
  const sw = (hex: string) => ({ hex, share: 0.5, lightness: 0.5, chroma: 0.1, evidence: "measured" as const });
  return {
    spec: "framelens.motion/1",
    generatedBy: "framelens test",
    source: { kind: "file", input: "ref.mp4", title: "Tracked" },
    range: { start: 0, end: 6 },
    timebase: { fps: 25, vfr: false, duration: 6, width: 1280, height: 720 },
    anchors: { words: [], beats: [], cuts: [{ id: "c1", t: 2, score: 9, evidence: "measured" }, { id: "c2", t: 4, score: 8, evidence: "measured" }] },
    changes: [],
    palette: [sw("#E0402F"), sw("#2F6FE0")],
    typography: [],
    shots: [shot("s1", 0, 2, ["#E0402F", "#FFFFFF"]), shot("s2", 2, 4, ["#2F6FE0", "#FFFFFF"]), shot("s3", 4, 6, ["#1F8040", "#FFFFFF"])],
    systems: [],
    events: [
      { kind: "move", start: 0.4, end: 0.8, frames: 10, peak: 5, peakAt: 0.3, easing: "ease-out", suggestion: "cubic-bezier(0.16, 1, 0.3, 1)", evidence: "derived" },
      { kind: "move", start: 2.5, end: 3, frames: 12, peak: 4, peakAt: 0.5, easing: "ease-in-out", suggestion: "cubic-bezier(0.65, 0, 0.35, 1)", evidence: "derived" },
      { kind: "move", start: 4.2, end: 4.6, frames: 10, peak: 4, peakAt: 0.5, easing: "linear", suggestion: "linear", evidence: "derived" },
    ],
    rhythm: { cuts: 2, cutsPerMinute: 20, meanShotSeconds: 2, medianShotSeconds: 2, movesPerMinute: 30 },
    audio: { sfx: [] },
  };
}

const bezier: Curve = { kind: "bezier", bezier: [0.7, 0.1, 0.2, 0.95] };
const spring = springCurve(Math.sqrt(170), 12 / (2 * Math.sqrt(170)));
const tracked = () => linkTracks(makeSpec(), [track("t1", 0.42, 0.44, bezier), track("t2", 2.48, spring.duration, spring), track("t3", 4.2, 0.4, { kind: "steps", steps: 4 })]);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-tracked-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tracked curves in the spec", () => {
  it("gives each style move its tracked curve", () => {
    const spec = tracked();
    expect(spec.events.map((e) => e.track)).toEqual(["t1", "t2", "t3"]);
    expect(spec.events[0]!.curve).toBe("cubic-bezier(0.7, 0.1, 0.2, 0.95)");
    expect(spec.events[0]!.easing).toBe("ease-in-out");
    expect(spec.events[1]!.curve).toMatch(/^linear\(0, /);
    expect(spec.events[2]!.curve).toBe("steps(4, end)");
  });

  it("prefers the tracked move over the family in every scene", () => {
    const scenes = scenesFromSpec(tracked());
    expect(scenes[0]!.move).toMatchObject({ offset: 0.42, seconds: 0.44, track: "t1", curve: bezier });
    expect(scenes[1]!.move!.curve!.kind).toBe("spring");
    expect(moveCss(scenes[0]!.move!)).toBe("cubic-bezier(0.7, 0.1, 0.2, 0.95)");
  });

  it("ignores a tampered curve and falls back to the family", () => {
    const spec = tracked();
    (spec.tracks![0]!.properties[0]!.curve as unknown as { bezier: unknown[] }).bezier = [0.2, "1); alert(1); (", 0.5, 1];
    const scenes = scenesFromSpec(spec);
    expect(scenes[0]!.move!.curve).toBeUndefined();
    expect(scenes[0]!.move!.easing).toBe("ease-in-out"); // the linked family stays; no text reaches the code
  });
});

describe("exporters with tracked curves", () => {
  it("css: cubic-bezier(), linear() for the spring, steps()", () => {
    const out = join(dir, "css");
    exportSpec(tracked(), "css", out);
    const css = readFileSync(join(out, "motion.css"), "utf8");
    expect(css).toContain("cubic-bezier(0.7, 0.1, 0.2, 0.95)");
    expect(css).toMatch(/#shot-2 h1 \{[^}]*linear\(0, /);
    expect(css).toContain("steps(4, end)");
    expect(readFileSync(join(out, "tokens.css"), "utf8")).toContain("--fl-ease-shot-1: cubic-bezier(0.7, 0.1, 0.2, 0.95); /* tracked t1 */");
    expect(readFileSync(join(out, "REFERENCE.md"), "utf8")).toMatch(/t1 at 0\.420 s: cubic-bezier/);
  });

  it("remotion: Easing.bezier with the tracked points and spring({config})", () => {
    const out = join(dir, "remotion");
    exportSpec(tracked(), "remotion", out);
    const timing = readFileSync(join(out, "src", "timing.ts"), "utf8");
    const scenes = JSON.parse(/export const SCENES = ([\s\S]*);\n/.exec(timing)![1]!) as { bezier?: number[]; spring?: { stiffness: number; damping: number; mass: number }; steps?: number }[];
    expect(scenes[0]!.bezier).toEqual([0.7, 0.1, 0.2, 0.95]);
    expect(scenes[1]!.spring!.stiffness).toBeCloseTo(170, 1);
    expect(scenes[1]!.spring!.damping).toBeCloseTo(12, 2);
    expect(scenes[1]!.spring!.mass).toBe(1);
    expect(scenes[1]!.bezier).toBeUndefined();
    expect(scenes[2]!.steps).toBe(4);
    const reference = readFileSync(join(out, "src", "Reference.tsx"), "utf8");
    expect(reference).toContain("spring({ frame: frame - enterAt, fps, config: scene.spring })");
  });

  it("hyperframes: exact GSAP eases from helpers", () => {
    const out = join(dir, "hf");
    exportSpec(tracked(), "hyperframes", out);
    const one = readFileSync(join(out, "compositions", "shot-1.html"), "utf8");
    expect(one).toContain("ease: flBezier(0.7, 0.1, 0.2, 0.95)");
    expect(one).toContain("const flBezier");
    const two = readFileSync(join(out, "compositions", "shot-2.html"), "utf8");
    expect(two).toMatch(/ease: flPoints\(\[\[0,0\],\[/);
    // The helpers are valid JavaScript and the eases behave.
    const helpers = /\/\/ Frame Lens eases[^\n]*\n([\s\S]*?)\n\s*const tl/.exec(one)![1]!;
    const make = new Function(`${helpers}\nreturn { flBezier, flPoints, flSteps };`)() as { flBezier: (...b: number[]) => (u: number) => number; flSteps: (n: number) => (u: number) => number };
    expect(make.flBezier(0.42, 0, 0.58, 1)(0.5)).toBeCloseTo(0.5, 5);
    expect(make.flSteps(4)(0.3)).toBe(0.25);
  });

  it("after-effects: bezier keys for t1, a key per frame for the spring, held keys for steps", () => {
    const out = join(dir, "ae");
    exportSpec(tracked(), "after-effects", out);
    const source = readFileSync(join(out, "framelens-reference.jsx"), "utf8");
    expect(() => new Function(source.replace("#target aftereffects", ""))).not.toThrow();
    const code = source.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/\b(let|const)\b|=>|`|\bclass\b|\.\.\./);
    const scenes = JSON.parse(/var SCENES = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { bezier?: number[]; keys?: [number, number][]; hold?: boolean; track?: string }[];
    expect(scenes[0]!.bezier).toEqual([0.7, 0.1, 0.2, 0.95]);
    expect(scenes[1]!.keys!.length).toBeGreaterThan(10);
    expect(scenes[1]!.keys!.at(-1)![1]).toBe(1);
    expect(Math.max(...scenes[1]!.keys!.map((k) => k[1]))).toBeGreaterThan(1); // the spring overshoots
    expect(scenes[1]!.hold).toBe(false);
    expect(scenes[2]!.keys!.map((k) => k[1])).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(scenes[2]!.hold).toBe(true);
  });

  it("lottie: bezier handles for t1, a keyframe per frame for the spring, held keys for steps", () => {
    const doc = lottieDocument(tracked());
    type Key = { t: number; s: number[]; o?: { x: number[]; y: number[] }; i?: { x: number[]; y: number[] }; h?: number };
    // Layers are top-first (later shots above earlier ones): put them back in shot order.
    const shapes = (doc.layers as unknown as { ty: number; ip: number; ks: { p: { k: Key[] } } }[]).filter((l) => l.ty === 4).sort((a, b) => a.ip - b.ip);
    const first = shapes[0]!.ks.p.k[0]!;
    expect([first.o!.x[0], first.o!.y[0], first.i!.x[0], first.i!.y[0]]).toEqual([0.7, 0.1, 0.2, 0.95]);
    expect(shapes[1]!.ks.p.k.length).toBeGreaterThan(10);
    expect(shapes[2]!.ks.p.k.slice(0, -1).every((k) => k.h === 1)).toBe(true);
  });

  it("hypit: names the tracked curve", () => {
    const out = join(dir, "hypit");
    const files = exportSpec(tracked(), "hypit", out, { workspace: dir });
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).toContain("tracked curve cubic-bezier(0.7, 0.1, 0.2, 0.95)");
  });
});

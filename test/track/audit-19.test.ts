// Regressions for the independent audit of PR #19: each test reproduces one input the first version got wrong.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bezierAt, busyBackground, encode, random, renderFrame, springAt } from "../../scripts/synth.mjs";
import { aeScript } from "../../src/export/after-effects.js";
import { lottieDocument } from "../../src/export/lottie.js";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { buildPlan } from "../../src/router/plan.js";
import type { MotionSpec } from "../../src/style/spec.js";
import { curveAt, springCurve, springPoints, SPRING_TOLERANCE, cssEasing } from "../../src/track/curve.js";
import { decodeGray } from "../../src/track/decode.js";
import { fitProperty } from "../../src/track/fit.js";
import { linkTracks, matchEvent } from "../../src/track/link.js";
import { exportable, type TrackedMove } from "../../src/track/run.js";
import { autoBox, trackElement, type GrayFrames } from "../../src/track/tracker.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const W = 320;
const H = 180;
const video = (total: number, frame: (i: number) => Uint8Array, fps = 30): GrayFrames => ({ width: W, height: H, frames: Array.from({ length: total }, (_, i) => ({ t: i / fps, data: frame(i) })) });
const ease: [number, number, number, number] = [0.42, 0, 0.58, 1];

describe("audit 1: element: auto", () => {
  it("finds the element, not the empty spot it rests on later, when it rests at its end for most of the window", async () => {
    const x = (i: number) => 260 - 200 * bezierAt([0.25, 0.1, 0.25, 1], (i - 8) / 12);
    const v = video(60, (i) => renderFrame(W, H, { cx: x(i), cy: 90, size: 30, background: 40 }));
    const found = (await autoBox(v))!;
    const cx = found.box.x + found.box.w / 2;
    expect(Math.abs(cx - x(found.index))).toBeLessThan(4);
    const points = await trackElement(v, found.box, found.index);
    expect(points.filter((p) => p.lost)).toHaveLength(0);
    points.forEach((p, i) => expect(Math.abs(p.x - points[0]!.x - (x(i) - x(0))), `frame ${i}`).toBeLessThan(0.3));
  }, 30_000);

  it("also for an upward move, a fade-in in place and a diagonal spring", async () => {
    const up = video(60, (i) => renderFrame(W, H, { cx: 160, cy: 150 - 110 * bezierAt(ease, (i - 8) / 12), size: 30, background: 40 }));
    const a = (await autoBox(up))!;
    expect((await trackElement(up, a.box, a.index)).filter((p) => p.lost)).toHaveLength(0);

    const fade = video(60, (i) => renderFrame(W, H, { cx: 160, cy: 90, size: 40, background: 40, opacity: bezierAt([0, 0, 0.58, 1], (i - 15) / 20) }));
    const b = (await autoBox(fade))!;
    expect(b.box.w).toBeGreaterThan(30);
    expect(b.index).toBeGreaterThanOrEqual(35); // a frame where the square is fully there

    const p = (i: number) => springAt(250, 10, (i - 10) / 30);
    const spring = video(75, (i) => renderFrame(W, H, { cx: 60 + 180 * p(i), cy: 40 + 90 * p(i), size: 32, background: 40 }));
    const c = (await autoBox(spring))!;
    expect(c.box.w).toBeLessThan(42); // the element, not a union of two positions
    const points = await trackElement(spring, c.box, c.index);
    expect(points.filter((q) => q.lost)).toHaveLength(0);
    const xs = points.map((q) => q.x);
    const fit = fitProperty(points.map((q) => q.t), xs, 30, { minTravel: 1.5 })!;
    expect(fit.curve.kind).toBe("spring");
  }, 60_000);
});

describe("audit 2: a fade-out on a busy background", () => {
  it("stays in place and is marked lost instead of jumping to look-alike background", async () => {
    const bg = busyBackground(W, H, 5);
    const rand = random(5);
    const v = video(60, (i) => renderFrame(W, H, { cx: 160, cy: 90, size: 30, background: bg, noise: 2, rand, opacity: 1 - bezierAt(ease, (i - 10) / 15) }));
    const points = await trackElement(v, { x: 145, y: 75, w: 30, h: 30 }, 0);
    for (const p of points) {
      if (!p.lost) expect(Math.hypot(p.x - 160, p.y - 90), `t ${p.t}`).toBeLessThan(1.5);
    }
    expect(points.slice(30).every((p) => p.lost)).toBe(true);
    expect(points[0]!.visibility).toBe(1);
    expect(points[40]!.visibility).toBeLessThan(0.25);
  }, 30_000);
});

describe("audit 3: windows that cut the move, noise and short moves", () => {
  it("reports a move cut by the window instead of fitting it as exact", () => {
    const t = Array.from({ length: 36 }, (_, i) => i / 30);
    const v = t.map((_, i) => 60 + 200 * bezierAt(ease, (i - 15) / 30));
    const fit = fitProperty(t, v, 30, { minTravel: 1.5 })!;
    expect(fit.cut).toBe("end");
    expect(fit.quality).toBe("unreliable");
    expect(exportable(fit)).toBe(false);
  });

  it("estimates noise from the resting samples, not from a fast spring", () => {
    const t = Array.from({ length: 90 }, (_, i) => i / 30);
    const v = t.map((_, i) => 100 + 200 * springAt(225, 4.5, (i - 9) / 30));
    const fit = fitProperty(t, v, 30, { minTravel: 1.5 })!;
    expect(fit.noise).toBeLessThan(0.003); // second differences read 0.014
    expect(fit.curve.kind).toBe("spring");
    expect(fit.cut).toBeUndefined();
  });

  it("says a move of five frames or fewer cannot be identified", () => {
    const t = Array.from({ length: 30 }, (_, i) => i / 30);
    const v = t.map((_, i) => 100 + 200 * bezierAt(ease, (i - 10) / 4));
    const fit = fitProperty(t, v, 30, { minTravel: 1.5 })!;
    expect(fit.identifiable).toBe(false);
    expect(fit.reason).toMatch(/too short/);
    expect(exportable(fit)).toBe(false);
  });
});

describe("audit 9: opacity", () => {
  it("does not read a move over a gradient as a fade", async () => {
    const grad = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grad[y * W + x] = 20 + (180 * x) / W;
    const v = video(60, (i) => renderFrame(W, H, { cx: 60 + 200 * bezierAt([0.25, 0.1, 0.25, 1], (i - 15) / 20), cy: 90, size: 30, background: grad }));
    const points = await trackElement(v, { x: 45, y: 75, w: 30, h: 30 }, 0);
    expect(points.every((p) => p.visibility === 1)).toBe(true);
  }, 30_000);

  it("does not measure opacity while the element touches the frame's edge", async () => {
    const v = video(60, (i) => renderFrame(W, H, { cx: 160 + 160 * bezierAt([0.42, 0, 1, 1], (i - 15) / 20), cy: 90, size: 40, background: 40 }));
    const points = await trackElement(v, { x: 140, y: 70, w: 40, h: 40 }, 0);
    expect(Number.isNaN(points.at(-1)!.visibility)).toBe(true);
    expect(points.filter((p) => Number.isFinite(p.visibility)).every((p) => p.visibility === 1)).toBe(true);
  }, 30_000);
});

describe("audit 11: scale", () => {
  it("measures a shrink and a grow within 2 % of the size", async () => {
    for (const to of [0.6, 1.6]) {
      const s = (i: number) => 1 + (to - 1) * bezierAt([0, 0, 0.58, 1], (i - 10) / 20);
      const v = video(50, (i) => renderFrame(W, H, { cx: 160, cy: 90, size: 40, background: 40, scale: s(i) }));
      const points = await trackElement(v, { x: 140, y: 70, w: 40, h: 40 }, 0);
      points.forEach((p, i) => expect(Math.abs(p.scale - s(i)) / s(i), `to ${to}, frame ${i}`).toBeLessThan(0.02));
    }
  }, 30_000);
});

describe("audit 10: spring points", () => {
  it("keeps straight segments within 0.5 % of a stiff spring", () => {
    for (const [k, c] of [[2000, 20], [170, 12], [100, 10]] as const) {
      const curve = springCurve(Math.sqrt(k), c / (2 * Math.sqrt(k)));
      const pts = springPoints(curve);
      let worst = 0;
      for (let i = 0; i <= 4000; i++) {
        const u = i / 4000;
        const j = Math.max(1, pts.findIndex(([x]) => x >= u));
        const [x0, y0] = pts[j - 1]!;
        const [x1, y1] = pts[j]!;
        const line = y0 + ((y1 - y0) * (u - x0)) / (x1 - x0 || 1);
        worst = Math.max(worst, Math.abs(line - curveAt(curve, u)));
      }
      expect(worst, `${k}/${c}`).toBeLessThanOrEqual(SPRING_TOLERANCE + 1e-4);
    }
    expect(cssEasing(springCurve(Math.sqrt(170), 12 / (2 * Math.sqrt(170))))).toMatch(/^linear\(0, [-\d.]+ [\d.]+%/);
  });
});

function spec(tracks: TrackedMove[]): MotionSpec {
  return {
    spec: "framelens.motion/1",
    generatedBy: "test",
    source: { kind: "file", input: "x.mp4" },
    range: { start: 0, end: 8 },
    timebase: { fps: 30, vfr: false, duration: 8, width: 320, height: 180 },
    anchors: { words: [], beats: [], cuts: [] },
    changes: [],
    palette: [],
    typography: [],
    shots: [
      { id: "s1", start: 0, end: 2, frames: 60, palette: ["#202020"] },
      { id: "s2", start: 2, end: 4, frames: 60, palette: ["#404040"] },
      { id: "s3", start: 4, end: 8, frames: 120, palette: ["#606060"] },
    ],
    systems: [],
    events: [{ kind: "move", start: 3.2, end: 3.6, frames: 12, peak: 3, peakAt: 0.3, easing: "ease-out", suggestion: "", evidence: "derived" }],
    rhythm: { cuts: 0, cutsPerMinute: 0, meanShotSeconds: 2, medianShotSeconds: 2, movesPerMinute: 1 },
    audio: { sfx: [] },
    tracks,
  };
}

function springTrack(start: number, quality: "exact" | "unreliable" = "exact"): TrackedMove {
  const curve = springCurve(Math.sqrt(30), 0.3);
  return {
    id: "t1",
    window: { start: start - 0.3, end: start + curve.duration + 0.4 },
    element: { box: { x: 0, y: 0, w: 10, h: 10 }, at: 0, auto: true },
    start,
    end: start + curve.duration,
    frames: curve.duration * 30,
    seconds: curve.duration,
    delay: 0.3,
    primary: "x",
    properties: [
      { property: "x", from: 0, to: 100, start, end: start + curve.duration, frames: curve.duration * 30, seconds: curve.duration, curve, rmse: quality === "exact" ? 0.002 : 0.08, maxError: 0.01, alternatives: [], overshoot: 0.3, oscillations: 2, noise: 0, reason: "", identifiable: true, quality, delay: 0, css: "", evidence: "derived" },
    ],
    unfitted: [],
    samples: [],
    evidence: "measured",
    fps: 30,
  };
}

describe("audit 4 and the export gate", () => {
  it("After Effects and Lottie keep a tracked spring's measured length past the shot's end", () => {
    const s = spec([springTrack(3.2)]);
    const seconds = s.tracks![0]!.seconds;
    expect(seconds).toBeGreaterThan(2);
    const source = aeScript(s);
    const scenes = JSON.parse(/var SCENES = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { keyStart: number; keyEnd: number; keys?: [number, number][] }[];
    expect(scenes[1]!.keyEnd - scenes[1]!.keyStart).toBeCloseTo(seconds, 1);
    expect(scenes[1]!.keys!.at(-1)![0]).toBeCloseTo(3.2 + seconds, 1);
    const doc = lottieDocument(s);
    const keys = (doc.layers as unknown as { ty: number; ks: { p: { k: { t: number }[] } } }[]).filter((l) => l.ty === 4)[1]!.ks.p.k;
    expect((keys.at(-1)!.t - keys[0]!.t) / 30).toBeCloseTo(seconds, 1);
  });

  it("does not link or export an unreliable curve", () => {
    const s = linkTracks(spec([springTrack(3.2, "unreliable")]), [springTrack(3.2, "unreliable")]);
    expect(s.events[0]!.track).toBeUndefined();
    const source = aeScript(s);
    expect(source).not.toContain('"keys"');
  });
});

describe("audit 6 and 12: stale move numbers, plans without moves", () => {
  it("does not attach a track to a renumbered style move it does not overlap", () => {
    const events = [{ start: 3.6, end: 4 }, { start: 4.8, end: 5.2 }] as MotionSpec["events"];
    expect(matchEvent({ events }, { start: 2.2, end: 2.6, move: 2 })).toBeUndefined();
    expect(matchEvent({ events }, { start: 3.62, end: 4, move: 2 })).toBe(0);
  });

  it("skips track when style found no moves", () => {
    const probe = { duration: 10, hasVideo: true, hasAudio: false, fps: 30, vfr: false, width: 320, height: 180 } as Parameters<typeof buildPlan>[0]["probe"];
    const plan = buildPlan({ goal: "style", probe, boundaries: { rate: 10, threshold: 0.3, candidates: [{ t: 1, score: 0.5 }], changesPerMinute: 6, dynamics: 0.1 } as never, hasSpeech: false, moves: [] });
    expect(plan.steps.some((s) => s.tool === "track")).toBe(false);
    expect(plan.notes.join(" ")).toMatch(/no moves to track/);
  });
});

const tools = mediaTools();

describe.skipIf(!tools)("audit 5, 8 and 3 with ffmpeg", () => {
  let dir: string;
  let stagger: string;
  let cutClip: string;
  let engine: Engine;

  beforeAll(async () => {
    dir = tempDir();
    const square = (bg: Float32Array | number, cx: number, cy: number) => renderFrame(W, H, { cx, cy, size: 30, background: bg });
    stagger = await encode(
      join(dir, "stagger.mp4"),
      Array.from({ length: 75 }, (_, i) => {
        const top = renderFrame(W, H, { cx: 60 + 180 * bezierAt([0.25, 0.1, 0.25, 1], (i - 10) / 15), cy: 50, size: 30, background: 40 });
        return square(Float32Array.from(top), 60 + 180 * bezierAt(ease, (i - 18) / 15), 130);
      }),
      { width: W, height: H, fps: 30, timeoutMs: 30_000 },
    );
    cutClip = await encode(join(dir, "cut.mp4"), Array.from({ length: 60 }, (_, i) => square(40, 60 + 200 * bezierAt(ease, (i - 15) / 30), 90)), { width: W, height: H, fps: 30, timeoutMs: 30_000 });
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps two elements tracked in the same window as two tracks", async () => {
    const a = await engine.track(stagger, { start: 0, end: 2.5, box: { x: 45, y: 35, w: 30, h: 30 } });
    const b = await engine.track(stagger, { start: 0, end: 2.5, box: { x: 45, y: 115, w: 30, h: 30 } });
    expect(a.track.id).not.toBe(b.track.id);
    const tracks = JSON.parse(readFileSync(b.files.tracks!, "utf8")) as TrackedMove[];
    expect(tracks).toHaveLength(2);
    const starts = tracks.map((t) => t.properties.find((p) => p.property === "x")!.start).sort();
    expect(starts[1]! - starts[0]!).toBeCloseTo(8 / 30, 1); // the stagger
    // The same box again replaces its own track.
    await engine.track(stagger, { start: 0, end: 2.5, box: { x: 45, y: 115, w: 30, h: 30 } });
    expect(JSON.parse(readFileSync(b.files.tracks!, "utf8"))).toHaveLength(2);
  }, 60_000);

  it("widens a window that cuts the move", async () => {
    const { track } = await engine.track(cutClip, { start: 0, end: 1.2, box: { x: 45, y: 75, w: 30, h: 30 } });
    expect(track.window.end).toBeGreaterThan(1.5);
    expect(track.notes?.join(" ")).toMatch(/widened/);
    const x = track.properties.find((p) => p.property === "x")!;
    expect(x.to).toBeCloseTo(260, 0);
    expect(Math.abs(x.frames - 30)).toBeLessThan(1);
  }, 60_000);

  it("errors when decoding times out instead of fitting a truncated window", async () => {
    await expect(decodeGray(cutClip, tools!, { start: 0, end: 2 }, { width: W, height: H }, { maxFrames: 100, fps: 30, timeoutMs: 1 })).rejects.toThrow(/timed out/);
  });
});

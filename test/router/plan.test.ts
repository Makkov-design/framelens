import { describe, expect, it } from "vitest";
import type { Boundaries } from "../../src/media/boundaries.js";
import type { ProbeInfo } from "../../src/media/probe.js";
import { buildPlan, busiestWindows, classify, denseWindows, inferGoal, loupeBudget, MAX_DENSE_SECONDS, sheetTokens } from "../../src/router/plan.js";

const probe = (duration: number): ProbeInfo => ({ duration, fps: 30, nominalFps: 30, vfr: false, hdr: false, hasVideo: true, hasAudio: true });
const bounds = (changesPerMinute: number, dynamics: number, times: number[] = []): Boundaries => ({
  rate: 4,
  threshold: 0.3,
  candidates: times.map((t) => ({ t, score: 0.6 })),
  dynamics,
  changesPerMinute,
});

describe("router", () => {
  it("guesses the goal from the request in English and Russian", () => {
    expect(inferGoal("Сделай конспект подкаста")).toBe("listen");
    expect(inferGoal("Возьми этот ролик как референс для моей анимации")).toBe("style");
    expect(inferGoal("what is the sound design here")).toBe("sound");
    expect(inferGoal("Разбери туториал и сделай инструкцию")).toBe("learn");
    expect(inferGoal("Где он показывает настройку DNS?")).toBe("find");
    expect(inferGoal(undefined)).toBeUndefined();
  });

  it("classifies videos by how their picture changes", () => {
    expect(classify(probe(600), bounds(0.5, 0.01), true).type).toBe("talking-head");
    expect(classify(probe(600), bounds(5, 0.03), true).type).toBe("screen");
    expect(classify(probe(45), bounds(40, 0.2), true).type).toBe("motion-graphics");
    expect(classify(probe(200), bounds(20, 0.1), false).type).toBe("music-video");
    expect(classify({ ...probe(0), frameCount: 1 }, undefined, false).type).toBe("still");
  });

  it("plans a podcast as a transcript plus one overview sheet", () => {
    const plan = buildPlan({ probe: probe(3 * 3600), boundaries: bounds(0.3, 0.005), hasSpeech: true });
    expect(plan.goal).toBe("listen");
    expect(plan.goalInferred).toBe(true);
    expect(plan.steps.map((s) => s.tool)).toEqual(["transcript", "frames"]);
    // 24 frames on one 4×6 sheet, as `frames` lays them out.
    expect(plan.estimate.sheets).toBe(1);
  });

  it("plans a motion reference with the loupe and keeps it bounded", () => {
    const times = Array.from({ length: 30 }, (_, i) => 1 + i * 1.4);
    const plan = buildPlan({ goal: "style", probe: probe(45), boundaries: bounds(40, 0.2, times), hasSpeech: false });
    expect(plan.goalInferred).toBe(false);
    const dense = plan.steps.filter((s) => s.args.every_frame);
    // One every-frame window per 8 s of video (45 s: 6), the ×10 passages about an eighth of it.
    expect(dense).toHaveLength(loupeBudget(45).dense);
    const passages = plan.steps.filter((s) => s.args.fps === 10);
    expect(passages.length).toBeLessThanOrEqual(2);
    expect(passages.reduce((sum, s) => sum + (s.args.end as number) - (s.args.start as number), 0)).toBeLessThanOrEqual(45 * 0.25);
    expect(plan.steps.at(-2)!.tool).toBe("style");
    expect(plan.steps.at(-1)).toMatchObject({ tool: "track", args: { move: 1, element: "auto" } });
    expect(plan.notes.join(" ")).toMatch(/24 more changes/);
    expect(plan.estimate.imageTokens).toBeLessThan(60_000);
  });

  it("joins overlapping every-frame windows, caps them by duration and prefers the strongest changes", () => {
    // Changes every half second, as boundaries at 2/s report a dissolve or a busy passage (the 33 s trailer case).
    const candidates = [4, 6.52, 7, 9.52, 11.52, 13.52, 14, 15, 16, 17, 19, 19.52].map((t) => ({ t, score: t === 15 ? 0.95 : t === 4 ? 0.9 : 0.4 }));
    const windows = denseWindows(candidates, 33, loupeBudget(33).dense);
    expect(windows).toHaveLength(4);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThan(windows[i - 1]!.end);
    for (const w of windows) expect(w.end - w.start).toBeLessThanOrEqual(MAX_DENSE_SECONDS + 1e-9);
    // The two strongest changes are in.
    expect(windows.some((w) => w.start <= 15 && w.end >= 15)).toBe(true);
    expect(windows.some((w) => w.start <= 4 && w.end >= 4)).toBe(true);
    // 6.52 and 7 (overlapping one-second windows) became one window, not two.
    expect(denseWindows(candidates.slice(1, 3), 33, 8)).toEqual([{ start: 6.02, end: 7.5, peak: 6.52, changes: 2 }]);
  });

  it("splits a long burst of changes into several every-frame windows of the budget", () => {
    // Changes every half second from 10 to 20 s, the strongest at 14 s and 18 s, and nothing else.
    const burst = Array.from({ length: 21 }, (_, i) => ({ t: 10 + i * 0.5, score: i === 8 || i === 16 ? 0.9 : 0.5 }));
    const windows = denseWindows(burst, 60, 4);
    // Before: one joined 10 s stretch, cut to a single 2 s window, three windows of the budget unused.
    expect(windows).toHaveLength(4);
    for (const w of windows) expect(w.end - w.start).toBeLessThanOrEqual(MAX_DENSE_SECONDS + 1e-9);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end);
    expect(windows.some((w) => w.start <= 14 && w.end >= 14)).toBe(true);
    expect(windows.some((w) => w.start <= 18 && w.end >= 18)).toBe(true);
  });

  it("keeps the style plan on a 33 s trailer far below the old 606 frames", () => {
    const times = [4, 6.52, 7, 9.52, 11.52, 13.52, 14, 15, 16, 17, 19, 19.52, 22.92, 24.92, 26, 26.72, 30.24];
    const plan = buildPlan({ goal: "style", probe: { ...probe(33), fps: 25, width: 1920, height: 1080 }, boundaries: bounds(30, 0.15, times), hasSpeech: false });
    const passages = plan.steps.filter((s) => s.args.fps === 10);
    const dense = plan.steps.filter((s) => s.args.every_frame);
    expect(passages.length).toBeLessThanOrEqual(2);
    expect(dense.length).toBeLessThanOrEqual(4);
    const spans = [...passages, ...dense].map((s) => [s.args.start as number, s.args.end as number] as const);
    // No two windows of the same kind overlap.
    for (const group of [passages, dense]) {
      const sorted = group.map((s) => [s.args.start as number, s.args.end as number]).sort((a, b) => a[0]! - b[0]!);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]).toBeGreaterThanOrEqual(sorted[i - 1]![1]!);
    }
    expect(spans.length).toBeGreaterThan(0);
    // Overview (66) + ×10 (2 × 4 s = 80) + every frame (≤ 4 × 2 s × 25 fps = 200), counted as `frames` lays them out.
    expect(plan.estimate.frames).toBeLessThan(350);
    expect(plan.estimate.imageTokens).toBeLessThan(35_000);
  });

  it("tracks a move listed twice only once", () => {
    const moves = [
      { start: 3.48, end: 7.12, frames: 91 },
      { start: 3.48, end: 7.12, frames: 91 },
      { start: 18.6, end: 23.16, frames: 114 },
    ];
    const plan = buildPlan({ goal: "style", probe: probe(33), boundaries: bounds(10, 0.1, [4]), hasSpeech: false, moves });
    expect(plan.steps.filter((s) => s.tool === "track").map((s) => s.args.move)).toEqual([1, 3]);
  });

  it("points track at the longest untracked style moves after style", () => {
    const moves = Array.from({ length: 9 }, (_, i) => ({ start: i, end: i + 0.5, frames: 10 + i, tracked: i === 8 }));
    const plan = buildPlan({ goal: "style", probe: probe(12), boundaries: bounds(10, 0.1, [1, 5]), hasSpeech: false, moves });
    const tracks = plan.steps.filter((s) => s.tool === "track");
    expect(tracks.map((s) => s.args.move)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(plan.steps.indexOf(tracks[0]!)).toBeGreaterThan(plan.steps.findIndex((s) => s.tool === "style"));
    expect(plan.notes.join(" ")).toMatch(/2 more moves can be tracked/);
  });

  it("estimates image tokens with Anthropic's rule", () => {
    expect(sheetTokens(16)).toBe(Math.ceil(1280 / 28) * Math.ceil((4 * 236) / 28));
    expect(sheetTokens(1)).toBe(Math.ceil(320 / 28) * Math.ceil(236 / 28));
  });

  it("picks non-overlapping busy windows", () => {
    const windows = busiestWindows(bounds(30, 0.2, [1, 1.5, 2, 2.5, 20, 30, 30.5]), 40, 8, 3);
    expect(windows[0]).toEqual({ start: 0, end: 8 });
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end);
  });
});

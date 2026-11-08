import { describe, expect, it } from "vitest";
import type { Boundaries } from "../../src/media/boundaries.js";
import type { ProbeInfo } from "../../src/media/probe.js";
import { buildPlan, busiestWindows, classify, inferGoal, sheetTokens } from "../../src/router/plan.js";

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
    expect(plan.estimate.sheets).toBe(2);
  });

  it("plans a motion reference with the loupe and keeps it bounded", () => {
    const times = Array.from({ length: 30 }, (_, i) => 1 + i * 1.4);
    const plan = buildPlan({ goal: "style", probe: probe(45), boundaries: bounds(40, 0.2, times), hasSpeech: false });
    expect(plan.goalInferred).toBe(false);
    const dense = plan.steps.filter((s) => s.args.every_frame);
    expect(dense).toHaveLength(12);
    expect(plan.steps.filter((s) => s.args.fps === 10).length).toBeLessThanOrEqual(3);
    expect(plan.steps.at(-1)!.tool).toBe("style");
    expect(plan.notes.join(" ")).toMatch(/18 more changes/);
    expect(plan.estimate.imageTokens).toBeLessThan(200_000);
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

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaTools } from "../media/exec.js";
import { filterValue } from "../media/sheets.js";

export interface EnergySample {
  t: number;
  /** Mean absolute brightness change from the previous frame, 0–255. */
  energy: number;
}

export type EasingFamily = "ease-out" | "ease-in" | "ease-in-out" | "linear" | "unclear";

export interface MotionEvent {
  start: number;
  end: number;
  frames: number;
  /** Peak change per frame. */
  peak: number;
  /** Where the fastest moment sits inside the move, 0 (start) to 1 (end). */
  peakAt: number;
  easing: EasingFamily;
  /** A CSS curve of that family to start from; refine with `frames` every_frame. */
  suggestion: string;
}

export const EASING_SUGGESTIONS: Record<EasingFamily, string> = {
  "ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
  "ease-in": "cubic-bezier(0.7, 0, 0.84, 0)",
  "ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
  linear: "linear",
  unclear: "",
};

/** Parses `metadata=print` output of signalstats YAVG on a frame-difference stream. */
export function parseEnergy(text: string): EnergySample[] {
  const samples: EnergySample[] = [];
  let t: number | undefined;
  for (const line of text.split("\n")) {
    const time = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const value = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (value && t !== undefined) {
      samples.push({ t: Math.round(t * 1000) / 1000, energy: Math.round(Number(value[1]) * 1000) / 1000 });
      t = undefined;
    }
  }
  return samples;
}

/** How much the picture changes from each frame to the next, over a range, at the native frame rate. */
export async function motionEnergy(source: string, tools: MediaTools, range: { start: number; end: number }): Promise<EnergySample[]> {
  const out = join(tmpdir(), `framelens-energy-${process.pid}-${Date.now()}.txt`);
  try {
    await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source, "-an",
      "-vf", `scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${filterValue(out)}`,
      "-fps_mode", "passthrough", "-f", "null", "-",
    ], { timeoutMs: 20 * 60_000 });
    return parseEnergy(readFileSync(out, "utf8")).map((s) => ({ t: Math.round((s.t + range.start) * 1000) / 1000, energy: s.energy }));
  } finally {
    rmSync(out, { force: true });
  }
}

export interface ClassifiedChange {
  t: number;
  score: number;
  kind: "cut" | "motion" | "flash";
}

/**
 * Tells cuts from fast motion and flashes using the per-frame energy: a cut is a one-frame spike, motion keeps
 * changing on the neighbouring frames, and a flash is two spikes close together (in, then back out).
 */
export function classifyChanges(candidates: { t: number; score: number }[], energy: EnergySample[], fps: number): ClassifiedChange[] {
  const frame = 1 / fps;
  const at = (t: number) => {
    let best: EnergySample | undefined;
    for (const s of energy) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) <= frame * 0.6 ? best.energy : 0;
  };
  const spikeTimes = (c: { t: number }) => {
    // The sampled time can sit a frame or two after the frame where the change happened.
    let peakT = c.t;
    // Walk back from the sample; on equal spikes the one nearest the sample wins.
    for (let k = -1; k >= -3; k--) if (at(c.t + k * frame) > at(peakT)) peakT = c.t + k * frame;
    return peakT;
  };
  const spikes = candidates.map((c) => ({ ...c, peakT: spikeTimes(c) }));
  return spikes.map((c, i) => {
    const peak = at(c.peakT);
    const before = at(c.peakT - frame);
    const after = at(c.peakT + frame);
    const neighbour = spikes.find((d, j) => j !== i && Math.abs(d.peakT - c.peakT) <= frame * 3.5);
    let kind: ClassifiedChange["kind"] = "cut";
    if (peak > 0 && (before >= peak * 0.3 || after >= peak * 0.3)) kind = "motion";
    else if (neighbour) kind = "flash";
    return { t: Math.round(c.peakT * 1000) / 1000, score: c.score, kind };
  });
}

/** Reads the easing family from the shape of a move's speed: where it peaks and how its ends taper. */
export function easingFromProfile(values: number[]): { easing: EasingFamily; peakAt: number } {
  if (values.length < 3) return { easing: "unclear", peakAt: 0.5 };
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const peakAt = peakIndex / (values.length - 1);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length) / (mean || 1);
  if (spread < 0.2) return { easing: "linear", peakAt };
  // Fast early with a long settle reads as ease-out; a long build-up to a late peak as ease-in.
  if (peakAt <= 0.34) return { easing: "ease-out", peakAt };
  if (peakAt >= 0.66) return { easing: "ease-in", peakAt };
  const startRatio = values[0]! / peak;
  const endRatio = values.at(-1)! / peak;
  if (startRatio < 0.6 && endRatio < 0.6) return { easing: "ease-in-out", peakAt };
  return { easing: "unclear", peakAt };
}

/**
 * Moves: runs of frames whose change stays above a threshold. A single-frame spike at a cut is a cut,
 * not a move, and is left out.
 */
export function motionEvents(samples: EnergySample[], cutTimes: number[], fps: number, options: { threshold?: number; gapFrames?: number } = {}): MotionEvent[] {
  if (!samples.length) return [];
  const sorted = [...samples.map((s) => s.energy)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const threshold = options.threshold ?? Math.max(0.8, median * 3);
  const gap = options.gapFrames ?? 2;
  const frameTime = 1 / fps;
  const isCut = (t: number) => cutTimes.some((c) => Math.abs(c - t) <= frameTime * 1.5);

  const runs: EnergySample[][] = [];
  let current: EnergySample[] = [];
  let quiet = 0;
  for (const s of samples) {
    if (s.energy >= threshold && !isCut(s.t)) {
      current.push(s);
      quiet = 0;
    } else if (current.length) {
      quiet++;
      if (quiet > gap) {
        runs.push(current);
        current = [];
        quiet = 0;
      }
    }
  }
  if (current.length) runs.push(current);

  return runs
    .filter((run) => run.length >= 3)
    .map((run) => {
      // Include the quieter edges of the move so the profile shows its acceleration.
      const first = samples.indexOf(run[0]!);
      const last = samples.indexOf(run.at(-1)!);
      const profile = samples.slice(Math.max(0, first - 1), last + 2).map((s) => s.energy);
      const { easing, peakAt } = easingFromProfile(profile);
      return {
        start: run[0]!.t,
        end: run.at(-1)!.t,
        frames: last - first + 1,
        peak: Math.max(...run.map((s) => s.energy)),
        peakAt: Math.round(peakAt * 100) / 100,
        easing,
        suggestion: EASING_SUGGESTIONS[easing],
      };
    });
}

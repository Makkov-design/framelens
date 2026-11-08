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
 * `sampleInterval` is the spacing of the samples the candidates came from: the change can be on any frame since
 * the previous sample (six frames back at 60 fps with 10 samples a second), so all of them are searched.
 * Neighbours are the adjacent energy samples, not times computed from the rate, so variable-rate files work too.
 */
export function classifyChanges(
  candidates: { t: number; score: number }[],
  energy: EnergySample[],
  fps: number,
  sampleInterval = 0.1,
): ClassifiedChange[] {
  const half = 0.5 / fps;
  const peakIndex = (t: number): number | undefined => {
    let best: number | undefined;
    // Walk back from the sample; on equal spikes the one nearest the sample wins.
    for (let i = energy.length - 1; i >= 0; i--) {
      const s = energy[i]!;
      if (s.t > t + half) continue;
      if (s.t < t - sampleInterval - half) break;
      if (best === undefined || s.energy > energy[best]!.energy) best = i;
    }
    return best;
  };
  const spikes = candidates.map((c) => ({ ...c, index: peakIndex(c.t) }));
  return spikes.map((c, i) => {
    const index = c.index;
    if (index === undefined) return { t: c.t, score: c.score, kind: "cut" as const };
    const peak = energy[index]!.energy;
    const before = energy[index - 1]?.energy ?? 0;
    const after = energy[index + 1]?.energy ?? 0;
    const neighbour = spikes.find((d, j) => j !== i && d.index !== undefined && d.index !== index && Math.abs(d.index - index) <= 3);
    let kind: ClassifiedChange["kind"] = "cut";
    if (peak > 0 && (before >= peak * 0.3 || after >= peak * 0.3)) kind = "motion";
    else if (neighbour) kind = "flash";
    return { t: Math.round(energy[index]!.t * 1000) / 1000, score: c.score, kind };
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

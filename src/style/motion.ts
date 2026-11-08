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
  let planes: Record<string, number> = {};
  const flush = () => {
    if (t === undefined || planes.Y === undefined) return;
    // Brightness change plus colour change, so a cut between two shots of equal brightness still shows.
    const energy = planes.Y + ((planes.U ?? 0) + (planes.V ?? 0)) / 2;
    samples.push({ t: Math.round(t * 1000) / 1000, energy: Math.round(energy * 1000) / 1000 });
  };
  for (const line of text.split("\n")) {
    const time = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (time) {
      flush();
      t = Number(time[1]);
      planes = {};
    }
    const value = /lavfi\.signalstats\.([YUV])AVG=([\d.]+)/.exec(line);
    if (value) planes[value[1]!] = Number(value[2]);
  }
  flush();
  return samples;
}

/** How much the picture changes from each frame to the next, over a range, at the native frame rate. */
export async function motionEnergy(source: string, tools: MediaTools, range: { start: number; end: number }): Promise<EnergySample[]> {
  const out = join(tmpdir(), `framelens-energy-${process.pid}-${Date.now()}.txt`);
  try {
    await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source, "-an",
      "-vf", `scale=160:-2,format=yuv444p,tblend=all_mode=difference,signalstats,metadata=print:file=${filterValue(out)}`,
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
  const seen = new Set<number>();
  const out: ClassifiedChange[] = [];
  for (const c of spikes) {
    const index = c.index;
    if (index === undefined) {
      out.push({ t: c.t, score: c.score, kind: "cut" });
      continue;
    }
    // Two samples of one flash often land on the same peak frame: one change, not two.
    if (seen.has(index)) continue;
    seen.add(index);
    const peak = energy[index]!.energy;
    const before = energy[index - 1]?.energy ?? 0;
    const after = energy[index + 1]?.energy ?? 0;
    let kind: ClassifiedChange["kind"] = "cut";
    if (peak > 0 && (before >= peak * 0.3 || after >= peak * 0.3)) kind = "motion";
    // The other half of a flash is in the energy itself, whether or not a sample landed on it.
    else if (flashPartner(energy, index) !== undefined) kind = "flash";
    out.push({ t: Math.round(energy[index]!.t * 1000) / 1000, score: c.score, kind });
  }
  return out;
}

/** A spike standing alone: far above the frames on both sides of it. */
function isolated(energy: EnergySample[], i: number): boolean {
  const e = energy[i]?.energy ?? 0;
  return e > 0 && (energy[i - 1]?.energy ?? 0) < e * 0.3 && (energy[i + 1]?.energy ?? 0) < e * 0.3;
}

/**
 * The other spike of a flash: a 2–3 frame flash is a jump in and a jump back out a few frames later, each standing
 * alone. Returns its index, if there is one within 3 frames.
 */
function flashPartner(energy: EnergySample[], i: number): number | undefined {
  const e = energy[i]!.energy;
  for (let d = 2; d <= 3; d++) {
    for (const j of [i - d, i + d]) {
      if (j >= 0 && j < energy.length && energy[j]!.energy >= e * 0.5 && energy[j]!.energy <= e * 2 && isolated(energy, j)) return j;
    }
  }
  return undefined;
}

/**
 * Cuts the sampled scene score can miss (two shots of similar colour): frames whose change is far above both the
 * frames around them and the video's usual change, standing alone.
 */
export function energySpikeCuts(energy: EnergySample[], minimum = 6): { t: number; score: number }[] {
  const cuts: { t: number; score: number }[] = [];
  const sorted = energy.map((s) => s.energy).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  for (let i = 1; i < energy.length - 1; i++) {
    const e = energy[i]!.energy;
    const before = energy[i - 1]!.energy;
    const after = energy[i + 1]!.energy;
    // A flash is two such spikes a few frames apart (in, then back out): neither is a cut.
    if (e >= Math.max(minimum, median * 6) && before < e * 0.3 && after < e * 0.3 && flashPartner(energy, i) === undefined) cuts.push({ t: energy[i]!.t, score: Math.min(1, e / 64) });
  }
  return cuts;
}

/** Reads the easing family from the shape of a move's speed: where it peaks and how its ends taper. */
export function easingFromProfile(values: number[]): { easing: EasingFamily; peakAt: number } {
  if (values.length < 3) return { easing: "unclear", peakAt: 0.5 };
  const peak = Math.max(...values);
  const peakAt = values.indexOf(peak) / (values.length - 1);
  // Judge the shape on the frames that actually move, not on quiet frames around them.
  const core = values.filter((v) => v >= peak * 0.15);
  const mean = core.reduce((s, v) => s + v, 0) / core.length;
  const spread = Math.sqrt(core.reduce((s, v) => s + (v - mean) ** 2, 0) / core.length) / (mean || 1);
  if (spread < 0.25) return { easing: "linear", peakAt };
  // Where the movement's weight sits: early for ease-out (fast start, long settle), late for ease-in.
  const total = values.reduce((s, v) => s + v, 0) || 1;
  const centroid = values.reduce((s, v, i) => s + v * i, 0) / total / (values.length - 1);
  if (centroid <= 0.42) return { easing: "ease-out", peakAt };
  if (centroid >= 0.58) return { easing: "ease-in", peakAt };
  const startRatio = values[0]! / peak;
  const endRatio = values.at(-1)! / peak;
  if (startRatio < 0.6 && endRatio < 0.6) return { easing: "ease-in-out", peakAt };
  return { easing: "linear", peakAt };
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

  // Compression noise: what a still frame scores. Slow ease-in starts and ease-out tails sit just above it.
  const baseline = median * 1.5 + 0.05;
  return runs
    .filter((run) => run.length >= 3)
    .map((run) => {
      let first = samples.indexOf(run[0]!);
      let last = samples.indexOf(run.at(-1)!);
      // Grow the move over its quiet edges, where it is still moving but below the detection threshold.
      while (first > 0 && samples[first - 1]!.energy > baseline && !isCut(samples[first - 1]!.t)) first--;
      while (last < samples.length - 1 && samples[last + 1]!.energy > baseline && !isCut(samples[last + 1]!.t)) last++;
      const profile = samples.slice(Math.max(0, first - 1), last + 2).map((s) => s.energy);
      const { easing, peakAt } = easingFromProfile(profile);
      // A frame's energy is its difference from the previous frame, so the move began one frame earlier.
      const start = Math.max(0, Math.round((samples[first]!.t - frameTime) * 1000) / 1000);
      return {
        start,
        end: samples[last]!.t,
        frames: last - first + 1,
        peak: Math.max(...run.map((s) => s.energy)),
        peakAt: Math.round(peakAt * 100) / 100,
        easing,
        suggestion: EASING_SUGGESTIONS[easing],
      };
    });
}

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { InvalidInputError } from "../errors.js";
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
    const time = /pts_time:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (time) {
      flush();
      t = Number(time[1]);
      planes = {};
    }
    const value = /lavfi\.signalstats\.([YUV])AVG=([\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (value) planes[value[1]!] = Number(value[2]);
  }
  flush();
  return samples;
}

/** How much the picture changes from each frame to the next, over a range, at the native frame rate. */
export async function motionEnergy(source: string, tools: MediaTools, range: { start: number; end: number }): Promise<EnergySample[]> {
  return (await motionProfile(source, tools, range)).energy;
}

/** Every frame of a range as tiny RGB pictures (64×36): transitions, shot colours, real moves versus noise. */
export interface PictureFrames {
  width: number;
  height: number;
  /** Source time of each frame. */
  times: number[];
  /** Packed RGB, one frame after another. */
  data: Uint8Array;
}

export const THUMB_WIDTH = 64;
export const THUMB_HEIGHT = 36;

/** The pixels of the first frame at or after `t` (the last frame when `t` is past the end); empty when there are none. */
export function frameAt(frames: PictureFrames, t: number): Uint8Array {
  const size = frames.width * frames.height * 3;
  if (!frames.times.length) return new Uint8Array(0);
  let k = frames.times.findIndex((time) => time >= t - 1e-4);
  if (k < 0) k = frames.times.length - 1;
  return frames.data.subarray(k * size, (k + 1) * size);
}

/** Frame times from `metadata=print` output. */
export function parseFrameTimes(text: string): number[] {
  const times: number[] = [];
  for (const line of text.split("\n")) {
    const time = /pts_time:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (time) times.push(Number(time[1]));
  }
  return times;
}

/** Most bytes of small frames one pass keeps (about 110,000 frames: an hour at 30 fps); beyond it only energy is read. */
export const MAX_FRAME_BYTES = 768 * 1024 * 1024;

/** Tone mapping of an HDR picture to SDR, as `framePixels` does it (needs ffmpeg with zimg). */
export const HDR_TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv";

export interface ProfileOptions {
  /** Tone-map the small frames of an HDR source, so the shot colours read from them are right. */
  hdr?: boolean;
  /** About how many frames the range holds: sizes the buffer once, and decides whether the frames fit. */
  expectedFrames?: number;
  /** Most bytes of small frames to keep (`MAX_FRAME_BYTES` by default). */
  maxBytes?: number;
}

/** Raw frames from ffmpeg's stdout into one buffer, grown as needed; rejects when they would pass `maxBytes`. */
function streamFrames(ffmpeg: string, args: string[], frameBytes: number, expected: number, maxBytes: number, timeoutMs: number): Promise<{ data: Uint8Array; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = new Uint8Array(Math.min(maxBytes, Math.max(64, expected) * frameBytes));
    let used = 0;
    let tooLarge = false;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      if (used + chunk.length > buffer.length) {
        if (used + chunk.length > maxBytes) {
          tooLarge = true;
          child.kill("SIGKILL");
          return;
        }
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(used + chunk.length, Math.ceil(buffer.length * 1.5))));
        grown.set(buffer.subarray(0, used));
        buffer = grown;
      }
      buffer.set(chunk, used);
      used += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new InvalidInputError("ffmpeg was not found on this computer. Run `npx framelens doctor` to see how to install it.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tooLarge) resolve({ data: new Uint8Array(0), tooLarge: true });
      else if (timedOut) reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)} s reading the frames.`));
      else if (code !== 0) reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${code}`}`));
      // Only whole frames; the buffer is not copied.
      else resolve({ data: buffer.subarray(0, used - (used % frameBytes)), tooLarge: false });
    });
  });
}

/**
 * One decoding pass over a range: the per-frame change (`energy`) and every frame as a tiny picture (`frames`), so
 * transitions can be told from moves and shot colours read without decoding the video again. The small frames come
 * through a pipe into one buffer (nothing on disk). A range whose frames would pass `maxBytes` gets the energy only
 * (`frames` empty, `skipped` true): analyze it in parts for transitions.
 */
export async function motionProfile(
  source: string,
  tools: MediaTools,
  range: { start: number; end: number },
  options: ProfileOptions = {},
): Promise<{ energy: EnergySample[]; frames: PictureFrames; skipped?: boolean }> {
  const stamp = `${process.pid}-${Date.now()}`;
  const out = join(tmpdir(), `framelens-energy-${stamp}.txt`);
  const times = join(tmpdir(), `framelens-thumbs-${stamp}.txt`);
  const size = THUMB_WIDTH * THUMB_HEIGHT * 3;
  const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
  const expected = options.expectedFrames ?? 0;
  // The first video stream, as the probe reads it.
  const input = ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source];
  const energyChain = `format=yuv444p,tblend=all_mode=difference,signalstats,metadata=print:file=${filterValue(out)}`;
  const thumbChain = (hdr: boolean) =>
    // Only the frame times are needed here: print one key per frame, not all of signalstats (a long range's log).
    `${hdr ? `${HDR_TONEMAP},` : ""}format=yuv444p,scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${filterValue(times)},format=rgb24`;
  const timeoutMs = 20 * 60_000;
  const energyOnly = () =>
    tools.exec(tools.ffmpeg, [...input, "-map", "0:v:0", "-an", "-vf", `scale=160:-2,${energyChain}`, "-fps_mode", "passthrough", "-f", "null", "-"], { timeoutMs }).catch(() => undefined);
  const result = (data: Uint8Array, skipped = false) => {
    const energy = existsSync(out) ? parseEnergy(readFileSync(out, "utf8")).map((s) => ({ t: Math.round((s.t + range.start) * 1000) / 1000, energy: s.energy })) : [];
    const stamps = skipped || !existsSync(times) ? [] : parseFrameTimes(readFileSync(times, "utf8"));
    const count = Math.min(stamps.length, Math.floor(data.length / size));
    return {
      energy,
      frames: { width: THUMB_WIDTH, height: THUMB_HEIGHT, times: stamps.slice(0, count).map((t) => Math.round((t + range.start) * 1000) / 1000), data: data.subarray(0, count * size) },
      ...(skipped && { skipped }),
    };
  };
  try {
    if (expected * size > maxBytes) {
      await energyOnly();
      return result(new Uint8Array(0), true);
    }
    const both = (hdr: boolean) =>
      streamFrames(tools.ffmpeg, [
        ...input,
        "-filter_complex", `[0:v:0]scale=160:-2,split=2[e][p];[e]${energyChain}[eo];[p]${thumbChain(hdr)}[po]`,
        "-map", "[eo]", "-fps_mode", "passthrough", "-f", "null", "-",
        "-map", "[po]", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1",
      ], size, expected, maxBytes, timeoutMs);
    const clear = () => {
      for (const file of [out, times]) rmSync(file, { force: true });
    };
    let read: { data: Uint8Array; tooLarge: boolean } | undefined;
    // HDR without zimg in this ffmpeg: the frames stay untone-mapped (colours approximate), as in `framePixels`.
    for (const hdr of options.hdr ? [true, false] : [false]) {
      try {
        read = await both(hdr);
        break;
      } catch {
        clear();
      }
    }
    if (!read) {
      // A one-frame video has no frame-to-frame change, and an output that never gets a frame fails the whole pass:
      // decode for each output on its own.
      await energyOnly();
      read = await streamFrames(tools.ffmpeg, [...input, "-map", "0:v:0", "-an", "-vf", `scale=160:-2,${thumbChain(false)}`, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], size, expected, maxBytes, timeoutMs);
    }
    if (read.tooLarge) {
      clear();
      await energyOnly();
      return result(new Uint8Array(0), true);
    }
    return result(read.data);
  } finally {
    for (const file of [out, times]) rmSync(file, { force: true });
  }
}

export interface ClassifiedChange {
  t: number;
  score: number;
  kind: "cut" | "motion" | "flash";
}

/**
 * Tells cuts from fast motion and flashes using the per-frame energy: a cut is a one-frame spike, motion keeps
 * changing on the neighbouring frames, and a flash is two spikes close together (in, then back out to the same
 * picture; with `frames`, a 2–3 frame shot between two cuts is told apart from a flash).
 * `sampleInterval` is the spacing of the samples the candidates came from: the change can be on any frame since
 * the previous sample (six frames back at 60 fps with 10 samples a second), so all of them are searched.
 * Neighbours are the adjacent energy samples, not times computed from the rate, so variable-rate files work too.
 */
export function classifyChanges(
  candidates: { t: number; score: number }[],
  energy: EnergySample[],
  fps: number,
  sampleInterval = 0.1,
  frames?: PictureFrames,
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
    else if (flashPartner(energy, index, frames) !== undefined) kind = "flash";
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
 * alone, and the picture after it is the one before it. Two cuts around a 2–3 frame shot also make two such spikes,
 * but the picture does not come back; with the frames at hand that is checked. Returns the partner's index, if there
 * is one within 3 frames.
 */
function flashPartner(energy: EnergySample[], i: number, frames?: PictureFrames): number | undefined {
  const e = energy[i]!.energy;
  for (let d = 2; d <= 3; d++) {
    for (const j of [i - d, i + d]) {
      if (j < 0 || j >= energy.length || energy[j]!.energy < e * 0.5 || energy[j]!.energy > e * 2 || !isolated(energy, j)) continue;
      if (comesBack(energy, Math.min(i, j), Math.max(i, j), frames)) return j;
    }
  }
  return undefined;
}

/** The frame at (or nearest to) time `t`, or undefined when no frame is within 20 ms. */
function frameIndex(frames: PictureFrames, t: number): number | undefined {
  let lo = 0;
  let hi = frames.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames.times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(frames.times[lo - 1]! - t) < Math.abs(frames.times[lo]! - t)) best = lo - 1;
  return Math.abs(frames.times[best]! - t) <= 0.02 ? best : undefined;
}

/** Mean absolute difference of two tiny frames, 0–255. */
function frameDifference(frames: PictureFrames, a: number, b: number): number {
  const size = frames.width * frames.height * 3;
  const x = frames.data.subarray(a * size, (a + 1) * size);
  const y = frames.data.subarray(b * size, (b + 1) * size);
  let sum = 0;
  for (let k = 0; k < size; k++) sum += Math.abs(x[k]! - y[k]!);
  return sum / size;
}

/**
 * Whether the picture after the second spike is the one before the first (a flash), not a new one (a short shot
 * between two cuts). Without frames the spikes alone decide: a flash.
 */
function comesBack(energy: EnergySample[], first: number, second: number, frames?: PictureFrames): boolean {
  if (!frames?.times.length) return true;
  const into = frameIndex(frames, energy[first]!.t);
  const out = frameIndex(frames, energy[second]!.t);
  if (into === undefined || out === undefined || into < 1) return true;
  // Back to (nearly) the same picture: what differs is noise or a little motion, not a new shot of a similar look.
  return frameDifference(frames, into - 1, out) < frameDifference(frames, into - 1, into) * 0.3;
}

/**
 * Cuts the sampled scene score can miss (two shots of similar colour): frames whose change is far above both the
 * frames around them and the video's usual change, standing alone.
 */
export function energySpikeCuts(energy: EnergySample[], minimum = 6, frames?: PictureFrames): { t: number; score: number }[] {
  const cuts: { t: number; score: number }[] = [];
  const sorted = energy.map((s) => s.energy).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  for (let i = 1; i < energy.length - 1; i++) {
    const e = energy[i]!.energy;
    const before = energy[i - 1]!.energy;
    const after = energy[i + 1]!.energy;
    // A flash is two such spikes a few frames apart (in, then back out): neither is a cut.
    if (e >= Math.max(minimum, median * 6) && before < e * 0.3 && after < e * 0.3 && flashPartner(energy, i, frames) === undefined) cuts.push({ t: energy[i]!.t, score: Math.min(1, e / 64) });
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
 * not a move, and is left out; so are the frames of `exclude` (transitions such as dissolves and fades, which change
 * the whole picture but are not moves).
 *
 * Each run grows over its quiet edges (slow starts and tails). Two runs separated only by such slow frames grow into
 * the same window: they are one move, reported once.
 */
export function motionEvents(
  samples: EnergySample[],
  cutTimes: number[],
  fps: number,
  options: { threshold?: number; gapFrames?: number; exclude?: { start: number; end: number }[] } = {},
): MotionEvent[] {
  if (!samples.length) return [];
  const sorted = [...samples.map((s) => s.energy)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const threshold = options.threshold ?? Math.max(0.8, median * 3);
  const gap = options.gapFrames ?? 2;
  const frameTime = 1 / fps;
  const excluded = options.exclude ?? [];
  // A transition's changed frames are those after its first state and up to its last: (start, end].
  const isCut = (t: number) =>
    cutTimes.some((c) => Math.abs(c - t) <= frameTime * 1.5) || excluded.some((x) => t > x.start + frameTime / 4 && t <= x.end + frameTime / 4);

  const runs: number[][] = [];
  let current: number[] = [];
  let quiet = 0;
  samples.forEach((s, i) => {
    if (s.energy >= threshold && !isCut(s.t)) {
      current.push(i);
      quiet = 0;
    } else if (current.length) {
      quiet++;
      if (quiet > gap) {
        runs.push(current);
        current = [];
        quiet = 0;
      }
    }
  });
  if (current.length) runs.push(current);

  // Compression noise: what a still frame scores. Slow ease-in starts and ease-out tails sit just above it.
  const baseline = median * 1.5 + 0.05;
  const windows: { first: number; last: number; peak: number }[] = [];
  for (const run of runs.filter((r) => r.length >= 3)) {
    let first = run[0]!;
    let last = run.at(-1)!;
    // Grow the move over its quiet edges, where it is still moving but below the detection threshold.
    while (first > 0 && samples[first - 1]!.energy > baseline && !isCut(samples[first - 1]!.t)) first--;
    while (last < samples.length - 1 && samples[last + 1]!.energy > baseline && !isCut(samples[last + 1]!.t)) last++;
    const peak = Math.max(...run.map((i) => samples[i]!.energy));
    const previous = windows.at(-1);
    // Grown over the same slow frames into the previous window: the same move, not a second one.
    if (previous && first <= previous.last + 1) {
      previous.last = Math.max(previous.last, last);
      previous.peak = Math.max(previous.peak, peak);
    } else windows.push({ first, last, peak });
  }
  return windows.map(({ first, last, peak }) => {
    const profile = samples.slice(Math.max(0, first - 1), last + 2).map((s) => s.energy);
    const { easing, peakAt } = easingFromProfile(profile);
    // A frame's energy is its difference from the previous frame, so the move began one frame earlier.
    const start = Math.max(0, Math.round((samples[first]!.t - frameTime) * 1000) / 1000);
    return {
      start,
      end: samples[last]!.t,
      frames: last - first + 1,
      peak,
      peakAt: Math.round(peakAt * 100) / 100,
      easing,
      suggestion: EASING_SUGGESTIONS[easing],
    };
  });
}

/** The same move listed more than once (same start, end and length) is kept once, at its first place. */
export function uniqueEvents<T extends { start: number; end: number; frames: number }>(events: T[]): T[] {
  const seen = new Set<string>();
  // The order is kept: a web page's or Lottie's own order of animations means something.
  return events.filter((e) => {
    const key = `${Math.round(e.start * 1000)}|${Math.round(e.end * 1000)}|${e.frames}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

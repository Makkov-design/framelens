import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaTools } from "../media/exec.js";
import { filterValue } from "../media/sheets.js";
import { rgbToOklab, type Swatch } from "../style/palette.js";

export interface SimilaritySample {
  t: number;
  /** Structural similarity of the two pictures, 0–1 (1 = identical). */
  ssim: number;
}

export interface CutMatch {
  reference: number;
  render?: number;
  /** Render minus reference, in frames (positive = late). */
  offsetFrames?: number;
}

export interface Comparison {
  durations: { reference: number; render: number; differenceSeconds: number };
  /**
   * `shift`: the whole render's cuts sit this many frames from the reference's (negative = early). Cuts are matched
   * after removing it, so a render that is only shifted is not reported as every cut missing and every cut extra.
   */
  cuts: { matched: CutMatch[]; missing: number[]; extra: number[]; shift?: { frames: number; seconds: number; cuts: number } };
  palette: { distance: number; reference: string[]; render: string[] };
  similarity: { mean: number; worst: SimilaritySample[] };
  verdict: string[];
}

/** How many least similar moments the report names and the side-by-side sheet shows: the same ones in both. */
export const WORST_MOMENTS = 6;

/** Parses ffmpeg ssim stats lines: `n:12 Y:0.98 U:0.99 V:0.99 All:0.985 (18.2)`. */
export function parseSsim(text: string, rate: number): SimilaritySample[] {
  const samples: SimilaritySample[] = [];
  for (const line of text.split("\n")) {
    const m = /n:(\d+).*All:([\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (m) samples.push({ t: Math.round(((Number(m[1]) - 1) / rate) * 1000) / 1000, ssim: Number(m[2]) });
  }
  return samples;
}

/** Samples both videos at the same rate and size and scores how alike each pair of pictures is. */
export async function similarity(reference: string, render: string, tools: MediaTools, rate = 4): Promise<SimilaritySample[]> {
  const out = join(tmpdir(), `framelens-ssim-${process.pid}-${Date.now()}.txt`);
  try {
    await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-i", reference, "-i", render,
      "-lavfi", `[0:v]fps=${rate},scale=320:180,setsar=1,format=yuv420p[a];[1:v]fps=${rate},scale=320:180,setsar=1,format=yuv420p[b];[a][b]ssim=stats_file=${filterValue(out)}`,
      "-f", "null", "-",
    ], { timeoutMs: 20 * 60_000 });
    return parseSsim(readFileSync(out, "utf8"), rate);
  } finally {
    rmSync(out, { force: true });
  }
}

/** Pairs each reference cut with the nearest render cut within `toleranceFrames` of where it should be (`t + shift`). */
function pairCuts(reference: number[], render: number[], fps: number, toleranceFrames: number, shiftSeconds = 0): { matched: CutMatch[]; extra: number[] } {
  const free = [...render];
  const matched: CutMatch[] = reference.map((t) => {
    const want = t + shiftSeconds;
    let best = -1;
    for (let i = 0; i < free.length; i++) if (best < 0 || Math.abs(free[i]! - want) < Math.abs(free[best]! - want)) best = i;
    if (best >= 0 && Math.abs(free[best]! - want) * fps <= toleranceFrames + 1e-6) {
      const [hit] = free.splice(best, 1);
      return { reference: t, render: hit!, offsetFrames: Math.round((hit! - t) * fps) };
    }
    return { reference: t };
  });
  return { matched, extra: free };
}

/** Largest shift of the whole render looked for, in seconds. */
const MAX_SHIFT_SECONDS = 2;

/**
 * A shift of the whole render, in frames: the offset (up to 2 s) that lines up most cuts within a frame, when it lines
 * up at least two and at least 60 % of the reference's cuts, and more of them than no shift does.
 */
export function constantShift(reference: number[], render: number[], fps: number): { frames: number; cuts: number } | undefined {
  if (reference.length < 2 || render.length < 2) return undefined;
  const lined = (frames: number) => pairCuts(reference, render, fps, 1, frames / fps).matched.filter((m) => m.render !== undefined).length;
  const candidates = new Set<number>();
  for (const r of reference) {
    for (const s of render) {
      const frames = Math.round((s - r) * fps);
      if (Math.abs(frames) <= MAX_SHIFT_SECONDS * fps) candidates.add(frames);
    }
  }
  let best: { frames: number; cuts: number } | undefined;
  for (const frames of candidates) {
    if (frames === 0) continue;
    const cuts = lined(frames);
    if (!best || cuts > best.cuts || (cuts === best.cuts && Math.abs(frames) < Math.abs(best.frames))) best = { frames, cuts };
  }
  if (!best || best.cuts < 2 || best.cuts < 0.6 * reference.length || best.cuts <= lined(0)) return undefined;
  return best;
}

/**
 * Pairs each reference cut with the nearest render cut within `toleranceFrames`. When the whole render is shifted
 * (it starts a few frames early or late), the shift is found first and the cuts are paired after removing it.
 */
export function matchCuts(reference: number[], render: number[], fps: number, toleranceFrames = 3): Comparison["cuts"] {
  const shift = constantShift(reference, render, fps);
  const { matched, extra } = pairCuts(reference, render, fps, toleranceFrames, shift ? shift.frames / fps : 0);
  return {
    matched,
    missing: matched.filter((m) => m.render === undefined).map((m) => m.reference),
    extra,
    ...(shift && { shift: { frames: shift.frames, seconds: Math.round((shift.frames / fps) * 1000) / 1000, cuts: shift.cuts } }),
  };
}

const hexLab = (hex: string) => rgbToOklab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));

/** Mean OKLab distance from each of the reference's main colours to the nearest render colour, weighted by share. */
export function paletteDistance(reference: Swatch[], render: Swatch[]): number {
  if (!reference.length || !render.length) return 1;
  let total = 0;
  let weight = 0;
  for (const ref of reference.slice(0, 6)) {
    const a = hexLab(ref.hex);
    const nearest = Math.min(...render.map((r) => {
      const b = hexLab(r.hex);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }));
    total += nearest * ref.share;
    weight += ref.share;
  }
  return Math.round((total / (weight || 1)) * 1000) / 1000;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The least similar moments as the report and the sheet name them: `2.28 s (0.41)`. */
export const momentList = (worst: SimilaritySample[]) => worst.map((w) => `${w.t.toFixed(2)} s (${w.ssim.toFixed(2)})`).join(", ");

export function verdict(c: Omit<Comparison, "verdict">, fps: number): string[] {
  const notes: string[] = [];
  const shift = c.cuts.shift;
  // A shifted render first: it explains every cut being off, which the lines below then leave out.
  if (shift) {
    notes.push(
      `The render is ${plural(Math.abs(shift.frames), "frame")} ${shift.frames < 0 ? "early" : "late"} (${shift.seconds > 0 ? "+" : ""}${shift.seconds.toFixed(2)} s): ` +
        `${shift.cuts} of ${c.cuts.matched.length} cuts line up once it is shifted. Move the whole render ${shift.frames < 0 ? "later" : "earlier"} by ${plural(Math.abs(shift.frames), "frame")} before fixing single cuts.`,
    );
  }
  if (Math.abs(c.durations.differenceSeconds) > 1 / fps) notes.push(`Duration differs by ${c.durations.differenceSeconds.toFixed(2)} s.`);
  const besides = shift ? " besides the shift" : "";
  if (c.cuts.missing.length) notes.push(`Missing cuts${besides} at ${c.cuts.missing.map((t) => `${t.toFixed(2)} s`).join(", ")}.`);
  if (c.cuts.extra.length) notes.push(`Extra cuts${besides} at ${c.cuts.extra.map((t) => `${t.toFixed(2)} s`).join(", ")}.`);
  const base = shift?.frames ?? 0;
  const late = c.cuts.matched.filter((m) => m.offsetFrames !== undefined && Math.abs(m.offsetFrames - base) >= 1);
  if (late.length) notes.push(`Cuts off by a frame or more${besides}: ${late.map((m) => `${m.reference.toFixed(2)} s (${m.offsetFrames! - base > 0 ? "+" : ""}${m.offsetFrames! - base})`).join(", ")}.`);
  if (c.palette.distance > 0.08) notes.push(`Colours drift from the reference (OKLab distance ${c.palette.distance}); compare the palettes.`);
  // The same moments the side-by-side sheet shows.
  if (c.similarity.worst.some((w) => w.ssim < 0.5)) notes.push(`Least similar moments (side by side in the sheet): ${momentList(c.similarity.worst)}.`);
  if (!notes.length) notes.push("Structure, timing and colour match the reference within tolerance.");
  return notes;
}

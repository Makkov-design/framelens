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
  cuts: { matched: CutMatch[]; missing: number[]; extra: number[] };
  palette: { distance: number; reference: string[]; render: string[] };
  similarity: { mean: number; worst: SimilaritySample[] };
  verdict: string[];
}

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

/** Pairs each reference cut with the nearest render cut within `toleranceFrames`. */
export function matchCuts(reference: number[], render: number[], fps: number, toleranceFrames = 3): Comparison["cuts"] {
  const free = [...render];
  const matched: CutMatch[] = reference.map((t) => {
    let best = -1;
    for (let i = 0; i < free.length; i++) if (best < 0 || Math.abs(free[i]! - t) < Math.abs(free[best]! - t)) best = i;
    if (best >= 0 && Math.abs(free[best]! - t) * fps <= toleranceFrames) {
      const [hit] = free.splice(best, 1);
      return { reference: t, render: hit!, offsetFrames: Math.round((hit! - t) * fps) };
    }
    return { reference: t };
  });
  return { matched, missing: matched.filter((m) => m.render === undefined).map((m) => m.reference), extra: free };
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

export function verdict(c: Omit<Comparison, "verdict">, fps: number): string[] {
  const notes: string[] = [];
  if (Math.abs(c.durations.differenceSeconds) > 1 / fps) notes.push(`Duration differs by ${c.durations.differenceSeconds.toFixed(2)} s.`);
  if (c.cuts.missing.length) notes.push(`Missing cuts at ${c.cuts.missing.map((t) => `${t.toFixed(2)} s`).join(", ")}.`);
  if (c.cuts.extra.length) notes.push(`Extra cuts at ${c.cuts.extra.map((t) => `${t.toFixed(2)} s`).join(", ")}.`);
  const late = c.cuts.matched.filter((m) => m.offsetFrames && Math.abs(m.offsetFrames) >= 1);
  if (late.length) notes.push(`Cuts off by a frame or more: ${late.map((m) => `${m.reference.toFixed(2)} s (${m.offsetFrames! > 0 ? "+" : ""}${m.offsetFrames})`).join(", ")}.`);
  if (c.palette.distance > 0.08) notes.push(`Colours drift from the reference (OKLab distance ${c.palette.distance}); compare the palettes.`);
  if (c.similarity.worst.length && c.similarity.worst[0]!.ssim < 0.5) notes.push(`Least similar moments: ${c.similarity.worst.slice(0, 5).map((w) => `${w.t.toFixed(2)} s (${w.ssim.toFixed(2)})`).join(", ")}.`);
  if (!notes.length) notes.push("Structure, timing and colour match the reference within tolerance.");
  return notes;
}

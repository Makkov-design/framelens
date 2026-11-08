import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MediaTools } from "../media/exec.js";
import type { ProbeInfo } from "../media/probe.js";
import type { Transcript } from "../speech/transcript.js";
import type { SourceRecord, Workspace } from "../workspace/workspace.js";
import { formatTimestamp } from "../youtube.js";
import { mergePalettes, palette, type Swatch } from "./palette.js";
import type { ClassifiedChange, MotionEvent } from "./motion.js";

export type Evidence = "measured" | "derived" | "inferred";

export interface Shot {
  id: string;
  start: number;
  end: number;
  frames: number;
  anchor?: string;
  palette: Swatch[];
}

export interface MotionSpec {
  spec: "framelens.motion/1";
  generatedBy: string;
  source: { kind: string; url?: string; title?: string; input: string };
  range: { start: number; end: number };
  timebase: { fps?: number; vfr: boolean; duration: number; width?: number; height?: number };
  anchors: {
    words: { id: string; t: number; end: number; text: string }[];
    beats: { id: string; t: number; downbeat?: boolean }[];
    cuts: { id: string; t: number; frame?: number; score: number; evidence: Evidence }[];
  };
  /** Abrupt changes that are not cuts: fast motion and flashes. */
  changes: { t: number; kind: "motion" | "flash"; score: number; evidence: Evidence }[];
  palette: (Swatch & { role?: string; evidence: Evidence })[];
  typography: { role: string; family_guess?: string; weight?: number; case?: string; evidence: Evidence }[];
  shots: (Omit<Shot, "palette"> & { palette: string[] })[];
  systems: { id: string; role: string; start: number; end: number; states: unknown[] }[];
  events: (MotionEvent & { kind: "move"; anchor?: string; evidence: Evidence })[];
  rhythm: { cuts: number; cutsPerMinute: number; meanShotSeconds: number; medianShotSeconds: number; movesPerMinute: number };
  audio: { tempo_bpm?: number; cut_on_beat_ratio?: number; sfx: unknown[] };
}

/** Grabs one frame as raw RGB pixels at 64×36 (tone-mapped when HDR, so colours are not washed out). */
export async function framePixels(source: string, t: number, probe: ProbeInfo, tools: MediaTools, tmpDir: string): Promise<Buffer> {
  const out = join(tmpDir, `px-${process.pid}-${Math.round(t * 1000)}.rgb`);
  const base = "scale=64:36:flags=area,format=rgb24";
  const hdr = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,";
  const run = (filters: string) =>
    tools.exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(t), "-i", source, "-frames:v", "1", "-vf", filters, "-f", "rawvideo", out]);
  try {
    if (probe.hdr) {
      try {
        await run(hdr + base);
      } catch {
        await run(base); // ffmpeg without zimg: colours stay approximate.
      }
    } else {
      await run(base);
    }
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

/** Shots between cuts; slivers shorter than two frames are merged into their neighbour. */
export function shotsFromCuts(cuts: number[], range: { start: number; end: number }, fps = 30): { start: number; end: number }[] {
  const edges = [range.start, ...cuts.filter((c) => c > range.start && c < range.end), range.end];
  const shots: { start: number; end: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    if (end - start < 2 / fps && shots.length) shots[shots.length - 1]!.end = end;
    else shots.push({ start, end });
  }
  return shots;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildSpec(input: {
  record: SourceRecord;
  probe: ProbeInfo;
  range: { start: number; end: number };
  transcript?: Transcript;
  changes: ClassifiedChange[];
  shots: Shot[];
  overall: Swatch[];
  events: MotionEvent[];
  version: string;
}): MotionSpec {
  const { probe, range, shots, events } = input;
  const fps = probe.fps;
  const cuts = input.changes.filter((c) => c.kind === "cut").map((c, i) => ({
    id: `c${i + 1}`,
    t: c.t,
    ...(fps && { frame: Math.round(c.t * fps) }),
    score: c.score,
    evidence: "measured" as const,
  }));
  const words = (input.transcript?.words ?? [])
    .filter((w) => w.t >= range.start && w.t <= range.end)
    .map((w, i) => ({ id: `w${i + 1}`, t: w.t, end: w.end, text: w.text }));
  const minutes = (range.end - range.start) / 60 || 1;
  const lengths = shots.map((s) => s.end - s.start);
  const nearestWord = (t: number) => words.find((w) => w.t <= t + 0.08 && w.end >= t - 0.08)?.id;
  return {
    spec: "framelens.motion/1",
    generatedBy: `framelens ${input.version}`,
    source: {
      kind: input.record.kind,
      input: input.record.input,
      ...(input.record.url && { url: input.record.url }),
      ...(input.record.title && { title: input.record.title }),
    },
    range,
    timebase: {
      ...(fps && { fps }),
      vfr: probe.vfr,
      duration: probe.duration,
      ...(probe.width && { width: probe.width }),
      ...(probe.height && { height: probe.height }),
    },
    anchors: { words, beats: [], cuts },
    changes: input.changes
      .filter((c): c is ClassifiedChange & { kind: "motion" | "flash" } => c.kind !== "cut")
      .map((c) => ({ t: c.t, kind: c.kind, score: c.score, evidence: "derived" as const })),
    palette: input.overall.map((s) => ({ ...s, evidence: "measured" as const })),
    typography: [],
    shots: shots.map((s) => ({ ...s, palette: s.palette.slice(0, 4).map((p) => p.hex) })),
    systems: [],
    events: events.map((e) => {
      const anchor = nearestWord(e.start) ?? cuts.find((c) => Math.abs(c.t - e.start) < 0.1)?.id;
      return { ...e, kind: "move" as const, ...(anchor && { anchor }), evidence: "derived" as const };
    }),
    rhythm: {
      cuts: cuts.length,
      cutsPerMinute: r2(cuts.length / minutes),
      meanShotSeconds: r2(lengths.reduce((s, l) => s + l, 0) / (lengths.length || 1)),
      medianShotSeconds: r2(median(lengths)),
      movesPerMinute: r2(events.length / minutes),
    },
    audio: { sfx: [] },
  };
}

const MEASURED_START = "<!-- framelens:measured:start -->";
const MEASURED_END = "<!-- framelens:measured:end -->";

/** Writes a file once; on later runs replaces only the measured block, keeping what the agent wrote around it. */
export function writeWithMeasuredBlock(ws: Workspace, name: string, measured: string, skeleton: string): string {
  const file = ws.path(name);
  const block = `${MEASURED_START}\n${measured.trim()}\n${MEASURED_END}`;
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    const a = current.indexOf(MEASURED_START);
    const b = current.indexOf(MEASURED_END);
    if (a >= 0 && b > a) return ws.writeText(name, current.slice(0, a) + block + current.slice(b + MEASURED_END.length));
    return file; // Written by hand without a block: never overwrite.
  }
  return ws.writeText(name, skeleton.replace("{{measured}}", block));
}

const fmt = (t: number) => `${formatTimestamp(t)}${(t % 1).toFixed(2).slice(1)}`;

export function styleMarkdown(spec: MotionSpec): { measured: string; skeleton: string } {
  const swatches = spec.palette.map((p) => `| \`${p.hex}\` | ${(p.share * 100).toFixed(1)}% | ${p.lightness} | ${p.chroma < 0.03 ? "neutral" : p.chroma} |`);
  const easing = new Map<string, number>();
  for (const e of spec.events) easing.set(e.easing, (easing.get(e.easing) ?? 0) + 1);
  const moveLines = spec.events.slice(0, 40).map((e) => `| ${fmt(e.start)} | ${e.frames} | ${e.easing} | ${e.suggestion || "—"} | ${e.peakAt} |`);
  const measured = [
    "## Measured",
    "",
    `Range ${fmt(spec.range.start)}–${fmt(spec.range.end)}, ${spec.timebase.width ?? "?"}×${spec.timebase.height ?? "?"} at ${spec.timebase.fps ?? "?"} fps${spec.timebase.vfr ? " (variable)" : ""}.`,
    "",
    `**Rhythm:** ${spec.rhythm.cuts} cuts (${spec.rhythm.cutsPerMinute} per minute), shots ${spec.rhythm.meanShotSeconds} s on average (median ${spec.rhythm.medianShotSeconds} s), ${spec.rhythm.movesPerMinute} moves per minute.`,
    "",
    "**Palette** (OKLab clusters weighted by screen time):",
    "",
    "| Colour | Share | Lightness | Chroma |",
    "|---|---|---|---|",
    ...swatches,
    "",
    `**Moves:** ${spec.events.length} (${[...easing.entries()].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}). Easing families are derived from how fast the whole picture changes, so check important moves with \`frames\` every_frame and refine the curve.`,
    "",
    ...(moveLines.length ? ["| Starts | Frames | Family | Starting curve | Peak at |", "|---|---|---|---|---|", ...moveLines] : []),
  ].join("\n");
  const skeleton = `# Style: ${spec.source.title ?? spec.source.input}

One sentence on the look and feel (to write after looking at the sheets).

{{measured}}

## Typography

Families (guesses), weights, sizes relative to frame height, case, tracking, how text enters and leaves.

## Visual systems

Things that live across several shots (captions, boards, frames, sound beds): their role, look, and how their state changes.

## Motion vocabulary

Entrances, exits and transitions that repeat, with their durations in frames and refined curves.

## Sound

Music, tempo, how cuts and moves sit on the beat, sound effects on transitions.

## How to recreate

Notes for HyperFrames, Remotion, After Effects or CSS: structure, timing anchors (words, beats, cuts), what to keep and what to redesign.
`;
  return { measured, skeleton };
}

export function timelineMarkdown(spec: MotionSpec, transcript?: Transcript): { measured: string; skeleton: string } {
  const sections = spec.shots.map((s) => {
    const said = (transcript?.segments ?? [])
      .filter((seg) => seg.start < s.end && seg.end > s.start)
      .map((seg) => seg.text)
      .join(" ");
    return `### ${fmt(s.start)}–${fmt(s.end)} · ${s.id} (${s.frames} frames)\n\nColours ${s.palette.map((p) => `\`${p}\``).join(" ")}.${said ? ` Said: “${said.slice(0, 300)}”` : ""}\n\n_What happens and why:_`;
  });
  const measured = ["## Shots", "", ...sections].join("\n\n");
  const skeleton = `# Timeline: ${spec.source.title ?? spec.source.input}

Sections by source time. Under each shot, connect what moves to the words, beats or actions it serves, and say what it does for the viewer.

{{measured}}
`;
  return { measured, skeleton };
}

export const ANALYSIS_SKELETON = (title: string) => `# Analysis: ${title}

Keep facts (what is on screen, measured numbers) apart from interpretation.

## What the piece is trying to do

## Hook

What happens in the first seconds, and why it holds attention.

## Structure and pacing

## Systems

Visual and sound systems that persist or recur, and what each contributes.

## Why it works

## What to keep, what to redesign

For the user's adaptation.

## Open questions

With the source times to revisit.
`;

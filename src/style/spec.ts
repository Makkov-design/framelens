import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MediaTools } from "../media/exec.js";
import type { ProbeInfo } from "../media/probe.js";
import type { Transcript } from "../speech/transcript.js";
import type { SourceRecord, Workspace } from "../workspace/workspace.js";
import { formatTimestamp } from "../youtube.js";
import { oneLine } from "../text.js";
import { mergePalettes, palette, type Swatch } from "./palette.js";
import { uniqueEvents, type ClassifiedChange, type MotionEvent } from "./motion.js";
import type { Transition } from "./transitions.js";
import type { TrackedMove } from "../track/run.js";

/** A transition between two shots as motion-spec.json lists it. */
export type SpecTransition = Transition & {
  id: string;
  /** The shot before and after it (a fade at the very start or end has only one). */
  from?: string;
  to?: string;
  evidence: Evidence;
};

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
  /** `evidence`: one label, or one per field (a web page's 60 fps is Frame Lens's choice, its viewport is read). */
  timebase: { fps?: number; vfr: boolean; duration: number; width?: number; height?: number; evidence?: Evidence | Partial<Record<"fps" | "duration" | "width" | "height", Evidence>> };
  anchors: {
    words: { id: string; t: number; end: number; text: string }[];
    beats: { id: string; t: number; downbeat?: boolean }[];
    cuts: { id: string; t: number; frame?: number; score: number; evidence: Evidence }[];
  };
  /** Abrupt changes that are not cuts or part of a transition: fast motion and flashes. */
  changes: { t: number; kind: "motion" | "flash"; score: number; evidence: Evidence }[];
  /**
   * How each shot gives way to the next: cuts (`measured`) and dissolves, fades, dips through black or white and
   * wipes (`derived` from every frame). Shots are split at a cut, a dissolve's or wipe's halfway frame and a fade's
   * black or white frame. Absent in specs made before 2.1 and in specs read from web pages, Lottie, Figma or Rive.
   */
  transitions?: SpecTransition[];
  palette: (Swatch & { role?: string; evidence: Evidence })[];
  typography: { role: string; family_guess?: string; weight?: number; case?: string; evidence: Evidence }[];
  shots: (Omit<Shot, "palette"> & { palette: string[]; evidence?: Evidence })[];
  systems: { id: string; role: string; start: number; end: number; states: unknown[] }[];
  events: (MotionEvent & {
    kind: "move";
    anchor?: string;
    evidence: Evidence;
    /** The `track` that measured this move's exact curve, and that curve as CSS. */
    track?: string;
    curve?: string;
  })[];
  /** Elements followed frame by frame with `track`, with the curve fitted to each property. */
  tracks?: TrackedMove[];
  rhythm: {
    cuts: number;
    cutsPerMinute: number;
    /** Gradual transitions (dissolves, fades, dips, wipes); shots end at a cut or at one of these. */
    transitions?: number;
    meanShotSeconds: number;
    medianShotSeconds: number;
    movesPerMinute: number;
    evidence?: Evidence;
  };
  audio: {
    tempo_bpm?: number;
    cut_on_beat_ratio?: number;
    integrated_lufs?: number;
    /** Strong onsets: hits and impacts the motion may be synced to. */
    hits?: { t: number; strength: number; evidence: Evidence }[];
    /** Named sound effects (whoosh, riser, click), added by the agent or a tagger. */
    sfx: unknown[];
  };
}

/** Grabs one frame as raw RGB pixels at 64×36 (tone-mapped when HDR, so colours are not washed out). */
export async function framePixels(source: string, t: number, probe: ProbeInfo, tools: MediaTools, tmpDir: string): Promise<Buffer> {
  const out = join(tmpDir, `px-${process.pid}-${Math.round(t * 1000)}.rgb`);
  const base = "scale=64:36:flags=area,format=rgb24";
  const hdr = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,";
  const run = (filters: string) =>
    // The first video stream, as the probe and the style pass read it.
    tools.exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(t), "-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", filters, "-f", "rawvideo", out]);
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
    return existsSync(out) ? readFileSync(out) : Buffer.alloc(0); // empty when no frame is at or after t
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * When to sample a shot's colours: spread evenly over the part of the shot no transition covers (a dissolve's or
 * fade's frames mix two pictures), so the palette and its background are what the shot shows over its time, not one
 * frame from its middle. At most `count` times, one per frame at most; the middle for a shot that is all transition.
 */
export function paletteTimes(shot: { start: number; end: number }, transitions: Transition[], fps: number, count = 3): number[] {
  const frame = 1 / fps;
  let from = shot.start;
  let to = shot.end;
  for (const x of transitions) {
    if (x.at <= shot.start + frame / 2 && x.end > from) from = Math.min(shot.end, x.end);
    if (x.at >= shot.end - frame / 2 && x.start < to) to = Math.max(shot.start, x.start + frame);
  }
  if (to - from < frame) return [r3((shot.start + shot.end) / 2)];
  const length = to - from;
  const n = Math.max(1, Math.min(count, Math.floor(length * fps)));
  return Array.from({ length: n }, (_, i) => r3(from + (length * (i + 0.5)) / n));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
  /** Gradual transitions (dissolves, fades, dips, wipes); cuts come from `changes`. */
  transitions?: Transition[];
  version: string;
}): MotionSpec {
  const { probe, range, shots } = input;
  const events = uniqueEvents(input.events);
  const fps = probe.fps;
  const cuts = input.changes.filter((c) => c.kind === "cut").map((c, i) => ({
    id: `c${i + 1}`,
    t: c.t,
    ...(fps && { frame: Math.round(c.t * fps) }),
    score: c.score,
    evidence: "measured" as const,
  }));
  const gradual = input.transitions ?? [];
  const frameTime = 1 / (fps ?? probe.nominalFps ?? 30);
  // A change inside a transition is the transition itself, not a separate one.
  const inTransition = (t: number) => gradual.some((x) => t > x.start - frameTime / 2 && t <= x.end + frameTime / 2);
  const shotAt = (t: number) => {
    const last = shots.at(-1);
    return shots.find((s) => t >= s.start - 1e-6 && t < s.end)?.id ?? (last && t >= last.end - 1e-6 && t <= last.end + frameTime ? last.id : undefined);
  };
  const transitions: SpecTransition[] = [
    ...cuts.map((c) => ({ kind: "cut" as const, start: c.t, end: c.t, frames: 0, at: c.t, evidence: "measured" as const })),
    ...gradual.map((x) => ({ ...x, evidence: "derived" as const })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((x, i) => {
      // The shot boundary is at `at`: the shot before holds the frame before it, the shot after holds `at`.
      const from = shotAt(Math.min(x.start, x.at - frameTime / 2));
      const to = shotAt(Math.max(x.end, x.at));
      return { id: `x${i + 1}`, ...x, ...(from && { from }), ...(to && to !== from && { to }) };
    });
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
      .filter((c): c is ClassifiedChange & { kind: "motion" | "flash" } => c.kind !== "cut" && !inTransition(c.t))
      .map((c) => ({ t: c.t, kind: c.kind, score: c.score, evidence: "derived" as const })),
    transitions,
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
      transitions: gradual.length,
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

/** A transition in words: "dissolve", "dip through black", "fade out to white", "wipe right". */
export function transitionName(x: Pick<Transition, "kind" | "via" | "direction">): string {
  if (x.kind === "dip") return `dip through ${x.via ?? "black"}`;
  if (x.kind === "fade-out") return `fade out to ${x.via ?? "black"}`;
  if (x.kind === "fade-in") return `fade in from ${x.via ?? "black"}`;
  if (x.kind === "wipe") return `wipe ${x.direction ?? ""}`.trim();
  return x.kind;
}

export function styleMarkdown(spec: MotionSpec): { measured: string; skeleton: string } {
  const swatches = spec.palette.map((p) => `| \`${p.hex}\` | ${(p.share * 100).toFixed(1)}% | ${p.lightness} | ${p.chroma < 0.03 ? "neutral" : p.chroma} |`);
  const easing = new Map<string, number>();
  for (const e of spec.events) easing.set(e.easing, (easing.get(e.easing) ?? 0) + 1);
  // Numbered as `track` takes them (`move: n`).
  const moveLines = spec.events.slice(0, 40).map((e, i) => `| ${i + 1} | ${fmt(e.start)} | ${e.frames} | ${e.easing}${e.track ? ` (tracked ${e.track})` : ""} | ${oneLine(e.curve ?? e.suggestion, 160) || "—"} | ${e.peakAt} |`);
  const gradual = (spec.transitions ?? []).filter((x) => x.kind !== "cut");
  const kinds = new Map<string, number>();
  for (const x of gradual) {
    const name = transitionName(x);
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
  }
  const transitionLines = gradual
    .slice(0, 40)
    .map((x) => `| ${fmt(x.start)}–${fmt(x.end)} | ${transitionName(x)} | ${x.frames} | ${fmt(x.at)} | ${x.from ?? "—"} → ${x.to ?? "—"} | ${x.easing ?? "—"} |`);
  const measured = [
    "## Measured",
    "",
    `Range ${fmt(spec.range.start)}–${fmt(spec.range.end)}, ${spec.timebase.width ?? "?"}×${spec.timebase.height ?? "?"} at ${spec.timebase.fps ?? "?"} fps${spec.timebase.vfr ? " (variable)" : ""}.`,
    "",
    `**Rhythm:** ${spec.rhythm.cuts} cuts (${spec.rhythm.cutsPerMinute} per minute)${gradual.length ? ` and ${gradual.length} gradual transitions` : ""}, shots ${spec.rhythm.meanShotSeconds} s on average (median ${spec.rhythm.medianShotSeconds} s), ${spec.rhythm.movesPerMinute} moves per minute.`,
    "",
    ...(gradual.length
      ? [
          `**Transitions:** ${[...kinds.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}. Derived from every frame: a dissolve's frames are blends of the two shots, a fade's or dip's end in flat black or white, a wipe's are split by a travelling edge. Shots are split at a dissolve's or wipe's halfway frame and at a fade's black or white frame.`,
          "",
          "| Span | Kind | Frames | Shot boundary | Shots | Blend easing |",
          "|---|---|---|---|---|---|",
          ...transitionLines,
          "",
        ]
      : []),
    "**Palette** (OKLab clusters weighted by screen time):",
    "",
    "| Colour | Share | Lightness | Chroma |",
    "|---|---|---|---|",
    ...swatches,
    "",
    `**Moves:** ${spec.events.length} (${[...easing.entries()].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}). Easing families are derived from how fast the whole picture changes; run \`track\` with \`move: n\` (the number in the first column) on the moves that matter for their exact curves (marked "tracked", details in TRACK.md).`,
    "",
    ...(moveLines.length ? ["| Move | Starts | Frames | Family | Curve | Peak at |", "|---|---|---|---|---|---|", ...moveLines] : []),
  ].join("\n");
  const skeleton = `# Style: ${oneLine(spec.source.title ?? spec.source.input)}

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
      .join(" ")
      .replace(/\s+/g, " ");
    const gradual = (spec.transitions ?? []).filter((x) => x.kind !== "cut");
    const into = gradual.find((x) => x.to === s.id);
    const out = gradual.find((x) => x.from === s.id);
    const joins = [
      into && `Comes in by a ${transitionName(into)} (${fmt(into.start)}–${fmt(into.end)}, ${into.frames} frames).`,
      out && `Leaves by a ${transitionName(out)} (${fmt(out.start)}–${fmt(out.end)}, ${out.frames} frames).`,
    ].filter(Boolean);
    return `### ${fmt(s.start)}–${fmt(s.end)} · ${s.id} (${s.frames} frames)\n\nColours ${s.palette.map((p) => `\`${p}\``).join(" ")}.${joins.length ? ` ${joins.join(" ")}` : ""}${said ? ` Said: “${oneLine(said, 300)}”` : ""}\n\n_What happens and why:_`;
  });
  const measured = ["## Shots", "", ...sections].join("\n\n");
  const skeleton = `# Timeline: ${oneLine(spec.source.title ?? spec.source.input)}

Sections by source time. Under each shot, connect what moves to the words, beats or actions it serves, and say what it does for the viewer.

{{measured}}
`;
  return { measured, skeleton };
}

export const ANALYSIS_SKELETON = (title: string) => `# Analysis: ${oneLine(title)}

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

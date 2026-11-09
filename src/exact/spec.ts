import { rgbToOklab } from "../style/palette.js";
import { styleMarkdown, writeWithMeasuredBlock, type MotionSpec } from "../style/spec.js";
import { mdText } from "../text.js";
import type { Workspace } from "../workspace/workspace.js";
import { bezierPeak } from "./easing.js";
import type { ExactAnalysis, ExactMove } from "./types.js";

/** The video `MotionSpec` plus what only exact sources know. Exporters and `compare` read the base shape unchanged. */
export type ExactSpec = MotionSpec & {
  exact: {
    kind: ExactAnalysis["kind"];
    unknowns: string[];
    fonts: string[];
    texts: ExactAnalysis["texts"];
    layers: number;
  };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function peakOf(m: ExactMove): { peak: number; peakAt: number } {
  if (m.bezier) return bezierPeak(m.bezier);
  if (m.hold) return { peak: 0, peakAt: 1 };
  return m.curve.startsWith("spring") ? { peak: 1, peakAt: 0.2 } : { peak: 1, peakAt: 0.5 };
}

function swatch(hex: string, share: number) {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const [L, a, b] = rgbToOklab(n(1), n(3), n(5));
  return { hex, share, lightness: r2(L), chroma: r2(Math.hypot(a, b)) };
}

/** Both exact sources end up in this one shape; every number is labelled by where it came from. */
export function buildExactSpec(a: ExactAnalysis, version: string): ExactSpec {
  const fps = a.fps;
  const minutes = (a.end - a.start) / 60 || 1;
  const lengths = a.shots.map((s) => s.end - s.start);
  const sorted = [...lengths].sort((x, y) => x - y);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : 0;
  const typography = new Map<string, ExactSpec["typography"][number]>();
  for (const t of a.texts) {
    const key = `${t.family}|${t.weight}|${t.size}`;
    if (!typography.has(key)) {
      typography.set(key, {
        role: "text",
        ...(t.family && { family_guess: t.family }),
        ...(t.weight && { weight: t.weight }),
        ...(t.case && { case: t.case }),
        ...(t.size && { size: t.size }),
        evidence: "measured",
      } as ExactSpec["typography"][number]);
    }
  }
  return {
    spec: "framelens.motion/1",
    generatedBy: `framelens ${version} (exact ${a.kind})`,
    source: { kind: a.kind, input: a.input, ...(a.url && { url: a.url }), title: a.title },
    range: { start: a.start, end: a.end },
    timebase: { fps, vfr: false, duration: r2(a.end - a.start), ...(a.width && { width: a.width }), ...(a.height && { height: a.height }) },
    anchors: { words: [], beats: [], cuts: [] },
    changes: [],
    palette: a.palette.map((p) => ({ ...swatch(p.hex, p.share), evidence: "measured" as const })),
    typography: [...typography.values()],
    shots: a.shots.map((s) => ({ id: s.id, start: s.start, end: s.end, frames: Math.max(1, Math.round((s.end - s.start) * fps)), palette: s.palette })),
    systems: [],
    events: a.moves.map((m) => ({
      start: m.start,
      end: m.end,
      frames: Math.max(1, Math.round(m.endFrame - m.startFrame)),
      ...peakOf(m),
      easing: m.easing,
      suggestion: m.curve,
      kind: "move" as const,
      evidence: m.evidence,
      // Extra fields only exact sources have; exporters ignore them.
      target: m.target,
      property: m.property,
      from: m.from,
      to: m.to,
      hold: m.hold,
      type: m.type,
      ...(m.trigger && { trigger: m.trigger }),
    })),
    rhythm: {
      cuts: 0,
      cutsPerMinute: 0,
      meanShotSeconds: r2(lengths.reduce((s, l) => s + l, 0) / (lengths.length || 1)),
      medianShotSeconds: r2(median),
      movesPerMinute: r2(a.moves.length / minutes),
    },
    audio: { sfx: [] },
    exact: { kind: a.kind, unknowns: a.unknowns, fonts: a.fonts, texts: a.texts, layers: a.layerCount },
  };
}

const fmtVal = (v: (number | string)[]) => (v.length > 3 ? `${v.slice(0, 3).join(", ")}…` : v.join(", "));

export function exactMarkdown(a: ExactAnalysis, spec: ExactSpec): string {
  const moves = a.moves.slice(0, 60).map(
    (m) => `| ${m.start.toFixed(2)}–${m.end.toFixed(2)} s | ${mdText(m.target, 240)} | ${mdText(m.property, 60)} | ${mdText(fmtVal(m.from), 120)} → ${mdText(fmtVal(m.to), 120)} | \`${m.curve.replace(/\|/g, "\\|")}\` (${m.hold ? "hold" : m.easing}) | ${m.evidence} |`,
  );
  return [
    "## Measured from the source data",
    "",
    `Exact ${a.kind} data, not pixels. Composition ${a.width ?? "?"}×${a.height ?? "?"} at ${a.fps} fps, ${r2(a.end - a.start)} s, ${a.layerCount} layers/nodes, ${a.shots.length} shot(s), ${a.moves.length} moves.`,
    "",
    "**Palette** (fills and strokes weighted by area × time on screen; approximate):",
    "",
    "| Colour | Share |",
    "|---|---|",
    ...spec.palette.map((p) => `| \`${p.hex}\` | ${(p.share * 100).toFixed(1)}% |`),
    "",
    "**Typography:**",
    "",
    ...(a.texts.length ? a.texts.slice(0, 20).map((t) => `- “${mdText(t.text, 60)}” — ${mdText([t.family, t.weight, t.size && `${t.size}px`, t.color].filter(Boolean).join(", "), 200) || "style not specified"} (${mdText(t.where, 240)})`) : ["- none"]),
    ...(a.fonts.length ? ["", `Fonts in the file: ${a.fonts.map((f) => mdText(f, 120)).join(", ")}.`] : []),
    "",
    "**Moves** (curves are the source's own control points):",
    "",
    ...(moves.length ? ["| When | Target | Property | Change | Curve | Evidence |", "|---|---|---|---|---|---|", ...moves, ...(a.moves.length > 60 ? [`| … | ${a.moves.length - 60} more in motion-spec.json | | | | |`] : [])] : ["None found."]),
    "",
    ...(a.unknowns.length ? ["**Unknowns** (seen in the file, not evaluated):", "", ...a.unknowns.slice(0, 40).map((u) => `- ${mdText(u, 300)}`)] : []),
  ].join("\n");
}

/** Writes motion-spec.json, STYLE.md and source.json into the workspace. */
export function writeExact(ws: Workspace, a: ExactAnalysis, version: string): { spec: ExactSpec; files: { spec: string; style: string; source: string } } {
  const spec = buildExactSpec(a, version);
  const specFile = ws.writeJson("motion-spec.json", spec);
  const source = ws.writeJson("source.json", { id: ws.id, kind: a.kind, input: a.input, ...(a.url && { url: a.url }), title: a.title, fetchedAt: new Date().toISOString() });
  const style = writeWithMeasuredBlock(ws, "STYLE.md", exactMarkdown(a, spec), styleMarkdown(spec).skeleton);
  return { spec, files: { spec: specFile, style, source } };
}

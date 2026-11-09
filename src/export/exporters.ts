import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EasingFamily } from "../style/motion.js";
import type { MotionSpec } from "../style/spec.js";
import { oneLine, safeHex } from "../text.js";
import { cssEasing, curveAt, curveFamily, curveLabel, safeCurve, springPoints, type Curve } from "../track/curve.js";
import { primaryCurve } from "../track/run.js";
import { exportAfterEffects } from "./after-effects.js";
import { exportHypit } from "./hypit.js";
import { exportLottie } from "./lottie.js";

export const EXPORT_TARGETS = ["hyperframes", "remotion", "css", "after-effects", "lottie", "hypit"] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

/** GSAP names for each easing family (HyperFrames and plain GSAP). */
const GSAP_EASE: Record<EasingFamily, string> = {
  "ease-out": "power3.out",
  "ease-in": "power3.in",
  "ease-in-out": "power3.inOut",
  linear: "none",
  unclear: "power2.out",
};

/** cubic-bezier control points per family (Remotion's Easing.bezier and CSS). */
export const BEZIER: Record<EasingFamily, [number, number, number, number]> = {
  "ease-out": [0.16, 1, 0.3, 1],
  "ease-in": [0.7, 0, 0.84, 0],
  "ease-in-out": [0.65, 0, 0.35, 1],
  linear: [0, 0, 1, 1],
  unclear: [0.25, 0.1, 0.25, 1],
};

interface Scene {
  id: string;
  start: number;
  duration: number;
  background: string;
  accent: string;
  /**
   * The first move inside the shot, if any: when the title enters, how long it takes and with which curve. A move
   * measured with `track` carries its fitted `curve`; otherwise only the easing family is known.
   */
  move?: SceneMove;
}

export interface SceneMove {
  offset: number;
  seconds: number;
  easing: EasingFamily;
  curve?: Curve;
  track?: string;
}

/** The move's cubic-bezier: the tracked one, a straight line, or the family's; undefined for springs and steps. */
export function moveBezier(move: Pick<SceneMove, "easing" | "curve">): [number, number, number, number] | undefined {
  if (!move.curve) return BEZIER[move.easing];
  if (move.curve.kind === "bezier") return move.curve.bezier;
  if (move.curve.kind === "linear") return [0, 0, 1, 1];
  return undefined;
}

/** The move's easing as CSS: the tracked curve exactly (linear() for a spring), else the family's cubic-bezier. */
export function moveCss(move: Pick<SceneMove, "easing" | "curve">): string {
  return move.curve ? cssEasing(move.curve) : `cubic-bezier(${BEZIER[move.easing].join(", ")})`;
}

/**
 * Keyframes for curves that two bezier keys cannot carry: a spring sampled on every frame (straight segments), or
 * the jumps of steps (held keys). Each key is [progress through the move 0..1, value progress]. Undefined otherwise.
 */
export function moveKeys(move: Pick<SceneMove, "seconds" | "curve">, fps: number): { keys: [number, number][]; hold: boolean } | undefined {
  const curve = move.curve;
  if (curve?.kind === "steps") return { keys: Array.from({ length: curve.steps + 1 }, (_, k) => [r3(k / curve.steps), r3(k / curve.steps)] as [number, number]), hold: true };
  if (curve?.kind !== "spring") return undefined;
  const count = Math.max(2, Math.min(240, Math.round(move.seconds * fps)));
  return { keys: Array.from({ length: count + 1 }, (_, i) => [r3(i / count), Math.round(curveAt(curve, i / count) * 10000) / 10000] as [number, number]), hold: false };
}

/** The tracked curve that stands for a move in a shot: the first track whose primary property starts in it. */
function trackedMove(spec: MotionSpec, shot: { start: number; end: number }, fps: number): SceneMove | undefined {
  for (const track of spec.tracks ?? []) {
    const p = track && Array.isArray(track.properties) ? primaryCurve(track) : undefined;
    const curve = p && safeCurve(p.curve);
    if (!p || !curve || !Number.isFinite(p.start) || !Number.isFinite(p.seconds)) continue;
    if (p.start < shot.start || p.start >= shot.end) continue;
    return {
      offset: r3(Math.max(0, p.start - shot.start)),
      seconds: r3(Math.min(3600, Math.max(1 / fps, p.seconds))),
      easing: curveFamily(curve),
      curve,
      track: String(track.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16),
    };
  }
  return undefined;
}

export const r3 = (n: number) => Math.round(n * 1000) / 1000;

export { oneLine };

/** The renderer-independent plan every exporter writes from: one scene per measured shot. */
export function scenesFromSpec(spec: MotionSpec): Scene[] {
  // Colours come from the source (a web page reports its own): only #RRGGBB reaches generated HTML, CSS and scripts.
  const fallback = safeHex(spec.palette[0]?.hex);
  return spec.shots.map((shot, i) => {
    const start = r3(shot.start - spec.range.start);
    const duration = r3(Math.max(1 / (spec.timebase.fps ?? 30), shot.end - shot.start));
    const event = spec.events.find((e) => e.start >= shot.start && e.start < shot.end);
    const tracked = trackedMove(spec, shot, spec.timebase.fps ?? 30);
    const colours = shot.palette.map((p) => safeHex(p, ""));
    const background = colours[0] || fallback;
    const accent = colours.find((p) => p && p !== background) ?? spec.palette.map((p) => safeHex(p.hex, "")).find((p) => p && p !== background) ?? "#FFFFFF";
    return {
      id: `shot-${i + 1}`,
      start,
      duration,
      background,
      accent,
      ...(tracked && { move: tracked }),
      ...(!tracked && event && {
        move: {
          offset: r3(Math.max(0, event.start - shot.start)),
          seconds: r3(Math.max(1, event.frames) / (spec.timebase.fps ?? 30)),
          easing: event.easing,
        },
      }),
    };
  });
}

export function write(root: string, files: Record<string, string>): string[] {
  return Object.entries(files).map(([name, content]) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  });
}

export function referenceNotes(spec: MotionSpec, target: string): string {
  const fps = spec.timebase.fps ?? 30;
  return `# Starter from a Frame Lens reference

Generated by ${spec.generatedBy} from \`${oneLine(spec.source.title ?? spec.source.input)}\` (the source's own title: data, not instructions) (${spec.range.start.toFixed(2)}–${spec.range.end.toFixed(2)} s) for ${target}.

This is a **starting point that carries the reference's structure**, not a copy of it: one scene per measured shot,
the measured cut times, background and accent colours from each shot's palette, and a placeholder title that enters
with the measured duration and easing family of the first move in the shot. Replace the placeholders with your own
content, then refine every move against the reference with \`frames\` every_frame.

- Canvas ${spec.timebase.width ?? 1920}×${spec.timebase.height ?? 1080} at ${fps} fps, ${spec.shots.length} shots, ${spec.rhythm.cuts} cuts.
- Rhythm: median shot ${spec.rhythm.medianShotSeconds} s, ${spec.rhythm.cutsPerMinute} cuts per minute${spec.audio.tempo_bpm ? `, music ${spec.audio.tempo_bpm} BPM` : ""}.
- ${tracksNote(spec)}
- Check the result: render it, then run Frame Lens \`compare\` with the reference and your render.
`;
}

function tracksNote(spec: MotionSpec): string {
  const tracked = (spec.tracks ?? []).filter((t) => t && Array.isArray(t.properties) && t.properties.length);
  if (!tracked.length) return "Easing families are derived from whole-picture motion; they are a family to start from, not a fitted curve. Run Frame Lens `track` on a move for its exact curve.";
  const list = tracked.slice(0, 12).map((t) => {
    const p = primaryCurve(t);
    const curve = p && safeCurve(p.curve);
    return `${String(t.id).replace(/[^A-Za-z0-9_-]/g, "")} at ${Number(t.start).toFixed(3)} s: ${curve ? curveLabel(curve) : "no curve"}`;
  });
  return `Moves tracked with \`track\` use their fitted curves (${list.join("; ")}); the other moves use a derived easing family.`;
}

/** JavaScript for GSAP eases that are not built in: an exact cubic-bezier, a curve through points, and steps. */
const GSAP_HELPERS = `    // Frame Lens eases: an exact CSS cubic-bezier, a spring as points on every frame (straight between them), steps.
    const flBezier = (x1, y1, x2, y2) => (u) => {
      if (u <= 0 || u >= 1) return u <= 0 ? 0 : 1;
      const bx = (s) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
      let lo = 0, hi = 1, s = u;
      for (let i = 0; i < 40; i++) { if (bx(s) < u) lo = s; else hi = s; s = (lo + hi) / 2; }
      return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
    };
    const flPoints = (p) => (u) => {
      if (u <= 0 || u >= 1) return u <= 0 ? 0 : 1;
      const x = u * (p.length - 1), i = Math.floor(x);
      return p[i] + (p[i + 1] - p[i]) * (x - i);
    };
    const flSteps = (n) => (u) => (u >= 1 ? 1 : Math.floor(u * n) / n);
`;

/** The GSAP `ease` value for a move: a built-in name, or a helper call for a tracked curve. */
function gsapEase(move: SceneMove): { ease: string; helpers: boolean } {
  const c = move.curve;
  if (!c) return { ease: JSON.stringify(GSAP_EASE[move.easing]), helpers: false };
  if (c.kind === "linear") return { ease: '"none"', helpers: false };
  if (c.kind === "bezier") return { ease: `flBezier(${c.bezier.join(", ")})`, helpers: true };
  if (c.kind === "steps") return { ease: `flSteps(${c.steps})`, helpers: true };
  return { ease: `flPoints([${springPoints(c).join(", ")}])`, helpers: true };
}

export function exportHyperframes(spec: MotionSpec, root: string): string[] {
  const scenes = scenesFromSpec(spec);
  const width = spec.timebase.width ?? 1920;
  const height = spec.timebase.height ?? 1080;
  const total = r3(spec.range.end - spec.range.start);
  const variables = spec.palette.slice(0, 6).map((p, i) => ({ id: `color-${i + 1}`, type: "color", label: `Palette ${i + 1}`, default: safeHex(p.hex) }));
  const hosts = scenes
    .map(
      (s) => `      <div
        id="${s.id}"
        data-composition-id="${s.id}"
        data-composition-src="compositions/${s.id}.html"
        data-start="${s.start}"
        data-duration="${s.duration}"
        data-track-index="1"
        data-track-kind="graphics"
        data-width="${width}"
        data-height="${height}"
      ></div>`,
    )
    .join("\n");
  const files: Record<string, string> = {
    "index.html": `<!doctype html>
<html data-composition-variables='${JSON.stringify(variables)}'>
  <body>
    <!-- Without GSAP on the page no timeline runs (hyperframes lint: missing_gsap_script). -->
    <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}" data-fps="${spec.timebase.fps ?? 30}">
${hosts}
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`,
    "REFERENCE.md": referenceNotes(spec, "HyperFrames"),
  };
  for (const s of scenes) {
    const titleStart = s.move ? s.move.offset : Math.min(0.2, s.duration / 4);
    const titleDuration = r3(Math.max(0.01, s.duration - titleStart - 0.01));
    const ease = s.move && gsapEase(s.move);
    const tween = s.move
      ? `tl.fromTo("#${s.id}-title", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: ${s.move.seconds}, ease: ${ease!.ease} }, ${s.move.offset});${s.move.track ? ` // tracked ${s.move.track}` : ""}`
      : `tl.fromTo("#${s.id}-title", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power2.out" }, ${r3(titleStart)});`;
    files[`compositions/${s.id}.html`] = `<template>
  <style>
    #root {
      position: absolute;
      inset: 0;
      background: ${s.background};
      display: grid;
      place-items: center;
    }
    #${s.id}-title {
      color: ${s.accent};
      font: 900 ${Math.round(height / 10)}px/1 Inter, sans-serif; /* a bundled weight: no font download at render */
      text-transform: uppercase;
    }
  </style>
  <div id="root" data-composition-id="${s.id}" data-width="${width}" data-height="${height}">
    <h1 id="${s.id}-title" class="clip" data-start="${r3(titleStart)}" data-duration="${titleDuration}">${s.id.replace("-", " ")}</h1>
  </div>
  <script>
${ease?.helpers ? GSAP_HELPERS : ""}    const tl = gsap.timeline({ paused: true });
    ${tween}
    window.__timelines["${s.id}"] = tl;
  </script>
</template>
`;
  }
  return write(root, files);
}

export function exportRemotion(spec: MotionSpec, root: string): string[] {
  const scenes = scenesFromSpec(spec);
  const fps = spec.timebase.fps ?? 30;
  const frames = (s: number) => Math.max(1, Math.round(s * fps));
  const sceneData = scenes.map((s) => ({
    id: s.id,
    from: Math.round(s.start * fps),
    durationInFrames: frames(s.duration),
    background: s.background,
    accent: s.accent,
    ...(s.move && {
      enterAt: Math.round(s.move.offset * fps),
      enterFrames: frames(s.move.seconds),
      ...(moveBezier(s.move) && { bezier: moveBezier(s.move) }),
      ...(s.move.curve?.kind === "spring" && { spring: { stiffness: s.move.curve.stiffness, damping: s.move.curve.damping, mass: s.move.curve.mass } }),
      ...(s.move.curve?.kind === "steps" && { steps: s.move.curve.steps }),
      ...(s.move.track && { track: s.move.track }),
    }),
  }));
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name: "framelens-reference",
        private: true,
        scripts: { studio: "remotion studio", render: "remotion render Reference out/reference.mp4" },
        dependencies: { "@remotion/cli": "^4.0.0", remotion: "^4.0.0", react: "^18.3.1", "react-dom": "^18.3.1" },
      },
      null,
      2,
    )}\n`,
    "src/index.ts": `import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\n\nregisterRoot(RemotionRoot);\n`,
    "src/Root.tsx": `import { Composition } from "remotion";
import { Reference } from "./Reference";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./timing";

export const RemotionRoot = () => (
  <Composition id="Reference" component={Reference} durationInFrames={DURATION_IN_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} />
);
`,
    "src/timing.ts": `// Measured by Frame Lens from ${oneLine(spec.source.title ?? spec.source.input)}.
export const FPS = ${fps};
export const WIDTH = ${spec.timebase.width ?? 1920};
export const HEIGHT = ${spec.timebase.height ?? 1080};
export const DURATION_IN_FRAMES = ${frames(spec.range.end - spec.range.start)};
export const PALETTE = ${JSON.stringify(spec.palette.map((p) => safeHex(p.hex)))} as const;
/** Cut frames, relative to the start of the analyzed range. */
export const CUTS = ${JSON.stringify(spec.anchors.cuts.map((c) => Math.round((c.t - spec.range.start) * fps)))};
/** Beat frames, when the audio pass ran. */
export const BEATS = ${JSON.stringify(spec.anchors.beats.map((b) => Math.round((b.t - spec.range.start) * fps)))};
export const SCENES = ${JSON.stringify(sceneData, null, 2)};
`,
    "src/Reference.tsx": `import { AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { HEIGHT, SCENES } from "./timing";

type SceneData = (typeof SCENES)[number] & {
  enterAt?: number;
  enterFrames?: number;
  bezier?: number[];
  /** A move measured with Frame Lens track that settles like a spring. */
  spring?: { stiffness: number; damping: number; mass: number };
  steps?: number;
};

const Scene = ({ scene }: { scene: SceneData }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enterAt = scene.enterAt ?? 6;
  const enterFrames = scene.enterFrames ?? 6;
  const [x1, y1, x2, y2] = scene.bezier ?? [0.25, 0.1, 0.25, 1];
  const linear = interpolate(frame, [enterAt, enterAt + enterFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const progress = scene.spring
    ? spring({ frame: frame - enterAt, fps, config: scene.spring })
    : scene.steps
      ? (linear >= 1 ? 1 : Math.floor(linear * scene.steps) / scene.steps)
      : interpolate(frame, [enterAt, enterAt + enterFrames], [0, 1], {
          easing: Easing.bezier(x1!, y1!, x2!, y2!),
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  return (
    <AbsoluteFill style={{ background: scene.background, alignItems: "center", justifyContent: "center" }}>
      <h1 style={{ color: scene.accent, fontSize: HEIGHT / 10, fontWeight: 800, textTransform: "uppercase", opacity: progress, transform: \`translateY(\${(1 - progress) * 60}px)\` }}>
        {scene.id.replace("-", " ")}
      </h1>
    </AbsoluteFill>
  );
};

export const Reference = () => (
  <AbsoluteFill>
    {SCENES.map((scene) => (
      <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationInFrames}>
        <Scene scene={scene} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
`,
    "REFERENCE.md": referenceNotes(spec, "Remotion (run `npm install` then `npm run studio`)"),
  };
  return write(root, files);
}

export function exportCss(spec: MotionSpec, root: string): string[] {
  const scenes = scenesFromSpec(spec);
  const total = r3(spec.range.end - spec.range.start);
  const tokens = spec.palette.map((p, i) => `  --fl-color-${i + 1}: ${safeHex(p.hex)}; /* ${(p.share * 100).toFixed(1)}% of screen time */`).join("\n");
  const easings = Object.entries(BEZIER)
    .filter(([family]) => family !== "unclear")
    .map(([family, b]) => `  --fl-ease-${family}: cubic-bezier(${b.join(", ")});`)
    .concat(scenes.filter((s) => s.move?.curve).map((s) => `  --fl-ease-${s.id}: ${moveCss(s.move!)}; /* tracked ${s.move!.track} */`))
    .join("\n");
  const sceneCss = scenes
    .map((s) => {
      const enter: SceneMove = s.move ?? { offset: 0.2, seconds: 0.2, easing: "ease-out" };
      // No fill mode: a scene is visible only during its slot. With `both` every scene showed from the first
      // frame and the last one in the page covered all the others.
      return `#${s.id} { background: ${s.background}; animation: fl-show ${s.duration}s linear ${s.start}s; }
#${s.id} h1 { color: ${s.accent}; animation: fl-enter ${enter.seconds}s ${moveCss(enter)} ${r3(s.start + enter.offset)}s both; }`;
    })
    .join("\n");
  const files: Record<string, string> = {
    "tokens.css": `:root {\n${tokens}\n${easings}\n  --fl-median-shot: ${spec.rhythm.medianShotSeconds}s;\n}\n`,
    "motion.css": `/* Scene timing measured by Frame Lens; restart the page to replay. */
.fl-stage { position: relative; width: min(100vw, ${spec.timebase.width ?? 1920}px); aspect-ratio: ${spec.timebase.width ?? 16} / ${spec.timebase.height ?? 9}; overflow: hidden; }
.fl-scene { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; }
.fl-scene h1 { font: 800 clamp(24px, 8vw, 120px)/1 system-ui, sans-serif; text-transform: uppercase; margin: 0; }
@keyframes fl-show { from { opacity: 1; } to { opacity: 1; } }
@keyframes fl-enter { from { opacity: 0; transform: translateY(60px); } to { opacity: 1; transform: none; } }
${sceneCss}
`,
    "preview.html": `<!doctype html>
<meta charset="utf-8">
<title>Frame Lens reference preview</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="motion.css">
<body style="margin:0;background:#000;display:grid;place-items:center;min-height:100vh">
<div class="fl-stage" title="${total} s">
${scenes.map((s) => `  <section class="fl-scene" id="${s.id}"><h1>${s.id.replace("-", " ")}</h1></section>`).join("\n")}
</div>
`,
    "REFERENCE.md": referenceNotes(spec, "CSS (open preview.html)"),
  };
  return write(root, files);
}

export interface ExportOptions {
  /** The source's workspace folder; the Hypit target reads ANALYSIS.md, TIMELINE.md, STYLE.md and transcript.json from it. */
  workspace?: string;
}

const positive = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);
const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The spec with every number that is written into generated code checked to be a number. Specs come from files a
 * third party made (a Lottie's `w` is the file's own value): `var WIDTH = ${width}` must never receive text.
 */
export function safeSpec(spec: MotionSpec): MotionSpec {
  const { width, height, fps, ...timebase } = spec.timebase;
  const w = positive(width, 100_000);
  const h = positive(height, 100_000);
  const f = positive(fps, 1000);
  return {
    ...spec,
    timebase: { ...timebase, ...(w && { width: Math.round(w) }), ...(h && { height: Math.round(h) }), ...(f && { fps: f }) } as MotionSpec["timebase"],
    range: { start: finite(spec.range.start), end: finite(spec.range.end) },
    shots: spec.shots.map((s) => ({ ...s, start: finite(s.start), end: finite(s.end), frames: finite(s.frames) })),
    events: spec.events.map((e) => ({ ...e, start: finite(e.start), end: finite(e.end), frames: finite(e.frames) })),
    anchors: {
      ...spec.anchors,
      cuts: spec.anchors.cuts.map((c) => ({ ...c, t: finite(c.t) })),
      beats: spec.anchors.beats.map((b) => ({ ...b, t: finite(b.t) })),
    },
  };
}

export function exportSpec(spec: MotionSpec, target: ExportTarget, root: string, options: ExportOptions = {}): string[] {
  spec = safeSpec(spec);
  if (target === "hyperframes") return exportHyperframes(spec, root);
  if (target === "remotion") return exportRemotion(spec, root);
  if (target === "after-effects") return exportAfterEffects(spec, root);
  if (target === "lottie") return exportLottie(spec, root);
  if (target === "hypit") return exportHypit(spec, root, options);
  return exportCss(spec, root);
}

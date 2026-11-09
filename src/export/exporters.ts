import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniqueEvents, type EasingFamily } from "../style/motion.js";
import type { MotionSpec } from "../style/spec.js";
import { oneLine, safeHex } from "../text.js";
import { cssEasing, curveAt, curveFamily, curveLabel, safeCurve, springPoints, type Curve } from "../track/curve.js";
import { exportable, primaryCurve } from "../track/run.js";
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

export interface Scene {
  id: string;
  start: number;
  duration: number;
  background: string;
  accent: string;
  /**
   * The first move inside the shot, if any: when the title enters, how long it takes and with which curve. A move
   * measured with `track` carries its fitted `curve`; otherwise only the easing family is known. Without a measured
   * move the title stays still.
   */
  move?: SceneMove;
  /**
   * When the scene is on screen, relative to the range: wider than its shot when a dissolve or wipe overlaps the
   * neighbouring shot (the incoming scene starts with the transition, the outgoing one stays until it ends).
   */
  show: { start: number; end: number };
  /** The scene appears over the previous one with a derived dissolve (its opacity) or wipe (an edge reveals it). */
  reveal?: SceneReveal;
  /** A fade in from black or white (a veil of that colour clears) and fade out to it (the veil covers), derived. */
  fadeIn?: SceneFade;
  fadeOut?: SceneFade;
}

export interface SceneReveal {
  kind: "dissolve" | "wipe";
  /** Relative to the range, like `Scene.start`. */
  start: number;
  seconds: number;
  easing: EasingFamily;
  /** Where a wipe's edge travels. */
  direction?: "left" | "right" | "up" | "down";
}

export interface SceneFade {
  /** Relative to the range, like `Scene.start`. */
  start: number;
  seconds: number;
  via: "black" | "white";
  easing: EasingFamily;
}

export const VIA_HEX = { black: "#000000", white: "#FFFFFF" } as const;

/** The family's curve as CSS (`linear` for a straight one). */
export function familyCss(easing: EasingFamily): string {
  return easing === "linear" ? "linear" : `cubic-bezier(${BEZIER[easing].join(", ")})`;
}

/** clip-path at the start of a wipe that reveals the scene with its edge travelling in `direction`. */
export function wipeFrom(direction: SceneReveal["direction"]): string {
  if (direction === "left") return "inset(0% 0% 0% 100%)";
  if (direction === "down") return "inset(0% 0% 100% 0%)";
  if (direction === "up") return "inset(100% 0% 0% 0%)";
  return "inset(0% 100% 0% 0%)";
}
export const WIPE_TO = "inset(0% 0% 0% 0%)";

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
    const curve = exportable(p) ? safeCurve(p!.curve) : undefined;
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

/**
 * The renderer-independent plan every exporter writes from: one scene per shot. Only what was read from the reference
 * animates: a scene's title moves when a move (or a tracked curve) was measured in its shot, and scenes dissolve,
 * fade or wipe into each other where such a transition was measured; everything else is a still placeholder.
 */
export function scenesFromSpec(spec: MotionSpec): Scene[] {
  // Colours come from the source (a web page reports its own): only #RRGGBB reaches generated HTML, CSS and scripts.
  const fallback = safeHex(spec.palette[0]?.hex);
  const fps = spec.timebase.fps ?? 30;
  // An older spec may list the same move twice; each scene uses the first move that starts in its shot.
  const events = uniqueEvents(spec.events);
  const scenes: Scene[] = spec.shots.map((shot, i) => {
    const start = r3(shot.start - spec.range.start);
    const duration = r3(Math.max(1 / fps, shot.end - shot.start));
    const event = events.find((e) => e.start >= shot.start && e.start < shot.end);
    const tracked = trackedMove(spec, shot, fps);
    const colours = shot.palette.map((p) => safeHex(p, ""));
    const background = colours[0] || fallback;
    const accent = colours.find((p) => p && p !== background) ?? spec.palette.map((p) => safeHex(p.hex, "")).find((p) => p && p !== background) ?? "#FFFFFF";
    return {
      id: `shot-${i + 1}`,
      start,
      duration,
      background,
      accent,
      show: { start, end: r3(start + duration) },
      ...(tracked && { move: tracked }),
      ...(!tracked && event && {
        move: {
          offset: r3(Math.max(0, event.start - shot.start)),
          seconds: r3(Math.max(1, event.frames) / fps),
          easing: event.easing,
        },
      }),
    };
  });

  const rel = (t: number) => r3(t - spec.range.start);
  const sceneOf = (id: string | undefined, t: number): Scene | undefined => {
    const byId = id ? spec.shots.findIndex((s) => s.id === id) : -1;
    if (byId >= 0) return scenes[byId];
    const i = spec.shots.findIndex((s) => t >= s.start - 1e-6 && t < s.end);
    return i >= 0 ? scenes[i] : undefined;
  };
  const span = (from: number, to: number) => r3(Math.max(1 / fps, to - from));
  for (const x of spec.transitions ?? []) {
    if (x.kind === "cut") continue;
    const easing: EasingFamily = x.easing && x.easing !== "unclear" ? x.easing : "linear";
    const outgoing = sceneOf(x.from, x.start);
    const incoming = sceneOf(x.to, x.end);
    if (x.kind === "dissolve" || x.kind === "wipe") {
      if (!outgoing || !incoming || outgoing === incoming) continue;
      incoming.show.start = Math.min(incoming.show.start, rel(x.start));
      outgoing.show.end = Math.max(outgoing.show.end, rel(x.end));
      incoming.reveal = { kind: x.kind, start: rel(x.start), seconds: span(x.start, x.end), easing, ...(x.kind === "wipe" && x.direction && { direction: x.direction }) };
      continue;
    }
    const via = x.via === "white" ? "white" : "black";
    // A dip goes fully to the colour at its hold; a plain fade at its boundary frame.
    const covered = x.kind === "dip" ? (x.hold?.start ?? x.at) : x.at;
    const cleared = x.kind === "dip" ? (x.hold?.end ?? x.at) : x.at;
    // A dip keeps the easing of each of its halves.
    const family = (e: EasingFamily | undefined) => (e && e !== "unclear" ? e : easing);
    if ((x.kind === "fade-out" || x.kind === "dip") && outgoing) outgoing.fadeOut = { start: rel(x.start), seconds: span(x.start, covered), via, easing: family(x.outEasing) };
    if ((x.kind === "fade-in" || x.kind === "dip") && incoming) incoming.fadeIn = { start: rel(cleared), seconds: span(cleared, x.end), via, easing: family(x.inEasing) };
  }
  return scenes;
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

This is a **starting point that carries the reference's structure**, not a copy of it: one scene per shot, the cut
times (measured), the dissolves, fades, dips and wipes between shots (derived from the frames), background and accent
colours from each shot's palette (measured), and a placeholder title. Only what Frame Lens read from the reference
animates: a title moves where \`style\` found a move in its shot (its start and length from the frames, its easing a
derived family, or a fitted curve when the move was tracked), and scenes dissolve, fade or wipe into each other where
such a transition was derived. Everything else holds still. Replace the placeholders with your own content, then
refine every move against the reference with \`frames\` every_frame.

- Canvas ${spec.timebase.width ?? 1920}×${spec.timebase.height ?? 1080} at ${fps} fps, ${spec.shots.length} shots, ${spec.rhythm.cuts} cuts${transitionsLine(spec)}.
- Rhythm: median shot ${spec.rhythm.medianShotSeconds} s, ${spec.rhythm.cutsPerMinute} cuts per minute${spec.audio.tempo_bpm ? `, music ${spec.audio.tempo_bpm} BPM` : ""}.
- ${tracksNote(spec)}
- Check the result: render it, then run Frame Lens \`compare\` with the reference and your render.

## Defaults (not measured)

These come from Frame Lens, not from the reference; change them freely:

- The placeholder title: its text (the scene's name), font, size, case and centred position, and its colour (the
  shot's accent colour, which is measured).
- What a move does to the title: it fades in (opacity 0 to 1) and rises ${Math.round((60 * (spec.timebase.height ?? 1080)) / 1080)} px. Only the move's start and length
  (from the frames) and its easing (a derived family, or a fitted curve when tracked) come from the reference; what
  actually moved there (and how far) is for you to read from the frames or from \`track\`.
- Scenes where no move was found show their title still for the whole shot (no entrance is invented).
- Dissolves and fades are opacity ramps of the length derived from the frames, with the easing family read from how
  the picture blended (derived); a wipe is a straight edge. Fades and dips go through flat black or white.
`;
}

function transitionsLine(spec: MotionSpec): string {
  const gradual = (spec.transitions ?? []).filter((x) => x.kind !== "cut");
  if (!gradual.length) return "";
  const counts = new Map<string, number>();
  for (const x of gradual) {
    const name = x.kind === "dip" ? `dip through ${x.via ?? "black"}` : x.kind === "fade-in" || x.kind === "fade-out" ? `${x.kind} (${x.via ?? "black"})` : x.kind;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return `, ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}`;
}

function tracksNote(spec: MotionSpec): string {
  const tracked = (spec.tracks ?? []).filter((t) => t && Array.isArray(t.properties) && t.properties.length);
  if (!tracked.length) return "Easing families are derived from whole-picture motion; they are a family to start from, not a fitted curve. Run Frame Lens `track` on a move for its exact curve.";
  const list = tracked.slice(0, 12).map((t) => {
    const p = primaryCurve(t);
    const curve = exportable(p) ? safeCurve(p!.curve) : undefined;
    return `${String(t.id).replace(/[^A-Za-z0-9_-]/g, "")} at ${Number(t.start).toFixed(3)} s: ${curve ? curveLabel(curve) : `not exported (${p ? `${p.quality}, error ${(p.rmse * 100).toFixed(1)} %` : "no curve"})`}`;
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
      let i = 1;
      while (i < p.length - 1 && p[i][0] < u) i++;
      const [x0, y0] = p[i - 1], [x1, y1] = p[i];
      return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0 || 1);
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
  return { ease: `flPoints(${JSON.stringify(springPoints(c))})`, helpers: true };
}

export function exportHyperframes(spec: MotionSpec, root: string): string[] {
  const scenes = scenesFromSpec(spec);
  const width = spec.timebase.width ?? 1920;
  const height = spec.timebase.height ?? 1080;
  const total = r3(spec.range.end - spec.range.start);
  const variables = spec.palette.slice(0, 6).map((p, i) => ({ id: `color-${i + 1}`, type: "color", label: `Palette ${i + 1}`, default: safeHex(p.hex) }));
  // A scene that dissolves or wipes in overlaps the previous one: its own Studio lane, and painted above it (z-index).
  const lanes: number[] = [];
  scenes.forEach((s, i) => lanes.push(i > 0 && s.show.start < scenes[i - 1]!.show.end - 1e-6 ? 3 - lanes[i - 1]! : 1));
  const hosts = scenes
    .map(
      (s, i) => `      <div
        id="${s.id}"
        data-composition-id="${s.id}"
        data-composition-src="compositions/${s.id}.html"
        data-start="${s.show.start}"
        data-duration="${r3(s.show.end - s.show.start)}"
        data-track-index="${lanes[i]}"
        data-track-kind="graphics"
        data-width="${width}"
        data-height="${height}"
        style="z-index: ${i + 1}"
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
    // Times inside the composition run from its own start, which is earlier than the shot when it dissolves in.
    const length = r3(s.show.end - s.show.start);
    const local = (t: number) => r3(Math.max(0, t - s.show.start));
    const lead = local(s.start);
    const titleStart = s.move ? r3(lead + s.move.offset) : 0;
    const titleDuration = r3(Math.max(0.01, length - titleStart - 0.01));
    const ease = s.move && gsapEase(s.move);
    const tweens: string[] = [];
    if (s.reveal) {
      const revealEase = JSON.stringify(GSAP_EASE[s.reveal.easing]);
      tweens.push(
        s.reveal.kind === "wipe"
          ? `tl.fromTo("#${s.id}-frame", { clipPath: "${wipeFrom(s.reveal.direction)}" }, { clipPath: "${WIPE_TO}", duration: ${s.reveal.seconds}, ease: ${revealEase} }, ${local(s.reveal.start)}); // wipe, derived from the reference`
          : `tl.fromTo("#${s.id}-frame", { opacity: 0 }, { opacity: 1, duration: ${s.reveal.seconds}, ease: ${revealEase} }, ${local(s.reveal.start)}); // dissolve, derived from the reference`,
      );
    }
    if (s.move) {
      tweens.push(`tl.fromTo("#${s.id}-title", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: ${s.move.seconds}, ease: ${ease!.ease} }, ${titleStart});${s.move.track ? ` // tracked ${s.move.track} (fitted curve)` : " // move found by style (easing family derived)"}`);
    }
    // A fade in and a fade out have a veil each, in their own colour (in from white, out to black is possible).
    if (s.fadeIn) {
      tweens.push(`tl.set("#${s.id}-veil-in", { opacity: 1 }, 0);`);
      tweens.push(`tl.to("#${s.id}-veil-in", { opacity: 0, duration: ${s.fadeIn.seconds}, ease: ${JSON.stringify(GSAP_EASE[s.fadeIn.easing])} }, ${local(s.fadeIn.start)}); // fade in from ${s.fadeIn.via}, derived`);
    }
    if (s.fadeOut) {
      tweens.push(`tl.set("#${s.id}-veil-out", { opacity: 0 }, 0);`);
      tweens.push(`tl.to("#${s.id}-veil-out", { opacity: 1, duration: ${s.fadeOut.seconds}, ease: ${JSON.stringify(GSAP_EASE[s.fadeOut.easing])} }, ${local(s.fadeOut.start)}); // fade out to ${s.fadeOut.via}, derived`);
    }
    const veils = ([["in", s.fadeIn], ["out", s.fadeOut]] as const).filter(([, f]) => f).map(([side, f]) => ({ id: `${s.id}-veil-${side}`, colour: VIA_HEX[f!.via] }));
    files[`compositions/${s.id}.html`] = `<template>
  <style>
    #root {
      position: absolute;
      inset: 0;
    }
    #${s.id}-frame {
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
    }${veils.map((v) => `
    #${v.id} {
      position: absolute;
      inset: 0;
      background: ${v.colour};
      opacity: 0;
    }`).join("")}
  </style>
  <div id="root" data-composition-id="${s.id}" data-width="${width}" data-height="${height}">
    <div id="${s.id}-frame">
      <h1 id="${s.id}-title" class="clip" data-start="${titleStart}" data-duration="${titleDuration}">${s.id.replace("-", " ")}</h1>
    </div>${veils.map((v) => `\n    <div id="${v.id}"></div>`).join("")}
  </div>
  <script>
${ease?.helpers ? GSAP_HELPERS : ""}    const tl = gsap.timeline({ paused: true });
${tweens.length ? tweens.map((t) => `    ${t}`).join("\n") : "    // No move or transition was found in this shot: the title holds still."}
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
  const sceneData = scenes.map((s) => {
    // Frames inside the scene's Sequence, which starts earlier than the shot when it dissolves in.
    const from = Math.round(s.show.start * fps);
    const local = (t: number) => Math.max(0, Math.round(t * fps) - from);
    const ramp = (r: { start: number; seconds: number; easing: EasingFamily }) => ({ at: local(r.start), frames: frames(r.seconds), bezier: BEZIER[r.easing] });
    return {
      id: s.id,
      from,
      durationInFrames: Math.max(1, Math.round(s.show.end * fps) - from),
      background: s.background,
      accent: s.accent,
      ...(s.move && {
        enterAt: local(s.start + s.move.offset),
        enterFrames: frames(s.move.seconds),
        ...(moveBezier(s.move) && { bezier: moveBezier(s.move) }),
        ...(s.move.curve?.kind === "spring" && { spring: { stiffness: s.move.curve.stiffness, damping: s.move.curve.damping, mass: s.move.curve.mass } }),
        ...(s.move.curve?.kind === "steps" && { steps: s.move.curve.steps }),
        ...(s.move.track && { track: s.move.track }),
      }),
      ...(s.reveal && { reveal: { kind: s.reveal.kind, ...ramp(s.reveal), ...(s.reveal.kind === "wipe" && { wipeFrom: wipeFrom(s.reveal.direction) }) } }),
      ...(s.fadeIn && { fadeIn: { ...ramp(s.fadeIn), color: VIA_HEX[s.fadeIn.via] } }),
      ...(s.fadeOut && { fadeOut: { ...ramp(s.fadeOut), color: VIA_HEX[s.fadeOut.via] } }),
    };
  });
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

/** An opacity ramp (dissolve, fade) or wipe derived from the reference: its first frame inside the scene, length and easing. */
type Ramp = { at: number; frames: number; bezier: number[] };

type SceneData = (typeof SCENES)[number] & {
  /** A move found in the shot: the title enters (fades in and rises) with its timing. Without one the title holds still. */
  enterAt?: number;
  enterFrames?: number;
  bezier?: number[];
  /** A move measured with Frame Lens track that settles like a spring. */
  spring?: { stiffness: number; damping: number; mass: number };
  steps?: number;
  /** A dissolve or wipe (derived) that brings this scene in over the previous one. */
  reveal?: Ramp & { kind: string; wipeFrom?: string };
  /** A fade in from, or out to, black or white (derived). */
  fadeIn?: Ramp & { color: string };
  fadeOut?: Ramp & { color: string };
};

/** 0 → 1 over a ramp, with its measured easing. */
const rampAt = (frame: number, ramp: Ramp) => {
  const [x1, y1, x2, y2] = ramp.bezier;
  return interpolate(frame, [ramp.at, ramp.at + ramp.frames], [0, 1], {
    easing: Easing.bezier(x1!, y1!, x2!, y2!),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

/** clip-path between the wipe's start and fully open. */
const wipeAt = (from: string, p: number) =>
  from.replace(/[\\d.]+%/g, (v) => \`\${(parseFloat(v) * (1 - p)).toFixed(2)}%\`);

const Scene = ({ scene }: { scene: SceneData }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let progress = 1;
  if (scene.enterAt !== undefined && scene.enterFrames !== undefined) {
    const enterAt = scene.enterAt;
    const enterFrames = scene.enterFrames;
    const [x1, y1, x2, y2] = scene.bezier ?? [0, 0, 1, 1];
    const linear = interpolate(frame, [enterAt, enterAt + enterFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    progress = scene.spring
      ? spring({ frame: frame - enterAt, fps, config: scene.spring })
      : scene.steps
        ? (linear >= 1 ? 1 : Math.floor(linear * scene.steps) / scene.steps)
        : interpolate(frame, [enterAt, enterAt + enterFrames], [0, 1], {
            easing: Easing.bezier(x1!, y1!, x2!, y2!),
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
  }
  const revealed = scene.reveal ? rampAt(frame, scene.reveal) : 1;
  const opacity = scene.reveal && scene.reveal.kind !== "wipe" ? revealed : 1;
  const clipPath = scene.reveal?.wipeFrom ? wipeAt(scene.reveal.wipeFrom, revealed) : undefined;
  return (
    <AbsoluteFill style={{ opacity, clipPath }}>
      <AbsoluteFill style={{ background: scene.background, alignItems: "center", justifyContent: "center" }}>
        <h1 style={{ color: scene.accent, fontSize: HEIGHT / 10, fontWeight: 800, textTransform: "uppercase", opacity: progress, transform: \`translateY(\${(1 - progress) * 60}px)\` }}>
          {scene.id.replace("-", " ")}
        </h1>
      </AbsoluteFill>
      {scene.fadeIn ? <AbsoluteFill style={{ background: scene.fadeIn.color, opacity: 1 - rampAt(frame, scene.fadeIn) }} /> : null}
      {scene.fadeOut ? <AbsoluteFill style={{ background: scene.fadeOut.color, opacity: rampAt(frame, scene.fadeOut) }} /> : null}
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
    .map((s, i) => {
      const n = i + 1;
      const from = s.show.start;
      const length = r3(s.show.end - s.show.start);
      const at = (t: number) => `${(Math.min(1, Math.max(0, (t - from) / (length || 1))) * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
      const rules: string[] = [];
      // No fill mode: a scene is visible only during its slot. With `both` every scene showed from the first frame
      // and the last one in the page covered all the others. A dissolve or wipe into the scene has its own keyframes.
      // Keyframe stops in time order; stops at the same offset are one stop (the later declarations win).
      const keyframes = (name: string, stops: [string, string][]) => {
        const merged: [string, Map<string, string>][] = [];
        for (const [offset, body] of stops) {
          const last = merged.at(-1);
          const decls = last && last[0] === offset ? last[1] : new Map<string, string>();
          if (decls !== last?.[1]) merged.push([offset, decls]);
          for (const d of body.split(";")) {
            const colon = d.indexOf(":");
            if (colon > 0) decls.set(d.slice(0, colon).trim(), d.slice(colon + 1).trim());
          }
        }
        return `@keyframes ${name} { ${merged.map(([offset, decls]) => `${offset} { ${[...decls].map(([p, v]) => `${p}: ${v};`).join(" ")} }`).join(" ")} }`;
      };
      if (s.reveal) {
        const r = s.reveal;
        const [shown, hidden] = r.kind === "wipe" ? [`opacity: 1; clip-path: ${WIPE_TO};`, `opacity: 1; clip-path: ${wipeFrom(r.direction)};`] : ["opacity: 1;", "opacity: 0;"];
        const stops: [string, string][] = [["0%", hidden], [at(r.start), `${hidden} animation-timing-function: ${familyCss(r.easing)};`], [at(r.start + r.seconds), shown], ["100%", shown]];
        rules.push(`${keyframes(`fl-show-${n}`, stops)} /* ${r.kind}, derived from the reference */`);
        rules.push(`#${s.id} { background: ${s.background}; animation: fl-show-${n} ${length}s linear ${from}s; }`);
      } else rules.push(`#${s.id} { background: ${s.background}; animation: fl-show ${length}s linear ${from}s; }`);
      if (s.move) rules.push(`#${s.id} h1 { color: ${s.accent}; animation: fl-enter ${s.move.seconds}s ${moveCss(s.move)} ${r3(s.start + s.move.offset)}s both; } /* ${s.move.track ? `tracked ${s.move.track} (fitted curve)` : "move found by style (easing family derived)"} */`);
      else rules.push(`#${s.id} h1 { color: ${s.accent}; } /* no move found in this shot: the title holds still */`);
      // A fade in and a fade out have a veil each, in their own colour.
      if (s.fadeIn) {
        const stops: [string, string][] = [["0%", "opacity: 1;"], [at(s.fadeIn.start), `opacity: 1; animation-timing-function: ${familyCss(s.fadeIn.easing)};`], [at(s.fadeIn.start + s.fadeIn.seconds), "opacity: 0;"], ["100%", "opacity: 0;"]];
        rules.push(`${keyframes(`fl-veil-in-${n}`, stops)} /* fade in from ${s.fadeIn.via}, derived */`);
        rules.push(`#${s.id} .fl-veil-in { background: ${VIA_HEX[s.fadeIn.via]}; animation: fl-veil-in-${n} ${length}s linear ${from}s both; }`);
      }
      if (s.fadeOut) {
        const stops: [string, string][] = [["0%", "opacity: 0;"], [at(s.fadeOut.start), `opacity: 0; animation-timing-function: ${familyCss(s.fadeOut.easing)};`], [at(s.fadeOut.start + s.fadeOut.seconds), "opacity: 1;"], ["100%", "opacity: 1;"]];
        rules.push(`${keyframes(`fl-veil-out-${n}`, stops)} /* fade out to ${s.fadeOut.via}, derived */`);
        rules.push(`#${s.id} .fl-veil-out { background: ${VIA_HEX[s.fadeOut.via]}; animation: fl-veil-out-${n} ${length}s linear ${from}s both; }`);
      }
      return rules.join("\n");
    })
    .join("\n");
  const files: Record<string, string> = {
    "tokens.css": `:root {\n${tokens}\n${easings}\n  --fl-median-shot: ${spec.rhythm.medianShotSeconds}s;\n}\n`,
    "motion.css": `/* Scene timing measured by Frame Lens; restart the page to replay. */
.fl-stage { position: relative; width: min(100vw, ${spec.timebase.width ?? 1920}px); aspect-ratio: ${spec.timebase.width ?? 16} / ${spec.timebase.height ?? 9}; overflow: hidden; }
.fl-scene { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; }
.fl-scene h1 { font: 800 clamp(24px, 8vw, 120px)/1 system-ui, sans-serif; text-transform: uppercase; margin: 0; }
.fl-veil { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
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
${scenes.map((s) => `  <section class="fl-scene" id="${s.id}"><h1>${s.id.replace("-", " ")}</h1>${s.fadeIn ? '<div class="fl-veil fl-veil-in"></div>' : ""}${s.fadeOut ? '<div class="fl-veil fl-veil-out"></div>' : ""}</section>`).join("\n")}
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
  const range = { start: finite(spec.range.start), end: finite(spec.range.end) };
  return {
    ...spec,
    timebase: { ...timebase, ...(w && { width: Math.round(w) }), ...(h && { height: Math.round(h) }), ...(f && { fps: f }) } as MotionSpec["timebase"],
    range,
    shots: spec.shots.map((s) => ({ ...s, start: finite(s.start), end: finite(s.end), frames: finite(s.frames) })),
    events: spec.events.map((e) => ({ ...e, start: finite(e.start), end: finite(e.end), frames: finite(e.frames) })),
    // Not a list (a hand-edited or hostile spec): no transitions, rather than a crash.
    ...(spec.transitions !== undefined && { transitions: Array.isArray(spec.transitions) ? safeTransitions(spec.transitions, range) : [] }),
    anchors: {
      ...spec.anchors,
      cuts: spec.anchors.cuts.map((c) => ({ ...c, t: finite(c.t) })),
      beats: spec.anchors.beats.map((b) => ({ ...b, t: finite(b.t) })),
    },
  };
}

const KINDS = new Set(["cut", "dissolve", "fade-in", "fade-out", "dip", "wipe"]);
const DIRECTIONS = new Set(["left", "right", "up", "down"]);
const FAMILIES = new Set(Object.keys(BEZIER));

/** Transitions from a spec file, kept only when every field that reaches generated code is one of the known values. */
function safeTransitions(list: unknown[], range: { start: number; end: number }): NonNullable<MotionSpec["transitions"]> {
  const out: NonNullable<MotionSpec["transitions"]> = [];
  // Times outside the analysed range are clamped into it; a transition of no length inside it is dropped.
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  const time = (v: unknown) => Math.min(hi, Math.max(lo, finite(v)));
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const x = raw as Record<string, unknown>;
    if (typeof x.kind !== "string" || !KINDS.has(x.kind)) continue;
    const hold = x.hold && typeof x.hold === "object" ? (x.hold as Record<string, unknown>) : undefined;
    out.push({
      id: typeof x.id === "string" ? x.id : "",
      kind: x.kind as NonNullable<MotionSpec["transitions"]>[number]["kind"],
      start: time(x.start),
      end: Math.max(time(x.start), time(x.end)),
      frames: Math.max(0, Math.min(100_000, Math.round(finite(x.frames)))),
      at: Math.min(Math.max(time(x.start), time(x.end)), Math.max(time(x.start), time(x.at))),
      evidence: x.evidence === "measured" ? "measured" : "derived",
      ...(typeof x.from === "string" && { from: x.from }),
      ...(typeof x.to === "string" && { to: x.to }),
      ...((x.via === "black" || x.via === "white") && { via: x.via }),
      ...(hold && { hold: { start: time(hold.start), end: Math.max(time(hold.start), time(hold.end)) } }),
      ...(typeof x.direction === "string" && DIRECTIONS.has(x.direction) && { direction: x.direction as "left" | "right" | "up" | "down" }),
      ...(typeof x.easing === "string" && FAMILIES.has(x.easing) && { easing: x.easing as EasingFamily }),
      ...(typeof x.outEasing === "string" && FAMILIES.has(x.outEasing) && { outEasing: x.outEasing as EasingFamily }),
      ...(typeof x.inEasing === "string" && FAMILIES.has(x.inEasing) && { inEasing: x.inEasing as EasingFamily }),
    });
  }
  return out;
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

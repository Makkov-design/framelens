import type { EasingFamily } from "../style/motion.js";
import { EASING_SUGGESTIONS } from "../style/motion.js";
import { bezierFamily, bezierPeak, type Bezier } from "../exact/easing.js";
import { rgbToOklab, type Swatch } from "../style/palette.js";
import type { Evidence, MotionSpec } from "../style/spec.js";
import type { PageAnimation, PageReading } from "./page-script.js";

export { cleanReading, mergeReadings, PAGE_SCRIPT, RECORDER_SCRIPT, type PageAnimation, type PageReading } from "./page-script.js";


const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  linear: [0, 0, 1, 1],
};

/** The family a CSS or GSAP easing belongs to; exact curves stay in `suggestion`. */
export function easingFamily(easing: string): EasingFamily {
  const e = String(easing).trim().toLowerCase();
  if (e === "linear" || e === "none" || e === "power0" || /^power0\./.test(e)) return "linear";
  // GSAP: name[.in|.out|.inOut](params), GSAP 2's Name.easeIn/easeOut/easeInOut; a bare name ("power2") is .out.
  const gsap = /^(power[1-4]|quad|cubic|quart|quint|strong|sine|expo|circ|back|elastic|bounce)(?:\.(in|out|inout|easein|easeout|easeinout))?(?:\(.*\))?$/.exec(e);
  if (gsap) {
    const side = (gsap[2] ?? "out").replace("ease", "");
    return side === "inout" ? "ease-in-out" : side === "in" ? "ease-in" : "ease-out";
  }
  const bezier = cssBezier(e);
  if (!bezier) return "unclear";
  // The same reading as exact Lottie and Figma curves, including control points on an end (ease-in is 0.42, 0, 1, 1).
  return bezierFamily(bezier);
}

/** The control points of a CSS `cubic-bezier()` or easing keyword; undefined for steps, `linear()` and GSAP eases. */
function cssBezier(easing: string): Bezier | undefined {
  const e = String(easing).trim().toLowerCase();
  const bezier = KEYWORDS[e] ?? (/^cubic-bezier\(([^)]+)\)$/.exec(e)?.[1]?.split(",").map(Number) as Bezier | undefined);
  return bezier && bezier.length === 4 && bezier.every((n) => Number.isFinite(n)) ? bezier : undefined;
}

/** The curve that shapes an animation: a CSS animation's first keyframe easing wins over the effect's timing easing. */
export function effectiveEasing(a: PageAnimation): string {
  if (a.kind === "css-animation") {
    const first = a.keyframes.find((k) => k.easing && k.easing !== "linear");
    if (first?.easing) return String(first.easing);
  }
  return a.easing;
}

const FPS = 60;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The page's animations as a motion spec: exact durations, delays and curves (`measured`); frame counts at Frame
 * Lens's 60 fps (`inferred`), and where each move is fastest (`derived` from a cubic-bezier, else `inferred`).
 */
export function specFromPage(reading: PageReading, version: string): MotionSpec {
  const total = reading.colors.reduce((s, c) => s + c.area, 0) || 1;
  // The page's own colours and the share of the page they cover; lightness and chroma are the same colours in OKLab.
  const palette: (Swatch & { evidence: "measured" })[] = reading.colors.slice(0, 8).map((c) => {
    const n = (i: number) => parseInt(c.hex.slice(i, i + 2), 16) || 0;
    const [L, a, b] = rgbToOklab(n(1), n(3), n(5));
    return {
      hex: c.hex,
      share: Math.round((c.area / total) * 1000) / 1000,
      lightness: Math.round(L * 1000) / 1000,
      chroma: Math.round(Math.hypot(a, b) * 1000) / 1000,
      evidence: "measured" as const,
    };
  });
  const finite = reading.animations.filter((a) => a.duration > 0 && a.duration < 60_000);
  const end = Math.max(1, ...finite.map((a) => (a.delay + a.duration * (a.iterations === "infinite" ? 1 : Math.min(a.iterations, 4))) / 1000));
  const events = finite.map((a) => {
    const easing = effectiveEasing(a);
    const family = easingFamily(easing);
    const start = r3(Math.max(0, a.delay) / 1000);
    // Where the move is fastest follows from the page's own curve when it is a cubic-bezier (derived); for steps,
    // `linear()` and GSAP eases it is the family's usual place (inferred), and the peak speed is not known.
    const bezier = cssBezier(easing);
    const shape = bezier ? bezierPeak(bezier) : { peak: 0, peakAt: family === "ease-out" ? 0.2 : family === "ease-in" ? 0.8 : 0.5 };
    // Times and repeats are the page's own; frames count them at the 60 fps Frame Lens picks for a page.
    const evidence: Partial<Record<string, Evidence>> = { start: "measured", end: "measured", iterations: "measured", frames: "inferred", peak: bezier ? "derived" : "inferred", peakAt: bezier ? "derived" : "inferred" };
    return {
      start,
      end: r3(start + a.duration / 1000),
      frames: Math.round((a.duration / 1000) * FPS),
      ...shape,
      easing: family,
      suggestion: easing || EASING_SUGGESTIONS[family],
      kind: "move" as const,
      evidence,
      target: a.target,
      name: a.name,
      properties: a.properties,
      // Every object with numbers carries its label (the page's own keyframe offsets and scroll position).
      keyframes: a.keyframes.map((k) => ({ ...k, evidence: "measured" as const })),
      source: a.kind,
      iterations: a.iterations,
      ...(a.scrollTriggered && { scroll: { triggeredAtY: a.scrollY, evidence: "measured" as const } }),
      ...(a.ended && { ended: true }),
    };
  });
  return {
    spec: "framelens.motion/1",
    generatedBy: `framelens ${version}`,
    source: { kind: "web", input: reading.url, url: reading.url, title: reading.title },
    range: { start: 0, end: r3(end) },
    // The viewport is read from the page; the length is where its animations end; 60 fps is Frame Lens's own
    // choice for a page (a page has no frame rate of its own).
    timebase: {
      fps: FPS,
      vfr: false,
      duration: r3(end),
      width: reading.viewport.width,
      height: reading.viewport.height,
      evidence: { fps: "inferred", duration: "derived", width: "measured", height: "measured" },
    },
    anchors: { words: [], beats: [], cuts: [] },
    changes: [],
    palette,
    typography: reading.fonts.map((f) => ({
      role: f.selector,
      family_guess: f.family,
      weight: Number(f.weight) || 400,
      case: f.transform === "none" ? "as written" : f.transform,
      size: f.size,
      lineHeight: f.lineHeight,
      letterSpacing: f.letterSpacing,
      sample: f.sample,
      evidence: "measured" as const,
    })),
    // One "shot" for the page: from load to where its animations end (derived from their measured times).
    shots: [{ id: "page", start: 0, end: r3(end), frames: Math.round(end * FPS), palette: palette.slice(0, 4).map((p) => p.hex), evidence: "derived" as const }],
    systems: [],
    events,
    rhythm: { cuts: 0, cutsPerMinute: 0, meanShotSeconds: r3(end), medianShotSeconds: r3(end), movesPerMinute: Math.round((events.length / (end / 60)) * 100) / 100, evidence: "derived" as const },
    audio: { sfx: [] },
  };
}

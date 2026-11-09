import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "../media/exec.js";
import type { ProbeInfo } from "../media/probe.js";
import type { Evidence } from "../style/spec.js";
import { cssEasing } from "./curve.js";
import { decodeGray, workSize } from "./decode.js";
import { fitProperty, type PropertyFit } from "./fit.js";
import { autoBox, trackElement, type Box } from "./tracker.js";

export const TRACK_PROPERTIES = ["x", "y", "scale", "opacity"] as const;
export type TrackProperty = (typeof TRACK_PROPERTIES)[number];

/** Longest window `track` reads at once (every frame is decoded and held while tracking). */
export const MAX_TRACK_SECONDS = 15;
export const MAX_TRACK_FRAMES = 900;

export interface TrackedProperty extends PropertyFit {
  property: TrackProperty;
  /** Seconds from the start of the tracked move (the earliest property) to this property's start: the stagger. */
  delay: number;
  /** The curve as CSS: cubic-bezier(), linear() for a spring, steps() or linear. */
  css: string;
  evidence: Evidence;
}

export interface TrackedMove {
  id: string;
  /** The window that was read, in source seconds. */
  window: { start: number; end: number };
  /** The element at the reference frame, in source pixels (top-left corner and size). */
  element: { box: Box; at: number; auto: boolean };
  /** The move: from the earliest property start to the latest property end. */
  start: number;
  end: number;
  frames: number;
  seconds: number;
  /** Seconds from the start of the window to the start of the move. */
  delay: number;
  /** The property that carries the move (the biggest change); its curve stands for the move in exports. */
  primary?: TrackProperty;
  properties: TrackedProperty[];
  /** Properties that changed but could not be fitted as one move (for example a value that goes and comes back). */
  unfitted: { property: TrackProperty; reason: string }[];
  /** Per-frame measurements: centre in source pixels, scale relative to the reference frame, relative opacity. */
  samples: { t: number; x: number; y: number; scale: number; opacity: number; score: number; lost: boolean }[];
  /** The style move this track refines, as its 1-based number in `events`. */
  move?: number;
  evidence: Evidence;
  fps: number;
}

export interface TrackRequest {
  start: number;
  end: number;
  /** Box in source pixels, or in fractions of the frame when every value is ≤ 1. Omit for the automatic choice. */
  box?: Box;
  /** Source time where the box is drawn (default: the window start). */
  at?: number;
  id: string;
  move?: number;
}

const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Tracks one element through a window and fits a timing curve to each property that moves. */
export async function trackWindow(source: string, probe: ProbeInfo, tools: MediaTools, request: TrackRequest): Promise<TrackedMove> {
  if (!probe.hasVideo || !probe.width || !probe.height) throw new InvalidInputError("This source has no picture to track.");
  const fps = probe.fps ?? probe.nominalFps ?? 30;
  const start = Math.max(0, request.start);
  const end = Math.min(probe.duration, request.end);
  if (!(end > start)) throw new InvalidInputError(`The window ${request.start}–${request.end} s is empty or outside the video (${probe.duration.toFixed(2)} s).`);
  if (end - start > MAX_TRACK_SECONDS) throw new InvalidInputError(`Track at most ${MAX_TRACK_SECONDS} s at a time: pass a narrower start/end around the move.`);
  const expected = Math.ceil((end - start) * fps) + 2;
  if (expected > MAX_TRACK_FRAMES) throw new InvalidInputError(`The window has about ${expected} frames (at most ${MAX_TRACK_FRAMES}); pass a narrower start/end.`);
  const size = workSize(probe.width, probe.height, expected);
  const video = await decodeGray(source, tools, { start, end }, size, { maxFrames: MAX_TRACK_FRAMES + 10, fps });
  if (video.frames.length < 4) throw new InvalidInputError(`Only ${video.frames.length} frame(s) in ${start}–${end} s: widen the window.`);
  const k = size.factor;

  let box: Box;
  let index: number;
  let auto = false;
  if (request.box) {
    const b = request.box;
    const fraction = [b.x, b.y, b.w, b.h].every((v) => v >= 0 && v <= 1);
    const sx = fraction ? probe.width : 1;
    const sy = fraction ? probe.height : 1;
    box = { x: b.x * sx * k, y: b.y * sy * k, w: b.w * sx * k, h: b.h * sy * k };
    if (box.w < 4 || box.h < 4) throw new InvalidInputError("The element box is too small to track (at least 4 pixels at analysis size); draw it around the whole element.");
    if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= size.width || box.y >= size.height) throw new InvalidInputError("The element box is outside the frame.");
    const at = request.at ?? start;
    index = video.frames.reduce((best, f, i) => (Math.abs(f.t - at) < Math.abs(video.frames[best]!.t - at) ? i : best), 0);
  } else {
    const found = autoBox(video);
    if (!found) throw new InvalidInputError("Nothing moves in this window, so there is no element to pick automatically. Pass a box or another window.");
    ({ box, index } = found);
    auto = true;
  }

  const points = trackElement(video, box, index);
  const maxContrast = Math.max(1e-6, ...points.filter((p) => !p.lost).map((p) => p.contrast));
  const samples = points.map((p) => ({
    t: p.t,
    x: r(p.x / k, 3),
    y: r(p.y / k, 3),
    scale: r(p.scale, 4),
    opacity: r(Math.max(0, p.contrast / maxContrast), 4),
    score: r(p.score, 4),
    lost: p.lost,
  }));
  const times = samples.map((s) => s.t);
  const good = (s: (typeof samples)[number]) => !s.lost;
  const series: Record<TrackProperty, number[]> = {
    x: samples.map((s) => (good(s) ? s.x : NaN)),
    y: samples.map((s) => (good(s) ? s.y : NaN)),
    scale: samples.map((s) => (good(s) ? s.scale : NaN)),
    opacity: samples.map((s) => s.opacity),
  };
  const minTravel: Record<TrackProperty, number> = { x: Math.max(1.5, 0.5 / k), y: Math.max(1.5, 0.5 / k), scale: 0.03, opacity: 0.15 };
  const fits: { property: TrackProperty; fit: PropertyFit }[] = [];
  const unfitted: TrackedMove["unfitted"] = [];
  for (const property of TRACK_PROPERTIES) {
    const values = series[property];
    const fit = fitProperty(times, values, fps, { minTravel: minTravel[property] });
    if (fit) {
      fits.push({ property, fit });
      continue;
    }
    const finite = values.filter(Number.isFinite);
    const spread = finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
    if (spread > minTravel[property] * 2) unfitted.push({ property, reason: "changes but does not go from one resting value to another (it may return, or the window cuts the move)" });
  }
  const moveStart = fits.length ? Math.min(...fits.map((f) => f.fit.start)) : start;
  const moveEnd = fits.length ? Math.max(...fits.map((f) => f.fit.end)) : start;
  const properties: TrackedProperty[] = fits.map(({ property, fit }) => ({
    property,
    ...fit,
    delay: r(fit.start - moveStart, 4),
    css: cssEasing(fit.curve),
    evidence: "derived",
  }));
  // The move is carried by the biggest change: position first (in pixels against the element's size), then scale, then opacity.
  const weight = (p: TrackedProperty) => {
    const travel = Math.abs(p.to - p.from);
    if (p.property === "x" || p.property === "y") return 10 + travel / Math.max(box.w, box.h, 1);
    if (p.property === "scale") return 5 + travel;
    return travel;
  };
  const primary = [...properties].sort((a, b) => weight(b) - weight(a))[0]?.property;
  return {
    id: request.id,
    window: { start: r(start, 4), end: r(end, 4) },
    element: { box: { x: r(box.x / k, 1), y: r(box.y / k, 1), w: r(box.w / k, 1), h: r(box.h / k, 1) }, at: video.frames[index]!.t, auto },
    start: r(moveStart, 4),
    end: r(moveEnd, 4),
    frames: r((moveEnd - moveStart) * fps, 2),
    seconds: r(moveEnd - moveStart, 4),
    delay: r(moveStart - start, 4),
    ...(primary && { primary }),
    properties,
    unfitted,
    samples,
    ...(request.move && { move: request.move }),
    evidence: "measured",
    fps,
  };
}

/** The curve that stands for a tracked move: its primary property's. */
export function primaryCurve(track: Pick<TrackedMove, "primary" | "properties">): TrackedProperty | undefined {
  return track.properties.find((p) => p.property === track.primary) ?? track.properties[0];
}

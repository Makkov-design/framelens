import type { MotionSpec } from "../style/spec.js";
import { cssEasing, curveFamily, safeCurve } from "./curve.js";
import { exportable, primaryCurve, type TrackedMove } from "./run.js";

/** Overlap of two time spans as a share of the shorter one. */
function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.max(1e-6, Math.min(a.end - a.start, b.end - b.start));
  return shared / shorter;
}

/** Shared area of two boxes as a share of the smaller one (1 when one holds the other). */
function boxShare(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-6, Math.min(a.w * a.h, b.w * b.h));
}

const GRADES = { exact: 0, approximate: 1, unreliable: 2 } as const;

/** How good a track's curve is for export: 0 exact, 1 approximate, 2 unreliable, 3 nothing exportable. */
export function trackGrade(track: Pick<TrackedMove, "primary" | "properties">): number {
  const p = Array.isArray(track.properties) ? primaryCurve(track) : undefined;
  if (!exportable(p) || !safeCurve(p!.curve)) return 3;
  return GRADES[p!.quality] ?? 3;
}

/** When a track was made: its time stamp, else its number (later tracks get higher numbers). */
function age(track: Pick<TrackedMove, "id" | "measuredAt">): [number, number] {
  const at = Date.parse(String(track.measuredAt ?? ""));
  return [Number.isFinite(at) ? at : 0, Number(String(track.id).replace(/^\D+/, "")) || 0];
}

/** Whether `a` is the better track of the same move: a better grade, then the newer one. */
export function betterTrack(a: TrackedMove, b: TrackedMove): boolean {
  const ga = trackGrade(a);
  const gb = trackGrade(b);
  if (ga !== gb) return ga < gb;
  const [ta, na] = age(a);
  const [tb, nb] = age(b);
  return ta !== tb ? ta > tb : na > nb;
}

/**
 * Whether two tracks followed the same thing: on the frames both matched, their centres stay within half the
 * element's size of each other most of the time. Undefined when they share too few matched frames to tell.
 */
function sameTrajectory(a: TrackedMove, b: TrackedMove, size: number): boolean | undefined {
  const matched = (t: TrackedMove) => (Array.isArray(t.samples) ? t.samples : []).filter((s) => s && !s.lost && [s.t, s.x, s.y].every(Number.isFinite));
  const sa = matched(a);
  const sb = matched(b);
  if (sa.length < 3 || sb.length < 3) return undefined;
  const half = 0.5 / (Number(a.fps) || Number(b.fps) || 30);
  let shared = 0;
  let close = 0;
  let j = 0;
  for (const p of sa) {
    while (j < sb.length - 1 && sb[j]!.t < p.t - half) j++;
    const q = sb[j]!;
    if (Math.abs(q.t - p.t) > half) continue;
    shared++;
    if (Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(4, size / 2)) close++;
  }
  return shared >= 3 ? close >= 0.6 * shared : undefined;
}

/**
 * Two tracks of the same element over the same move: their windows or moves overlap by half, and they followed the
 * same thing (their centres agree on the frames both matched; the boxes may be drawn at different times). Without
 * enough frames in common, their element boxes must share half of the smaller one (a bad automatic box around the
 * whole picture holds the right one).
 */
export function sameTrackedMove(a: TrackedMove, b: TrackedMove): boolean {
  const window = (t: TrackedMove) => t.requested ?? t.window;
  const box = (t: TrackedMove) => t.element?.box;
  const ba = box(a);
  const bb = box(b);
  if (!ba || !bb || ![ba.x, ba.y, ba.w, ba.h, bb.x, bb.y, bb.w, bb.h].every(Number.isFinite)) return false;
  const wa = window(a);
  const wb = window(b);
  const timeShared = (wa && wb && overlap(wa, wb) >= 0.5) || (a.end > a.start && b.end > b.start && overlap(a, b) >= 0.5);
  if (!timeShared) return false;
  return sameTrajectory(a, b, Math.min(ba.w, ba.h, bb.w, bb.h)) ?? boxShare(ba, bb) >= 0.5;
}

/**
 * The tracks that stand for their moves: when one element and window was tracked more than once (an automatic pick,
 * then a box), the best-graded track wins, and the newest of equally good ones. `replacedBy` names the winner of every
 * track left out.
 */
export function preferredTracks(tracks: TrackedMove[]): { kept: TrackedMove[]; replacedBy: Map<string, string> } {
  const list = tracks.filter((t) => t && typeof t === "object" && Array.isArray(t.properties));
  const replacedBy = new Map<string, string>();
  const kept: TrackedMove[] = [];
  // Best first: each track then only has to look at the ones already kept.
  const order = [...list].sort((a, b) => (betterTrack(a, b) ? -1 : betterTrack(b, a) ? 1 : 0));
  for (const t of order) {
    const winner = kept.find((k) => sameTrackedMove(k, t));
    if (winner) replacedBy.set(String(t.id), String(winner.id));
    else kept.push(t);
  }
  return { kept: list.filter((t) => kept.includes(t)), replacedBy };
}

/**
 * The style move a track refines: the one it overlaps most (at least half), preferring the one it names. A stored
 * number alone is not enough: re-running `style` on another range renumbers the moves.
 */
export function matchEvent(spec: Pick<MotionSpec, "events">, track: Pick<TrackedMove, "start" | "end" | "move">): number | undefined {
  const named = track.move ? spec.events[track.move - 1] : undefined;
  if (named && overlap(named, track) >= 0.5) return track.move! - 1;
  let best: { index: number; share: number } | undefined;
  spec.events.forEach((e, index) => {
    const share = overlap(e, track);
    if (share >= 0.5 && (!best || share > best.share)) best = { index, share };
  });
  return best?.index;
}

/**
 * Puts the tracks into the spec and gives every style move a tracked curve where one exists: its easing family and
 * its suggestion become the fitted curve's, and `track` names the track it came from. A move tracked more than once
 * takes the best-graded, newest track.
 */
export function linkTracks(spec: MotionSpec, tracks: TrackedMove[]): MotionSpec {
  spec.tracks = tracks;
  for (const e of spec.events) {
    delete e.track;
    delete e.curve;
  }
  const chosen = new Map<number, TrackedMove>();
  for (const track of preferredTracks(tracks).kept) {
    // Only curves good enough to export reach the style moves (and through them every exporter).
    if (trackGrade(track) > 1) continue;
    const index = matchEvent(spec, track);
    if (index === undefined) continue;
    const current = chosen.get(index);
    if (!current || betterTrack(track, current)) chosen.set(index, track);
  }
  for (const [index, track] of chosen) {
    const curve = safeCurve(primaryCurve(track)!.curve)!;
    const event = spec.events[index]!;
    event.track = track.id;
    event.curve = cssEasing(curve);
    event.easing = curveFamily(curve);
    event.suggestion = event.curve;
  }
  return spec;
}

import type { MotionSpec } from "../style/spec.js";
import { cssEasing, curveFamily, safeCurve } from "./curve.js";
import { primaryCurve, type TrackedMove } from "./run.js";

/** Overlap of two time spans as a share of the shorter one. */
function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.max(1e-6, Math.min(a.end - a.start, b.end - b.start));
  return shared / shorter;
}

/** The style move a track refines: the one it names, else the one it overlaps most (at least half). */
export function matchEvent(spec: Pick<MotionSpec, "events">, track: Pick<TrackedMove, "start" | "end" | "move">): number | undefined {
  if (track.move && spec.events[track.move - 1]) return track.move - 1;
  let best: { index: number; share: number } | undefined;
  spec.events.forEach((e, index) => {
    const share = overlap(e, track);
    if (share >= 0.5 && (!best || share > best.share)) best = { index, share };
  });
  return best?.index;
}

/**
 * Puts the tracks into the spec and gives every style move a tracked curve where one exists: its easing family and
 * its suggestion become the fitted curve's, and `track` names the track it came from.
 */
export function linkTracks(spec: MotionSpec, tracks: TrackedMove[]): MotionSpec {
  spec.tracks = tracks;
  for (const e of spec.events) {
    delete e.track;
    delete e.curve;
  }
  for (const track of tracks) {
    const primary = primaryCurve(track);
    const curve = primary && safeCurve(primary.curve);
    if (!curve) continue;
    const index = matchEvent(spec, track);
    if (index === undefined) continue;
    const event = spec.events[index]!;
    event.track = track.id;
    event.curve = cssEasing(curve);
    event.easing = curveFamily(curve);
    event.suggestion = event.curve;
  }
  return spec;
}

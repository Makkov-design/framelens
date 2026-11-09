/**
 * Transitions between shots, read from every frame of a range as tiny pictures (see `motionProfile`):
 *
 * - a dissolve (cross-fade): every frame between the two pictures is a blend of them;
 * - a fade out to black or white, a fade in from it, or a dip (out, then in, through the colour): the same blend,
 *   with one side a flat black or white frame;
 * - a wipe: every frame is part one picture, part the other, split by an edge that travels across the frame.
 *
 * Cuts are found elsewhere (`classifyChanges`); a push (the new picture sliding the old one out) is not told apart
 * from a move.
 */
import { easingFromProfile, type EasingFamily, type PictureFrames } from "./motion.js";

export type TransitionKind = "cut" | "dissolve" | "fade-in" | "fade-out" | "dip" | "wipe";
export type Via = "black" | "white";

export interface Transition {
  kind: TransitionKind;
  /** The last frame of the outgoing picture (for a cut, the cut frame). */
  start: number;
  /** The first frame of the incoming picture (for a cut, the cut frame). */
  end: number;
  /** Frames the change takes: 0 for a cut. */
  frames: number;
  /** Where the shot boundary goes: the cut frame, a dissolve's or wipe's halfway frame, a fade's black or white frame. */
  at: number;
  /** The colour a fade or dip goes through. */
  via?: Via;
  /** A dip: the first and last frame that are entirely the colour. */
  hold?: { start: number; end: number };
  /** Where a wipe's edge travels. */
  direction?: "left" | "right" | "up" | "down";
  /** How the blend progresses (from the share of the new picture on each frame). */
  easing?: EasingFamily;
  /** How far the frames are from the model (a blend of the two pictures, or a wipe between them), 0 = exact. */
  fit?: number;
}

export interface TransitionOptions {
  /** Shortest gradual transition, in frames; shorter ones read as cuts. */
  minFrames?: number;
  /** Longest black or white hold between a fade out and a fade in that still makes one dip. */
  maxHoldSeconds?: number;
  /** Frames (times) that are cuts: no transition spans one. */
  cuts?: number[];
  /** Windows where the picture keeps changing (moves): candidates for wipes. */
  windows?: { start: number; end: number }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

const median = (xs: ArrayLike<number>): number => {
  const s = Array.from(xs).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Pixel access on the tiny frames. */
class Frames {
  readonly size: number;
  readonly pixels: number;
  constructor(readonly f: PictureFrames) {
    this.pixels = f.width * f.height;
    this.size = this.pixels * 3;
  }
  get count(): number {
    return this.f.times.length;
  }
  frame(k: number): Uint8Array {
    return this.f.data.subarray(k * this.size, (k + 1) * this.size);
  }
  time(k: number): number {
    return this.f.times[k]!;
  }
  /** Mean absolute difference of two frames, 0–1. */
  difference(a: number, b: number): number {
    const x = this.frame(a);
    const y = this.frame(b);
    let sum = 0;
    for (let i = 0; i < this.size; i++) sum += Math.abs(x[i]! - y[i]!);
    return sum / this.size / 255;
  }
  /** Cosine between the changes into frames k and j (each from its previous frame). */
  coherence(k: number, j: number): number {
    const a1 = this.frame(k);
    const a0 = this.frame(k - 1);
    const b1 = this.frame(j);
    const b0 = this.frame(j - 1);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < this.size; i++) {
      const da = a1[i]! - a0[i]!;
      const db = b1[i]! - b0[i]!;
      dot += da * db;
      na += da * da;
      nb += db * db;
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }
  /** Mean luma (0–1) and its spread over the frame. */
  luma(k: number): { mean: number; sd: number } {
    const x = this.frame(k);
    let sum = 0;
    let sq = 0;
    for (let p = 0; p < this.pixels; p++) {
      const y = (0.2126 * x[p * 3]! + 0.7152 * x[p * 3 + 1]! + 0.0722 * x[p * 3 + 2]!) / 255;
      sum += y;
      sq += y * y;
    }
    const mean = sum / this.pixels;
    return { mean, sd: Math.sqrt(Math.max(0, sq / this.pixels - mean * mean)) };
  }
  /** A flat black or white frame (a fade's end), or undefined. Title cards with text are not flat. */
  flat(k: number): Via | undefined {
    const { mean, sd } = this.luma(k);
    if (sd > 0.03) return undefined;
    if (mean <= 0.08) return "black";
    if (mean >= 0.9) return "white";
    return undefined;
  }
}

/** Blend model: how well frames a+1..b-1 are mixes of frame a and frame b, and the share of b in each. */
function blendFit(fr: Frames, a: number, b: number): { alphas: number[]; residuals: number[] } {
  const A = fr.frame(a);
  const B = fr.frame(b);
  let norm = 0;
  for (let i = 0; i < fr.size; i++) norm += (B[i]! - A[i]!) ** 2;
  const alphas: number[] = [];
  const residuals: number[] = [];
  for (let k = a + 1; k < b; k++) {
    const F = fr.frame(k);
    let dot = 0;
    for (let i = 0; i < fr.size; i++) dot += (F[i]! - A[i]!) * (B[i]! - A[i]!);
    const alpha = norm ? dot / norm : 0;
    let r = 0;
    for (let i = 0; i < fr.size; i++) r += (F[i]! - A[i]! - alpha * (B[i]! - A[i]!)) ** 2;
    alphas.push(alpha);
    residuals.push(norm ? Math.sqrt(r / norm) : 1);
  }
  return { alphas, residuals };
}

/** Share of pixels that change clearly between two frames: a shot change touches most of the picture. */
function changedShare(fr: Frames, a: number, b: number, threshold = 25): number {
  const A = fr.frame(a);
  const B = fr.frame(b);
  let changed = 0;
  for (let p = 0; p < fr.pixels; p++) {
    const d = Math.max(Math.abs(A[p * 3]! - B[p * 3]!), Math.abs(A[p * 3 + 1]! - B[p * 3 + 1]!), Math.abs(A[p * 3 + 2]! - B[p * 3 + 2]!));
    if (d > threshold) changed++;
  }
  return changed / fr.pixels;
}

/**
 * Whether b is a's picture lit brighter or darker: both have detail, and it is the same detail (the two frames are
 * strongly correlated). A lighting change, not a new shot.
 */
function sameLit(fr: Frames, a: number, b: number): boolean {
  const A = fr.frame(a);
  const B = fr.frame(b);
  const n = fr.size;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    sa += A[i]!;
    sb += B[i]!;
    saa += A[i]! * A[i]!;
    sbb += B[i]! * B[i]!;
    sab += A[i]! * B[i]!;
  }
  const varA = saa / n - (sa / n) ** 2;
  const varB = sbb / n - (sb / n) ** 2;
  // A flat frame has no detail to compare.
  if (Math.sqrt(varA) < 8 || Math.sqrt(varB) < 8) return false;
  return (sab / n - (sa / n) * (sb / n)) / Math.sqrt(varA * varB) >= 0.9;
}

/**
 * Whether b is a's picture moved a little (shifted up to two pixels or zoomed up to 8 %): over a few tiny pixels a slow
 * pan or zoom looks like a blend of its ends, but it is a move.
 */
function movedPicture(fr: Frames, a: number, b: number): boolean {
  const { width: w, height: h } = fr.f;
  const A = fr.frame(a);
  const B = fr.frame(b);
  const border = 3;
  const cost = (sample: (x: number, y: number) => number | undefined): number => {
    let sum = 0;
    let count = 0;
    for (let y = border; y < h - border; y++) {
      for (let x = border; x < w - border; x++) {
        const q = sample(x, y);
        if (q === undefined) continue;
        const p = (y * w + x) * 3;
        sum += Math.abs(B[p]! - A[q]!) + Math.abs(B[p + 1]! - A[q + 1]!) + Math.abs(B[p + 2]! - A[q + 2]!);
        count++;
      }
    }
    return count ? sum / count : Infinity;
  };
  const at = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h ? (y * w + x) * 3 : undefined);
  const still = cost((x, y) => at(x, y));
  if (!still) return false;
  let best = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) best = Math.min(best, cost((x, y) => at(x + dx, y + dy)));
  for (const s of [0.92, 0.96, 1.04, 1.08]) best = Math.min(best, cost((x, y) => at(Math.round((x - w / 2) / s + w / 2), Math.round((y - h / 2) / s + h / 2))));
  return best < still * 0.6;
}

/** The easing of a blend from the share of the new picture on each frame. */
function blendEasing(alphas: number[]): EasingFamily {
  const steps = [...alphas, 1].map((v, i, all) => Math.max(0, v - (i ? all[i - 1]! : 0)));
  return easingFromProfile(steps).easing;
}

interface Candidate {
  kind: "dissolve" | "fade-in" | "fade-out" | "wipe";
  /** Frame indices of the outgoing and incoming pictures. */
  a: number;
  b: number;
  at: number;
  via?: Via;
  direction?: Transition["direction"];
  easing?: EasingFamily;
  fit: number;
}

/**
 * A run of changing frames can start or end with frames of ordinary motion next to the blend. Frames at either end
 * that barely move towards the other picture (under a quarter of the average step) are not part of the transition.
 */
function trimBlend(fr: Frames, a: number, b: number, minSteps: number): [number, number] {
  for (let guard = 0; guard < 30 && b - a > minSteps; guard++) {
    const { alphas } = blendFit(fr, a, b);
    const step = 1 / (b - a);
    if (alphas[0]! < 0.25 * step) a++;
    else if (1 - alphas.at(-1)! < 0.25 * step) b--;
    else break;
  }
  return [a, b];
}

/** Frames a+1..b-1 as a blend of a and b: a dissolve or a fade, or undefined. */
function blendCandidate(fr: Frames, a: number, b: number): Candidate | undefined {
  if (fr.difference(a, b) < 0.04 || changedShare(fr, a, b) < 0.4) return undefined;
  const { alphas, residuals } = blendFit(fr, a, b);
  if (!alphas.length) return undefined;
  const fit = median(residuals);
  if (fit > 0.3 || Math.max(...residuals) > 0.6) return undefined;
  // One frame between the two pictures: it must be a real mix of them.
  if (alphas.length === 1 && (alphas[0]! < 0.1 || alphas[0]! > 0.9)) return undefined;
  if (alphas.length > 1 && (alphas[0]! > 0.6 || alphas.at(-1)! < 0.4)) return undefined;
  if (alphas.some((v) => v < -0.2 || v > 1.2)) return undefined;
  if (alphas.some((v, i) => i > 0 && v < alphas[i - 1]! - 0.1)) return undefined;
  const from = fr.flat(a);
  const to = fr.flat(b);
  const easing = blendEasing(alphas);
  if (to && !from) return { kind: "fade-out", a, b, at: b, via: to, easing, fit };
  if (from && !to) return { kind: "fade-in", a, b, at: a, via: from, easing, fit };
  if (!from && !to && (sameLit(fr, a, b) || movedPicture(fr, a, b))) return undefined;
  const half = alphas.findIndex((v) => v >= 0.5);
  return { kind: "dissolve", a, b, at: half >= 0 ? a + 1 + half : b, easing, fit };
}

/**
 * Frames a+1..b-1 as a wipe from a to b: each pixel is one picture or the other, the new picture's region grows, and
 * a straight edge (vertical or horizontal) separates them on every frame.
 */
function wipeCandidate(fr: Frames, a: number, b: number): Candidate | undefined {
  if (b - a < 3 || fr.difference(a, b) < 0.06 || changedShare(fr, a, b) < 0.6) return undefined;
  const { width: w, height: h } = fr.f;
  const A = fr.frame(a);
  const B = fr.frame(b);
  const strong: number[] = [];
  for (let p = 0; p < fr.pixels; p++) {
    const d = Math.abs(A[p * 3]! - B[p * 3]!) + Math.abs(A[p * 3 + 1]! - B[p * 3 + 1]!) + Math.abs(A[p * 3 + 2]! - B[p * 3 + 2]!);
    if (d > 60) strong.push(p);
  }
  if (strong.length < fr.pixels * 0.4) return undefined;
  const shares: number[] = [];
  const residuals: number[] = [];
  const directions: string[] = [];
  for (let k = a + 1; k < b; k++) {
    const F = fr.frame(k);
    const isNew = new Uint8Array(fr.pixels);
    let residual = 0;
    let span = 0;
    let fresh = 0;
    for (const p of strong) {
      const toA = Math.abs(F[p * 3]! - A[p * 3]!) + Math.abs(F[p * 3 + 1]! - A[p * 3 + 1]!) + Math.abs(F[p * 3 + 2]! - A[p * 3 + 2]!);
      const toB = Math.abs(F[p * 3]! - B[p * 3]!) + Math.abs(F[p * 3 + 1]! - B[p * 3 + 1]!) + Math.abs(F[p * 3 + 2]! - B[p * 3 + 2]!);
      residual += Math.min(toA, toB);
      span += toA + toB;
      if (toB < toA) {
        isNew[p] = 1;
        fresh++;
      }
    }
    residuals.push(span ? residual / (span / 2) : 1);
    const share = fresh / strong.length;
    shares.push(share);
    // Nearly all old or all new: no edge to read yet.
    if (share < 0.1 || share > 0.9) continue;
    // The best straight edge: for each axis and side, the threshold that agrees with most labels.
    let best = { agree: 0, direction: "" };
    for (const axis of ["x", "y"] as const) {
      const n = axis === "x" ? w : h;
      const newAt = new Array<number>(n).fill(0);
      const allAt = new Array<number>(n).fill(0);
      for (const p of strong) {
        const c = axis === "x" ? p % w : Math.floor(p / w);
        allAt[c]!++;
        newAt[c]! += isNew[p]!;
      }
      // New picture on the low side (edge moving towards high coordinates) or on the high side.
      let newBelow = 0;
      let allBelow = 0;
      const totalNew = newAt.reduce((s, v) => s + v, 0);
      for (let c = 0; c <= n; c++) {
        const lowSide = newBelow + (strong.length - allBelow - (totalNew - newBelow));
        const highSide = allBelow - newBelow + (totalNew - newBelow);
        if (lowSide > best.agree) best = { agree: lowSide, direction: axis === "x" ? "right" : "down" };
        if (highSide > best.agree) best = { agree: highSide, direction: axis === "x" ? "left" : "up" };
        if (c < n) {
          newBelow += newAt[c]!;
          allBelow += allAt[c]!;
        }
      }
    }
    if (best.agree < strong.length * 0.9) return undefined;
    directions.push(best.direction);
  }
  const fit = median(residuals);
  if (fit > 0.25 || !directions.length) return undefined;
  // Mixed frames (not blends) that grow from the old picture to the new one, always split the same way.
  if (shares[0]! > 0.6 || shares.at(-1)! < 0.4 || shares.some((v, i) => i > 0 && v < shares[i - 1]! - 0.05)) return undefined;
  const direction = [...new Set(directions)].sort((x, y) => directions.filter((d) => d === y).length - directions.filter((d) => d === x).length)[0]!;
  if (directions.filter((d) => d === direction).length < directions.length * 0.8) return undefined;
  const half = shares.findIndex((v) => v >= 0.5);
  // The window may hold still or moving frames of either picture around the wipe: the wipe is where the edge travels,
  // the frames around the halfway one over which the new picture's share keeps growing.
  const middle = Math.max(0, half);
  let first = middle;
  while (first > 0 && shares[first - 1]! < shares[first]! - 0.005 && shares[first - 1]! > 0.01) first--;
  let last = middle;
  while (last < shares.length - 1 && shares[last + 1]! > shares[last]! + 0.005 && shares[last + 1]! < 0.99) last++;
  return {
    kind: "wipe",
    a: a + first,
    b: a + last + 2,
    at: half >= 0 ? a + 1 + half : b,
    direction: direction as Transition["direction"],
    easing: blendEasing(shares),
    fit: Math.round(fit * 1000) / 1000,
  };
}

/**
 * Gradual transitions in a range of tiny frames. Dissolves and fades are found as runs of frames whose changes lean the
 * same way (each frame's change correlates with the next one's), trimmed of plain motion at their ends and checked
 * against the blend model; wipes are checked in the given windows. Results are in time order and do not overlap.
 */
export function detectTransitions(frames: PictureFrames, fps: number, options: TransitionOptions = {}): Transition[] {
  const fr = new Frames(frames);
  const n = fr.count;
  if (n < 4 || frames.data.length < n * fr.size) return [];
  const minFrames = options.minFrames ?? 3;
  const frameTime = 1 / fps;
  const cutAt = (k: number) => (options.cuts ?? []).some((c) => Math.abs(c - fr.time(k)) <= frameTime / 2);

  const change = new Float64Array(n);
  for (let k = 1; k < n; k++) change[k] = fr.difference(k, k - 1);
  // The noise floor from the quieter frames (a transition-heavy piece can change on half of its frames).
  const quiet = Array.from(change.subarray(1)).sort((x, y) => x - y);
  const floor = Math.max(0.004, 3 * (quiet[Math.floor(quiet.length * 0.2)] ?? 0));
  const active = (k: number) => k > 0 && k < n && change[k]! > floor && !cutAt(k);

  const candidates: Candidate[] = [];
  // Runs of frames whose changes lean the same way (one quiet frame, such as a repeated frame, may sit inside). The
  // bar is low because motion inside the two shots adds its own changes to a dissolve's; the blend model decides.
  for (let k = 1; k < n; ) {
    if (!active(k)) {
      k++;
      continue;
    }
    let last = k;
    for (;;) {
      let j = last + 1;
      if (j < n && !active(j) && !cutAt(j)) j++;
      if (!active(j) || fr.coherence(last, j) < 0.3) break;
      last = j;
    }
    // A fade into or out of a flat frame is unmistakable from two frames on; a dissolve needs `minFrames`.
    if (last - k + 1 >= Math.min(2, minFrames)) {
      const [a, b] = trimBlend(fr, k - 1, last, Math.min(2, minFrames));
      const found = blendCandidate(fr, a, b);
      if (found && (found.kind !== "dissolve" || b - a >= minFrames)) candidates.push(found);
    }
    k = last + 1;
  }

  // Wipes: in windows of continuous change (not already a blend), frames split between the two pictures.
  const index = (t: number) => {
    let best = 0;
    for (let k = 0; k < n; k++) if (Math.abs(fr.time(k) - t) < Math.abs(fr.time(best) - t)) best = k;
    return best;
  };
  for (const w of options.windows ?? []) {
    const a = index(w.start);
    const b = index(w.end);
    if (b - a < minFrames || candidates.some((c) => c.a < b && c.b > a)) continue;
    let crossesCut = false;
    for (let k = a + 1; k <= b; k++) if (cutAt(k)) crossesCut = true;
    if (crossesCut) continue;
    const found = wipeCandidate(fr, a, b);
    if (found) candidates.push(found);
  }
  candidates.sort((x, y) => x.a - y.a);

  // A fade out and a fade in through the same colour, with at most a short hold between them: one dip.
  const maxHold = Math.round((options.maxHoldSeconds ?? 0.5) * fps);
  const out: Transition[] = [];
  const time = (k: number) => r3(fr.time(k));
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const next = candidates[i + 1];
    if (c.kind === "fade-out" && next?.kind === "fade-in" && next.via === c.via && next.a >= c.b && next.a - c.b <= maxHold) {
      let flat = true;
      // The shot boundary is the hold's darkest (or brightest) frame.
      let extreme = c.b;
      const level = (k: number) => (c.via === "black" ? fr.luma(k).mean : 1 - fr.luma(k).mean);
      for (let k = c.b; k <= next.a; k++) {
        if (fr.flat(k) !== c.via) flat = false;
        if (level(k) < level(extreme) - 1e-6) extreme = k;
      }
      if (flat) {
        out.push({
          kind: "dip",
          start: time(c.a),
          end: time(next.b),
          frames: next.b - c.a,
          at: time(extreme),
          via: c.via!,
          hold: { start: time(c.b), end: time(next.a) },
          fit: Math.round(Math.max(c.fit, next.fit) * 1000) / 1000,
        });
        i++;
        continue;
      }
    }
    out.push({
      kind: c.kind,
      start: time(c.a),
      end: time(c.b),
      frames: c.b - c.a,
      at: time(c.at),
      ...(c.via && { via: c.via }),
      ...(c.direction && { direction: c.direction }),
      ...(c.easing && c.easing !== "unclear" && { easing: c.easing }),
      fit: Math.round(c.fit * 1000) / 1000,
    });
  }
  return out;
}

/**
 * Moves whose picture never gets away from where it started (compression noise or grain on a still shot that happens
 * to score above the threshold) are left out: some frame of a real move differs visibly from the move's first frame.
 */
export function visibleMoves<T extends { start: number; end: number }>(events: T[], frames: PictureFrames, minimum = 0.004): T[] {
  const fr = new Frames(frames);
  const n = fr.count;
  if (n < 2 || frames.data.length < n * fr.size) return events;
  const index = (t: number) => {
    let best = 0;
    for (let k = 0; k < n; k++) if (Math.abs(fr.time(k) - t) < Math.abs(fr.time(best) - t)) best = k;
    return best;
  };
  return events.filter((e) => {
    const a = index(e.start);
    const b = index(e.end);
    if (b <= a) return true;
    let most = 0;
    for (let k = a + 1; k <= b; k++) most = Math.max(most, fr.difference(a, k));
    return most >= minimum;
  });
}

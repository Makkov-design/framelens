import type { MotionSpec } from "../style/spec.js";
import { moveBezier, moveKeys, r3, referenceNotes, scenesFromSpec, write, type SceneMove } from "./exporters.js";

const r4 = (n: number) => Math.round(n * 10000) / 10000;

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => r4(parseInt(full.slice(i, i + 2), 16) / 255)) as [number, number, number];
}

const transform = (position: unknown, opacity: unknown) => ({
  o: opacity,
  r: { a: 0, k: 0 },
  p: position,
  a: { a: 0, k: [0, 0, 0] },
  s: { a: 0, k: [100, 100, 100] },
});

/**
 * Two keyframes with a cubic-bezier. In Lottie `o` is the outgoing handle of a keyframe and `i` the incoming handle of
 * the next one, both in the same (x, y) space as CSS cubic-bezier(x1, y1, x2, y2): o = (x1, y1), i = (x2, y2).
 */
function animated(t0: number, t1: number, from: number[], to: number[], b: readonly [number, number, number, number]) {
  return {
    a: 1,
    k: [
      { t: t0, s: from, o: { x: [b[0]], y: [b[1]] }, i: { x: [b[2]], y: [b[3]] } },
      { t: t1, s: to },
    ],
  };
}

/**
 * Keyframes for a tracked spring or steps: one per sample, straight between them (linear handles), or held (`h: 1`)
 * for steps. `keys` are [frame, progress] pairs; values go from `from` to `to`.
 */
function sampledAnimated(keys: [number, number][], hold: boolean, from: number[], to: number[]) {
  const value = (p: number) => from.map((v, i) => r3(v + (to[i]! - v) * p));
  const frames = keys.filter((k, i) => i === 0 || k[0] > keys[i - 1]![0]);
  return {
    a: 1,
    k: frames.map(([t, p], i) => (i === frames.length - 1 ? { t, s: value(p) } : hold ? { t, s: value(p), h: 1 } : { t, s: value(p), o: { x: [0], y: [0] }, i: { x: [1], y: [1] } })),
  };
}

/** A Bodymovin 5.x document: a solid and a rectangle placeholder per measured shot. */
export function lottieDocument(spec: MotionSpec) {
  const fps = spec.timebase.fps ?? 30;
  const width = spec.timebase.width ?? 1920;
  const height = spec.timebase.height ?? 1080;
  const frame = (seconds: number) => Math.round(seconds * fps);
  const travel = Math.round((60 * height) / 1080);
  const scenes = scenesFromSpec(spec);

  const shapes: object[] = [];
  const solids: object[] = [];
  scenes.forEach((s, n) => {
    const ip = frame(s.start);
    const op = Math.max(ip + 1, frame(s.start + s.duration));
    const move: SceneMove = s.move ?? { offset: Math.min(0.2, s.duration / 4), seconds: 0.2, easing: "ease-out" };
    const t0 = Math.min(op - 1, ip + frame(move.offset));
    const t1 = Math.min(op, Math.max(t0 + 1, t0 + frame(move.seconds)));
    const bezier = moveBezier(move);
    const sampled = bezier ? undefined : moveKeys(move, fps);
    const keys = sampled?.keys.map(([u, p]) => [Math.round(t0 + u * (t1 - t0)), p] as [number, number]);
    const position = (from: number[], to: number[]) => (bezier ? animated(t0, t1, from, to, bezier) : sampledAnimated(keys!, sampled!.hold, from, to));
    shapes.push({
      ddd: 0,
      ind: n * 2 + 1,
      ty: 4,
      nm: `${s.id} title placeholder`,
      sr: 1,
      ks: transform(position([width / 2, height / 2 + travel, 0], [width / 2, height / 2, 0]), position([0], [100])),
      ao: 0,
      shapes: [
        {
          ty: "gr",
          nm: "Placeholder",
          it: [
            { ty: "rc", nm: "Rectangle", d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [r3(width * 0.5), r3(height * 0.14)] }, r: { a: 0, k: 0 } },
            { ty: "fl", nm: "Accent", c: { a: 0, k: [...rgb(s.accent), 1] }, o: { a: 0, k: 100 }, r: 1 },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip,
      op,
      st: 0,
      bm: 0,
    });
    solids.push({
      ddd: 0,
      ind: n * 2 + 2,
      ty: 1,
      nm: `${s.id} background`,
      sr: 1,
      ks: transform({ a: 0, k: [width / 2, height / 2, 0] }, { a: 0, k: 100 }),
      ao: 0,
      sw: width,
      sh: height,
      sc: s.background,
      ip,
      op,
      st: 0,
      bm: 0,
    });
  });

  const last = Math.max(...scenes.map((s) => frame(s.start + s.duration)), frame(spec.range.end - spec.range.start));
  return {
    v: "5.7.4",
    fr: fps,
    ip: 0,
    op: last,
    w: width,
    h: height,
    nm: spec.source.title ?? "Frame Lens reference",
    ddd: 0,
    assets: [],
    // Lottie draws the first layer on top: placeholders over backgrounds.
    layers: [...shapes, ...solids],
    markers: [],
  };
}

export function exportLottie(spec: MotionSpec, root: string): string[] {
  return write(root, {
    "reference.json": `${JSON.stringify(lottieDocument(spec), null, 2)}\n`,
    "REFERENCE.md": `${referenceNotes(spec, "Lottie (open reference.json in lottiefiles.com, lottie-web or After Effects with Bodymovin)")}
## What is in reference.json

- Bodymovin 5.x document at ${spec.timebase.fps ?? 30} fps; times are frames. One solid layer (\`ty: 1\`, \`sc\` colour) per shot with its in and out frame.
- One shape layer per shot with a rectangle placeholder. Its position and opacity keyframes carry the first move's timing; the easing is written as \`o\` and \`i\` handles, equal to the CSS cubic-bezier(x1, y1, x2, y2) as \`o\` = (x1, y1) and \`i\` = (x2, y2).
- Layers are listed top-first: placeholders above backgrounds.
- Moves measured with Frame Lens \`track\` use their fitted curve: a cubic-bezier as the handles above, a spring as a keyframe on every frame with straight handles, steps as held keyframes (\`h: 1\`).
- Replace the placeholder rectangles with your own shapes or text layers; keep the in and out frames and the easing.
`,
  });
}

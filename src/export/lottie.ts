import type { MotionSpec } from "../style/spec.js";
import { BEZIER, moveBezier, moveKeys, r3, referenceNotes, scenesFromSpec, VIA_HEX, write, type SceneFade, type SceneMove } from "./exporters.js";

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

/** A Bodymovin 5.x document: a solid and a rectangle placeholder per shot. */
export function lottieDocument(spec: MotionSpec) {
  const fps = spec.timebase.fps ?? 30;
  const width = spec.timebase.width ?? 1920;
  const height = spec.timebase.height ?? 1080;
  const frame = (seconds: number) => Math.round(seconds * fps);
  const travel = Math.round((60 * height) / 1080);
  const scenes = scenesFromSpec(spec);

  const shapes: object[] = [];
  const solids: object[] = [];
  const veils: object[] = [];
  const still = (value: number[]) => ({ a: 0, k: value.length === 1 ? value[0] : value });
  scenes.forEach((s, n) => {
    // The layers live while the scene is on screen: from the start of a dissolve into it to the end of one out of it.
    const ip = frame(s.show.start);
    const op = Math.max(ip + 1, frame(s.show.end));
    // A dissolve (derived; a wipe is drawn as a dissolve here): the incoming scene's opacity ramps up over it.
    const revealed = s.reveal && animated(frame(s.reveal.start), Math.max(frame(s.reveal.start) + 1, frame(s.reveal.start + s.reveal.seconds)), [0], [100], BEZIER[s.reveal.easing]);
    const move: SceneMove | undefined = s.move;
    let ks: ReturnType<typeof transform>;
    if (move) {
      const shotEnd = Math.max(ip + 1, frame(s.start + s.duration));
      const t0 = Math.min(shotEnd - 1, frame(s.start) + frame(move.offset));
      // A tracked move keeps its measured length past the layer's out point (which still trims it): squeezing it into
      // the shot would play it faster than measured.
      const t1 = move.curve ? Math.max(t0 + 1, t0 + frame(move.seconds)) : Math.min(shotEnd, Math.max(t0 + 1, t0 + frame(move.seconds)));
      const bezier = moveBezier(move);
      const sampled = bezier ? undefined : moveKeys(move, fps);
      const keys = sampled?.keys.map(([u, p]) => [Math.round(t0 + u * (t1 - t0)), p] as [number, number]);
      const position = (from: number[], to: number[]) => (bezier ? animated(t0, t1, from, to, bezier) : sampledAnimated(keys!, sampled!.hold, from, to));
      ks = transform(position([width / 2, height / 2 + travel, 0], [width / 2, height / 2, 0]), position([0], [100]));
    } else {
      // No move found: the placeholder holds still, coming in only with its scene.
      ks = transform(still([width / 2, height / 2, 0]), revealed ?? still([100]));
    }
    for (const [fade, from, to, start, end] of [
      [s.fadeIn, 100, 0, ip, s.fadeIn && frame(s.fadeIn.start + s.fadeIn.seconds)],
      [s.fadeOut, 0, 100, s.fadeOut && frame(s.fadeOut.start), op],
    ] as [SceneFade | undefined, number, number, number, number][]) {
      if (!fade) continue;
      const k0 = frame(fade.start);
      veils.push({
        ddd: 0,
        ty: 1,
        nm: `${s.id} ${from > to ? `fade in from ${fade.via}` : `fade out to ${fade.via}`}`,
        sr: 1,
        ks: transform({ a: 0, k: [width / 2, height / 2, 0] }, animated(k0, Math.max(k0 + 1, frame(fade.start + fade.seconds)), [from], [to], BEZIER[fade.easing])),
        ao: 0,
        sw: width,
        sh: height,
        sc: VIA_HEX[fade.via],
        ip: Math.min(start, k0),
        op: Math.max(end, k0 + 1),
        st: 0,
        bm: 0,
      });
    }
    shapes.push({
      ddd: 0,
      ind: n * 2 + 1,
      ty: 4,
      nm: `${s.id} title placeholder`,
      sr: 1,
      ks,
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
      ks: transform({ a: 0, k: [width / 2, height / 2, 0] }, revealed ?? { a: 0, k: 100 }),
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
    // Lottie draws the first layer on top: fades over everything, later scenes over earlier ones (a dissolve brings
    // the incoming scene in over the outgoing one), each scene's placeholder over its background.
    layers: [...veils, ...shapes.map((shape, n) => [shape, solids[n]!]).reverse().flat()].map((layer, i) => ({ ...layer, ind: i + 1 })),
    markers: [],
  };
}

export function exportLottie(spec: MotionSpec, root: string): string[] {
  return write(root, {
    "reference.json": `${JSON.stringify(lottieDocument(spec), null, 2)}\n`,
    "REFERENCE.md": `${referenceNotes(spec, "Lottie (open reference.json in lottiefiles.com, lottie-web or After Effects with Bodymovin)")}
## What is in reference.json

- Bodymovin 5.x document at ${spec.timebase.fps ?? 30} fps; times are frames. One solid layer (\`ty: 1\`, \`sc\` colour) per shot with its in and out frame.
- One shape layer per shot with a rectangle placeholder. Where \`style\` found a move in the shot, its position and opacity keyframes carry that move's timing; the easing (a derived family, or a fitted curve when tracked) is written as \`o\` and \`i\` handles, equal to the CSS cubic-bezier(x1, y1, x2, y2) as \`o\` = (x1, y1) and \`i\` = (x2, y2). Without a move the placeholder holds still.
- Transitions (derived from the frames): a dissolve is an opacity ramp on the incoming shot's layers, which start with the dissolve and sit above the outgoing shot; a fade or dip is a black or white solid over the shot whose opacity covers or clears it. A wipe is drawn as a dissolve of the same length (its direction is in motion-spec.json); add a mask for its edge.
- Layers are listed top-first: fades, then later shots above earlier ones, each placeholder above its background.
- Moves measured with Frame Lens \`track\` use their fitted curve: a cubic-bezier as the handles above, a spring as a keyframe on every frame with straight handles, steps as held keyframes (\`h: 1\`).
- Replace the placeholder rectangles with your own shapes or text layers; keep the in and out frames and the easing.
`,
  });
}

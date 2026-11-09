import type { MotionSpec } from "../style/spec.js";
import { BEZIER, moveBezier, moveKeys, oneLine, r3, referenceNotes, scenesFromSpec, VIA_HEX, write, type SceneFade, type SceneMove } from "./exporters.js";

type Bezier = readonly [number, number, number, number];

export interface AeEase {
  outSpeed: number;
  outInfluence: number;
  inSpeed: number;
  inInfluence: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * cubic-bezier(x1, y1, x2, y2) to After Effects temporal ease for a move of `distance` units over `seconds`.
 *
 * AE keeps a speed (units per second) and an influence (0.1 to 100 percent of the segment's time) per keyframe handle.
 * The bezier handle from the first key to (x1, y1) gives the outgoing side: influence = x1 * 100, speed = slope at the
 * start = (y1 / x1) * average speed. The handle from the second key to (x2, y2) gives the incoming side:
 * influence = (1 - x2) * 100, speed = slope at the end = ((1 - y2) / (1 - x2)) * average speed.
 * So an ease-out such as (0.16, 1, 0.3, 1) leaves the first key fast (about 6x the average speed) and arrives at the
 * second key with speed 0 and a long, high incoming influence (70). A straight line (0, 0, 1, 1) maps to AE's
 * linear: average speed with 33.33 influence on both sides.
 */
export function bezierToAeEase(b: Bezier, distance: number, seconds: number): AeEase {
  const average = distance / Math.max(seconds, 0.001);
  const [x1, y1, x2, y2] = b;
  if (x1 === y1 && x2 === y2) return { outSpeed: r4(average), outInfluence: 33.3333, inSpeed: r4(average), inInfluence: 33.3333 };
  const ox = Math.max(x1, 0.001);
  const ix = Math.max(1 - x2, 0.001);
  return {
    outSpeed: r4((y1 / ox) * average),
    outInfluence: r4(clamp(x1 * 100, 0.1, 100)),
    inSpeed: r4(((1 - y2) / ix) * average),
    inInfluence: r4(clamp((1 - x2) * 100, 0.1, 100)),
  };
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => r4(parseInt(full.slice(i, i + 2), 16) / 255)) as [number, number, number];
}

/** The ExtendScript that builds the composition. Data is plain object literals; no ES5+ syntax is used. */
export function aeScript(spec: MotionSpec): string {
  const fps = spec.timebase.fps ?? 30;
  const width = spec.timebase.width ?? 1920;
  const height = spec.timebase.height ?? 1080;
  const total = r3(spec.range.end - spec.range.start);
  const travel = r3((60 * height) / 1080);
  const all = scenesFromSpec(spec);
  const scenes = all.map((s, i) => {
    // The layers live while the scene is on screen: from the start of a dissolve into it to the end of one out of it.
    const start = s.show.start;
    const end = s.show.end;
    // A dissolve or wipe (derived; a wipe is drawn as a dissolve here): the solid's opacity ramps up over it.
    const reveal = s.reveal && { keyStart: s.reveal.start, keyEnd: r3(s.reveal.start + s.reveal.seconds), ease: bezierToAeEase(BEZIER[s.reveal.easing], 100, s.reveal.seconds), ...(s.reveal.kind === "wipe" && { wipe: s.reveal.direction ?? "right" }) };
    const base = { name: `Shot ${i + 1}`, label: `SHOT ${i + 1}`, start, end, background: rgb(s.background), accent: rgb(s.accent), ...(reveal && { reveal }) };
    // No move found: the title holds still (no keyframes).
    const move: SceneMove | undefined = s.move;
    if (!move) return base;
    // A tracked move keeps its measured length even when it runs past the cut (the layer's out point still trims
    // it); squeezing it into the shot would play it faster than measured. A derived move stays inside the shot.
    const shotEnd = r3(s.start + s.duration);
    let keyStart = r3(s.start + move.offset);
    let keyEnd = move.curve ? r3(keyStart + move.seconds) : Math.min(shotEnd, r3(s.start + move.offset + move.seconds));
    if (keyEnd - keyStart < 1 / fps) keyStart = Math.max(s.start, r3(keyEnd - 1 / fps));
    keyEnd = r3(keyEnd);
    const seconds = Math.max(keyEnd - keyStart, 1 / fps);
    const bezier = moveBezier(move);
    // A spring or steps: a key on every frame (straight between them) or on every jump (held).
    const sampled = moveKeys({ ...move, seconds }, fps);
    return {
      ...base,
      keyStart,
      keyEnd,
      easing: move.easing,
      ...(move.track && { track: move.track }),
      ...(bezier
        ? { bezier, positionEase: bezierToAeEase(bezier, travel, seconds), opacityEase: bezierToAeEase(bezier, 100, seconds) }
        : { keys: sampled!.keys.map(([u, p]) => [r3(keyStart + u * seconds), p]), hold: sampled!.hold }),
    };
  });
  // A fade or dip (derived): a solid of the colour over the scene, whose opacity covers (out) or clears (in).
  const veils = all.flatMap((s, i) =>
    (
      [
        s.fadeIn && { fade: s.fadeIn, from: 100, to: 0, start: s.show.start, end: r3(s.fadeIn.start + s.fadeIn.seconds), what: `fade in from ${s.fadeIn.via}` },
        s.fadeOut && { fade: s.fadeOut, from: 0, to: 100, start: s.fadeOut.start, end: s.show.end, what: `fade out to ${s.fadeOut.via}` },
      ].filter(Boolean) as { fade: SceneFade; from: number; to: number; start: number; end: number; what: string }[]
    ).map((v) => ({
      name: `Shot ${i + 1} ${v.what}`,
      color: rgb(VIA_HEX[v.fade.via]),
      start: v.start,
      end: Math.max(v.end, r3(v.start + 1 / fps)),
      keyStart: v.fade.start,
      keyEnd: r3(v.fade.start + v.fade.seconds),
      from: v.from,
      to: v.to,
      // Signed: a veil that clears goes down, so its keyframe speeds are negative.
      ease: bezierToAeEase(BEZIER[v.fade.easing], v.to - v.from, v.fade.seconds),
    })),
  );

  const markers = new Map<number, string[]>();
  const mark = (t: number, label: string) => {
    const at = r3(t - spec.range.start);
    if (at < 0 || at > total) return;
    markers.set(at, [...(markers.get(at) ?? []), label]);
  };
  spec.anchors.cuts.forEach((c, i) => mark(c.t, `cut ${i + 1}`));
  spec.anchors.beats.forEach((b, i) => mark(b.t, b.downbeat ? `downbeat ${i + 1}` : `beat ${i + 1}`));
  (spec.audio.hits ?? []).forEach((h, i) => mark(h.t, `hit ${i + 1} (${h.strength.toFixed(2)})`));
  const markerList = [...markers.entries()].sort((a, b) => a[0] - b[0]).map(([t, labels]) => ({ t, label: labels.join(" + ") }));

  const json = (v: unknown) => JSON.stringify(v, null, 2);
  return `#target aftereffects
// Frame Lens reference: ${oneLine(spec.source.title ?? spec.source.input)}
// Generated by ${spec.generatedBy}. Run it from File > Scripts > Run Script File... in After Effects.
//
// Builds one composition: per shot a solid (trimmed to its in and out) with a placeholder text layer above it whose
// Position and Opacity keyframes enter with the timing of the shot's first move (still when no move was found),
// dissolves derived from the reference as opacity ramps of the incoming shot (wipes too: draw their edge with a mask
// or Linear Wipe), derived fades and dips as a black or white solid over the shot, and composition markers for every
// cut, beat and strong audio hit. Replace the placeholder text with your own content.
//
// Easing: each move is a CSS-style cubic-bezier(x1, y1, x2, y2) converted to KeyframeEase (speed, influence).
//   outgoing key: influence = x1 * 100, speed = (y1 / x1) * average speed
//   incoming key: influence = (1 - x2) * 100, speed = ((1 - y2) / (1 - x2)) * average speed
// Average speed is distance / seconds (60 px scaled to the frame height for Position, 100 percent for Opacity).
// An ease-out therefore leaves the first key fast and arrives at the second with speed 0 and a high incoming influence.
// Moves measured with Frame Lens \`track\` carry their fitted curve: a cubic-bezier becomes the two eased keys above, a
// spring becomes a key on every frame (\`keys\`, linear between them) and steps become held keys. The other moves use
// easing families derived from whole-picture motion; refine those in the Graph Editor.
(function () {
  var FPS = ${fps};
  var WIDTH = ${width};
  var HEIGHT = ${height};
  var DURATION = ${total};
  var TRAVEL = ${travel};
  var SCENES = ${json(scenes)};
  var VEILS = ${json(veils)};
  var MARKERS = ${json(markerList)};

  function ease(speed, influence) {
    return new KeyframeEase(speed, influence);
  }

  // Two keyframes, then the bezier handles: first key leaves with ease.outSpeed, second arrives with ease.inSpeed.
  function keyEase(prop, ease2) {
    var linear = ease(0, 33.3333);
    prop.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    prop.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    prop.setTemporalEaseAtKey(1, [linear], [ease(ease2.outSpeed, ease2.outInfluence)]);
    prop.setTemporalEaseAtKey(2, [ease(ease2.inSpeed, ease2.inInfluence)], [linear]);
  }

  // A key per sample of a tracked spring (linear between them) or per jump of steps (held).
  function sampledKeys(prop, keys, hold, value) {
    var k;
    for (k = 0; k < keys.length; k++) prop.setValueAtTime(keys[k][0], value(keys[k][1]));
    var type = hold ? KeyframeInterpolationType.HOLD : KeyframeInterpolationType.LINEAR;
    for (k = 1; k <= prop.numKeys; k++) prop.setInterpolationTypeAtKey(k, type, type);
  }

  // An opacity ramp: two eased keys from one value to another.
  function ramp(prop, keyStart, keyEnd, from, to, ease2) {
    prop.setValueAtTime(keyStart, from);
    prop.setValueAtTime(keyEnd, to);
    keyEase(prop, ease2);
  }

  var i;
  var s;
  var v;
  var layer;

  app.beginUndoGroup("Frame Lens reference");
  try {
    var comp = app.project.items.addComp("Frame Lens reference", WIDTH, HEIGHT, 1, DURATION, FPS);

    // Each shot's background, then its title above it; later shots are added later, so the whole shot sits above the
    // one before (new layers go on top): a dissolve fades the incoming shot in over the outgoing shot and its title.
    for (i = 0; i < SCENES.length; i++) {
      s = SCENES[i];
      layer = comp.layers.addSolid(s.background, s.name + " background", WIDTH, HEIGHT, 1, DURATION);
      layer.inPoint = s.start;
      layer.outPoint = s.end;
      if (s.reveal) ramp(layer.property("Opacity"), s.reveal.keyStart, s.reveal.keyEnd, 0, 100, s.reveal.ease);

      layer = comp.layers.addText(s.label);
      layer.name = s.name + " title";
      var sourceText = layer.property("Source Text");
      var doc = sourceText.value;
      doc.fontSize = Math.round(HEIGHT / 10);
      doc.fillColor = s.accent;
      doc.applyFill = true;
      doc.justification = ParagraphJustification.CENTER_JUSTIFY;
      sourceText.setValue(doc);
      layer.inPoint = s.start;
      layer.outPoint = s.end;

      var position = layer.property("Position");
      var opacity = layer.property("Opacity");
      if (s.keys) {
        sampledKeys(position, s.keys, s.hold, function (p) { return [WIDTH / 2, HEIGHT / 2 + TRAVEL * (1 - p)]; });
        sampledKeys(opacity, s.keys, s.hold, function (p) { return Math.max(0, Math.min(100, 100 * p)); });
      } else if (s.keyStart !== undefined) {
        position.setValueAtTime(s.keyStart, [WIDTH / 2, HEIGHT / 2 + TRAVEL]);
        position.setValueAtTime(s.keyEnd, [WIDTH / 2, HEIGHT / 2]);
        keyEase(position, s.positionEase);
        opacity.setValueAtTime(s.keyStart, 0);
        opacity.setValueAtTime(s.keyEnd, 100);
        keyEase(opacity, s.opacityEase);
      } else {
        // No move found: the title holds still (it only comes in with its shot when that dissolves in).
        position.setValue([WIDTH / 2, HEIGHT / 2]);
        if (s.reveal) ramp(opacity, s.reveal.keyStart, s.reveal.keyEnd, 0, 100, s.reveal.ease);
      }
    }

    for (i = 0; i < VEILS.length; i++) {
      v = VEILS[i];
      layer = comp.layers.addSolid(v.color, v.name, WIDTH, HEIGHT, 1, DURATION);
      layer.inPoint = v.start;
      layer.outPoint = v.end;
      ramp(layer.property("Opacity"), v.keyStart, v.keyEnd, v.from, v.to, v.ease);
    }

    for (i = 0; i < MARKERS.length; i++) {
      comp.markerProperty.setValueAtTime(MARKERS[i].t, new MarkerValue(MARKERS[i].label));
    }

    comp.openInViewer();
  } finally {
    app.endUndoGroup();
  }
})();
`;
}

export function exportAfterEffects(spec: MotionSpec, root: string): string[] {
  return write(root, {
    "framelens-reference.jsx": aeScript(spec),
    "REFERENCE.md": `${referenceNotes(spec, "After Effects")}
## Use in After Effects

1. Open After Effects, then **File → Scripts → Run Script File…** and choose \`framelens-reference.jsx\`.
2. No scripting preference needs to change: the script only builds a composition, it writes no files.
3. The composition "Frame Lens reference" appears with one solid and one placeholder text layer per shot, composition markers for cuts, beats and strong audio hits, and the whole build is one undo step.
4. Transitions (derived from the frames): a dissolve is an Opacity ramp on the incoming shot's background and title (each shot's title sits right above its background, and the incoming shot above the outgoing one, starting with the dissolve); a fade or dip is a black or white solid over the shot whose Opacity covers or clears it. A wipe is drawn as a dissolve of the same length (its direction is in motion-spec.json): add a mask or Linear Wipe for the edge. Shots where no move was found keep their title still.

Easing is converted from each move's cubic-bezier to keyframe speed and influence (see the comment at the top of the script). It has not been run in After Effects by Frame Lens itself; if a version of After Effects rejects a call, the error line points at the exact statement.
`,
  });
}

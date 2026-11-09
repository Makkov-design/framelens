import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSpec, scenesFromSpec } from "../../src/export/exporters.js";
import { lottieDocument } from "../../src/export/lottie.js";
import type { MotionSpec } from "../../src/style/spec.js";

/** Three shots: s1 dissolves into s2 (1.8–2.2 s), s2 dips through black into s3 (3.7–4.3 s). No move measured. */
function makeSpec(events: MotionSpec["events"] = []): MotionSpec {
  const shot = (id: string, start: number, end: number, palette: string[]) => ({ id, start, end, frames: Math.round((end - start) * 25), palette });
  return {
    spec: "framelens.motion/1",
    generatedBy: "framelens test",
    source: { kind: "file", input: "ref.mp4", title: "Ref" },
    range: { start: 0, end: 6 },
    timebase: { fps: 25, vfr: false, duration: 6, width: 1280, height: 720 },
    anchors: { words: [], beats: [], cuts: [] },
    changes: [],
    transitions: [
      { id: "x1", kind: "dissolve", start: 1.8, end: 2.2, frames: 10, at: 2, easing: "linear", evidence: "derived", from: "s1", to: "s2" },
      { id: "x2", kind: "dip", start: 3.7, end: 4.3, frames: 15, at: 4, via: "black", hold: { start: 4, end: 4 }, evidence: "derived", from: "s2", to: "s3" },
    ],
    palette: [{ hex: "#FFFFFF", share: 0.5, lightness: 1, chroma: 0, evidence: "measured" }],
    typography: [],
    shots: [shot("s1", 0, 2, ["#FFFFFF", "#1EA0E0"]), shot("s2", 2, 4, ["#434E43", "#677251"]), shot("s3", 4, 6, ["#FFFFFF", "#1EA0E0"])],
    systems: [],
    events,
    rhythm: { cuts: 0, cutsPerMinute: 0, transitions: 2, meanShotSeconds: 2, medianShotSeconds: 2, movesPerMinute: 0 },
    audio: { sfx: [] },
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-transitions-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("exporters render measured transitions and invent no motion", () => {
  it("plans a dissolve as an overlap with an opacity ramp, a dip as fades through the colour, and no title moves", () => {
    const scenes = scenesFromSpec(makeSpec());
    expect(scenes.map((s) => s.move)).toEqual([undefined, undefined, undefined]);
    expect(scenes[0]!.show).toEqual({ start: 0, end: 2.2 });
    expect(scenes[1]!.show).toEqual({ start: 1.8, end: 4 });
    expect(scenes[1]!.reveal).toEqual({ kind: "dissolve", start: 1.8, seconds: 0.4, easing: "linear" });
    expect(scenes[1]!.fadeOut).toEqual({ start: 3.7, seconds: 0.3, via: "black", easing: "linear" });
    expect(scenes[2]!.fadeIn).toEqual({ start: 4, seconds: 0.3, via: "black", easing: "linear" });
  });

  it("uses a move listed twice once", () => {
    const move = { kind: "move" as const, start: 0.4, end: 0.8, frames: 10, peak: 5, peakAt: 0.3, easing: "ease-out" as const, suggestion: "", evidence: "derived" as const };
    const scenes = scenesFromSpec(makeSpec([move, move]));
    expect(scenes[0]!.move).toMatchObject({ offset: 0.4, seconds: 0.4 });
    expect(scenes[1]!.move).toBeUndefined();
  });

  it("CSS: cross-fade keyframes, a black veil for the dip, and still titles", () => {
    const out = join(dir, "css");
    exportSpec(makeSpec(), "css", out);
    const css = readFileSync(join(out, "motion.css"), "utf8");
    expect(css).not.toMatch(/h1 \{[^}]*animation/);
    expect(css).toContain("#shot-1 h1 { color: #1EA0E0; } /* no move found in this shot: the title holds still */");
    expect(css).toMatch(/@keyframes fl-show-2 \{ 0% \{ opacity: 0; animation-timing-function: linear; \} 18\.182% \{ opacity: 1; \} 100% \{ opacity: 1; \} \}/);
    expect(css).toContain("#shot-2 { background: #434E43; animation: fl-show-2 2.2s linear 1.8s; }");
    expect(css).toContain("#shot-1 { background: #FFFFFF; animation: fl-show 2.2s linear 0s; }");
    expect(css).toMatch(/#shot-2 \.fl-veil-out \{ background: #000000; animation: fl-veil-out-2 2\.2s linear 1\.8s both; \}/);
    expect(css).toMatch(/#shot-3 \.fl-veil-in \{ background: #000000;/);
    expect(css).toContain("/* dissolve, derived from the reference */");
    expect(css).not.toMatch(/measured (dissolve|fade|move)/);
    const html = readFileSync(join(out, "preview.html"), "utf8");
    expect(html).toContain('<section class="fl-scene" id="shot-2"><h1>shot 2</h1><div class="fl-veil fl-veil-out"></div></section>');
    expect(html).toContain('<section class="fl-scene" id="shot-1"><h1>shot 1</h1></section>');
    expect(readFileSync(join(out, "REFERENCE.md"), "utf8")).toMatch(/## Defaults \(not measured\)[\s\S]*title still for the whole shot/);
  });

  it("HyperFrames: overlapping scenes on their own lanes, painted in order, with measured tweens only", () => {
    const out = join(dir, "hf");
    exportSpec(makeSpec(), "hyperframes", out);
    const index = readFileSync(join(out, "index.html"), "utf8");
    expect(index).toMatch(/id="shot-2"[\s\S]*?data-start="1\.8"[\s\S]*?data-duration="2\.2"[\s\S]*?data-track-index="2"[\s\S]*?style="z-index: 2"/);
    const one = readFileSync(join(out, "compositions/shot-1.html"), "utf8");
    expect(one).toContain("// No move or transition was found in this shot: the title holds still.");
    expect(one).not.toContain("fromTo");
    const two = readFileSync(join(out, "compositions/shot-2.html"), "utf8");
    expect(two).toContain('tl.fromTo("#shot-2-frame", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "none" }, 0); // dissolve, derived from the reference');
    expect(two).toContain('tl.to("#shot-2-veil-out", { opacity: 1, duration: 0.3, ease: "none" }, 1.9); // fade out to black, derived');
    expect(two).not.toContain('"#shot-2-title", { opacity: 0');
    const three = readFileSync(join(out, "compositions/shot-3.html"), "utf8");
    expect(three).toContain('tl.set("#shot-3-veil-in", { opacity: 1 }, 0);');
    expect(three).toContain('tl.to("#shot-3-veil-in", { opacity: 0, duration: 0.3, ease: "none" }, 0); // fade in from black, derived');
  });

  it("Remotion: sequences cover the overlap, ramps carry the measured frames, the component parses", () => {
    const out = join(dir, "remotion");
    exportSpec(makeSpec(), "remotion", out);
    const timing = readFileSync(join(out, "src/timing.ts"), "utf8");
    const scenes = JSON.parse(/export const SCENES = (\[[\s\S]*?\]);\n/.exec(timing)![1]!) as { from: number; durationInFrames: number; enterAt?: number; reveal?: { at: number; frames: number }; fadeOut?: { at: number; frames: number; color: string }; fadeIn?: { at: number; frames: number } }[];
    expect(scenes.map((s) => [s.from, s.durationInFrames])).toEqual([[0, 55], [45, 55], [100, 50]]);
    expect(scenes.every((s) => s.enterAt === undefined)).toBe(true);
    expect(scenes[1]!.reveal).toMatchObject({ at: 0, frames: 10 });
    expect(scenes[1]!.fadeOut).toMatchObject({ at: 48, frames: 8, color: "#000000" });
    expect(scenes[2]!.fadeIn).toMatchObject({ at: 0, frames: 8 });
    const component = readFileSync(join(out, "src/Reference.tsx"), "utf8");
    expect(() => transformSync(component, { loader: "tsx" })).not.toThrow();
    expect(() => transformSync(timing, { loader: "ts" })).not.toThrow();
    expect(component).toContain("let progress = 1;");
  });

  it("After Effects: still titles, an opacity ramp for the dissolve and black solids for the dip, in ES3", () => {
    const out = join(dir, "ae");
    exportSpec(makeSpec(), "after-effects", out);
    const source = readFileSync(join(out, "framelens-reference.jsx"), "utf8");
    expect(() => new Function(source.replace("#target aftereffects", ""))).not.toThrow();
    const code = source.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/\b(let|const)\b|=>|`|\bclass\b|\.\.\./);
    expect(code).not.toMatch(/,\s*[\]}]/);
    const scenes = JSON.parse(/var SCENES = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { start: number; end: number; keyStart?: number; reveal?: { keyStart: number; keyEnd: number } }[];
    expect(scenes.map((s) => [s.start, s.end])).toEqual([[0, 2.2], [1.8, 4], [4, 6]]);
    expect(scenes.every((s) => s.keyStart === undefined)).toBe(true);
    expect(scenes[1]!.reveal).toMatchObject({ keyStart: 1.8, keyEnd: 2.2 });
    const veils = JSON.parse(/var VEILS = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { name: string; color: number[]; keyStart: number; keyEnd: number; from: number; to: number }[];
    expect(veils.map((v) => [v.name, v.color, v.keyStart, v.keyEnd, v.from, v.to])).toEqual([
      ["Shot 2 fade out to black", [0, 0, 0], 3.7, 4, 0, 100],
      ["Shot 3 fade in from black", [0, 0, 0], 4, 4.3, 100, 0],
    ]);
  });

  it("Lottie: the incoming solid ramps up above the outgoing one, black veils for the dip, still placeholders", () => {
    const doc = lottieDocument(makeSpec());
    type Layer = { ty: number; nm: string; ip: number; op: number; sc?: string; ks: { p: { a: number }; o: { a: number; k: unknown } } };
    const layers = doc.layers as unknown as Layer[];
    expect(layers.slice(0, 2).map((l) => [l.nm, l.sc])).toEqual([
      ["shot-2 fade out to black", "#000000"],
      ["shot-3 fade in from black", "#000000"],
    ]);
    const solid2 = layers.find((l) => l.nm === "shot-2 background")!;
    expect(solid2.ks.o.a).toBe(1);
    expect([solid2.ip, solid2.op]).toEqual([45, 100]);
    expect(layers.indexOf(solid2)).toBeLessThan(layers.findIndex((l) => l.nm === "shot-1 background"));
    expect(layers.filter((l) => l.ty === 4 && l.nm !== "shot-2 title placeholder").every((l) => l.ks.p.a === 0 && l.ks.o.a === 0)).toBe(true);
  });

  it("draws a wipe as a travelling clip-path edge in CSS, HyperFrames and Remotion", () => {
    const spec = makeSpec();
    spec.transitions![0] = { ...spec.transitions![0]!, kind: "wipe", direction: "left" };
    const scenes = scenesFromSpec(spec);
    expect(scenes[1]!.reveal).toEqual({ kind: "wipe", start: 1.8, seconds: 0.4, easing: "linear", direction: "left" });
    exportSpec(spec, "css", join(dir, "wipe-css"));
    expect(readFileSync(join(dir, "wipe-css", "motion.css"), "utf8")).toMatch(/@keyframes fl-show-2 \{ 0% \{ opacity: 1; clip-path: inset\(0% 0% 0% 100%\); animation-timing-function: linear; \} 18\.182% \{ opacity: 1; clip-path: inset\(0% 0% 0% 0%\); \}/);
    exportSpec(spec, "hyperframes", join(dir, "wipe-hf"));
    expect(readFileSync(join(dir, "wipe-hf", "compositions/shot-2.html"), "utf8")).toContain('tl.fromTo("#shot-2-frame", { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.4, ease: "none" }, 0); // wipe, derived from the reference');
    exportSpec(spec, "remotion", join(dir, "wipe-remotion"));
    expect(readFileSync(join(dir, "wipe-remotion", "src/timing.ts"), "utf8")).toContain('"wipeFrom": "inset(0% 0% 0% 100%)"');
  });

  it("gives a fade in and a fade out of one scene a veil each, in their own colours and easings", () => {
    const spec = makeSpec();
    // s2 fades in from white (a dip through white from s1), and dips through black into s3 with its own easings.
    spec.transitions![0] = { id: "x1", kind: "dip", start: 1.7, end: 2.3, frames: 15, at: 2, via: "white", hold: { start: 2, end: 2 }, outEasing: "ease-in", inEasing: "ease-out", evidence: "derived", from: "s1", to: "s2" };
    spec.transitions![1] = { ...spec.transitions![1]!, outEasing: "ease-in-out", inEasing: "linear" };
    const scenes = scenesFromSpec(spec);
    expect(scenes[1]!.fadeIn).toMatchObject({ via: "white", easing: "ease-out" });
    expect(scenes[1]!.fadeOut).toMatchObject({ via: "black", easing: "ease-in-out" });
    expect(scenes[0]!.fadeOut).toMatchObject({ via: "white", easing: "ease-in" });
    exportSpec(spec, "css", join(dir, "two-veils-css"));
    const css = readFileSync(join(dir, "two-veils-css", "motion.css"), "utf8");
    expect(css).toMatch(/#shot-2 \.fl-veil-in \{ background: #FFFFFF;/);
    expect(css).toMatch(/#shot-2 \.fl-veil-out \{ background: #000000;/);
    exportSpec(spec, "hyperframes", join(dir, "two-veils-hf"));
    const hf = readFileSync(join(dir, "two-veils-hf", "compositions/shot-2.html"), "utf8");
    expect(hf).toMatch(/#shot-2-veil-in \{[^}]*background: #FFFFFF;/);
    expect(hf).toMatch(/#shot-2-veil-out \{[^}]*background: #000000;/);
  });

  it("After Effects: each title right above its own background, and a veil that clears has negative speeds", () => {
    const out = join(dir, "ae-order");
    exportSpec(makeSpec(), "after-effects", out);
    const source = readFileSync(join(out, "framelens-reference.jsx"), "utf8");
    // One loop adds a shot's solid and then its title (new layers go on top), shot after shot.
    const loop = source.slice(source.indexOf("for (i = 0; i < SCENES.length; i++)"), source.indexOf("for (i = 0; i < VEILS.length; i++)"));
    expect(loop.match(/for \(i = 0; i < SCENES\.length; i\+\+\)/g)).toHaveLength(1);
    expect(loop.indexOf("addSolid")).toBeLessThan(loop.indexOf("addText"));
    const veils = JSON.parse(/var VEILS = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { from: number; to: number; ease: { outSpeed: number; inSpeed: number } }[];
    const clearing = veils.find((v) => v.from > v.to)!;
    expect(clearing.ease.outSpeed).toBeLessThan(0);
    const covering = veils.find((v) => v.from < v.to)!;
    expect(covering.ease.outSpeed).toBeGreaterThan(0);
  });

  it("exports a hostile spec whose transitions are not a list, or lie outside the range", () => {
    const notAList = makeSpec();
    (notAList as unknown as Record<string, unknown>).transitions = "dissolve";
    expect(() => exportSpec(notAList, "css", join(dir, "not-a-list"))).not.toThrow();
    const far = makeSpec();
    far.transitions![0] = { ...far.transitions![0]!, start: -1e9, end: 1e12, at: 5e11 };
    for (const target of ["css", "hyperframes", "remotion", "after-effects", "lottie"] as const) expect(() => exportSpec(far, target, join(dir, `far-${target}`))).not.toThrow();
    const css = readFileSync(join(dir, "far-css", "motion.css"), "utf8");
    expect(css).not.toMatch(/\d{7,}/);
  });

  it("drops transition fields that are not known values before they reach code", () => {
    const spec = makeSpec();
    (spec.transitions![0] as unknown as Record<string, unknown>).easing = "linear); alert(1); (";
    (spec.transitions![1] as unknown as Record<string, unknown>).via = "red; } body { display: none";
    const out = join(dir, "hostile");
    exportSpec(spec, "css", out);
    const css = readFileSync(join(out, "motion.css"), "utf8");
    expect(css).not.toContain("alert");
    expect(css).not.toContain("display: none");
  });
});

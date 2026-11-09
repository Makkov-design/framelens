import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aeScript, bezierToAeEase } from "../../src/export/after-effects.js";
import { BEZIER, EXPORT_TARGETS, exportSpec, scenesFromSpec } from "../../src/export/exporters.js";
import { lottieDocument } from "../../src/export/lottie.js";
import type { MotionSpec } from "../../src/style/spec.js";

const sw = (hex: string) => ({ hex, share: 0.5, lightness: 0.5, chroma: 0.1, evidence: "measured" as const });

function makeSpec(): MotionSpec {
  const shot = (id: string, start: number, end: number, palette: string[]) => ({ id, start, end, frames: Math.round((end - start) * 25), palette });
  return {
    spec: "framelens.motion/1",
    generatedBy: "framelens test",
    source: { kind: "file", input: "ref.mp4", title: "My Ref: Launch!" },
    range: { start: 0, end: 6 },
    timebase: { fps: 25, vfr: false, duration: 6, width: 1280, height: 720 },
    anchors: {
      words: [
        { id: "w1", t: 0.5, end: 0.8, text: "Hello" },
        { id: "w2", t: 2.6, end: 3, text: "world" },
      ],
      beats: [
        { id: "b1", t: 0.5 },
        { id: "b2", t: 2, downbeat: true },
      ],
      cuts: [
        { id: "c1", t: 2, score: 9, evidence: "measured" },
        { id: "c2", t: 4, score: 8, evidence: "measured" },
      ],
    },
    changes: [],
    palette: [sw("#E0402F"), sw("#2F6FE0"), sw("#FFFFFF")],
    typography: [],
    shots: [shot("s1", 0, 2, ["#E0402F", "#FFFFFF"]), shot("s2", 2, 4, ["#2F6FE0", "#FFFFFF"]), shot("s3", 4, 6, ["#1F8040"])],
    systems: [],
    events: [
      { kind: "move", start: 0.4, end: 0.8, frames: 10, peak: 5, peakAt: 0.3, easing: "ease-out", suggestion: "cubic-bezier(0.16, 1, 0.3, 1)", evidence: "derived" },
      { kind: "move", start: 2.5, end: 3, frames: 12, peak: 4, peakAt: 0.5, easing: "ease-in-out", suggestion: "cubic-bezier(0.65, 0, 0.35, 1)", evidence: "derived" },
    ],
    rhythm: { cuts: 2, cutsPerMinute: 20, meanShotSeconds: 2, medianShotSeconds: 2, movesPerMinute: 20 },
    audio: { tempo_bpm: 120, hits: [{ t: 3.2, strength: 0.9, evidence: "measured" }, { t: 9, strength: 0.7, evidence: "measured" }], sfx: [] },
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fl-export-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("export targets", () => {
  it("lists the new targets", () => {
    expect(EXPORT_TARGETS).toEqual(expect.arrayContaining(["hyperframes", "remotion", "css", "after-effects", "lottie", "hypit"]));
  });
});

describe("after-effects", () => {
  it("maps a bezier to KeyframeEase speed and influence", () => {
    const e = bezierToAeEase([0.16, 1, 0.3, 1], 100, 1);
    expect(e).toEqual({ outSpeed: 625, outInfluence: 16, inSpeed: 0, inInfluence: 70 });
    expect(bezierToAeEase([0, 0, 1, 1], 100, 2)).toMatchObject({ outSpeed: 50, outInfluence: 33.3333, inSpeed: 50 });
  });

  it("writes an ES3-valid script with the expected keyframes, markers and undo group", () => {
    const spec = makeSpec();
    const out = join(dir, "ae");
    const files = exportSpec(spec, "after-effects", out);
    expect(files.map((f) => f.replace(/\\/g, "/").split("/").pop())).toEqual(["framelens-reference.jsx", "REFERENCE.md"]);
    const source = readFileSync(join(out, "framelens-reference.jsx"), "utf8");

    // Parses as a function body once the ExtendScript directive is removed.
    expect(() => new Function(source.replace("#target aftereffects", ""))).not.toThrow();
    // No ES5+/ES6 syntax: strip comments and strings, then look for it.
    const code = source.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/\b(let|const)\b|=>|`|\bclass\b|\.\.\./);
    expect(code).not.toMatch(/,\s*[\]}]/); // trailing commas are an ES3 error
    expect(source.indexOf("app.beginUndoGroup")).toBeGreaterThan(-1);
    expect(source.indexOf("app.beginUndoGroup")).toBeLessThan(source.indexOf("addComp"));
    expect(source.indexOf("app.endUndoGroup")).toBeGreaterThan(source.indexOf("comp.markerProperty"));
    expect(source).toContain("var FPS = 25;");
    expect(source).toContain("var WIDTH = 1280;");
    expect(source).toContain("var DURATION = 6;");

    const scenes = JSON.parse(/var SCENES = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { start: number; end: number; keyStart: number; keyEnd: number; bezier: number[]; background: number[] }[];
    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 4], [4, 6]]);
    // Shot 1: first move starts 0.4 s in and lasts 10 frames at 25 fps.
    expect([scenes[0]!.keyStart, scenes[0]!.keyEnd]).toEqual([0.4, 0.8]);
    expect(scenes[0]!.bezier).toEqual([...BEZIER["ease-out"]]);
    // Shot 2: move at 2.5 s (0.5 into the shot), 12 frames.
    expect([scenes[1]!.keyStart, scenes[1]!.keyEnd]).toEqual([2.5, 2.98]);
    // Shot 3 has no measured move: its title holds still (no keys are invented).
    expect(scenes[2]!.keyStart).toBeUndefined();
    expect(scenes[2]!.bezier).toBeUndefined();
    expect(source).toContain("position.setValue([WIDTH / 2, HEIGHT / 2]);");
    expect(scenes[0]!.background[0]).toBeCloseTo(0xe0 / 255, 3);

    const markers = JSON.parse(/var MARKERS = (\[[\s\S]*?\]);\n/.exec(source)![1]!) as { t: number; label: string }[];
    expect(markers).toEqual([
      { t: 0.5, label: "beat 1" },
      { t: 2, label: "cut 1 + downbeat 2" },
      { t: 3.2, label: "hit 1 (0.90)" },
      { t: 4, label: "cut 2" },
    ]);
  });
});

describe("lottie", () => {
  it("writes a Bodymovin document whose layers match the shots and whose easing round-trips", () => {
    const spec = makeSpec();
    const out = join(dir, "lottie");
    exportSpec(spec, "lottie", out);
    const doc = JSON.parse(readFileSync(join(out, "reference.json"), "utf8")) as ReturnType<typeof lottieDocument>;
    expect(doc).toMatchObject({ fr: 25, ip: 0, op: 150, w: 1280, h: 720 });
    expect(typeof doc.v).toBe("string");

    type Key = { t: number; s: number[]; o?: { x: number[]; y: number[] }; i?: { x: number[]; y: number[] } };
    type Layer = { ty: number; ip: number; op: number; sc?: string; ks: { p: { a: number; k: Key[] }; o: { a: number; k: Key[] } } };
    const layers = doc.layers as unknown as Layer[];
    // Top-first: later shots above earlier ones, each placeholder right above its background.
    expect(layers.map((l) => [l.ty, l.ip])).toEqual([[4, 100], [1, 100], [4, 50], [1, 50], [4, 0], [1, 0]]);
    const solids = layers.filter((l) => l.ty === 1).sort((a, b) => a.ip - b.ip);
    const shapes = layers.filter((l) => l.ty === 4).sort((a, b) => a.ip - b.ip);
    expect(solids).toHaveLength(3);
    expect(shapes).toHaveLength(3);
    expect(solids.map((l) => [l.ip, l.op])).toEqual([[0, 50], [50, 100], [100, 150]]);
    expect(solids.map((l) => l.sc)).toEqual(["#E0402F", "#2F6FE0", "#1F8040"]);
    expect(shapes.map((l) => [l.ip, l.op])).toEqual([[0, 50], [50, 100], [100, 150]]);

    const scenes = scenesFromSpec(spec);
    shapes.forEach((layer, n) => {
      const move = scenes[n]!.move;
      if (!move) {
        // No measured move: the placeholder holds still.
        expect(layer.ks.p.a).toBe(0);
        expect(layer.ks.o).toEqual({ a: 0, k: 100 });
        return;
      }
      const [a, b] = layer.ks.p.k;
      const bezier = BEZIER[move.easing];
      expect([a!.o!.x[0], a!.o!.y[0], a!.i!.x[0], a!.i!.y[0]]).toEqual([...bezier]);
      expect(layer.ks.o.k.map((k) => k.s[0])).toEqual([0, 100]);
      expect(b!.t).toBeGreaterThan(a!.t);
      expect(a!.t).toBe(layer.ip + Math.round(move.offset * 25));
      expect(b!.t - a!.t).toBe(Math.round(move.seconds * 25));
    });
    expect(scenes[2]!.move).toBeUndefined();
  });
});

describe("hypit", () => {
  it("generates ANALYSIS.md and TIMELINE.md from the spec when the workspace has nothing", () => {
    const out = join(dir, "hypit-bare");
    const files = exportSpec(makeSpec(), "hypit", out).map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("references/my-ref-launch/ANALYSIS.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("HANDOFF.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("transcript.json"))).toBe(false);
    const timeline = readFileSync(join(out, "references/my-ref-launch/TIMELINE.md"), "utf8");
    expect(timeline).toContain("## 0.00–2.00 · Opening (s1)");
    expect(timeline).toContain("## 2.00–4.00 · Build (s2)");
    expect(timeline).toContain("## 4.00–6.00 · Close (s3)");
    expect(timeline).toContain("Move at 2.50 s to 3.00 s (12 frames, ease-in-out");
    expect(timeline).toContain("Strong audio hits at 3.20 s (0.90)");
    expect(timeline).toContain("“world” 2.60–3.00");
    expect(timeline).toContain("Not written yet");
    const analysis = readFileSync(join(out, "references/my-ref-launch/ANALYSIS.md"), "utf8");
    expect(analysis).toContain("## Measured facts");
    expect(analysis).toContain("## Interpretation");
    expect(analysis).toContain("No interpretation has been written yet");
  });

  it("uses the workspace notes and maps the transcript", () => {
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "ANALYSIS.md"), "# Analysis: x\n\n## What the piece is trying to do\n\nIt sells a launch with fast, confident cuts and a single bold claim per shot.\n");
    writeFileSync(
      join(ws, "TIMELINE.md"),
      "# Timeline\n\n<!-- framelens:measured:start -->\n## Shots\n\n### 0:00.00–0:02.00 · s1 (50 frames)\n\nColours.\n\n_What happens and why:_ The hook slams the title in on the word Hello.\n\n### 0:02.00–0:04.00 · s2 (50 frames)\n\n_What happens and why:_\n<!-- framelens:measured:end -->\n",
    );
    writeFileSync(join(ws, "STYLE.md"), "# Style: x\n\nBold, saturated and quick, with the title always centred.\n");
    writeFileSync(
      join(ws, "transcript.json"),
      JSON.stringify({ source: "whisper", words: [{ t: 0.5, end: 0.8, text: "Hello" }, { t: 2.6, end: 3, text: "world" }], segments: [] }),
    );
    const out = join(dir, "hypit-ws");
    const files = exportSpec(makeSpec(), "hypit", out, { workspace: ws }).map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("transcript.json"))).toBe(true);
    const base = join(out, "references/my-ref-launch");
    expect(JSON.parse(readFileSync(join(base, "transcript.json"), "utf8"))).toEqual({
      words: [{ word: "Hello", start: 0.5, end: 0.8 }, { word: "world", start: 2.6, end: 3 }],
    });
    const timeline = readFileSync(join(base, "TIMELINE.md"), "utf8");
    expect(timeline).toContain("The hook slams the title in on the word Hello.");
    expect(timeline).toContain("Not written yet"); // s2 has only the template
    const analysis = readFileSync(join(base, "ANALYSIS.md"), "utf8");
    expect(analysis).toContain("fast, confident cuts");
    expect(analysis).toContain("Bold, saturated and quick");
    expect(analysis).not.toContain("No interpretation has been written yet");
    expect(readFileSync(join(out, "HANDOFF.md"), "utf8")).toContain("/hypit");
  });
});

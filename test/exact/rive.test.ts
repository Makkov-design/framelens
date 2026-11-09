import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine.js";
import { exportSpec } from "../../src/export/exporters.js";
import type { FetchLike } from "../../src/exact/http.js";
import { isRiveBytes, MAX_RIVE_BYTES, modelRive, parseRive, readRive, riveMarkdown } from "../../src/exact/rive.js";
import { riveLink, runExact } from "../../src/exact/run.js";
import { exactSummary } from "../../src/local-tools-exact.js";
import { silentLogger } from "../../src/logger.js";
import { tempDir } from "../media/fixtures.js";
import { header, object, riv, varuint, type Obj } from "./rive-writer.js";

const FIXTURES = join(__dirname, "..", "fixtures", "rive");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** y of a CSS cubic-bezier at time progress p (bisection on x, like the runtime's solver). */
function bezierAt([x1, y1, x2, y2]: [number, number, number, number], p: number): number {
  const c = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (c(mid, x1, x2) < p) lo = mid;
    else hi = mid;
  }
  return c((lo + hi) / 2, y1, y2);
}

// Artboard slots (ids in the file point here): 0 Main, 1 Ball, 2 Disc, 3 Ellipse, 4 Fill, 5 SolidColor, 6 CubicEase, 7 Elastic.
const scene: Obj[] = [
  [23],
  [1, [[4, "string", "Main"], [7, "double", 400], [8, "double", 300]]],
  [2, [[4, "string", "Ball"], [5, "uint", 0], [13, "double", 50]]],
  [3, [[4, "string", "Disc"], [5, "uint", 1]]],
  [4, [[5, "uint", 2], [20, "double", 100], [21, "double", 100]]],
  [20, [[5, "uint", 2]]],
  [18, [[5, "uint", 4], [37, "color", 0xffff0000]]],
  [28, [[63, "double", 0.25], [64, "double", 0.1], [65, "double", 0.25], [66, "double", 1]]],
  [174, [[405, "uint", 1], [406, "double", 1.5], [407, "double", 0.5]]],
  [31, [[55, "string", "Bounce"], [56, "uint", 30], [57, "uint", 30], [59, "uint", 1]]],
  [25, [[51, "uint", 1]]],
  [26, [[53, "uint", 13]]],
  [30, [[67, "uint", 0], [68, "uint", 2], [69, "uint", 6], [70, "double", 50]]],
  [30, [[67, "uint", 15], [68, "uint", 2], [69, "uint", 7], [70, "double", 250]]],
  [30, [[67, "uint", 30], [70, "double", 150]]],
  [26, [[53, "uint", 15]]],
  [30, [[67, "uint", 0], [68, "uint", 1], [70, "double", 0]]],
  [30, [[67, "uint", 30], [70, "double", Math.PI]]],
  [25, [[51, "uint", 5]]],
  [26, [[53, "uint", 37]]],
  [37, [[67, "uint", 0], [68, "uint", 1], [88, "color", 0xffff0000]]],
  [37, [[67, "uint", 30], [88, "color", 0x800000ff]]],
  [25, [[51, "uint", 4]]],
  [26, [[53, "uint", 41]]],
  [84, [[67, "uint", 0], [181, "bool", true]]],
  [84, [[67, "uint", 10], [181, "bool", false]]],
  [26, [[53, "uint", 999]]],
  [171, [[67, "uint", 5]]],
  [53, [[55, "string", "Ctl"]]],
  [59, [[138, "string", "hover"], [141, "bool", true]]],
  [56, [[138, "string", "level"], [140, "double", 2]]],
  [58, [[138, "string", "tap"]]],
  [57, [[138, "string", "Layer 1"]]],
  [63],
  [65, [[151, "uint", 3]]],
  [62],
  [64],
  [61, [[149, "uint", 0]]],
  [65, [[151, "uint", 2], [152, "uint", 4 | 8], [158, "uint", 300], [160, "uint", 100]]],
  [71, [[155, "uint", 0], [156, "uint", 0]]],
  [68, [[155, "uint", 2]]],
  [70, [[155, "uint", 1], [156, "uint", 5], [157, "double", 1.5]]],
];

describe("Rive binary reader", () => {
  it("reads the header, the table of contents and every field type", () => {
    const bytes = riv({
      major: 7,
      minor: 3,
      fileId: 123456789,
      toc: [[4000, 2]],
      objects: [
        [1067, [[67, "uint", 300], [1068, "int", -42]]],
        [2, [[4, "string", "Näme ✓"], [13, "double", 1.5], [196, "bool", true]]],
        [18, [[37, "color", 0x80123456]]],
        [106, [[212, "bytes", new Uint8Array(1000)]]],
      ],
    });
    expect(isRiveBytes(bytes)).toBe(true);
    const f = readRive(bytes);
    expect([f.major, f.minor, f.fileId]).toEqual([7, 3, 123456789]);
    expect(f.toc.get(4000)).toBe(2);
    expect(f.objects.map((o) => o.type)).toEqual([1067, 2, 18, 106]);
    expect(f.objects[0]!.props.get(67)).toBe(300);
    expect(f.objects[0]!.props.get(1068)).toBe(-42);
    expect(f.objects[1]!.props.get(4)).toBe("Näme ✓");
    expect(f.objects[1]!.props.get(13)).toBeCloseTo(1.5);
    expect(f.objects[1]!.props.get(196)).toBe(true);
    expect(f.objects[2]!.props.get(37)).toBe(0x80123456);
    expect(f.objects[3]!.props.get(212)).toBe(1000); // bytes are skipped, only their length is kept
    expect(f.notes).toEqual([]);
  });

  it("skips properties it does not know by the type the table of contents gives, across packed words", () => {
    // Five unknown keys need two uint32 words of field bits (4 keys per word, as RuntimeHeader::read packs them).
    const toc: [number, 0 | 1 | 2 | 3][] = [[4000, 2], [4001, 1], [4002, 3], [4003, 0], [4004, 2]];
    const f = readRive(
      riv({
        toc,
        objects: [
          [1, [[4, "string", "Main"]]],
          [2, [[4000, "double", 9.5], [4001, "string", "future text"], [4002, "color", 0xffffffff], [4003, "uint", 300_000], [4004, "double", 1], [4, "string", "Kept"]]],
          [9999, [[4001, "string", "unknown type, known shape"]]],
          [2, [[4, "string", "After"], [5, "uint", 0]]],
        ],
      }),
    );
    expect(f.notes).toEqual([]);
    expect(f.objects[1]!.props.get(4)).toBe("Kept");
    expect(f.objects[1]!.props.get(4003)).toBe(300_000);
    expect([...f.skipped.keys()].sort()).toEqual([4000, 4001, 4002, 4003, 4004]);
    // An unknown object type still takes its slot in the artboard, as the runtime's readNullObject does.
    const m = modelRive(f);
    expect(m.artboards[0]!.objects.map((o) => o?.type ?? null)).toEqual([1, 2, null, 2]);
    const a = parseRive(riv({ toc, objects: [[1, [[4, "string", "Main"]]], [2, [[4000, "double", 1]]]] }), { input: "x.riv" });
    expect(a.analysis.unknowns.some((u) => /table of contents/.test(u))).toBe(true);
  });

  it("stops where the runtime would: a key that is neither known nor in the table of contents", () => {
    const f = readRive(riv({ objects: [[1, [[4, "string", "Main"]]], [2, [[4500, "uint", 1]]], [2]] }));
    expect(f.objects).toHaveLength(1);
    expect(f.notes[0]).toMatch(/property key 4500 is neither a known Rive property nor listed/);
  });

  it("rejects what is not a Rive file, other format versions and cut headers", () => {
    expect(() => readRive(Buffer.from("{\"v\":\"5.7\"}"))).toThrow(/not a Rive file/);
    expect(() => readRive(riv({ major: 6, objects: [] }))).toThrow(/version 6\.0 is not supported/);
    // A short older file still reports its version, not a cut header: the version is checked before the rest.
    expect(() => readRive(Uint8Array.from([...Buffer.from("RIVE"), 6, 1]))).toThrow(/version 6\.1 is not supported/);
    expect(() => readRive(Uint8Array.from([...Buffer.from("RIVE"), 7]))).toThrow(/cut short inside its header/);
    expect(() => readRive(Uint8Array.from([...Buffer.from("RIVE"), 7, 0, 1, 0x88, 0x27]))).toThrow(/cut short inside its header/);
    const big = new Uint8Array(MAX_RIVE_BYTES + 1);
    big.set(Buffer.from("RIVE"));
    expect(() => readRive(big)).toThrow(/larger than 30 MB/);
  });

  it("keeps what it read before a cut, a lying length or an endless number", () => {
    const good = object([1, [[4, "string", "Main"]]]);
    const cut = readRive(Uint8Array.from([...header(), ...good, ...object([2, [[4, "string", "Ball"]]]).slice(0, 5)]));
    expect(cut.objects).toHaveLength(1);
    expect(cut.notes[0]).toMatch(/ends inside object #2/);

    // A string that claims a terabyte: checked against what is left, nothing is allocated for it.
    const lying = readRive(Uint8Array.from([...header(), ...good, 2, 4, ...varuint(2 ** 40), 65, 66]));
    expect(lying.objects).toHaveLength(1);
    expect(lying.notes[0]).toMatch(/ends inside object #2/);

    const endless = readRive(Uint8Array.from([...header(), ...good, 2, ...new Array(11).fill(0xff), 1]));
    expect(endless.notes[0]).toMatch(/longer than 10 bytes/);

    const wide = readRive(Uint8Array.from([...header(), ...good, 2, ...varuint(70_000), 0]));
    expect(wide.notes[0]).toMatch(/out of range/);
  });

  it("caps the object count and the length of kept strings", () => {
    const many = Uint8Array.from([...header(), ...new Array(260_000).fill([2, 0]).flat()]);
    const f = readRive(many);
    expect(f.objects).toHaveLength(250_000);
    expect(f.notes[0]).toMatch(/more than 250000 objects/);
    const long = readRive(riv({ objects: [[1, [[4, "string", "x".repeat(50_000)]]]] }));
    expect((long.objects[0]!.props.get(4) as string).length).toBe(2000);
  });
});

describe("Rive file to moves, palette and state machines", () => {
  const r = parseRive(riv({ objects: scene }), { input: "scene.riv" });
  const a = r.analysis;

  it("reads the artboard and the animation timing", () => {
    expect(a.kind).toBe("rive");
    expect(a.title).toBe("Main");
    expect([a.width, a.height, a.fps]).toEqual([400, 300, 30]);
    expect(a.shots).toEqual([{ id: "s1", name: "Bounce", start: 0, end: 1, palette: ["#FF0000"] }]);
    expect(a.end).toBe(1);
  });

  it("turns keyframes into moves with the file's own curves", () => {
    const x = a.moves.filter((m) => m.property === "position.x");
    expect(x[0]).toMatchObject({ target: "Ball", start: 0, end: 0.5, from: [50], to: [250], bezier: [0.25, 0.1, 0.25, 1], curve: "cubic-bezier(0.25, 0.1, 0.25, 1)", evidence: "measured", type: "move" });
    expect(x[1]).toMatchObject({ start: 0.5, end: 1, from: [250], to: [150], curve: "elastic(out, amplitude 1.5, period 0.5)", easing: "ease-out" });
    expect(x[1]!.bezier).toBeUndefined();
    expect(a.moves.find((m) => m.property === "rotation")).toMatchObject({ from: [0], to: [180], curve: "linear", type: "rotate" });
    expect(a.moves.find((m) => m.property === "fill")).toMatchObject({ target: "Ball/Disc/Fill/SolidColor", from: ["#FF0000"], to: ["#0000FF80"], type: "colour change" });
    expect(a.moves.find((m) => m.property === "visible")).toMatchObject({ hold: true, curve: "steps(1, end)", from: ["true"], to: ["false"], end: 0.333 });
    expect(r.placement[0]).toMatchObject({ moves: 5, events: 1 });
    expect(a.palette).toEqual([{ hex: "#FF0000", share: 1 }]);
  });

  it("summarises the state machine in RIVE.md", () => {
    const md = riveMarkdown(r);
    expect(md).toContain("### `Ctl` (artboard `Main`)");
    expect(md).toContain("Inputs: `hover` (boolean, starts true), `level` (number, starts 2), `tap` (trigger).");
    expect(md).toContain("- Entry → animation `Bounce`, blend 0 ms (linear)");
    expect(md).toContain("- animation `Bounce` → Exit, blend 300 ms (linear), after exit time 100%, when `hover` is true and `tap` fires and `level` > 1.5");
    expect(md).toContain("| `Main` | `Bounce` | 30 | 30 frames (1 s) | — | loop | 1× | 3 | 5 | 1 | 0–1 s |");
  });

  it("treats names as untrusted text and survives broken references", () => {
    const hostile: Obj[] = [
      [1, [[4, "string", "Evil\n# Injected heading\n`|` [x](javascript:alert(1))"]]],
      [2, [[4, "string", "A"], [5, "uint", 2]]],
      [2, [[4, "string", "B"], [5, "uint", 1]]], // A and B are each other's parent
      [28, [[63, "double", 7], [64, "double", 0], [65, "double", -3], [66, "double", 1]]],
      [31, [[55, "string", "T\r\nline"], [56, "uint", 0], [57, "uint", 10]]],
      [25, [[51, "uint", 77]]],
      [26, [[53, "uint", 13]]],
      [30, [[67, "uint", 0], [70, "double", 0]]],
      [30, [[67, "uint", 5], [70, "double", 1]]],
      [25, [[51, "uint", 1]]],
      [26, [[53, "uint", 13]]],
      [30, [[67, "uint", 0], [68, "uint", 2], [69, "uint", 3], [70, "double", 0]]],
      [30, [[67, "uint", 6], [68, "uint", 2], [69, "uint", 1], [70, "double", 10]]],
      [30, [[67, "uint", 9], [70, "double", 20]]],
    ];
    const h = parseRive(riv({ objects: hostile }), { input: "h.riv" });
    const md = riveMarkdown(h);
    expect(md.split("\n").some((l) => l.startsWith("# Injected"))).toBe(false);
    expect(md).toContain("`Evil # Injected heading \\| [x](javascript:alert(1))`");
    expect(h.analysis.fps).toBe(60); // fps 0 falls back to the runtime default
    expect(h.analysis.unknowns.some((u) => /object id 77/.test(u))).toBe(true);
    const [first, second] = h.analysis.moves;
    expect(first!.target).toBe("B/A"); // the parent cycle stops instead of looping
    expect(first!.bezier).toEqual([1, 0, 0, 1]); // x control points clamped to 0–1
    expect(second!.curve).toBe("linear"); // an interpolator id pointing at a node
    expect(second!.evidence).toBe("inferred"); // a stand-in curve is not a measurement
    expect(first!.evidence).toBe("measured");
    expect(h.analysis.unknowns.some((u) => /Node is not evaluated: treated as linear/.test(u))).toBe(true);
  });
});

describe("Rive playback timing, text styles and ids", () => {
  it("plays the work area at |speed|, backwards for negative speed, cutting curves exactly at the edges", () => {
    const b: [number, number, number, number] = [0.25, 0.1, 0.25, 1];
    const timed = (speed: number): Obj[] => [
      [1, [[4, "string", "Main"]]],
      [2, [[4, "string", "Ball"], [5, "uint", 0]]],
      [28, [[63, "double", b[0]], [64, "double", b[1]], [65, "double", b[2]], [66, "double", b[3]]]],
      [31, [[55, "string", "Run"], [56, "uint", 10], [57, "uint", 40], [58, "double", speed], [60, "uint", 10], [61, "uint", 30], [62, "bool", true]]],
      [25, [[51, "uint", 1]]],
      [26, [[53, "uint", 13]]],
      [30, [[67, "uint", 0], [68, "uint", 1], [70, "double", 0]]],
      [30, [[67, "uint", 20], [68, "uint", 2], [69, "uint", 2], [70, "double", 100]]],
      [30, [[67, "uint", 40], [70, "double", 300]]],
      [26, [[53, "uint", 41]]],
      [84, [[67, "uint", 15], [181, "bool", true]]],
      [84, [[67, "uint", 25], [181, "bool", false]]],
    ];
    const original = (f: number) => (f <= 20 ? f * 5 : 100 + bezierAt(b, (f - 20) / 20) * 200);
    const valueAt = (m: { start: number; end: number; from: (number | string)[]; to: (number | string)[]; bezier?: [number, number, number, number] }, t: number) => {
      const p = (t - m.start) / (m.end - m.start);
      const y = m.bezier ? bezierAt(m.bezier, p) : p;
      return Number(m.from[0]) + y * (Number(m.to[0]) - Number(m.from[0]));
    };

    // Forward at 2×: frames 10–30 of a 10 fps animation take (30 − 10) / 10 / 2 = 1 s; frame f plays at (f − 10) / 20 s.
    const fwd = parseRive(riv({ objects: timed(2) }), { input: "t.riv" }).analysis;
    expect(fwd.end).toBe(1);
    const [a, c] = fwd.moves.filter((m) => m.property === "position.x");
    expect(a).toMatchObject({ start: 0, end: 0.5, from: [50], to: [100], curve: "linear", evidence: "measured" });
    expect(c).toMatchObject({ start: 0.5, end: 1, from: [100], evidence: "measured" });
    for (const f of [22, 25, 28]) expect(Math.abs(valueAt(c!, (f - 10) / 20) - original(f))).toBeLessThan(0.5);
    // A hold keeps its value from frame 15 and jumps at frame 25: 0.25–0.75 s.
    expect(fwd.moves.find((m) => m.property === "visible")).toMatchObject({ start: 0.25, end: 0.75, hold: true, from: ["true"], to: ["false"] });

    // Backwards at −2×: playback starts at frame 30 and frame f plays at (30 − f) / 20 s.
    const back = parseRive(riv({ objects: timed(-2) }), { input: "t.riv" }).analysis;
    expect(back.end).toBe(1);
    const xs = back.moves.filter((m) => m.property === "position.x");
    expect(xs.map((m) => [m.start, m.end, m.to[0]])).toEqual([[0, 0.5, 100], [0.5, 1, 50]]);
    for (const f of [22, 25, 28]) expect(Math.abs(valueAt(xs[0]!, (30 - f) / 20) - original(f))).toBeLessThan(0.5);
    // Played backwards, the hold at frame 25 changes the value back to true when playback reaches it.
    expect(back.moves.find((m) => m.property === "visible")).toMatchObject({ start: 0.25, end: 0.25, hold: true, from: ["false"], to: ["true"] });
  });

  it("reads text sizes and fonts from TextStylePaint and resolves font ids into the file's assets", () => {
    const r = parseRive(
      riv({
        objects: [
          [141, [[203, "string", "Bodoni"], [204, "uint", 1]]],
          [106, [[212, "bytes", new Uint8Array(10)]]],
          [141, [[203, "string", "Emoji"], [204, "uint", 2]]],
          [1, [[4, "string", "Main"]]],
          [134, [[5, "uint", 0]]],
          [137, [[5, "uint", 1], [274, "double", 48], [279, "uint", 0]]],
          [135, [[5, "uint", 1], [268, "string", "hi"], [272, "uint", 2]]],
          [31, [[55, "string", "Swap"], [56, "uint", 30], [57, "uint", 30]]],
          [25, [[51, "uint", 2]]],
          [26, [[53, "uint", 279]]],
          [50, [[67, "uint", 0], [122, "uint", 0]]],
          [50, [[67, "uint", 15], [122, "uint", 1]]],
          [25, [[51, "uint", 0]]],
          [26, [[53, "uint", 118]]],
          [450, [[67, "uint", 0], [68, "uint", 1], [631, "uint", 0]]],
          [450, [[67, "uint", 10], [631, "uint", 255]]],
          [26, [[53, "uint", 125]]],
          [450, [[67, "uint", 0], [68, "uint", 1], [631, "uint", 3]]],
          [450, [[67, "uint", 10], [631, "uint", 6]]],
        ],
      }),
      { input: "fonts.riv", title: "fonts" },
    );
    const a = r.analysis;
    expect(a.title).toBe("fonts");
    expect(a.texts).toEqual([{ text: "hi", family: "Bodoni", size: 48, where: "Text" }]);
    expect(a.fonts).toEqual(["Bodoni", "Emoji"]);
    expect(a.unknowns.some((u) => /TextStylePaint/.test(u))).toBe(false);
    expect(a.moves.find((m) => m.property === "font")).toMatchObject({ target: "Text/TextStylePaint", from: ["Bodoni"], to: ["Emoji"], hold: true });
    // Colour channels interpolate (CoreRegistry::isInterpolatableUint); other uints step.
    expect(a.moves.find((m) => m.property === "colour red")).toMatchObject({ from: [0], to: [255], hold: false, curve: "linear" });
    expect(a.moves.find((m) => m.property === "points")).toMatchObject({ from: [3], to: [6], hold: true });
    expect(riveMarkdown(r)).toContain("- FontAsset `Bodoni` (embedded, 10 bytes)");
  });

  it("places unknown objects where the runtime's importers do, so state and input ids still line up", () => {
    const r = parseRive(
      riv({
        objects: [
          [1, [[4, "string", "Main"]]],
          [2, [[4, "string", "Ball"], [5, "uint", 0]]],
          [31, [[55, "string", "A"]]],
          [25, [[51, "uint", 1]]],
          [26, [[53, "uint", 13]]],
          [9000], // swallowed by the keyed property importer: takes no artboard slot
          [30, [[67, "uint", 0], [68, "uint", 1], [70, "double", 0]]],
          [30, [[67, "uint", 30], [70, "double", 10]]],
          [31, [[55, "string", "B"]]],
          [53, [[55, "string", "SM"]]],
          [59, [[138, "string", "hover"]]],
          [9001], // after the state machine: a null input that still takes index 1
          [56, [[138, "string", "level"]]],
          [57, [[138, "string", "L"]]],
          [63],
          [65, [[151, "uint", 3]]],
          [71, [[155, "uint", 1], [156, "uint", 0]]],
          [70, [[155, "uint", 2], [156, "uint", 5], [157, "double", 1]]],
          [9002], // inside a layer: an empty state that still takes index 1
          [61, [[149, "uint", 0]]],
          [61, [[149, "uint", 1]]],
        ],
      }),
      { input: "sm.riv" },
    );
    const ab = r.model.artboards[0]!;
    expect(ab.objects.map((o) => o?.type ?? null)).toEqual([1, 2]);
    const m = ab.machines[0]!;
    expect(m.inputs.map((i) => (i ? i.type : null))).toEqual([59, null, 56]);
    expect(m.layers[0]!.states.map((s) => s.type)).toEqual([63, -1, 61, 61]);
    const md = riveMarkdown(r);
    expect(md).toContain("Inputs: `hover` (boolean, starts false), an input of a type this reader does not know, `level` (number, starts 0).");
    expect(md).toContain("- Entry → animation `B`, blend 0 ms (linear), when input 1 (a type this reader does not know) is true and `level` > 1");
  });

  it("escapes names in STYLE.md and RIVE.md so they cannot add markup, links or table columns", async () => {
    const evil = "Anim <b>bold</b> [c](https://evil.example) x|y *em*";
    const bytes = riv({
      objects: [
        [1, [[4, "string", "Main"]]],
        [2, [[4, "string", evil], [5, "uint", 0]]],
        [31, [[55, "string", evil], [56, "uint", 10], [57, "uint", 10]]],
        [25, [[51, "uint", 1]]],
        [26, [[53, "uint", 13]]],
        [30, [[67, "uint", 0], [68, "uint", 1], [70, "double", 0]]],
        [30, [[67, "uint", 10], [70, "double", 5]]],
        [25, [[51, "uint", 99]]],
      ],
    });
    const dir = tempDir();
    try {
      const path = join(dir, "evil.riv");
      writeFileSync(path, bytes);
      const r = await runExact({ source: path, root: dir, version: "test" });
      for (const file of [r.files.style!, r.files.rive!]) {
        const md = readFileSync(file, "utf8");
        // Outside code spans, nothing from the file may become HTML, a link, emphasis or a new table column.
        const prose = md.replace(/`[^`\n]*`/g, "");
        expect(prose).not.toMatch(/(^|[^\\])(<b>|\]\(|\*em)|https:\/\//);
      }
      const style = readFileSync(r.files.style!, "utf8");
      // The move row keeps its 6 columns: the pipe in the name is escaped.
      const row = style.split("\n").find((l) => l.startsWith("| 0.00–1.00 s"))!;
      expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
      expect(style).toContain("Anim \\<b\\>bold\\</b\\> \\[c\\](https:\\/\\/evil.example) x\\|y \\*em\\*");
      expect(readFileSync(r.files.rive!, "utf8")).toContain("- Anim \\<b\\>bold\\</b\\> \\[c\\](https:\\/\\/evil.example) x\\|y \\*em\\*: keys an object id 99");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("real Rive files (rive-app/rive-runtime test assets, MIT)", () => {
  it("cubic_value_test.riv: artboard, work area and the values Rive's own test expects", () => {
    const r = parseRive(fixture("cubic_value_test.riv"), { input: "cubic_value_test.riv" });
    const ab = r.model.artboards[0]!;
    expect(r.model.artboards).toHaveLength(1);
    expect([ab.name, ab.width, ab.height]).toEqual(["New Artboard", 500, 500]);
    const anim = ab.animations[0]!;
    expect([anim.name, anim.fps, anim.duration, anim.loop]).toEqual(["Timeline 1", 60, 60, 0]);
    expect(anim.workArea).toEqual({ start: 5, end: 53 });
    expect(r.model.typeCounts.get(138)).toBe(3); // three CubicValueInterpolators, as cubic_value_test.cpp requires
    const moves = r.analysis.moves.filter((m) => m.target === "grey_rectangle" && m.property === "position.x");
    // The runtime plays only the work area, frames 5–53: keyframes at 2–10 are cut at 5, 53–56 never play.
    // Spec frames are playback frames, so local frame f sits at f − 5.
    expect(moves.map((m) => [m.startFrame, m.endFrame])).toEqual([[0, 5], [5, 19], [19, 32], [32, 48]]);
    expect(r.analysis.end).toBe(0.8);
    expect(r.analysis.unknowns).toContain("Timeline 1: 1 keyframe segment(s) outside the work area, which the runtime never plays: left out");
    expect(moves[1]).toMatchObject({ from: [435.974], to: [333.981], curve: "cubic-bezier(0.174, 2.446, 0.58, 1)", evidence: "measured" });
    const at = (frame: number) => {
      const m = moves.find((x) => x.startFrame <= frame && frame <= x.endFrame)!;
      const p = (frame - m.startFrame) / (m.endFrame - m.startFrame);
      return Number(m.from[0]) + bezierAt(m.bezier!, p) * (Number(m.to[0]) - Number(m.from[0]));
    };
    // cubic_value_test.cpp: x is 290.71 at frame 15 and 363.01 at frame 11.
    expect(Math.abs(at(15 - 5) - 290.71)).toBeLessThan(0.3);
    expect(Math.abs(at(11 - 5) - 363.01)).toBeLessThan(0.3);
    // The cut segment is the same curve: its start value and its shape match the uncut keyframes 2–10.
    const original = (f: number) => 179.387 + bezierAt([0.42, 0, 0.58, 1], (f - 2) / 8) * (435.974 - 179.387);
    expect(Math.abs(Number(moves[0]!.from[0]) - original(5))).toBeLessThan(0.01);
    expect(moves[0]!.to).toEqual([435.974]);
    for (const f of [5.5, 7, 9]) expect(Math.abs(at(f - 5) - original(f))).toBeLessThan(0.3);
    expect(riveMarkdown(r)).toContain("| `New Artboard` | `Timeline 1` | 60 | 60 frames (1 s) | 0.08–0.88 s | one shot | 1× | 1 | 4 | 0 | 0–0.8 s |");
  });

  it("light_switch.riv: the state machine, its boolean input and the poses it blends between", () => {
    const r = parseRive(fixture("light_switch.riv"), { input: "light_switch.riv" });
    const ab = r.model.artboards[0]!;
    expect(ab.machines).toHaveLength(1);
    expect(ab.animations.map((a) => [a.name, a.duration, a.fps])).toEqual([["Off", 60, 60], ["On", 60, 60]]);
    const md = riveMarkdown(r);
    expect(md).toContain("### `Switch` (artboard `New Artboard`)");
    expect(md).toContain("Inputs: `On` (boolean, starts true). Listeners (pointer and event handlers): 1, not evaluated.");
    expect(md).toContain("- animation `Off` → animation `On`, blend 200 ms (linear), when `On` is true");
    expect(md).toContain("- animation `On` → animation `Off`, blend 200 ms (linear), when `On` is false");
    expect(md).toContain("- `Off`: `light` opacity = `0.2`");
    expect(md).toContain("- `On`: `light` opacity = `1`");
  });
});

describe("exact on a .riv, then export", () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes motion-spec.json, STYLE.md and RIVE.md, and export finds the workspace by the file's path", async () => {
    const path = join(FIXTURES, "cubic_value_test.riv");
    const r = await runExact({ source: path, root: dir, version: "test", exportTarget: "css" });
    expect(r.ws.id).toMatch(/^rive-/);
    expect(r.spec.source.kind).toBe("rive");
    expect(r.spec.events).toHaveLength(4);
    expect(r.spec.events[1]).toMatchObject({ suggestion: "cubic-bezier(0.174, 2.446, 0.58, 1)", evidence: "measured", property: "position.x" });
    expect(r.spec.timebase).toMatchObject({ fps: 60, width: 500, height: 500, duration: 0.8 });
    expect(r.spec.source.title).toBe("cubic_value_test"); // the file's name, not the default "New Artboard"
    expect(readFileSync(r.files.rive!, "utf8")).toContain("## State machines");
    expect(readFileSync(r.files.style!, "utf8")).toContain("cubic-bezier(0.174, 2.446, 0.58, 1)");
    expect(r.exported!.files.some((f) => f.endsWith(".css"))).toBe(true);
    expect(exactSummary(r)).toMatch(/Rive: 1 artboard\(s\), 1 animation\(s\) \(“Timeline 1”\), 1 state machine\(s\) \(“State Machine 1”\)/);

    const engine = new Engine({
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", exec: async () => ({ stdout: "", stderr: "" }) },
      resolve: async () => {
        throw new Error("must not resolve a .riv file as a video");
      },
      root: dir,
      logger: silentLogger,
    });
    const out = await engine.export(path, "remotion", "test");
    expect(out.ws.id).toBe(r.ws.id);
    expect(out.files.some((f) => f.endsWith("timing.ts"))).toBe(true);
    const timing = readFileSync(out.files.find((f) => f.endsWith("timing.ts"))!, "utf8");
    // The starter takes each scene's entrance from its first move: grey_rectangle's first 5 played frames.
    expect(timing).toMatch(/"enterAt": 0,\s+"enterFrames": 5/);
    expect(timing).toContain("DURATION_IN_FRAMES = 48;");
    expect(exportSpec(r.spec, "after-effects", join(dir, "ae"), { workspace: r.ws.dir }).length).toBeGreaterThan(0);
  });

  it("reads an extensionless link by its fingerprint and moves it under a rive workspace", async () => {
    const bytes = fixture("light_switch.riv");
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), json: async () => ({}) });
    const r = await runExact({ source: "https://example.com/files/switch", root: dir, version: "test", fetchImpl });
    expect(r.ws.id).toMatch(/^rive-/);
    expect(r.analysis.kind).toBe("rive");
    expect(readdirSync(join(r.ws.dir, "source"))[0]).toMatch(/\.riv$/);
    expect(existsSync(join(dir, r.ws.id.replace(/^rive-/, "lottie-")))).toBe(false);
  });

  it("accepts direct .riv links on rive.app hosts and refuses rive.app pages without fetching them", async () => {
    expect(riveLink("https://public.rive.app/community/runtime-files/2195-4346-avatar-pack.riv")).toBe(true);
    expect(riveLink("https://example.com/a/b.json")).toBe(false);
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      throw new Error("no");
    };
    await expect(runExact({ source: "https://rive.app/community/files/1234-cool-thing/", root: dir, version: "test", fetchImpl })).rejects.toThrow(/rive\.app link is a page, not a \.riv file/);
    await expect(runExact({ source: "https://editor.rive.app/file/abc", root: dir, version: "test", fetchImpl })).rejects.toThrow(/does not open Rive pages or sign in/);
    expect(fetched).toBe(false);
  });

  it("says so when a .riv link returns something else", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("<html>login</html>").buffer as ArrayBuffer, json: async () => ({}) });
    await expect(runExact({ source: "https://cdn.example.com/x.riv", root: dir, version: "test", fetchImpl })).rejects.toThrow(/is not a Rive file/);
  });
});

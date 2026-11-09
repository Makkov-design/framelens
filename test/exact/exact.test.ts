import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bezierFamily } from "../../src/exact/easing.js";
import { destinationIds, fetchFigma, parseFigma, parseFigmaUrl } from "../../src/exact/figma.js";
import { downloadFile, type FetchLike } from "../../src/exact/http.js";
import { loadLottieFile, parseLottie } from "../../src/exact/lottie.js";
import { FigmaTokenError, runExact } from "../../src/exact/run.js";
import { readZip } from "../../src/exact/zip.js";
import { exportSpec } from "../../src/export/exporters.js";
import type { MotionSpec } from "../../src/style/spec.js";

const lottie = {
  v: "5.7.0",
  nm: "Demo",
  fr: 30,
  ip: 0,
  op: 60,
  w: 400,
  h: 300,
  fonts: { list: [{ fName: "Inter-Bold", fFamily: "Inter", fStyle: "Bold" }] },
  layers: [
    {
      ty: 4,
      nm: "Box",
      ind: 1,
      ip: 0,
      op: 60,
      st: 0,
      sr: 1,
      ks: {
        p: {
          a: 1,
          k: [
            { t: 0, s: [50, 150, 0], e: [350, 150, 0], o: { x: [0.2], y: [0.8] }, i: { x: [0.3], y: [1] } },
            { t: 30, s: [350, 150, 0], h: 1 },
            { t: 45, s: [350, 50, 0] },
          ],
        },
        o: {
          a: 1,
          k: [
            { t: 0, s: [0], e: [100], o: { x: [0.167], y: [0.167] }, i: { x: [0.833], y: [0.833] } },
            { t: 20, s: [100] },
          ],
        },
      },
      shapes: [{ ty: "gr", nm: "Group", it: [{ ty: "rc", s: { a: 0, k: [100, 100] } }, { ty: "fl", c: { a: 0, k: [1, 0.2, 0.2, 1] } }] }],
    },
    {
      ty: 5,
      nm: "Title",
      ind: 2,
      ip: 0,
      op: 60,
      ks: { r: { a: 0, k: 0, x: "wiggle(2, 30)" }, p: { s: true, x: { a: 1, k: [{ t: 10, s: [10], e: [60], o: { x: 0.5, y: 0 }, i: { x: 0.5, y: 1 } }, { t: 40, s: [60] }] }, y: { a: 0, k: 20 } } },
      t: { d: { k: [{ t: 0, s: { s: 48, f: "Inter-Bold", t: "Hello", fc: [1, 1, 1] } }] } },
    },
  ],
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "framelens-exact-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const comp = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, n, comp);
    central.push(c, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe("lottie", () => {
  const a = parseLottie(lottie, { input: "demo.json" });

  it("reads the composition", () => {
    expect([a.fps, a.width, a.height, a.start, a.end]).toEqual([30, 400, 300, 0, 2]);
    expect(a.layerCount).toBe(2);
    expect(a.shots).toHaveLength(1);
  });

  it("emits eased position, hold and linear opacity moves with exact curves", () => {
    const pos = a.moves.filter((m) => m.target === "Box" && m.property === "position");
    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({ from: [50, 150, 0], to: [350, 150, 0], start: 0, end: 1, curve: "cubic-bezier(0.2, 0.8, 0.3, 1)", easing: "ease-out", evidence: "measured", hold: false });
    expect(pos[1]).toMatchObject({ hold: true, start: 1, end: 1.5, from: [350, 150, 0], to: [350, 50, 0], curve: "steps(1, end)" });
    const op = a.moves.find((m) => m.property === "opacity")!;
    expect(op).toMatchObject({ type: "fade in", easing: "linear", to: [100] });
  });

  it("reads split position and lists expressions as unknowns", () => {
    expect(a.moves.find((m) => m.property === "position.x")).toMatchObject({ target: "Title", from: [10], to: [60], start: 0.333, end: 1.333 });
    expect(a.unknowns.some((u) => u.includes("wiggle"))).toBe(true);
  });

  it("collects palette, text and fonts", () => {
    expect(a.palette.map((p) => p.hex)).toContain("#FF3333");
    expect(a.palette.map((p) => p.hex)).toContain("#FFFFFF");
    expect(a.texts[0]).toMatchObject({ text: "Hello", family: "Inter", size: 48, weight: 700, color: "#FFFFFF" });
    expect(a.fonts).toEqual(["Inter Bold"]);
  });

  it("maps precomp time and makes one shot per precomp layer", () => {
    const comp = {
      fr: 30, ip: 0, op: 90, w: 100, h: 100,
      assets: [{ id: "c1", layers: [{ ty: 4, nm: "Dot", ip: 0, op: 30, ks: { s: { a: 1, k: [{ t: 0, s: [0, 0], e: [100, 100], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } }, { t: 15, s: [100, 100] }] } }, shapes: [] }] }],
      layers: [{ ty: 0, nm: "Scene", refId: "c1", ip: 30, op: 90, st: 30, sr: 1, ks: {} }, { ty: 0, nm: "Intro", refId: "c1", ip: 0, op: 30, st: 0, sr: 1, ks: {} }],
    };
    const r = parseLottie(comp, { input: "c.json" });
    expect(r.shots).toMatchObject([{ id: "s1", name: "Intro", start: 0, end: 1 }, { id: "s2", name: "Scene", start: 1, end: 3 }]);
    expect(r.moves.find((m) => m.target === "Scene/Dot")).toMatchObject({ target: "Scene/Dot", start: 1, end: 1.5, easing: "ease-in-out" });
  });

  it("rejects non-Lottie JSON", () => {
    expect(() => parseLottie({ hello: 1 }, { input: "x" })).toThrow(/Lottie/);
  });

  it("classifies families", () => {
    expect(bezierFamily([0, 0, 1, 1])).toBe("linear");
    expect(bezierFamily([0.7, 0, 0.84, 0])).toBe("ease-in");
  });
});

describe("dotLottie and downloads", () => {
  it("reads a .lottie archive with a manifest", () => {
    const zip = makeZip({ "manifest.json": JSON.stringify({ animations: [{ id: "anim" }] }), "animations/anim.json": JSON.stringify(lottie) });
    expect([...readZip(zip).keys()]).toEqual(["manifest.json", "animations/anim.json"]);
    const file = join(dir, "x.lottie");
    writeFileSync(file, zip);
    const { json, entry } = loadLottieFile(file);
    expect(entry).toBe("animations/anim.json");
    expect(parseLottie(json, { input: file }).moves.length).toBeGreaterThan(0);
  });

  it("rejects non-zip bytes and links that are not http(s)", async () => {
    expect(() => readZip(Buffer.from("not a zip at all, just some text padding padding"))).toThrow(/ZIP/);
    await expect(downloadFile("file:///etc/passwd", dir)).rejects.toThrow(/http/);
  });

  it("downloads through the injected fetch", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(Buffer.from(JSON.stringify(lottie))).buffer, json: async () => lottie });
    const file = await downloadFile("https://assets.lottie.host/x/anim.json", join(dir, "dl"), fetchImpl);
    expect(existsSync(file)).toBe(true);
    expect(parseLottie(JSON.parse(readFileSync(file, "utf8")), { input: file }).fps).toBe(30);
  });
});

const rect = (x: number, y: number, w = 100, h = 40) => ({ x, y, width: w, height: h });
const home = {
  id: "1:1", name: "Home", type: "FRAME", absoluteBoundingBox: rect(0, 0, 375, 812),
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
  children: [
    {
      id: "1:3", name: "Button", type: "RECTANGLE", absoluteBoundingBox: rect(20, 700, 335, 48), cornerRadius: 8,
      fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 } }],
      reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "1:2", transition: { type: "SMART_ANIMATE", duration: 0.4, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0.8, x2: 0.2, y2: 1 } } } }] }],
    },
    { id: "1:4", name: "Label", type: "TEXT", characters: "Go", absoluteBoundingBox: rect(30, 40), style: { fontFamily: "Inter", fontWeight: 700, fontSize: 24 }, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] },
  ],
};
const detail = {
  id: "1:2", name: "Detail", type: "FRAME", absoluteBoundingBox: rect(500, 0, 375, 812),
  fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }],
  children: [{ id: "2:3", name: "Button", type: "RECTANGLE", absoluteBoundingBox: rect(500 + 20, 100, 335, 48), cornerRadius: 8, fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 } }] }],
};
const nodes = (...docs: object[]) => ({ nodes: Object.fromEntries(docs.map((d) => [(d as { id: string }).id, { document: d }])) });

describe("figma", () => {
  it("parses links", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/Name?node-id=12-34")).toEqual({ fileKey: "AbC123xyz", nodeId: "12:34" });
    expect(parseFigmaUrl("https://www.figma.com/proto/AbC123xyz/Name?node-id=1-2&starting-point-node-id=1-9").nodeId).toBe("1:2");
    expect(() => parseFigmaUrl("https://evil.example.com/design/AbC123xyz/x")).toThrow(/figma\.com/);
  });

  it("reads transitions, smart-animate diffs, palette and text", () => {
    const a = parseFigma(nodes(home, detail), { input: "x" });
    const t = a.moves.find((m) => m.property === "transition")!;
    expect(t).toMatchObject({ type: "SMART_ANIMATE", curve: "cubic-bezier(0.2, 0.8, 0.2, 1)", evidence: "measured", trigger: "ON_CLICK", start: 1, end: 1.4, to: ["Detail"] });
    expect(a.moves.find((m) => m.property === "y" && m.target === "Button")).toMatchObject({ from: [700], to: [100] });
    expect(a.moves.some((m) => m.property === "x")).toBe(false);
    expect(a.shots.map((s) => s.name)).toEqual(["Home", "Detail"]);
    expect(a.texts[0]).toMatchObject({ text: "Go", family: "Inter", weight: 700, size: 24 });
    expect(a.palette.map((p) => p.hex)).toContain("#0066FF");
    expect(a.unknowns.some((u) => /dwell/.test(u))).toBe(true);
  });

  it("accepts legacy interactions and millisecond durations", () => {
    const old = { ...home, children: [{ ...home.children[0]!, reactions: undefined, interactions: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 2 }, action: { type: "NODE", destinationId: "1:2", transition: { type: "DISSOLVE", duration: 300, easing: { type: "EASE_OUT" } } } }] }] };
    const a = parseFigma(nodes(old, detail), { input: "x" });
    const t = a.moves.find((m) => m.property === "transition")!;
    expect(t).toMatchObject({ start: 2, end: 2.3, evidence: "derived", trigger: "AFTER_TIMEOUT" });
  });

  it("reports springs", () => {
    const sp = { ...home, children: [{ ...home.children[0]!, reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:2", transition: { type: "MOVE_IN", direction: "LEFT", duration: 0.5, easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: 1, stiffness: 200, damping: 20 } } } }] }] }] };
    expect(parseFigma(nodes(sp, detail), { input: "x" }).moves[0]).toMatchObject({ curve: "spring(1, 200, 20)", type: "MOVE_IN LEFT", evidence: "measured" });
  });

  it("fetches with the token header, pulls missing destinations, and explains a missing token", async () => {
    const urls: string[] = [];
    let seenHeader = "";
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      seenHeader = init?.headers?.["X-Figma-Token"] ?? "";
      const body = url.includes("ids=1%3A2") ? nodes(detail) : nodes(home);
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => body };
    };
    await expect(fetchFigma("https://www.figma.com/design/AbC123xyz/N?node-id=1-1", undefined, fetchImpl)).rejects.toThrow(FigmaTokenError);
    const { json } = await fetchFigma("https://www.figma.com/design/AbC123xyz/N?node-id=1-1", "secret-token", fetchImpl);
    expect(seenHeader).toBe("secret-token");
    expect(urls[0]).toBe("https://api.figma.com/v1/files/AbC123xyz/nodes?ids=1%3A1&depth=6");
    expect(urls).toHaveLength(2);
    expect(destinationIds(json)).toEqual(["1:2"]);
    const err = await fetchFigma("https://www.figma.com/design/AbC123xyz/N?node-id=1-1", "secret-token", async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) })).catch((e: Error) => e.message);
    expect(err).toMatch(/403/);
    expect(err).not.toContain("secret-token");
  });
});

describe("spec writer and export", () => {
  it("writes motion-spec.json and STYLE.md, keeps hand-written text, and the existing exporters accept the spec", async () => {
    const file = join(dir, "demo.json");
    writeFileSync(file, JSON.stringify(lottie));
    const r = await runExact({ source: file, root: join(dir, "ws"), version: "test" });
    expect(r.ws.id).toMatch(/^lottie-[0-9a-f]{10}$/);
    const spec = JSON.parse(readFileSync(r.files.spec!, "utf8")) as MotionSpec;
    expect(spec.spec).toBe("framelens.motion/1");
    expect(spec.events.find((e) => (e as { property?: string }).property === "position")).toMatchObject({ kind: "move", evidence: "measured", suggestion: "cubic-bezier(0.2, 0.8, 0.3, 1)", frames: 30 });
    expect(spec.timebase).toMatchObject({ fps: 30, width: 400, height: 300, duration: 2, evidence: "measured" });
    // The file's own values are measured; counts and rates computed from them are derived.
    expect(spec.shots.every((s) => s.evidence === "measured")).toBe(true);
    expect(spec.rhythm.evidence).toBe("derived");
    expect((spec as unknown as { exact: { evidence: string; texts: { evidence: string }[] } }).exact).toMatchObject({ evidence: "measured", texts: [expect.objectContaining({ evidence: "measured" })] });
    const style = readFileSync(r.files.style!, "utf8");
    expect(style).toContain("cubic-bezier(0.2, 0.8, 0.3, 1)");
    expect(style).toContain("wiggle");
    writeFileSync(r.files.style!, style.replace("One sentence on the look", "MY NOTE: look"));
    await runExact({ source: file, root: join(dir, "ws"), version: "test" });
    expect(readFileSync(r.files.style!, "utf8")).toContain("MY NOTE");

    for (const target of ["hyperframes", "remotion", "css"] as const) {
      const out = join(dir, "out", target);
      const files = exportSpec(spec, target, out);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every(existsSync)).toBe(true);
    }
  });

  it("runs the figma path from figma_json and writes a starter", async () => {
    const r = await runExact({ figmaJson: nodes(home, detail), root: join(dir, "ws"), version: "test", exportTarget: "css" });
    expect(r.ws.id).toMatch(/^figma-[0-9a-f]{10}$/);
    expect(r.exported!.files.length).toBeGreaterThan(0);
  });

  it("needs a token for links and says how to get one", async () => {
    await expect(runExact({ source: "https://www.figma.com/design/AbC123xyz/N?node-id=1-1", root: join(dir, "ws"), version: "t", env: {} })).rejects.toThrow(/personal access token/);
  });
});

// Found before the 2.1.0 tag: `exact` on a video leaked a JSON parser error (Unexpected token ' ', "    ftypqt"...),
// and palettes listed one colour three times (#FFFFFF, #FEFFFF, #FEFEFE).
describe("videos and near-identical colours", () => {
  it("says a video or GIF is not an animation file and points to plan or style", async () => {
    const files: [string, Buffer, RegExp][] = [
      ["clip.mov", Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  \0\0\0\0qt  ")]), /QuickTime \(MOV\) video/],
      ["clip.json", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom\0\0\x02\0isomiso2")]), /an MP4 video/],
      ["clip.lottie", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), /a WebM video/],
      ["clip.riv", Buffer.concat([Buffer.from("RIFF\x10\0\0\0AVI LIST")]), /an AVI video/],
      ["loop.json", Buffer.from("GIF89a\x01\0\x01\0"), /a GIF animation/],
    ];
    for (const [name, bytes, kind] of files) {
      const file = join(dir, name);
      writeFileSync(file, bytes);
      const error = await runExact({ source: file, root: join(dir, "ws"), version: "test" }).then(() => undefined, (e: Error) => e);
      expect(error, name).toBeInstanceOf(Error);
      expect(error!.message, name).toMatch(kind);
      expect(error!.message, name).toMatch(/not a Lottie, Rive or Figma file[\s\S]*`plan`[\s\S]*`style`/);
      expect(error!.message, name).not.toMatch(/Unexpected token|JSON/);
    }
  });

  it("merges colours within a small OKLab distance and keeps distinct ones", async () => {
    const file = join(dir, "whites.json");
    const fill = (c: number[]) => ({ ty: 4, nm: "Box", ind: 1, ip: 0, op: 60, st: 0, sr: 1, ks: {}, shapes: [{ ty: "gr", it: [{ ty: "rc", s: { a: 0, k: [100, 100] } }, { ty: "fl", c: { a: 0, k: [...c, 1] } }] }] });
    const doc = { ...lottie, layers: [fill([1, 1, 1]), fill([254 / 255, 1, 1]), fill([254 / 255, 254 / 255, 254 / 255]), fill([250 / 255, 250 / 255, 250 / 255]), fill([0.2, 0.4, 1])] };
    writeFileSync(file, JSON.stringify(doc));
    const r = await runExact({ source: file, root: join(dir, "ws"), version: "test" });
    const hexes = r.analysis.palette.map((p) => p.hex);
    expect(hexes.filter((h) => /^#F[E-F]F[E-F]F[E-F]$/.test(h))).toHaveLength(1);
    expect(hexes).toContain("#FAFAFA");
    expect(hexes).toContain("#3366FF");
    expect(r.analysis.palette.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 2);
    for (const shot of r.analysis.shots) expect(shot.palette.filter((h) => /^#F[E-F]F[E-F]F[E-F]$/.test(h)).length).toBeLessThanOrEqual(1);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { bezierCss, bezierFamily, type Bezier } from "./easing.js";
import { readZip } from "./zip.js";
import type { ExactAnalysis, ExactMove, ExactShot, ExactText } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- Lottie files are untrusted JSON; every read below is guarded. */
type J = any;

const MAX_DEPTH = 8;
/**
 * Work limits for hostile files: precomps can reference each other (100 layers that each place the same 100-layer
 * precomp, eight deep, is 10^16 visits from a few kilobytes), groups can nest thousands deep, and a file can hold
 * millions of keyframes. Past a limit the rest is skipped and listed under unknowns.
 */
const MAX_LAYER_VISITS = 20_000;
const MAX_GROUP_DEPTH = 32;
const MAX_MOVES = 20_000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const arr = (v: unknown): number[] | undefined => (typeof v === "number" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : undefined);

function toHex(c: number[]): string {
  const scale = c.some((x, i) => i < 3 && x > 1) ? 1 : 255; // Almost every exporter writes 0–1; a few write 0–255.
  return `#${c
    .slice(0, 3)
    .map((x) => Math.max(0, Math.min(255, Math.round(x * scale))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Reads a .json or .lottie file (dotLottie zip) and returns the animation JSON plus the entry name for zips. */
export function loadLottieFile(path: string): { json: J; entry?: string; fontsFromZip: string[] } {
  if (!existsSync(path)) throw new Error(`"${path}" is not a file on this computer.`);
  const data = readFileSync(path);
  if (data.length > 2 && data[0] === 0x50 && data[1] === 0x4b) {
    const files = readZip(data);
    let name: string | undefined;
    const manifest = files.get("manifest.json");
    if (manifest) {
      try {
        const id = JSON.parse(manifest.toString("utf8"))?.animations?.[0]?.id;
        if (typeof id === "string") name = [`animations/${id}.json`, `a/${id}.json`].find((n) => files.has(n));
      } catch {
        // Fall through to the first animation file.
      }
    }
    name ??= [...files.keys()].find((n) => /^(animations|a)\/.+\.json$/.test(n));
    if (!name) throw new Error("This .lottie archive has no animation file (expected animations/<id>.json).");
    return { json: JSON.parse(files.get(name)!.toString("utf8")), entry: name, fontsFromZip: [...files.keys()].filter((n) => /^(fonts|f)\//.test(n)) };
  }
  return { json: JSON.parse(data.toString("utf8")), fontsFromZip: [] };
}

interface TimeMap {
  off: number;
  str: number;
}

interface Ctx {
  fr: number;
  W: number;
  H: number;
  moves: ExactMove[];
  unknowns: Set<string>;
  colors: Map<string, number>;
  sink: Map<string, number>;
  texts: ExactText[];
  assets: Map<string, J>;
  fontMap: Map<string, { family: string; style: string }>;
  layerCount: number;
  skippedPaths: number;
  /** Set when a work limit was reached. */
  truncated: Set<string>;
}

const rootFrame = (m: TimeMap, f: number) => m.off + f * m.str;

function addColor(ctx: Ctx, hex: string, weight: number) {
  ctx.colors.set(hex, (ctx.colors.get(hex) ?? 0) + weight);
  ctx.sink.set(hex, (ctx.sink.get(hex) ?? 0) + weight);
}

function typeLabel(property: string, from: (number | string)[], to: (number | string)[]): string {
  if (property === "opacity") {
    const a = Number(from[0]);
    const b = Number(to[0]);
    return b > a ? "fade in" : "fade out";
  }
  if (property.startsWith("position")) return "move";
  if (property.startsWith("scale")) return "scale";
  if (property.startsWith("rotation")) return "rotate";
  if (property === "fill" || property === "stroke") return "colour change";
  return property;
}

/** Emits one move per keyframe segment of an animated property; static properties emit nothing. */
function emit(ctx: Ctx, target: string, name: string, p: J, map: TimeMap, kind: "number" | "color" = "number") {
  if (!p || typeof p !== "object") return;
  if (typeof p.x === "string" && p.x.trim()) ctx.unknowns.add(`expression on ${target} ${name}: ${p.x.trim().replace(/\s+/g, " ").slice(0, 80)}`);
  const k = p.k;
  if (!(Array.isArray(k) && k.length && typeof k[0] === "object" && k[0] !== null && "t" in k[0])) return;
  for (let i = 0; i < k.length; i++) {
    if (ctx.moves.length >= MAX_MOVES) {
      ctx.truncated.add(`more than ${MAX_MOVES} keyframe segments: the rest are not listed`);
      return;
    }
    const kf = k[i];
    const next = k[i + 1];
    if (!next || typeof kf.t !== "number" || typeof next.t !== "number") continue;
    const from = arr(kf.s);
    if (!from) continue;
    const to = arr(kf.e) ?? arr(next.s) ?? from;
    const hold = kf.h === 1;
    const same = from.length === to.length && from.every((v, j) => Math.abs(v - to[j]!) < 1e-9);
    if (same) continue;
    let bezier: Bezier | undefined;
    if (!hold && kf.o && kf.i) {
      const o = (v: J) => (Array.isArray(v) ? v[0] : v);
      const ox = o(kf.o.x);
      const oy = o(kf.o.y);
      const ix = o(kf.i.x);
      const iy = o(kf.i.y);
      if ([ox, oy, ix, iy].every((v) => typeof v === "number")) bezier = [Math.max(0, Math.min(1, ox)), oy, Math.max(0, Math.min(1, ix)), iy].map(r3) as Bezier;
    }
    const f0 = rootFrame(map, kf.t);
    const f1 = rootFrame(map, next.t);
    const conv = (v: number[]): (number | string)[] => (kind === "color" ? [toHex(v)] : v.map(r3));
    const fromV = conv(from);
    const toV = conv(to);
    const dims = name === "position" && from.length >= 2 ? name : name;
    ctx.moves.push({
      target,
      property: dims,
      start: r3(f0 / ctx.fr),
      end: r3(f1 / ctx.fr),
      startFrame: r3(f0),
      endFrame: r3(f1),
      from: fromV,
      to: toV,
      hold,
      ...(bezier && { bezier }),
      curve: hold ? "steps(1, end)" : bezier ? bezierCss(bezier) : "linear",
      easing: hold ? "linear" : bezier ? bezierFamily(bezier) : "linear",
      type: hold ? `hold (${typeLabel(name, fromV, toV)})` : typeLabel(name, fromV, toV),
      evidence: "measured",
    });
  }
}

const TRANSFORM_PROPS: [string, string][] = [["p", "position"], ["a", "anchor"], ["s", "scale"], ["r", "rotation"], ["o", "opacity"], ["sk", "skew"]];

function emitTransform(ctx: Ctx, target: string, ks: J, map: TimeMap) {
  if (!ks) return;
  for (const [key, name] of TRANSFORM_PROPS) {
    const p = ks[key];
    if (key === "p" && p?.s === true) {
      emit(ctx, target, "position.x", p.x, map);
      emit(ctx, target, "position.y", p.y, map);
      if (p.z) emit(ctx, target, "position.z", p.z, map);
    } else {
      emit(ctx, target, name, p, map);
    }
  }
}

const SHAPE_PROPS: Record<string, [string, string][]> = {
  rc: [["s", "size"], ["p", "position"], ["r", "roundness"]],
  el: [["s", "size"], ["p", "position"]],
  tm: [["s", "trim.start"], ["e", "trim.end"], ["o", "trim.offset"]],
  tr: TRANSFORM_PROPS,
};

function firstColor(c: J): number[] | undefined {
  const k = c?.k;
  if (Array.isArray(k) && k.length && typeof k[0] === "object") return arr(k[0].s);
  return arr(k);
}

function walkShapes(items: J[], target: string, weight: number, map: TimeMap, ctx: Ctx, depth = 0) {
  if (!Array.isArray(items)) return;
  if (depth > MAX_GROUP_DEPTH) {
    ctx.truncated.add(`shape groups nested more than ${MAX_GROUP_DEPTH} deep: inner groups not read`);
    return;
  }
  let area: number | undefined;
  for (const it of items) {
    if ((it?.ty === "rc" || it?.ty === "el") && it.s?.a !== 1) {
      const s = arr(it.s?.k);
      if (s && s.length >= 2) area = (s[0]! * s[1]!) / (ctx.W * ctx.H);
    }
  }
  const shapeWeight = weight * Math.min(1, area ?? 0.05); // Unknown geometry (paths) counts as a small shape: approximate.
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const here = `${target}/${it.nm ?? it.ty}`;
    if (it.ty === "gr") {
      walkShapes(it.it ?? [], here, weight, map, ctx, depth + 1);
    } else if (it.ty === "fl" || it.ty === "st") {
      const rgb = firstColor(it.c);
      if (rgb && rgb.length >= 3) addColor(ctx, toHex(rgb), it.ty === "fl" ? shapeWeight : shapeWeight * 0.1);
      emit(ctx, here, it.ty === "fl" ? "fill" : "stroke", it.c, map, "color");
      emit(ctx, here, `${it.ty === "fl" ? "fill" : "stroke"}-opacity`, it.o, map);
      if (it.ty === "st") emit(ctx, here, "stroke-width", it.w, map);
    } else if (it.ty === "gf" || it.ty === "gs") {
      ctx.unknowns.add(`gradient ${it.ty === "gf" ? "fill" : "stroke"} on ${here}: colours not read`);
    } else if (it.ty === "sh") {
      if (it.ks?.a === 1) ctx.skippedPaths++;
    } else if (SHAPE_PROPS[it.ty]) {
      for (const [key, name] of SHAPE_PROPS[it.ty]!) {
        if (it.ty === "tr" && key === "p" && it.p?.s === true) {
          emit(ctx, here, "position.x", it.p.x, map);
          emit(ctx, here, "position.y", it.p.y, map);
        } else {
          emit(ctx, here, name, it[key], map);
        }
      }
    }
  }
}

function weightFromStyle(style: string): number | undefined {
  const s = style.toLowerCase();
  const table: [RegExp, number][] = [[/thin|hairline/, 100], [/extra.?light|ultra.?light/, 200], [/light/, 300], [/semi.?bold|demi/, 600], [/extra.?bold|ultra.?bold|heavy/, 800], [/black/, 900], [/bold/, 700], [/medium/, 500], [/regular|normal|book|roman/, 400]];
  return table.find(([re]) => re.test(s))?.[1];
}

function readText(layer: J, target: string, weight: number, ctx: Ctx) {
  const docs = layer.t?.d?.k;
  if (!Array.isArray(docs)) return;
  if (docs.length > 1) ctx.unknowns.add(`text content changes over time on ${target} (${docs.length} states; all listed)`);
  if (Array.isArray(layer.t?.a) && layer.t.a.length) ctx.unknowns.add(`text animators on ${target}: per-character motion not converted`);
  for (const d of docs) {
    const s = d?.s;
    if (!s || typeof s.t !== "string") continue;
    const font = ctx.fontMap.get(s.f);
    const fc = arr(s.fc);
    const color = fc && fc.length >= 3 ? toHex(fc) : undefined;
    if (color) addColor(ctx, color, weight * 0.05);
    ctx.texts.push({
      text: s.t.slice(0, 200),
      ...(font?.family || s.f ? { family: font?.family ?? s.f } : {}),
      ...(typeof s.s === "number" && { size: s.s }),
      ...(font && weightFromStyle(font.style) ? { weight: weightFromStyle(font.style)! } : {}),
      ...(color && { color }),
      ...(s.ca === 1 ? { case: "upper" } : {}),
      where: target,
    });
  }
}

function walkLayers(layers: J[], map: TimeMap, prefix: string, depth: number, ctx: Ctx, root?: { shots: ExactShot[]; precompShots: ExactShot[] }) {
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    if (ctx.layerCount >= MAX_LAYER_VISITS) {
      ctx.truncated.add(`more than ${MAX_LAYER_VISITS} layers (precomps included): the rest are not read`);
      return;
    }
    ctx.layerCount++;
    const name = `${prefix}${layer.nm ?? `layer ${layer.ind ?? ctx.layerCount}`}`;
    const ip = typeof layer.ip === "number" ? layer.ip : 0;
    const op = typeof layer.op === "number" ? layer.op : ip;
    const span = Math.max(0, op - ip) * map.str;
    const weight = span / Math.max(1, ctx.fr * 1); // Weight by seconds on screen; normalised at the end.
    const before = ctx.sink;
    if (root) ctx.sink = new Map();

    emitTransform(ctx, name, layer.ks, map);
    if (layer.ef?.length) ctx.unknowns.add(`effects on ${name} (${layer.ef.length}) are not read`);
    if (layer.tm) ctx.unknowns.add(`time remapping on ${name}`);
    if (layer.ddd === 1) ctx.unknowns.add(`3D layer ${name}: depth not read`);

    switch (layer.ty) {
      case 1: {
        if (typeof layer.sc === "string" && /^#[0-9a-f]{6}$/i.test(layer.sc)) addColor(ctx, layer.sc.toUpperCase(), (weight * (layer.sw * layer.sh)) / (ctx.W * ctx.H) || 0);
        break;
      }
      case 4:
        walkShapes(layer.shapes ?? [], name, weight, map, ctx);
        break;
      case 5:
        readText(layer, name, weight, ctx);
        break;
      case 0: {
        const asset = ctx.assets.get(layer.refId);
        if (Array.isArray(asset?.layers) && depth < MAX_DEPTH) {
          walkLayers(asset.layers, { off: map.off + (layer.st ?? 0) * map.str, str: map.str * (layer.sr ?? 1) }, `${name}/`, depth + 1, ctx);
        } else if (!asset) {
          ctx.unknowns.add(`precomp ${name} points at missing asset ${layer.refId}`);
        }
        break;
      }
      case 2:
        ctx.unknowns.add(`image layer ${name}: bitmap colours not read`);
        break;
      default:
    }

    if (root) {
      const start = r3(rootFrame(map, ip) / ctx.fr);
      const end = r3(rootFrame(map, op) / ctx.fr);
      const shot: ExactShot = { id: "", name, start, end, palette: topColors(ctx.sink) };
      if (layer.ty === 0 && end > start) root.precompShots.push(shot);
      ctx.sink = before;
    }
  }
}

const dimension = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100_000 ? Math.round(v) : undefined);

function topColors(m: Map<string, number>, n = 4): string[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([hex]) => hex);
}

export function parseLottie(j: J, meta: { input: string; url?: string; title?: string; entry?: string; fontFiles?: string[] }): ExactAnalysis {
  if (!j || typeof j !== "object" || !Array.isArray(j.layers) || typeof j.fr !== "number") {
    throw new Error("This does not look like a Lottie file (expected fr, layers, ip, op, w, h).");
  }
  const fr = j.fr > 0 && j.fr <= 1000 ? j.fr : 30;
  const ip = typeof j.ip === "number" ? j.ip : 0;
  const op = typeof j.op === "number" ? j.op : ip;
  const fontMap = new Map<string, { family: string; style: string }>();
  const fonts: string[] = [];
  for (const f of j.fonts?.list ?? []) {
    if (f?.fName) fontMap.set(f.fName, { family: f.fFamily ?? f.fName, style: f.fStyle ?? "" });
    fonts.push([f?.fFamily ?? f?.fName, f?.fStyle].filter(Boolean).join(" "));
  }
  const ctx: Ctx = {
    fr,
    W: dimension(j.w) ?? 1,
    H: dimension(j.h) ?? 1,
    moves: [],
    unknowns: new Set(),
    colors: new Map(),
    sink: new Map(),
    texts: [],
    assets: new Map((j.assets ?? []).filter((a: J) => a?.id !== undefined).map((a: J) => [a.id, a])),
    fontMap,
    layerCount: 0,
    skippedPaths: 0,
    truncated: new Set(),
  };
  const root = { shots: [] as ExactShot[], precompShots: [] as ExactShot[] };
  walkLayers(j.layers, { off: 0, str: 1 }, "", 0, ctx, root);
  if (ctx.skippedPaths) ctx.unknowns.add(`${ctx.skippedPaths} animated path shape(s): morphing is not converted`);
  for (const note of ctx.truncated) ctx.unknowns.add(note);
  if (meta.fontFiles?.length) fonts.push(...meta.fontFiles.map((f) => `embedded ${f}`));

  const start = r3(ip / fr);
  const end = r3(op / fr);
  // One precomp is not a sequence of shots; use the whole composition then.
  const shots: ExactShot[] = root.precompShots.length > 1
    ? root.precompShots
    : [{ id: "", name: j.nm ?? "Composition", start, end, palette: topColors(ctx.colors) }];
  shots.sort((a, b) => a.start - b.start);
  shots.forEach((s, i) => (s.id = `s${i + 1}`));

  const total = [...ctx.colors.values()].reduce((s, v) => s + v, 0) || 1;
  const palette = [...ctx.colors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, w]) => ({ hex, share: r3(w / total) }));
  ctx.moves.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    kind: "lottie",
    title: String(j.nm ?? meta.title ?? meta.input).slice(0, 200),
    input: meta.input,
    ...(meta.url && { url: meta.url }),
    fps: fr,
    // Only numbers: these are written into generated After Effects and Remotion code.
    ...(dimension(j.w) && { width: dimension(j.w) }),
    ...(dimension(j.h) && { height: dimension(j.h) }),
    start,
    end,
    shots,
    moves: ctx.moves,
    palette,
    texts: ctx.texts,
    fonts: [...new Set(fonts)],
    unknowns: [...ctx.unknowns],
    layerCount: ctx.layerCount,
  };
}

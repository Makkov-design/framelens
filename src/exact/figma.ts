import { bezierCss, bezierFamily, type Bezier } from "./easing.js";
import { getJson, type FetchLike } from "./http.js";
import type { ExactAnalysis, ExactMove, ExactShot, ExactText } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma JSON is untrusted; every read below is guarded. */
type J = any;

export const FIGMA_TOKEN_HELP =
  "Reading a Figma prototype needs a personal access token. Create one in Figma: Settings → Security → Personal access tokens → " +
  "Generate new token, with the read-only scope \"File content: Read\" (file_content:read) and nothing else. Put it in the " +
  "environment as FIGMA_TOKEN where Frame Lens runs and restart the client; the token is never logged. " +
  "Alternative without a token: in Claude Code, call the Figma MCP tool get_motion_context for the frame and pass its JSON output as `figma_json`.";

export function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Not a link. Pass a figma.com/design/…?node-id=… or figma.com/proto/… URL.");
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error("Only figma.com links are accepted.");
  const parts = u.pathname.split("/").filter(Boolean);
  const kind = parts.findIndex((p) => ["file", "design", "proto", "board", "make"].includes(p));
  if (kind < 0 || !parts[kind + 1]) throw new Error("Could not find the file key in this Figma link.");
  // Branch links: /design/:fileKey/branch/:branchKey/:name → the branch key is the file key.
  const fileKey = parts[kind + 2] === "branch" && parts[kind + 3] ? parts[kind + 3]! : parts[kind + 1]!;
  if (!/^[A-Za-z0-9]{6,64}$/.test(fileKey)) throw new Error("The file key in this link looks invalid.");
  const raw = u.searchParams.get("node-id") ?? u.searchParams.get("starting-point-node-id");
  const nodeId = raw ? raw.replace(/-/g, ":") : undefined;
  return { fileKey, ...(nodeId && { nodeId }) };
}

/** Every destination node id mentioned by a reaction, so the fetch can pull frames that were not in the first answer. */
export function destinationIds(json: J): string[] {
  const out = new Set<string>();
  walk(rootsOf(json), (n) => {
    for (const r of reactionsOf(n)) for (const a of actionsOf(r)) if (typeof a.destinationId === "string") out.add(a.destinationId);
  });
  return [...out];
}

/** REST: GET /v1/files/:key/nodes?ids=…&depth=…, plus one more call for destination frames outside the first answer. */
export async function fetchFigma(
  url: string,
  token: string | undefined,
  fetchImpl?: FetchLike,
  depth = 6,
): Promise<{ json: J; fileKey: string }> {
  if (!token) throw new FigmaTokenError(FIGMA_TOKEN_HELP);
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const headers = { "X-Figma-Token": token };
  const base = `https://api.figma.com/v1/files/${fileKey}`;
  const call = async (path: string) => {
    const { status, body } = await getJson(`${base}${path}`, headers, fetchImpl);
    if (status === 403) throw new Error("Figma refused the token (403). Check that FIGMA_TOKEN is valid, not expired, and has the file_content:read scope, and that you can open this file.");
    if (status === 404) throw new Error("Figma says the file or node was not found (404). Check the link and the node-id.");
    if (status === 429) throw new Error("Figma rate limit reached (429). Wait a minute and try again.");
    if (status < 200 || status >= 300 || !body || typeof body !== "object") throw new Error(`Figma request failed with HTTP ${status}.`);
    return body as J;
  };
  const first = await call(nodeId ? `/nodes?ids=${encodeURIComponent(nodeId)}&depth=${depth}` : `?depth=${Math.min(depth, 3)}`);
  const known = new Set<string>();
  walk(rootsOf(first), (n) => n.id && known.add(n.id));
  const missing = destinationIds(first).filter((id) => !known.has(id)).slice(0, 20);
  if (missing.length && first.nodes) {
    const more = await call(`/nodes?ids=${encodeURIComponent(missing.join(","))}&depth=${depth}`);
    Object.assign(first.nodes, more.nodes ?? {});
  }
  return { json: first, fileKey };
}

export class FigmaTokenError extends Error {
  override name = "FigmaTokenError";
}

/* ---------- parsing ---------- */

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const hex2 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, "0");
const colorHex = (c: J) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();

function rootsOf(json: J): J[] {
  if (!json || typeof json !== "object") return [];
  if (json.nodes && typeof json.nodes === "object") return Object.values(json.nodes).map((v: J) => v?.document ?? v).filter(Boolean);
  if (json.document) return [json.document];
  if (Array.isArray(json)) return json;
  return [json];
}

function walk(roots: J[], fn: (n: J, parents: J[]) => void, limit = { n: 50_000 }) {
  const visit = (n: J, parents: J[]) => {
    if (!n || typeof n !== "object" || limit.n-- <= 0 || parents.length > 60) return;
    fn(n, parents);
    if (Array.isArray(n.children)) for (const c of n.children) visit(c, [...parents, n]);
  };
  for (const r of roots) visit(r, []);
}

const reactionsOf = (n: J): J[] => (Array.isArray(n.reactions) ? n.reactions : Array.isArray(n.interactions) ? n.interactions : []);
const actionsOf = (r: J): J[] => (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []);

const SPRINGS: Record<string, [number, number, number]> = { GENTLE: [1, 100, 15], QUICK: [1, 300, 20], BOUNCY: [1, 600, 15], SLOW: [1, 80, 20] };
/** Figma's named curves are not in the REST data; these are the usual CSS-style equivalents (marked derived). */
const PRESETS: Record<string, Bezier> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

function readEasing(e: J): Pick<ExactMove, "bezier" | "curve" | "easing" | "evidence"> & { note?: string } {
  const type = String(e?.type ?? "EASE_OUT");
  const cb = e?.easingFunctionCubicBezier;
  if (cb && [cb.x1, cb.y1, cb.x2, cb.y2].every((v: unknown) => typeof v === "number")) {
    const b = [cb.x1, cb.y1, cb.x2, cb.y2].map(r3) as Bezier;
    return { bezier: b, curve: bezierCss(b), easing: bezierFamily(b), evidence: "measured" };
  }
  const sp = e?.easingFunctionSpring ?? (SPRINGS[type] && { mass: SPRINGS[type]![0], stiffness: SPRINGS[type]![1], damping: SPRINGS[type]![2] });
  if (sp && typeof sp.stiffness === "number") {
    const named = SPRINGS[type] && !e?.easingFunctionSpring;
    return { curve: `spring(${sp.mass ?? 1}, ${sp.stiffness}, ${sp.damping})`, easing: "ease-out", evidence: named ? "derived" : "measured" };
  }
  const b = PRESETS[type] ?? PRESETS.EASE_OUT!;
  return { bezier: b, curve: bezierCss(b), easing: bezierFamily(b), evidence: "derived", note: type };
}

interface Flat {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  fill?: string;
  rotation: number;
  radius: number;
}

function solid(n: J): { hex: string; a: number } | undefined {
  const f = (Array.isArray(n.fills) ? n.fills : []).find((x: J) => x?.type === "SOLID" && x.visible !== false && x.color);
  return f ? { hex: colorHex(f.color), a: (f.opacity ?? 1) * (f.color.a ?? 1) } : undefined;
}

/** Layers of a frame keyed by name path, positioned relative to the frame: what Smart Animate matches on. */
function flatten(frame: J): Map<string, Flat> {
  const out = new Map<string, Flat>();
  const o = frame.absoluteBoundingBox ?? { x: 0, y: 0 };
  const seen = new Map<string, number>();
  const visit = (n: J, path: string, depth: number) => {
    if (depth > 40 || out.size > 5000) return;
    for (const c of Array.isArray(n.children) ? n.children : []) {
      let key = `${path}/${c.name ?? c.type}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) key += `#${count}`;
      const b = c.absoluteBoundingBox;
      if (b) {
        out.set(key, {
          x: r3(b.x - o.x),
          y: r3(b.y - o.y),
          w: r3(b.width),
          h: r3(b.height),
          opacity: r3(c.opacity ?? 1),
          ...(solid(c) && { fill: solid(c)!.hex }),
          rotation: r3(c.rotation ?? 0),
          radius: r3(c.cornerRadius ?? 0),
        });
      }
      visit(c, key, depth + 1);
    }
  };
  visit(frame, "", 0);
  return out;
}

function textStyle(n: J, where: string): ExactText | undefined {
  if (n.type !== "TEXT" || typeof n.characters !== "string") return undefined;
  const s = n.style ?? {};
  const fill = solid(n);
  return {
    text: n.characters.slice(0, 200),
    ...(s.fontFamily && { family: s.fontFamily }),
    ...(typeof s.fontSize === "number" && { size: s.fontSize }),
    ...(typeof s.fontWeight === "number" && { weight: s.fontWeight }),
    ...(fill && { color: fill.hex }),
    ...(s.textCase && s.textCase !== "ORIGINAL" ? { case: String(s.textCase).toLowerCase() } : {}),
    where,
  };
}

export function parseFigma(json: J, meta: { input: string; url?: string; title?: string }): ExactAnalysis {
  const roots = rootsOf(json);
  if (!roots.length) throw new Error("No Figma nodes found in this JSON (expected a /v1/files/:key/nodes response or a node).");

  const byId = new Map<string, J>();
  const topOf = new Map<string, J>(); // node id → the top-level frame it lives in
  const frames: J[] = [];
  const owners: { node: J; top: J }[] = [];
  const isFrameLike = (n: J) => ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"].includes(n.type);
  walk(roots, (n, parents) => {
    if (n.id) byId.set(n.id, n);
    const top = [...parents, n].find((p, i) => isFrameLike(p) && (i === 0 || parents[i - 1]?.type === "CANVAS" || parents[i - 1]?.type === "DOCUMENT" || parents[i - 1]?.type === "SECTION"));
    const frame = top ?? [...parents, n].find(isFrameLike);
    if (frame?.id) topOf.set(n.id ?? "", frame);
    if (frame && !frames.includes(frame) && frame === n) frames.push(n);
    if (reactionsOf(n).length && frame) owners.push({ node: n, top: frame });
  });
  if (!frames.length) for (const r of roots) if (isFrameLike(r)) frames.push(r);

  // Flow order: start at the first frame that has interactions (else the first frame), follow transitions.
  const order: J[] = [];
  const queue: J[] = [owners[0]?.top ?? frames[0]].filter(Boolean);
  const outgoing = (f: J) => owners.filter((o) => o.top === f);
  while (queue.length && order.length < 60) {
    const f = queue.shift()!;
    if (order.includes(f)) continue;
    order.push(f);
    for (const o of outgoing(f)) for (const r of reactionsOf(o.node)) for (const a of actionsOf(r)) {
      const dest = byId.get(a.destinationId);
      const destTop = dest && (topOf.get(dest.id) ?? dest);
      if (destTop && !order.includes(destTop)) queue.push(destTop);
    }
  }
  for (const f of frames) if (!order.includes(f) && order.length < 60) order.push(f);

  const moves: ExactMove[] = [];
  const unknowns = new Set<string>();
  const fps = 60;
  const shots: ExactShot[] = [];
  const colors = new Map<string, number>();
  const texts: ExactText[] = [];
  const fontSet = new Set<string>();
  let cursor = 0;
  const frameBox = (f: J) => f.absoluteBoundingBox ?? { width: f.size?.x ?? 0, height: f.size?.y ?? 0 };

  for (const f of order) {
    const sink = new Map<string, number>();
    walk([f], (n) => {
      const b = n.absoluteBoundingBox;
      const fill = solid(n);
      if (fill && b) {
        const w = (b.width * b.height) * fill.a;
        colors.set(fill.hex, (colors.get(fill.hex) ?? 0) + w);
        sink.set(fill.hex, (sink.get(fill.hex) ?? 0) + w);
      }
      const t = textStyle(n, `${f.name}/${n.name}`);
      if (t) {
        texts.push(t);
        if (t.family) fontSet.add(`${t.family}${t.weight ? ` ${t.weight}` : ""}`);
      }
    });

    const outs = outgoing(f);
    const timeouts = outs.flatMap((o) => reactionsOf(o.node)).map((r) => r.trigger).filter((t: J) => t?.type === "AFTER_TIMEOUT" && typeof t.timeout === "number").map((t: J) => t.timeout as number);
    const dwell = timeouts.length ? Math.min(...timeouts) : 1;
    const start = cursor;
    let advance = dwell;
    for (const o of outs) for (const r of reactionsOf(o.node)) for (const a of actionsOf(r)) {
      const tr = a.transition;
      if (!tr || typeof tr !== "object") {
        if (a.destinationId) unknowns.add(`${o.node.name} → ${byId.get(a.destinationId)?.name ?? a.destinationId}: instant navigation, no transition`);
        continue;
      }
      const raw = typeof tr.duration === "number" ? tr.duration : 0.3;
      const seconds = raw < 20 ? raw : raw / 1000; // REST data carries seconds; some exports carry milliseconds.
      const e = readEasing(tr.easing);
      if (e.note) unknowns.add(`${e.note}: Figma's named curve is not in the data; the usual equivalent is used (derived)`);
      const dest = byId.get(a.destinationId);
      const destName = dest?.name ?? a.destinationId ?? "(unknown)";
      const trigger = String(r.trigger?.type ?? "ON_CLICK");
      const at = start + dwell;
      const kind = String(tr.type ?? "DISSOLVE");
      const label = `${kind}${tr.direction ? ` ${tr.direction}` : ""}`;
      const base = { start: r3(at), end: r3(at + seconds), startFrame: Math.round(at * fps), endFrame: Math.round((at + seconds) * fps), hold: false, trigger, ...e, evidence: e.evidence };
      delete (base as { note?: string }).note;
      moves.push({ ...base, target: `${o.node.name} → ${destName}`, property: "transition", from: [String(f.name)], to: [String(destName)], type: label });
      if (kind === "SMART_ANIMATE" && dest) {
        const destTop = topOf.get(dest.id) ?? dest;
        const A = flatten(f);
        const B = flatten(destTop);
        for (const [path, a1] of A) {
          const b1 = B.get(path);
          if (!b1) continue;
          const diff = (prop: string, x: number | string | undefined, y: number | string | undefined) => {
            if (x === undefined || y === undefined || x === y) return;
            moves.push({ ...base, target: `${path.slice(1)}`, property: prop, from: [x], to: [y], type: `smart animate ${prop}` });
          };
          diff("x", a1.x, b1.x);
          diff("y", a1.y, b1.y);
          diff("width", a1.w, b1.w);
          diff("height", a1.h, b1.h);
          diff("opacity", a1.opacity, b1.opacity);
          diff("fill", a1.fill, b1.fill);
          diff("rotation", a1.rotation, b1.rotation);
          diff("cornerRadius", a1.radius, b1.radius);
        }
      }
      advance = Math.max(advance, dwell + seconds);
    }
    const end = start + advance;
    shots.push({ id: "", name: String(f.name ?? f.id), start: r3(start), end: r3(end), palette: [...sink.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h) });
    cursor = end;
  }
  shots.forEach((s, i) => (s.id = `s${i + 1}`));
  if (!moves.length) unknowns.add("no prototype transitions were found: the frames have no reactions/interactions with a transition");
  unknowns.add("Prototype transitions are user-triggered; the timeline places each frame after the previous one with a 1 s dwell (or its AFTER_TIMEOUT), which is a layout of the flow, not a recorded time");

  const total = [...colors.values()].reduce((s, v) => s + v, 0) || 1;
  const palette = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex, w]) => ({ hex, share: r3(w / total) }));
  const box = order[0] ? frameBox(order[0]) : undefined;
  return {
    kind: "figma",
    title: String(meta.title ?? order[0]?.name ?? meta.input).slice(0, 200),
    input: meta.input,
    ...(meta.url && { url: meta.url }),
    fps,
    ...(box?.width && { width: Math.round(box.width), height: Math.round(box.height) }),
    start: 0,
    end: r3(cursor),
    shots,
    moves: moves.sort((a, b) => a.start - b.start),
    palette,
    texts,
    fonts: [...fontSet],
    unknowns: [...unknowns],
    layerCount: byId.size,
  };
}

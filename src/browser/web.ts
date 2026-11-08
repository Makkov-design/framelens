import type { EasingFamily } from "../style/motion.js";
import { EASING_SUGGESTIONS } from "../style/motion.js";
import { bezierFamily, type Bezier } from "../exact/easing.js";
import { oneLine, safeHex } from "../text.js";
import type { Swatch } from "../style/palette.js";
import type { MotionSpec } from "../style/spec.js";

/** What the page script reports for one running animation (CSS animation, CSS transition, WAAPI or GSAP). */
export interface PageAnimation {
  kind: "css-animation" | "css-transition" | "waapi" | "gsap";
  name: string;
  target: string;
  /** Milliseconds. */
  delay: number;
  duration: number;
  iterations: number | "infinite";
  direction?: string;
  easing: string;
  /** Per-keyframe easing for CSS animations, where the curve lives. */
  keyframes: { offset: number | null; easing?: string; [property: string]: unknown }[];
  properties: string[];
  scrollY: number;
  scrollTriggered?: boolean;
}

export interface PageReading {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollHeight: number;
  animations: PageAnimation[];
  fonts: { selector: string; family: string; weight: string; size: string; lineHeight: string; letterSpacing: string; transform: string; sample: string }[];
  colors: { hex: string; area: number }[];
  gsap: boolean;
}

/**
 * Runs in the page. Reads every animation the browser knows about (document.getAnimations covers CSS animations,
 * transitions and WAAPI, including Motion's hardware-accelerated ones), GSAP tweens when `window.gsap` is exposed,
 * the computed type of headings and text, and the colours on screen weighted by area.
 */
export const PAGE_SCRIPT = `(() => {
  const short = (el) => {
    if (!el || !el.tagName) return "?";
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + el.id;
    const cls = [...(el.classList || [])].slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
    }
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.tagName && parts.length < 3; e = e.parentElement) parts.unshift(short(e));
    return parts.join(" > ");
  };
  const keep = ["transform", "opacity", "translate", "scale", "rotate", "filter", "clipPath", "clip-path", "color", "backgroundColor", "background-color", "offsetDistance", "width", "height", "top", "left", "letterSpacing", "strokeDashoffset"];
  // The page owns every object read here and may have replaced any of them; one part that throws must not lose
  // the others.
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  };
  const animations = safe(() => [...document.getAnimations()].slice(0, 500), []).map((a) => safe(() => {
    const effect = a.effect;
    const timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : {};
    const frames = effect && effect.getKeyframes ? effect.getKeyframes() : [];
    const props = [...new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k))))];
    const kind = a.constructor.name === "CSSAnimation" ? "css-animation" : a.constructor.name === "CSSTransition" ? "css-transition" : "waapi";
    return {
      kind,
      name: a.animationName || a.transitionProperty || a.id || props.join("+"),
      target: path(effect && effect.target),
      delay: Number(timing.delay || 0),
      duration: Number(timing.duration || 0),
      iterations: timing.iterations === Infinity ? "infinite" : Number(timing.iterations || 1),
      direction: timing.direction,
      easing: String(timing.easing || "linear"),
      keyframes: frames.slice(0, 12).map((f) => {
        const o = { offset: f.offset == null ? null : Math.round(f.offset * 1000) / 1000, easing: f.easing };
        for (const k of keep) if (f[k] !== undefined) o[k] = String(f[k]).slice(0, 160);
        return o;
      }),
      properties: props.slice(0, 12),
      scrollY: Math.round(window.scrollY),
    };
  }, null)).filter(Boolean);
  // A tween's startTime() is on its parent timeline and already includes its delay; nested timelines add theirs.
  const globalStart = (t) => {
    let s = t.startTime ? t.startTime() : 0;
    for (let p = t.parent, n = 0; p && p.parent && n < 20; p = p.parent, n++) s = (p.startTime ? p.startTime() : 0) + s / ((p.timeScale && p.timeScale()) || 1);
    return s;
  };
  let gsapFound = false;
  if (safe(() => Boolean(window.gsap && window.gsap.globalTimeline), false)) safe(() => {
    gsapFound = true;
    const st = window.ScrollTrigger;
    const tweens = [...window.gsap.globalTimeline.getChildren(true, true, false)];
    for (const t of tweens.slice(0, 300)) safe(() => {
      const v = t.vars || {};
      const targets = (t.targets ? t.targets() : []).slice(0, 3);
      const props = Object.keys(v).filter((k) => !["ease", "duration", "delay", "repeat", "yoyo", "stagger", "onComplete", "onUpdate", "onStart", "scrollTrigger", "overwrite", "immediateRender", "paused", "id", "callbackScope"].includes(k) && typeof v[k] !== "function");
      animations.push({
        kind: "gsap",
        name: v.id || props.join("+"),
        target: targets.map((x) => (x && x.tagName ? path(x) : String(x))).join(", "),
        delay: Math.round(globalStart(t) * 1000),
        duration: Math.round((t.duration ? t.duration() : v.duration || 0.5) * 1000),
        iterations: v.repeat === -1 ? "infinite" : (v.repeat || 0) + 1,
        direction: v.yoyo ? "alternate" : "normal",
        easing: typeof v.ease === "string" ? v.ease : v.ease ? "custom" : "power1.out",
        keyframes: [Object.fromEntries(props.slice(0, 10).map((k) => [k, String(v[k]).slice(0, 80)]))],
        properties: props.slice(0, 12),
        scrollY: Math.round(window.scrollY),
        scrollTriggered: Boolean(v.scrollTrigger) || Boolean(st && st.getAll && st.getAll().some((s) => s.animation === t)),
      });
    }, null);
  }, null);
  const fonts = [];
  const seen = new Set();
  safe(() => { for (const el of [...document.querySelectorAll("h1,h2,h3,h4,p,a,button,li,span,label")].slice(0, 3000)) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || "").trim();
    if (!text || r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    const key = [cs.fontFamily, cs.fontWeight, cs.fontSize, cs.textTransform].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push({ selector: short(el), family: cs.fontFamily, weight: cs.fontWeight, size: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, transform: cs.textTransform, sample: text.slice(0, 40) });
    if (fonts.length >= 14) break;
  } }, null);
  const toHex = (c) => {
    const m = c && c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const [r, g, b, a] = m[1].split(",").map((x) => parseFloat(x));
    if (a !== undefined && a < 0.5) return null;
    return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("").toUpperCase();
  };
  const colors = {};
  const vw = innerWidth, vh = innerHeight;
  safe(() => { for (const el of [...document.querySelectorAll("body, body *")].slice(0, 5000)) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (!w || !h) continue;
    const cs = getComputedStyle(el);
    const bg = toHex(cs.backgroundColor);
    if (bg) colors[bg] = (colors[bg] || 0) + w * h;
    const fg = el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) ? toHex(cs.color) : null;
    if (fg) colors[fg] = (colors[fg] || 0) + w * h * 0.15;
  } }, null);
  return {
    url: location.href,
    title: safe(() => document.title, ""),
    viewport: { width: vw, height: vh },
    scrollHeight: safe(() => document.documentElement.scrollHeight, vh),
    animations,
    fonts,
    colors: Object.entries(colors).map(([hex, area]) => ({ hex, area: Math.round(area) })).sort((a, b) => b.area - a.area).slice(0, 12),
    gsap: gsapFound,
  };
})()`;

const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  linear: [0, 0, 1, 1],
};

/** The family a CSS or GSAP easing belongs to; exact curves stay in `suggestion`. */
export function easingFamily(easing: string): EasingFamily {
  const e = String(easing).trim().toLowerCase();
  if (e === "linear" || e === "none" || e === "power0" || /^power0\./.test(e)) return "linear";
  // GSAP: name[.in|.out|.inOut](params), GSAP 2's Name.easeIn/easeOut/easeInOut; a bare name ("power2") is .out.
  const gsap = /^(power[1-4]|quad|cubic|quart|quint|strong|sine|expo|circ|back|elastic|bounce)(?:\.(in|out|inout|easein|easeout|easeinout))?(?:\(.*\))?$/.exec(e);
  if (gsap) {
    const side = (gsap[2] ?? "out").replace("ease", "");
    return side === "inout" ? "ease-in-out" : side === "in" ? "ease-in" : "ease-out";
  }
  const bezier = KEYWORDS[e] ?? (/^cubic-bezier\(([^)]+)\)$/.exec(e)?.[1]?.split(",").map(Number) as Bezier | undefined);
  if (!bezier || bezier.length !== 4 || bezier.some((n) => !Number.isFinite(n))) return "unclear";
  // The same reading as exact Lottie and Figma curves, including control points on an end (ease-in is 0.42, 0, 1, 1).
  return bezierFamily(bezier);
}

/** The curve that shapes an animation: a CSS animation's first keyframe easing wins over the effect's timing easing. */
export function effectiveEasing(a: PageAnimation): string {
  if (a.kind === "css-animation") {
    const first = a.keyframes.find((k) => k.easing && k.easing !== "linear");
    if (first?.easing) return String(first.easing);
  }
  return a.easing;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const text = (v: unknown, max = 160): string => oneLine(typeof v === "string" || typeof v === "number" ? v : "", max);
const list = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const KINDS = new Set<PageAnimation["kind"]>(["css-animation", "css-transition", "waapi", "gsap"]);

/**
 * What the page script returned, made safe to use: the page can replace any object the script reads, so every field
 * is checked for its type, strings are cut to one short line (element ids can hold line breaks, and these land in
 * Markdown and starter code) and colours must be #RRGGBB.
 */
export function cleanReading(raw: unknown): PageReading {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const viewport = (r.viewport && typeof r.viewport === "object" ? r.viewport : {}) as Record<string, unknown>;
  const animations = list<Record<string, unknown>>(r.animations, 800)
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      kind: KINDS.has(a.kind as PageAnimation["kind"]) ? (a.kind as PageAnimation["kind"]) : "waapi",
      name: text(a.name),
      target: text(a.target, 240),
      delay: num(a.delay),
      duration: num(a.duration),
      iterations: a.iterations === "infinite" ? ("infinite" as const) : Math.max(0, num(a.iterations, 1)),
      direction: text(a.direction, 40),
      easing: text(a.easing, 120) || "linear",
      keyframes: list<Record<string, unknown>>(a.keyframes, 12)
        .filter((k) => k && typeof k === "object")
        .map((k) => {
          const out: PageAnimation["keyframes"][number] = { offset: typeof k.offset === "number" && Number.isFinite(k.offset) ? k.offset : null };
          if (k.easing !== undefined) out.easing = text(k.easing, 120);
          for (const [key, value] of Object.entries(k).slice(0, 24)) if (key !== "offset" && key !== "easing") out[text(key, 40)] = text(value);
          return out;
        }),
      properties: list<unknown>(a.properties, 12).map((p) => text(p, 40)),
      scrollY: num(a.scrollY),
      ...(a.scrollTriggered === true && { scrollTriggered: true }),
    }));
  const fonts = list<Record<string, unknown>>(r.fonts, 14)
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      selector: text(f.selector, 120),
      family: text(f.family, 120),
      weight: text(f.weight, 10),
      size: text(f.size, 20),
      lineHeight: text(f.lineHeight, 20),
      letterSpacing: text(f.letterSpacing, 20),
      transform: text(f.transform, 20),
      sample: text(f.sample, 40),
    }));
  const colors = list<Record<string, unknown>>(r.colors, 12)
    .map((c) => ({ hex: safeHex(c?.hex, ""), area: Math.max(0, num(c?.area)) }))
    .filter((c) => c.hex);
  return {
    url: text(r.url, 2000),
    title: text(r.title, 200),
    viewport: { width: num(viewport.width, 1440), height: num(viewport.height, 900) },
    scrollHeight: num(r.scrollHeight),
    animations,
    fonts,
    colors,
    gsap: r.gsap === true,
  };
}

/** Merges readings taken at several scroll positions, keeping one entry per animation. */
export function mergeReadings(readings: PageReading[]): PageReading {
  const first = readings[0]!;
  const seen = new Map<string, PageAnimation>();
  for (const r of readings) {
    for (const a of r.animations) {
      const key = `${a.kind}|${a.target}|${a.name}|${a.duration}`;
      if (!seen.has(key)) seen.set(key, { ...a, scrollTriggered: a.scrollTriggered || a.scrollY > 0 });
    }
  }
  const colors = new Map<string, number>();
  for (const r of readings) for (const c of r.colors) colors.set(c.hex, (colors.get(c.hex) ?? 0) + c.area);
  return {
    ...first,
    animations: [...seen.values()],
    colors: [...colors.entries()].map(([hex, area]) => ({ hex, area })).sort((a, b) => b.area - a.area).slice(0, 12),
    gsap: readings.some((r) => r.gsap),
  };
}

const FPS = 60;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The page's animations as a motion spec: exact durations, delays and curves (`measured`). */
export function specFromPage(reading: PageReading, version: string): MotionSpec {
  const total = reading.colors.reduce((s, c) => s + c.area, 0) || 1;
  const palette: (Swatch & { evidence: "measured" })[] = reading.colors.slice(0, 8).map((c) => ({
    hex: c.hex,
    share: Math.round((c.area / total) * 1000) / 1000,
    lightness: 0,
    chroma: 0,
    evidence: "measured" as const,
  }));
  const finite = reading.animations.filter((a) => a.duration > 0 && a.duration < 60_000);
  const end = Math.max(1, ...finite.map((a) => (a.delay + a.duration * (a.iterations === "infinite" ? 1 : Math.min(a.iterations, 4))) / 1000));
  const events = finite.map((a) => {
    const easing = effectiveEasing(a);
    const family = easingFamily(easing);
    const start = r3(Math.max(0, a.delay) / 1000);
    return {
      start,
      end: r3(start + a.duration / 1000),
      frames: Math.round((a.duration / 1000) * FPS),
      peak: 0,
      peakAt: family === "ease-out" ? 0.2 : family === "ease-in" ? 0.8 : 0.5,
      easing: family,
      suggestion: easing || EASING_SUGGESTIONS[family],
      kind: "move" as const,
      evidence: "measured" as const,
      target: a.target,
      name: a.name,
      properties: a.properties,
      keyframes: a.keyframes,
      source: a.kind,
      iterations: a.iterations,
      ...(a.scrollTriggered && { scroll: { triggeredAtY: a.scrollY } }),
    };
  });
  return {
    spec: "framelens.motion/1",
    generatedBy: `framelens ${version}`,
    source: { kind: "web", input: reading.url, url: reading.url, title: reading.title },
    range: { start: 0, end: r3(end) },
    timebase: { fps: FPS, vfr: false, duration: r3(end), width: reading.viewport.width, height: reading.viewport.height },
    anchors: { words: [], beats: [], cuts: [] },
    changes: [],
    palette,
    typography: reading.fonts.map((f) => ({
      role: f.selector,
      family_guess: f.family,
      weight: Number(f.weight) || 400,
      case: f.transform === "none" ? "as written" : f.transform,
      size: f.size,
      lineHeight: f.lineHeight,
      letterSpacing: f.letterSpacing,
      sample: f.sample,
      evidence: "measured" as const,
    })),
    shots: [{ id: "page", start: 0, end: r3(end), frames: Math.round(end * FPS), palette: palette.slice(0, 4).map((p) => p.hex) }],
    systems: [],
    events,
    rhythm: { cuts: 0, cutsPerMinute: 0, meanShotSeconds: r3(end), medianShotSeconds: r3(end), movesPerMinute: Math.round((events.length / (end / 60)) * 100) / 100 },
    audio: { sfx: [] },
  };
}

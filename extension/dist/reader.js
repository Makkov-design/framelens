// Frame Lens page reader, generated from src/browser/page-script.ts (the same script the web tool runs).
(() => {
  
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
  const describe = (a, scrollY) => safe(() => {
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
      scrollY,
    };
  }, null);

  const live = safe(() => [...document.getAnimations()].slice(0, 500), []);
  const animations = live.map((a) => describe(a, Math.round(window.scrollY))).filter(Boolean);
  // What the recorder saw start that the browser no longer lists (it ended, was cancelled or lost its element):
  // described as it started, at the scroll position it started at.
  const listed = new Set(live);
  const recorder = safe(() => window[Symbol.for("framelens.recorder")], undefined);
  const recorded = safe(() => (recorder && typeof recorder.entries === "function" ? recorder.entries() : []), []);
  for (const r of Array.isArray(recorded) ? recorded.slice(0, 1000) : []) safe(() => {
    if (!r || !r.reading || typeof r.reading !== "object" || listed.has(r.animation)) return;
    const state = safe(() => String(r.animation.playState), "");
    animations.push(state === "running" || state === "paused" ? { ...r.reading } : { ...r.reading, ended: true });
  }, null);
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
    const m = c && c.match(/rgba?\(([^)]+)\)/);
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
})();

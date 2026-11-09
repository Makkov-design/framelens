// src/text.ts
function oneLine(text2, max = 200) {
  return String(text2 ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function safeHex(value, fallback = "#111111") {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).replace(/./g, (c) => c + c)}`.toUpperCase();
  return fallback;
}

// src/browser/page-script.ts
var RECORDER_KEY = `Symbol.for("framelens.recorder")`;
var DESCRIBE = `
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
`;
var RECORDER_SCRIPT = `(() => {
  const KEY = ${RECORDER_KEY};
  if (window[KEY]) return;
  ${DESCRIBE}
  const docAnimations = Document.prototype.getAnimations;
  const elementAnimations = Element.prototype.getAnimations;
  const scroll = () => safe(() => Math.round(window.scrollY || 0), 0);
  const entries = [];
  const known = new WeakSet();
  const add = (a) => {
    if (!a || typeof a !== "object" || known.has(a) || entries.length >= 1000) return;
    known.add(a);
    const reading = describe(a, scroll());
    if (reading) entries.push({ animation: a, reading });
  };
  const fromElement = (el) => safe(() => {
    if (el && typeof elementAnimations === "function") for (const a of elementAnimations.call(el)) add(a);
  }, null);
  for (const type of ["animationstart", "transitionrun", "transitionstart"]) {
    safe(() => window.addEventListener(type, (event) => fromElement(event.target), { capture: true, passive: true }), null);
  }
  safe(() => {
    const animate = Element.prototype.animate;
    if (typeof animate === "function") {
      Element.prototype.animate = function animate_(...args) {
        const a = animate.apply(this, args);
        safe(() => add(a), null);
        return a;
      };
    }
    const play = Animation.prototype.play;
    if (typeof play === "function") {
      Animation.prototype.play = function play_(...args) {
        const result = play.apply(this, args);
        safe(() => add(this), null);
        return result;
      };
    }
  }, null);
  const began = safe(() => performance.now(), 0);
  let frames = 0;
  const sample = () => {
    safe(() => {
      if (typeof docAnimations === "function") for (const a of docAnimations.call(document)) add(a);
    }, null);
    frames++;
    if (frames < 600 && safe(() => performance.now(), 0) - began < 10000) safe(() => requestAnimationFrame(sample), null);
  };
  safe(() => requestAnimationFrame(sample), null);
  safe(() => Object.defineProperty(window, KEY, { value: { entries: () => entries.slice() }, enumerable: false }), null);
})()`;
var PAGE_SCRIPT = `(() => {
  ${DESCRIBE}
  const live = safe(() => [...document.getAnimations()].slice(0, 500), []);
  const animations = live.map((a) => describe(a, Math.round(window.scrollY))).filter(Boolean);
  // What the recorder saw start that the browser no longer lists (it ended, was cancelled or lost its element):
  // described as it started, at the scroll position it started at.
  const listed = new Set(live);
  const recorder = safe(() => window[${RECORDER_KEY}], undefined);
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
var num = (v, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var text = (v, max = 160) => oneLine(typeof v === "string" || typeof v === "number" ? v : "", max);
var list = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
var KINDS = /* @__PURE__ */ new Set(["css-animation", "css-transition", "waapi", "gsap"]);
function cleanReading(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const viewport = r.viewport && typeof r.viewport === "object" ? r.viewport : {};
  const animations = list(r.animations, 800).filter((a) => a && typeof a === "object").map((a) => ({
    kind: KINDS.has(a.kind) ? a.kind : "waapi",
    name: text(a.name),
    target: text(a.target, 240),
    delay: num(a.delay),
    duration: num(a.duration),
    iterations: a.iterations === "infinite" ? "infinite" : Math.max(0, num(a.iterations, 1)),
    direction: text(a.direction, 40),
    easing: text(a.easing, 120) || "linear",
    keyframes: list(a.keyframes, 12).filter((k) => k && typeof k === "object").map((k) => {
      const out = { offset: typeof k.offset === "number" && Number.isFinite(k.offset) ? k.offset : null };
      if (k.easing !== void 0) out.easing = text(k.easing, 120);
      for (const [key, value] of Object.entries(k).slice(0, 24)) if (key !== "offset" && key !== "easing") out[text(key, 40)] = text(value);
      return out;
    }),
    properties: list(a.properties, 12).map((p) => text(p, 40)),
    scrollY: num(a.scrollY),
    ...a.scrollTriggered === true && { scrollTriggered: true },
    ...a.ended === true && { ended: true }
  }));
  const fonts = list(r.fonts, 14).filter((f) => f && typeof f === "object").map((f) => ({
    selector: text(f.selector, 120),
    family: text(f.family, 120),
    weight: text(f.weight, 10),
    size: text(f.size, 20),
    lineHeight: text(f.lineHeight, 20),
    letterSpacing: text(f.letterSpacing, 20),
    transform: text(f.transform, 20),
    sample: text(f.sample, 40)
  }));
  const colors = list(r.colors, 12).map((c) => ({ hex: safeHex(c?.hex, ""), area: Math.max(0, num(c?.area)) })).filter((c) => c.hex);
  return {
    url: text(r.url, 2e3),
    title: text(r.title, 200),
    viewport: { width: num(viewport.width, 1440), height: num(viewport.height, 900) },
    scrollHeight: num(r.scrollHeight),
    animations,
    fonts,
    colors,
    gsap: r.gsap === true
  };
}
function mergeReadings(readings) {
  const first = readings[0];
  const seen = /* @__PURE__ */ new Map();
  for (const r of readings) {
    for (const a of r.animations) {
      const key = `${a.kind}|${a.target}|${a.name}|${a.duration}|${a.delay}`;
      const known = seen.get(key);
      if (!known) seen.set(key, { ...a, scrollTriggered: a.scrollTriggered || a.scrollY > 0 });
      else if (known.ended && !a.ended) delete known.ended;
    }
  }
  const colors = /* @__PURE__ */ new Map();
  for (const r of readings) for (const c of r.colors) colors.set(c.hex, (colors.get(c.hex) ?? 0) + c.area);
  return {
    ...first,
    animations: [...seen.values()],
    colors: [...colors.entries()].map(([hex, area]) => ({ hex, area })).sort((a, b) => b.area - a.area).slice(0, 12),
    gsap: readings.some((r) => r.gsap)
  };
}

// extension/src/downloads.ts
function explain(error) {
  if (!error) return "the browser stopped it";
  if (/USER_CANCELED/.test(error)) return "it was cancelled";
  if (/NO_SPACE/.test(error)) return "the disk is full";
  if (/ACCESS_DENIED|FILE_BLOCKED|FILE_SECURITY_CHECK_FAILED|FILE_VIRUS_INFECTED/.test(error)) return `the browser or the system refused the file (${error})`;
  if (/NAME_TOO_LONG|TOO_LARGE|FILE_FAILED/.test(error)) return `the file could not be written (${error})`;
  return error;
}
async function downloadAndWait(api, options, timeoutMs = 10 * 6e4) {
  let id = -1;
  let listener;
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The browser did not finish saving the file.")), timeoutMs);
    const settle = (state, error, filename) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve(filename ?? "");
      } else if (state === "interrupted") {
        clearTimeout(timer);
        reject(new Error(`The file was not saved: ${explain(error)}.`));
      }
    };
    listener = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current) {
        void api.search({ id }).then(
          ([item]) => settle(delta.state?.current, delta.error?.current ?? item?.error, item?.filename),
          () => settle(delta.state?.current, delta.error?.current, void 0)
        );
      }
    };
    api.onChanged.addListener(listener);
    api.download(options).then(async (started) => {
      id = started;
      const [item] = await api.search({ id });
      settle(item?.state, item?.error, item?.filename);
    }).catch((error) => {
      clearTimeout(timer);
      reject(new Error(`The file was not saved: ${error?.message ?? String(error)}`));
    });
  });
  try {
    return await finished;
  } finally {
    if (listener) api.onChanged.removeListener(listener);
  }
}

// extension/src/names.ts
var FOLDER = "FrameLens";
var READING_FORMAT = "framelens.page-reading/1";
var pad = (n) => String(n).padStart(2, "0");
function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function hostSlug(url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
  }
  return host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "page";
}
function readingFileName(url, d) {
  return `${FOLDER}/page-${hostSlug(url)}-${stamp(d)}.framelens.json`;
}
function recordingFileName(url, d) {
  return `${FOLDER}/recording-${hostSlug(url)}-${stamp(d)}.webm`;
}

// extension/src/background.ts
var wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function inPage(tabId, run, timeoutMs = 3e4) {
  const call = chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", ...run });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("The page did not answer in time (its own scripts may be busy).")), timeoutMs);
  });
  try {
    const results = await Promise.race([call, timeout]);
    return results?.[0]?.result;
  } finally {
    clearTimeout(timer);
  }
}
function scrollPage(x, y, ms) {
  window.scrollTo(x, y);
  return new Promise((resolve) => setTimeout(() => resolve({ x: window.scrollX, y: window.scrollY }), ms));
}
async function readTab(tabId, options = {}) {
  const start = await inPage(tabId, { func: () => ({ x: window.scrollX, y: window.scrollY }) });
  try {
    await inPage(tabId, { func: scrollPage, args: [0, 0, 600] });
    const readings = [cleanReading(await inPage(tabId, { files: ["reader.js"] }))];
    const first = readings[0];
    const maxScroll = Math.min(first.scrollHeight - first.viewport.height, options.maxScroll ?? 12e3);
    const stops = [];
    for (let y = 450; y < maxScroll; y += 450) stops.push(y);
    if (maxScroll > 0) stops.push(maxScroll);
    for (const y of stops) {
      await inPage(tabId, { func: scrollPage, args: [0, y, 350] });
      readings.push(cleanReading(await inPage(tabId, { files: ["reader.js"] })));
    }
    const reading = mergeReadings(readings);
    const now = /* @__PURE__ */ new Date();
    const filename = readingFileName(reading.url, now);
    const json = JSON.stringify({ framelens: READING_FORMAT, capturedWith: `Frame Lens extension ${"2.1.0"}`, capturedAt: now.toISOString(), ...reading });
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const url = `data:application/json;base64,${btoa(binary)}`;
    if (url.length > 2 * 1024 * 1024 - 64) throw new Error("This page's reading is too large to save (over 2 MB).");
    const savedTo = await downloadAndWait(chrome.downloads, { url, filename, conflictAction: "uniquify", saveAs: false });
    return { reading, filename, savedTo };
  } finally {
    await inPage(tabId, { func: scrollPage, args: [start?.x ?? 0, start?.y ?? 0, 0] }).catch(() => void 0);
  }
}
async function offscreenOpen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}
async function toOffscreen(message) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}
async function recordingStatus() {
  if (!await offscreenOpen()) return { recording: false };
  return await toOffscreen({ type: "status" }) ?? { recording: false };
}
async function startRecording(tabId) {
  if ((await recordingStatus()).recording) throw new Error("A recording is already running. Stop it first.");
  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!await offscreenOpen()) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Records the tab the user chose with MediaRecorder." });
  }
  const answer = await toOffscreen({ type: "start", streamId, url: tab.url ?? "" });
  if (!answer?.ok) throw new Error(answer?.error ?? "The recorder did not start.");
  await chrome.action.setBadgeBackgroundColor({ color: "#D93025" });
  await chrome.action.setBadgeText({ text: "REC" });
  return { startedAt: answer.startedAt ?? Date.now() };
}
async function stopRecording() {
  if (!await offscreenOpen()) throw new Error("Nothing is being recorded.");
  await toOffscreen({ type: "stop" });
}
async function saveRecording(message) {
  const filename = recordingFileName(message.pageUrl, /* @__PURE__ */ new Date());
  try {
    const savedTo = await downloadAndWait(chrome.downloads, { url: message.url, filename, conflictAction: "uniquify", saveAs: false });
    return { filename, savedTo };
  } finally {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.offscreen.closeDocument().catch(() => void 0);
  }
}
var lastSaved = {};
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target !== "background") return false;
  const answer = (work) => {
    work.then((value) => reply({ ok: true, ...value }), (error) => reply({ ok: false, error: error?.message ?? String(error) }));
    return true;
  };
  switch (message.type) {
    case "read":
      return answer(readTab(message.tabId).then(({ reading, filename, savedTo }) => ({ filename, savedTo, animations: reading.animations.length, gsap: reading.gsap })));
    case "record-start":
      return answer(startRecording(message.tabId));
    case "record-stop":
      return answer(stopRecording());
    case "status":
      return answer(recordingStatus().then((s) => ({ ...s, lastSaved })));
    case "recorded":
      return answer(
        saveRecording(message).then(
          (saved) => (lastSaved = { filename: saved.filename }, saved),
          (error) => {
            lastSaved = { error: error.message };
            throw error;
          }
        )
      );
    case "record-failed":
      lastSaved = { error: String(message.error ?? "The recording stopped.") };
      return answer(chrome.action.setBadgeText({ text: "" }).then(() => chrome.offscreen.closeDocument().catch(() => void 0)));
    default:
      return false;
  }
});
globalThis.framelens = { readTab, startRecording, stopRecording, recordingStatus, wait };
export {
  readTab,
  recordingStatus,
  startRecording,
  stopRecording
};

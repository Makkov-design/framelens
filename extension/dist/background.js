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
    ...a.scrollTriggered === true && { scrollTriggered: true }
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
      const key = `${a.kind}|${a.target}|${a.name}|${a.duration}`;
      if (!seen.has(key)) seen.set(key, { ...a, scrollTriggered: a.scrollTriggered || a.scrollY > 0 });
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
    const json = JSON.stringify({ framelens: READING_FORMAT, capturedWith: `Frame Lens extension ${"2.0.0"}`, capturedAt: now.toISOString(), ...reading });
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

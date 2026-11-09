// extension/src/webm.ts
var EBML = 440786851;
var SEGMENT = 408125543;
var INFO = 357149030;
var TIMECODE_SCALE = 2807729;
var DURATION = 17545;
var SEEK_HEAD = 290298740;
var CLUSTER = 524531317;
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === void 0 || first === 0) return void 0;
  let length = 1;
  while (length <= 8 && !(first & 128 >> length - 1)) length++;
  if (length > 8 || pos + length > buf.length) return void 0;
  let value = keepMarker ? first : first & 255 >> length;
  let ones = (first & 255 >> length) === 255 >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 255) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}
function element(buf, pos) {
  const id = vint(buf, pos, true);
  if (!id) return void 0;
  const size = vint(buf, pos + id.length, false);
  if (!size) return void 0;
  return { id: id.value, dataStart: pos + id.length + size.length, size: size.value, unknown: size.unknown };
}
function readUint(buf, start, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i];
  return v;
}
function size8(n) {
  const out = new Uint8Array(8);
  out[0] = 1;
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
}
function findInfo(head) {
  const header = element(head, 0);
  if (!header || header.id !== EBML) return void 0;
  const segmentPos = header.dataStart + header.size;
  const segment = element(head, segmentPos);
  if (!segment || segment.id !== SEGMENT || !segment.unknown) return void 0;
  for (let pos = segment.dataStart; pos < head.length; ) {
    const el = element(head, pos);
    if (!el || el.unknown) return void 0;
    if (el.id === SEEK_HEAD || el.id === CLUSTER) return void 0;
    const end = el.dataStart + el.size;
    if (el.id === INFO) {
      if (end > head.length) return void 0;
      let timecodeScale = 1e6;
      let hasDuration = false;
      for (let p = el.dataStart; p < end; ) {
        const child = element(head, p);
        if (!child) return void 0;
        if (child.id === TIMECODE_SCALE) timecodeScale = readUint(head, child.dataStart, child.size) || 1e6;
        if (child.id === DURATION) hasDuration = true;
        p = child.dataStart + child.size;
      }
      return { start: pos, end, dataStart: el.dataStart, timecodeScale, hasDuration };
    }
    pos = end;
  }
  return void 0;
}
async function withWebmDuration(blob, durationMs) {
  if (!(durationMs > 0)) return blob;
  const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const info = findInfo(head);
  if (!info || info.hasDuration) return blob;
  const duration = new Uint8Array(11);
  duration.set([68, 137, 136]);
  new DataView(duration.buffer).setFloat64(3, durationMs * 1e6 / info.timecodeScale);
  const data = head.subarray(info.dataStart, info.end);
  const infoBytes = new Uint8Array(4 + 8 + data.length + duration.length);
  infoBytes.set([21, 73, 169, 102]);
  infoBytes.set(size8(data.length + duration.length), 4);
  infoBytes.set(data, 12);
  infoBytes.set(duration, 12 + data.length);
  return new Blob([blob.slice(0, info.start), infoBytes, blob.slice(info.end)], { type: blob.type });
}

// extension/src/offscreen.ts
var MAX_RECORDING_MS = 15 * 6e4;
var TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
var session;
var lastUrl;
function record(stream, url) {
  if (session) throw new Error("A recording is already running.");
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, { ...mimeType && { mimeType }, videoBitsPerSecond: 8e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let audio;
  if (stream.getAudioTracks().length) {
    audio = new AudioContext();
    audio.createMediaStreamSource(stream).connect(audio.destination);
  }
  const startedAt = Date.now();
  session = { recorder, stream, ...audio && { audio }, chunks, startedAt, started: performance.now(), url, timer: setTimeout(() => void finish(), MAX_RECORDING_MS) };
  for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => void finish());
  recorder.start(1e3);
  return startedAt;
}
async function stop() {
  const s = session;
  if (!s) return void 0;
  session = void 0;
  clearTimeout(s.timer);
  const stopped = new Promise((resolve) => s.recorder.onstop = () => resolve());
  if (s.recorder.state !== "inactive") s.recorder.stop();
  await stopped;
  const durationMs = performance.now() - s.started;
  for (const track of s.stream.getTracks()) track.stop();
  await s.audio?.close().catch(() => void 0);
  const blob = await withWebmDuration(new Blob(s.chunks, { type: s.recorder.mimeType || "video/webm" }), durationMs);
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  return { url: lastUrl, pageUrl: s.url, durationMs: Math.round(durationMs), bytes: blob.size };
}
async function finish() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  try {
    const file = await stop();
    if (file) await chrome.runtime.sendMessage({ target: "background", type: "recorded", ...file });
  } catch (error) {
    await chrome.runtime.sendMessage({ target: "background", type: "record-failed", error: error?.message ?? String(error) });
  }
}
async function startFromTab(streamId, url) {
  const source = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: source,
    video: { mandatory: { ...source.mandatory, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } }
  });
  return record(stream, url);
}
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.target !== "offscreen") return false;
    if (message.type === "status") {
      reply({ recording: Boolean(session), ...session && { startedAt: session.startedAt, url: session.url } });
      return false;
    }
    if (message.type === "start") {
      startFromTab(String(message.streamId), String(message.url ?? "")).then(
        (startedAt) => reply({ ok: true, startedAt }),
        (error) => reply({ ok: false, error: error?.message ?? String(error) })
      );
      return true;
    }
    if (message.type === "stop") {
      reply({ ok: true });
      void finish();
      return false;
    }
    return false;
  });
}
globalThis.framelensRecorder = { record, stop };
export {
  MAX_RECORDING_MS,
  record,
  stop
};

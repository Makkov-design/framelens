import { withWebmDuration } from "./webm.js";

declare const chrome: any;

/**
 * The offscreen document that records: MediaRecorder needs a page, and a service worker has none. It records the
 * tab stream the service worker asked for, keeps the tab audible, writes the duration into the WebM when it stops,
 * and hands the file back as a blob: address for the service worker to save.
 */

/** Long screen recordings get large; a forgotten one stops itself. */
export const MAX_RECORDING_MS = 15 * 60_000;

const TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

interface Session {
  recorder: MediaRecorder;
  stream: MediaStream;
  audio?: AudioContext;
  chunks: Blob[];
  startedAt: number;
  started: number;
  url: string;
  timer: ReturnType<typeof setTimeout>;
}

let session: Session | undefined;
let lastUrl: string | undefined;

/** Starts recording a stream (the tab's, or any other in the live check). */
export function record(stream: MediaStream, url: string): number {
  if (session) throw new Error("A recording is already running.");
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let audio: AudioContext | undefined;
  // Capturing a tab silences it for the user; play its sound back so they can keep watching normally.
  if (stream.getAudioTracks().length) {
    audio = new AudioContext();
    audio.createMediaStreamSource(stream).connect(audio.destination);
  }
  const startedAt = Date.now();
  session = { recorder, stream, ...(audio && { audio }), chunks, startedAt, started: performance.now(), url, timer: setTimeout(() => void finish(), MAX_RECORDING_MS) };
  // The tab closing ends the stream: keep what was recorded.
  for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => void finish());
  recorder.start(1000);
  return startedAt;
}

/** Stops, writes the duration into the file and returns it as a blob: address. */
export async function stop(): Promise<{ url: string; pageUrl: string; durationMs: number; bytes: number } | undefined> {
  const s = session;
  if (!s) return undefined;
  session = undefined;
  clearTimeout(s.timer);
  const stopped = new Promise<void>((resolve) => (s.recorder.onstop = () => resolve()));
  if (s.recorder.state !== "inactive") s.recorder.stop();
  await stopped;
  const durationMs = performance.now() - s.started;
  for (const track of s.stream.getTracks()) track.stop();
  await s.audio?.close().catch(() => undefined);
  const blob = await withWebmDuration(new Blob(s.chunks, { type: s.recorder.mimeType || "video/webm" }), durationMs);
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  return { url: lastUrl, pageUrl: s.url, durationMs: Math.round(durationMs), bytes: blob.size };
}

/** Stops and hands the file to the service worker to save (from the popup's Stop, the time limit or a closed tab). */
async function finish(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  try {
    const file = await stop();
    if (file) await chrome.runtime.sendMessage({ target: "background", type: "recorded", ...file });
  } catch (error) {
    await chrome.runtime.sendMessage({ target: "background", type: "record-failed", error: (error as Error)?.message ?? String(error) });
  }
}

async function startFromTab(streamId: string, url: string): Promise<number> {
  const source = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: source,
    video: { mandatory: { ...source.mandatory, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } },
  } as unknown as MediaStreamConstraints);
  return record(stream, url);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: Record<string, any>, _sender: unknown, reply: (answer: unknown) => void) => {
    if (message?.target !== "offscreen") return false;
    if (message.type === "status") {
      reply({ recording: Boolean(session), ...(session && { startedAt: session.startedAt, url: session.url }) });
      return false;
    }
    if (message.type === "start") {
      startFromTab(String(message.streamId), String(message.url ?? "")).then(
        (startedAt) => reply({ ok: true, startedAt }),
        (error: Error) => reply({ ok: false, error: error?.message ?? String(error) }),
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

(globalThis as Record<string, unknown>).framelensRecorder = { record, stop };

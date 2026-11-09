import { cleanReading, mergeReadings, type PageReading } from "../../src/browser/page-script.js";
import { downloadAndWait } from "./downloads.js";
import { READING_FORMAT, readingFileName, recordingFileName } from "./names.js";

declare const chrome: any;
declare const FRAMELENS_VERSION: string;

/**
 * The extension's service worker. "Read this page's motion" runs Frame Lens's own page reader (reader.js, built
 * from src/browser/page-script.ts) in the tab at the top and while scrolling, exactly like the `web` tool, and saves
 * the merged reading to Downloads/FrameLens. "Record this tab" records the visible tab in an offscreen document.
 * Nothing is sent anywhere: files go to the Downloads folder only.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inPage<T>(tabId: number, run: { files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[] }, timeoutMs = 30_000): Promise<T> {
  // The main world, like the `web` tool's DevTools reading: GSAP's timeline lives on the page's own window.
  const call = chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", ...run });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The page did not answer in time (its own scripts may be busy).")), timeoutMs);
  });
  try {
    const results = (await Promise.race([call, timeout])) as { result?: unknown }[] | undefined;
    return results?.[0]?.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Scrolls the page and waits for scroll-triggered animations to start (the same pause the `web` tool uses). */
function scrollPage(x: number, y: number, ms: number): Promise<{ x: number; y: number }> {
  window.scrollTo(x, y);
  return new Promise((resolve) => setTimeout(() => resolve({ x: window.scrollX, y: window.scrollY }), ms));
}

/** Reads the tab's animations at the top and every half screen down to the bottom, then puts the scroll back. */
export async function readTab(tabId: number, options: { maxScroll?: number } = {}): Promise<{ reading: PageReading; filename: string; savedTo: string }> {
  const start = await inPage<{ x: number; y: number }>(tabId, { func: () => ({ x: window.scrollX, y: window.scrollY }) });
  try {
    await inPage(tabId, { func: scrollPage, args: [0, 0, 600] });
    const readings: PageReading[] = [cleanReading(await inPage(tabId, { files: ["reader.js"] }))];
    const first = readings[0]!;
    const maxScroll = Math.min(first.scrollHeight - first.viewport.height, options.maxScroll ?? 12_000);
    const stops: number[] = [];
    for (let y = 450; y < maxScroll; y += 450) stops.push(y);
    if (maxScroll > 0) stops.push(maxScroll);
    for (const y of stops) {
      await inPage(tabId, { func: scrollPage, args: [0, y, 350] });
      readings.push(cleanReading(await inPage(tabId, { files: ["reader.js"] })));
    }
    const reading = mergeReadings(readings);
    const now = new Date();
    const filename = readingFileName(reading.url, now);
    const json = JSON.stringify({ framelens: READING_FORMAT, capturedWith: `Frame Lens extension ${FRAMELENS_VERSION}`, capturedAt: now.toISOString(), ...reading });
    // A service worker cannot make blob: addresses, so the file goes as a data: address (base64 is the shortest;
    // the browser takes up to 2 MB, far more than a reading).
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const url = `data:application/json;base64,${btoa(binary)}`;
    if (url.length > 2 * 1024 * 1024 - 64) throw new Error("This page's reading is too large to save (over 2 MB).");
    // Only a file that is really there counts: an interrupted download is reported, not called saved.
    const savedTo = await downloadAndWait(chrome.downloads, { url, filename, conflictAction: "uniquify", saveAs: false });
    return { reading, filename, savedTo };
  } finally {
    await inPage(tabId, { func: scrollPage, args: [start?.x ?? 0, start?.y ?? 0, 0] }).catch(() => undefined);
  }
}

// --- Recording -------------------------------------------------------------------------------------------------

async function offscreenOpen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function toOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

export async function recordingStatus(): Promise<{ recording: boolean; startedAt?: number; url?: string }> {
  if (!(await offscreenOpen())) return { recording: false };
  return (await toOffscreen<{ recording: boolean; startedAt?: number; url?: string }>({ type: "status" })) ?? { recording: false };
}

export async function startRecording(tabId: number): Promise<{ startedAt: number }> {
  if ((await recordingStatus()).recording) throw new Error("A recording is already running. Stop it first.");
  const tab = await chrome.tabs.get(tabId);
  // Allowed because the user opened the extension on this tab (activeTab); the stream is for this extension only.
  const streamId: string = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!(await offscreenOpen())) {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Records the tab the user chose with MediaRecorder." });
  }
  const answer = await toOffscreen<{ ok: boolean; error?: string; startedAt?: number }>({ type: "start", streamId, url: tab.url ?? "" });
  if (!answer?.ok) throw new Error(answer?.error ?? "The recorder did not start.");
  await chrome.action.setBadgeBackgroundColor({ color: "#D93025" });
  await chrome.action.setBadgeText({ text: "REC" });
  return { startedAt: answer.startedAt ?? Date.now() };
}

export async function stopRecording(): Promise<void> {
  if (!(await offscreenOpen())) throw new Error("Nothing is being recorded.");
  await toOffscreen({ type: "stop" });
}

/** The offscreen document hands over the finished file as a blob: address; it is saved, then the document closes. */
async function saveRecording(message: { url: string; pageUrl?: string }): Promise<{ filename: string; savedTo: string }> {
  const filename = recordingFileName(message.pageUrl, new Date());
  try {
    const savedTo = await downloadAndWait(chrome.downloads, { url: message.url, filename, conflictAction: "uniquify", saveAs: false });
    return { filename, savedTo };
  } finally {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

let lastSaved: { filename?: string; error?: string } = {};

chrome.runtime.onMessage.addListener((message: Record<string, any>, _sender: unknown, reply: (answer: unknown) => void) => {
  if (message?.target !== "background") return false;
  const answer = (work: Promise<unknown>) => {
    work.then((value) => reply({ ok: true, ...(value as object) }), (error: Error) => reply({ ok: false, error: error?.message ?? String(error) }));
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
        saveRecording(message as { url: string; pageUrl?: string }).then(
          (saved) => ((lastSaved = { filename: saved.filename }), saved),
          (error: Error) => {
            lastSaved = { error: error.message };
            throw error;
          },
        ),
      );
    case "record-failed":
      lastSaved = { error: String(message.error ?? "The recording stopped.") };
      return answer(chrome.action.setBadgeText({ text: "" }).then(() => chrome.offscreen.closeDocument().catch(() => undefined)));
    default:
      return false;
  }
});

// For the live check (tests drive the worker over the DevTools protocol) and for anyone debugging the extension.
(globalThis as Record<string, unknown>).framelens = { readTab, startRecording, stopRecording, recordingStatus, wait };

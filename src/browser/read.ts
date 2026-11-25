import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "../media/exec.js";
import { buildSheets, type Sheet } from "../media/sheets.js";
import { hostAddresses, hostOf, isPrivateAddress, systemLookup, type Lookup } from "../sources/cobalt.js";
import { oneLine } from "../text.js";
import { evaluate, findBrowser, launchBrowser, navigate, screenshot, type BrowserSession } from "./cdp.js";
import { cleanReading, mergeReadings, PAGE_SCRIPT, RECORDER_SCRIPT, type PageReading } from "./web.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In the page: the running animations and the ones the recorder kept, each once (at most 1000). */
const ALL_ANIMATIONS = `(() => { const list = new Set(); try { for (const a of document.getAnimations()) list.add(a); } catch (e) {} try { for (const e of window[Symbol.for("framelens.recorder")].entries()) if (e && e.animation) list.add(e.animation); } catch (e) {} return [...list].slice(0, 1000); })()`;

export interface PageResult {
  reading: PageReading;
  /** Pages and frames the page tried to open on this computer or the local network, which were refused. */
  refused?: string[];
  /** Scripts, images, fetches and other subresources the page asked for there, which were not loaded. */
  blocked?: string[];
  /** Screenshots down the page. */
  views: string[];
  /** The opening animations frame by frame (all page animations paused and stepped together). */
  sheet?: Sheet;
}

/**
 * Opens a page in a throwaway headless profile, reads its animations at the top and while scrolling, takes views
 * down the page, then pauses every animation and steps it in time to film the opening motion frame by frame.
 */
export async function readPage(url: string, outDir: string, tools: MediaTools, options: { maxScroll?: number; stepSeconds?: number; lookup?: Lookup } = {}): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) throw new InvalidInputError(`"${url}" is not a web page address (http or https).`);
  const executable = findBrowser();
  if (!executable) throw new InvalidInputError("Reading web pages needs Chrome or Edge on this computer (or FRAMELENS_BROWSER pointing to one).");
  const profile = mkdtempSync(join(tmpdir(), "framelens-page-"));
  const session = await launchBrowser({ executable, profile, headless: true, width: 1440, height: 900, maxLifetimeMs: 3 * 60_000 });
  try {
    await session.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, session.sessionId);
    // The recorder runs before the page's own scripts, so motion that ends before the page is read still counts.
    await session.cdp.send("Page.enable", {}, session.sessionId);
    await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER_SCRIPT }, session.sessionId);
    const { refused, blocked } = await guardRequests(session, new URL(url), options.lookup);
    await navigate(session, url).catch((error: unknown) => {
      if (refused.length) throw new InvalidInputError(`${oneLine(url, 300)} redirected to ${refused[0]}, on this computer or the local network; it was not opened.`);
      throw error;
    });
    await wait(1200);
    const readings: PageReading[] = [cleanReading(await evaluate(session, PAGE_SCRIPT))];
    const first = readings[0]!;
    // The page navigated to a refused address and the tab shows the browser's error page: nothing to read.
    if (refused.length && /^chrome-error:/i.test(first.url)) {
      throw new InvalidInputError(`${oneLine(url, 300)} sent the browser to ${refused[0]}, on this computer or the local network; it was not opened.`);
    }
    const maxScroll = Math.min(first.scrollHeight - first.viewport.height, options.maxScroll ?? 12_000);
    const views: string[] = [];
    const take = async (name: string) => {
      const file = join(outDir, `${name}.png`);
      writeFileSync(file, await screenshot(session));
      views.push(file);
    };
    await take("view-0000");
    // Half a screen at a time, always ending exactly at the bottom so the last section is read too.
    const stops: number[] = [];
    for (let y = 450; y < maxScroll; y += 450) stops.push(y);
    if (maxScroll > 0) stops.push(maxScroll);
    for (const [i, y] of stops.entries()) {
      await evaluate(session, `window.scrollTo(0, ${y})`);
      await wait(350);
      readings.push(cleanReading(await evaluate(session, PAGE_SCRIPT)));
      if (i % 4 === 3 || i === stops.length - 1) await take(`view-${String(y).padStart(5, "0")}`);
    }
    await evaluate(session, "window.scrollTo(0, 0)");
    await wait(300);

    // Film the opening: pause every animation (also the ones the recorder kept after they ended, which come back while
    // paused), step them together, screenshot each step.
    const step = options.stepSeconds ?? 1 / 20;
    const longest = await evaluate<number>(
      session,
      `(() => { try { return Math.min(4000, Math.max(0, ...${ALL_ANIMATIONS}.map((a) => { const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}; return Number.isFinite(t.endTime) ? t.endTime : 0; }))); } catch (e) { return 0; } })()`,
    ).then((v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(4000, Math.max(0, v)) : 0));
    const frames: { t: number; file: string }[] = [];
    if (longest > 0) {
      for (let t = 0; t <= longest / 1000 + 1e-9 && frames.length < 48; t += step) {
        await evaluate(session, `(() => { try { ${ALL_ANIMATIONS}.forEach((a) => { try { a.pause(); a.currentTime = ${Math.round(t * 1000)}; } catch (e) {} }); } catch (e) {} })()`);
        await wait(40);
        const file = join(outDir, `motion-${t.toFixed(3).padStart(8, "0")}.png`);
        writeFileSync(file, await screenshot(session));
        frames.push({ t: Math.round(t * 1000) / 1000, file });
      }
    }
    const sheet = frames.length
      ? (await buildSheets(frames, outDir, "opening", { columns: 4, rows: Math.min(6, Math.ceil(frames.length / 4)), width: 480, label: (f) => `${f.t.toFixed(2)} s` }, tools))[0]
      : undefined;
    return { reading: mergeReadings(readings), views, ...(sheet && { sheet }), ...(refused.length && { refused: [...new Set(refused)] }), ...(blocked.length && { blocked: [...new Set(blocked)] }) };
  } finally {
    await session.close();
    removeProfile(profile);
  }
}

/**
 * Holds every request of the tab until its host is checked: documents (the page, its redirects, the navigations its
 * scripts start, its frames) and subresources (scripts, styles, images, fetch and XHR). One on this computer or the
 * local network is refused, unless it is the host the user gave. A page cannot send the reading, its text and
 * screenshots, to an admin page or a cloud metadata address, nor pull an internal script's text into the reading.
 * Returns the lists the refused documents and blocked subresources are added to. WebSockets are not requests the
 * browser lets us hold (SECURITY.md).
 */
async function guardRequests(session: BrowserSession, input: URL, lookup: Lookup = systemLookup): Promise<{ refused: string[]; blocked: string[] }> {
  const refused: string[] = [];
  const blocked: string[] = [];
  const own = hostOf(input);
  // One lookup per host: a page asks for many subresources from the same few hosts.
  const verdicts = new Map<string, Promise<boolean>>();
  const isPrivate = (host: string) => {
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = hostAddresses(host, lookup).then((addresses) => addresses.some(isPrivateAddress), () => false);
      verdicts.set(host, verdict);
    }
    return verdict;
  };
  session.cdp.on("Fetch.requestPaused", (params, sid) => {
    if (sid !== session.sessionId) return;
    const requestId = params.requestId as string;
    const target = String((params.request as { url?: unknown } | undefined)?.url ?? "");
    const isDocument = params.resourceType === "Document";
    void (async () => {
      let refuse = false;
      try {
        const next = new URL(target);
        const host = hostOf(next);
        // A name that does not resolve here does not open in the browser either.
        if ((next.protocol === "http:" || next.protocol === "https:") && host !== own) refuse = await isPrivate(host);
      } catch {
        // Not a link: nothing to check.
      }
      if (refuse) {
        (isDocument ? refused : blocked).push(oneLine(target, 120));
        await session.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, session.sessionId);
      } else await session.cdp.send("Fetch.continueRequest", { requestId }, session.sessionId);
    })().catch(() => undefined);
  });
  await session.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, session.sessionId);
  return { refused, blocked };
}

/**
 * Removes the temporary browser profile. Windows can hold its files a moment after the browser exits (EBUSY, EPERM),
 * so the removal retries, and a folder that still cannot go is left in the temp folder rather than throwing away a
 * finished reading from `finally`.
 */
export function removeProfile(profile: string, remove: typeof rmSync = rmSync): void {
  try {
    remove(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the system's temp cleanup.
  }
}

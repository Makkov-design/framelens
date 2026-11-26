import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "../media/exec.js";
import { buildSheets, type Sheet } from "../media/sheets.js";
import { hostAddresses, hostOf, isPrivateAddress, systemLookup, type Lookup } from "../sources/cobalt.js";
import { oneLine } from "../text.js";
import { evaluate, findBrowser, launchBrowser, navigate, screenshot, type BrowserSession } from "./cdp.js";
import { exemptHost, startProxy, upstreamFromEnv, type ProxyOptions, type RequestProxy } from "./proxy.js";
import { cleanReading, mergeReadings, PAGE_SCRIPT, RECORDER_SCRIPT, type PageReading } from "./web.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In the page: the running animations and the ones the recorder kept, each once (at most 1000). */
const ALL_ANIMATIONS = `(() => { const list = new Set(); try { for (const a of document.getAnimations()) list.add(a); } catch (e) {} try { for (const e of window[Symbol.for("framelens.recorder")].entries()) if (e && e.animation) list.add(e.animation); } catch (e) {} return [...list].slice(0, 1000); })()`;

export interface PageResult {
  reading: PageReading;
  /** Pages and frames the page tried to open on this computer or the local network, which were refused. */
  refused?: string[];
  /** Hosts any request of the page (a script, image, fetch, worker, prefetch, WebSocket) tried to reach there, refused. */
  blocked?: string[];
  /**
   * The network's own proxy (HTTPS_PROXY and the like, without credentials) that checked requests went on through, how
   * many hosts went to it (by name: it resolves them again, so none is pinned), and how many of them this computer
   * could not resolve at all.
   */
  upstream?: { proxy: string; hosts: number; unresolved: number };
  /** Screenshots down the page. */
  views: string[];
  /** The opening animations frame by frame (all page animations paused and stepped together). */
  sheet?: Sheet;
}

/**
 * Opens a page in a throwaway headless profile, reads its animations at the top and while scrolling, takes views
 * down the page, then pauses every animation and steps it in time to film the opening motion frame by frame.
 */
export async function readPage(url: string, outDir: string, tools: MediaTools, options: { maxScroll?: number; stepSeconds?: number; lookup?: Lookup; env?: NodeJS.ProcessEnv; dial?: ProxyOptions["dial"] } = {}): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) throw new InvalidInputError(`"${url}" is not a web page address (http or https).`);
  const executable = findBrowser();
  if (!executable) throw new InvalidInputError("Reading web pages needs Chrome or Edge on this computer (or FRAMELENS_BROWSER pointing to one).");
  const input = new URL(url);
  // Every request of the browser goes through this proxy. Without it the page is not opened at all.
  let proxy: RequestProxy;
  try {
    const upstream = upstreamFromEnv(options.env ?? process.env);
    proxy = await startProxy({ exempt: exemptHost(input), ...(options.lookup && { lookup: options.lookup }), ...(options.dial && { dial: options.dial }), ...(upstream && { upstream }) });
  } catch (error) {
    throw new InvalidInputError(`Could not start the request check for the page (${oneLine((error as Error).message, 120)}); the page was not opened.`);
  }
  const profile = mkdtempSync(join(tmpdir(), "framelens-page-"));
  let session: BrowserSession;
  try {
    session = await launchBrowser({ executable, profile, headless: true, width: 1440, height: 900, maxLifetimeMs: 3 * 60_000, proxy: proxy.url });
  } catch (error) {
    await proxy.close();
    removeProfile(profile);
    throw error;
  }
  // The browser's own DevTools port is on this computer: no page request may reach it, also from an exempt local page.
  if (session.debugPort) proxy.blockLocalPort(session.debugPort);
  try {
    await answerProxyAuth(session, proxy).catch((error: unknown) => {
      throw new InvalidInputError(`Could not set up the request check for the page (${oneLine((error as Error).message, 120)}); the page was not opened.`);
    });
    await withoutWebRtc(session).catch((error: unknown) => {
      throw new InvalidInputError(`Could not turn WebRTC off for the page (${oneLine((error as Error).message, 120)}); the page was not opened.`);
    });
    await session.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, session.sessionId);
    // The recorder runs before the page's own scripts, so motion that ends before the page is read still counts.
    await session.cdp.send("Page.enable", {}, session.sessionId);
    await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER_SCRIPT }, session.sessionId);
    const refused = await guardNavigations(session, input, options.lookup);
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
    return { reading: mergeReadings(readings), views, ...(sheet && { sheet }), ...(refused.length && { refused: [...new Set(refused)] }), ...(proxy.refused.length && { blocked: [...proxy.refused] }), ...(proxy.upstream && { upstream: { proxy: proxy.upstream, hosts: proxy.viaUpstream.size, unresolved: proxy.unresolved.size } }) };
  } finally {
    await session.close();
    await proxy.close();
    removeProfile(profile);
  }
}

/**
 * WebRTC's TCP connections to this computer's own address skip the proxy (Chrome connects them directly), and `web`
 * has no use for WebRTC, so its constructors are removed before any page script runs: in the tab, in every frame of it
 * (also a new about:blank or sandboxed one), in out-of-process frames and in popups, which are attached paused, given
 * the same script and let run. Workers have no RTCPeerConnection; they are only let run. Nothing is intercepted or
 * closed here.
 */
export const NO_WEBRTC_SCRIPT = `(() => { for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) { try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false, enumerable: false }); } catch (e) {} } })();`;

async function withoutWebRtc(session: BrowserSession): Promise<void> {
  const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  session.cdp.on("Target.attachedToTarget", (params) => {
    const child = params.sessionId as string | undefined;
    const type = (params.targetInfo as { type?: string } | undefined)?.type;
    if (!child) return;
    void (async () => {
      try {
        if (type === "page" || type === "iframe") {
          await session.cdp.send("Page.enable", {}, child);
          await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_WEBRTC_SCRIPT, runImmediately: true }, child);
          await session.cdp.send("Target.setAutoAttach", attach, child);
        }
      } catch {
        // A frame that is gone by now has nothing left to run.
      } finally {
        await session.cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined);
      }
    })();
  });
  await session.cdp.send("Page.enable", {}, session.sessionId);
  await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_WEBRTC_SCRIPT, runImmediately: true }, session.sessionId);
  // Frames and workers of the tab, and popups it opens (new pages, attached from the browser).
  await session.cdp.send("Target.setAutoAttach", attach, session.sessionId);
  await session.cdp.send("Target.setAutoAttach", { ...attach, filter: [{ type: "page", exclude: false }, { exclude: true }] });
}

/**
 * Gives Chrome the proxy's per-run credentials. Requests are paused on the browser target only so their auth challenges
 * reach us (Chrome reports a challenge only for a request it intercepts) and are let go at once. Only the proxy's own
 * 407 gets the credentials; a page's 401 or a 407 from anywhere else is cancelled, so they never reach a site.
 */
async function answerProxyAuth(session: BrowserSession, proxy: RequestProxy): Promise<void> {
  const origin = `${proxy.host}:${proxy.port}`;
  session.cdp.on("Fetch.requestPaused", (params, sid) => {
    if (sid) return;
    void session.cdp.send("Fetch.continueRequest", { requestId: params.requestId as string }).catch(() => undefined);
  });
  session.cdp.on("Fetch.authRequired", (params, sid) => {
    if (sid) return;
    const challenge = params.authChallenge as { source?: string; origin?: string } | undefined;
    const ours = challenge?.source === "Proxy" && /^(?:https?:\/\/)?([^/]+)\/?$/.exec(String(challenge.origin ?? ""))?.[1] === origin;
    void session.cdp
      .send("Fetch.continueWithAuth", {
        requestId: params.requestId as string,
        authChallengeResponse: ours ? { response: "ProvideCredentials", username: proxy.username, password: proxy.password } : { response: "CancelAuth" },
      })
      .catch(() => undefined);
  });
  await session.cdp.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

/**
 * Holds every document request of the tab (the page, its redirects, the navigations its scripts start, its frames)
 * until its host is checked: one on this computer or the local network is refused, unless it is the host the user
 * gave and that host is literally local. The proxy enforces the same for every request; this check gives the clear
 * message for a page that redirects. A page cannot send the reading, its text and screenshots, to an admin page or a cloud metadata address.
 * Returns the list the refused addresses are added to.
 */
async function guardNavigations(session: BrowserSession, input: URL, lookup: Lookup = systemLookup): Promise<string[]> {
  const refused: string[] = [];
  // Exempt only when the user's own input is literally local (`localhost`, a loopback or private IP): a public name
  // that resolves to a private address is refused like any other.
  const own = exemptHost(input);
  session.cdp.on("Fetch.requestPaused", (params, sid) => {
    if (sid !== session.sessionId) return;
    const requestId = params.requestId as string;
    const target = String((params.request as { url?: unknown } | undefined)?.url ?? "");
    void (async () => {
      let refuse = false;
      try {
        const next = new URL(target);
        const host = hostOf(next);
        if ((next.protocol === "http:" || next.protocol === "https:") && host !== own) refuse = (await hostAddresses(host, lookup)).some(isPrivateAddress);
      } catch {
        // A name that does not resolve here does not open in the browser either.
      }
      if (refuse) {
        refused.push(oneLine(target, 120));
        await session.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, session.sessionId);
      } else await session.cdp.send("Fetch.continueRequest", { requestId }, session.sessionId);
    })().catch(() => undefined);
  });
  await session.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, session.sessionId);
  return refused;
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

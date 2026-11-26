// Every WebRTC global of this Chromium is either removed by `web` (NO_WEBRTC_SCRIPT) or known not to open a
// connection by itself: a new entry point in a later Chromium fails here instead of reaching around the proxy.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate, findBrowser, launchBrowser, navigate } from "../../src/browser/cdp.js";
import { NO_WEBRTC_SCRIPT } from "../../src/browser/read.js";
import { tempDir } from "../media/fixtures.js";

const browser = findBrowser();
const canRun = Boolean(browser && (globalThis as { WebSocket?: unknown }).WebSocket && (process.env.CI || process.env.FRAMELENS_BROWSER_TESTS));

/** The names NO_WEBRTC_SCRIPT removes, read from the script itself. */
const removed = JSON.parse(/for \(const name of (\[[^\]]*\])/.exec(NO_WEBRTC_SCRIPT)![1]!) as string[];

/**
 * WebRTC globals that cannot open a connection by themselves: events, errors, stats, encoded frames and the parts a
 * peer connection hands out (its senders, receivers and transports exist only through one, which is removed).
 */
const NO_CONNECTION = new Set([
  "RTCCertificate",
  "RTCDTMFSender",
  "RTCDTMFToneChangeEvent",
  "RTCDataChannelEvent",
  "RTCDtlsTransport",
  "RTCEncodedAudioFrame",
  "RTCEncodedVideoFrame",
  "RTCError",
  "RTCErrorEvent",
  "RTCPeerConnectionIceErrorEvent",
  "RTCPeerConnectionIceEvent",
  "RTCRtpReceiver",
  "RTCRtpScriptTransform",
  "RTCRtpSender",
  "RTCRtpTransceiver",
  "RTCSctpTransport",
  "RTCStatsReport",
  "RTCTrackEvent",
  // Worker-side halves of RTCRtpScriptTransform (encoded frames of a sender or receiver).
  "RTCTransformEvent",
  "RTCRtpScriptTransformer",
]);

const LIST = `Object.getOwnPropertyNames(globalThis).filter((n) => /^(webkit)?RTC/i.test(n)).sort()`;

describe.skipIf(!canRun)("WebRTC entry points of this browser", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/worker.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        // Each name, and whether a worker script can make one itself ("illegal" when only a page can hand it over).
        res.end(`postMessage(${LIST}.map((n) => { try { new self[n](); return n + ":made"; } catch (e) { return n + (/illegal constructor/i.test(String(e)) ? ":illegal" : ":made"); } }))`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Fresh</title>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("are all removed by web or known not to open a connection, in a page and in a worker", async () => {
    // A plain browser and page (secure context, nothing removed): what this Chromium offers a page.
    const session = await launchBrowser({ executable: browser!, profile: tempDir(), headless: true, width: 800, height: 600 });
    try {
      await navigate(session, `${base}/`);
      const page = await evaluate<string[]>(session, LIST);
      const worker = await evaluate<string[]>(session, `new Promise((resolve) => { new Worker("/worker.js").onmessage = (e) => resolve(e.data); })`);
      expect(page).toContain("RTCPeerConnection");
      expect(page.filter((n) => !removed.includes(n) && !NO_CONNECTION.has(n))).toEqual([]);
      // Workers are not given the removal script. What they have beyond the list above (RTCDataChannel)
      // cannot be made in the worker, only handed over from a page, where it is removed.
      const inWorker = worker.map((w) => w.split(":") as [string, string]).filter(([n]) => !NO_CONNECTION.has(n));
      expect(inWorker.filter(([n, how]) => how !== "illegal" || !removed.includes(n))).toEqual([]);
      // Every removed name is one this browser has (a renamed entry point would leave its new name unlisted above).
      expect(removed.filter((n) => !page.includes(n))).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);
});

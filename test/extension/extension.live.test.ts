import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../../src/browser/cdp.js";
import { readPage } from "../../src/browser/read.js";
import type { PageAnimation, PageReading } from "../../src/browser/web.js";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { extractFrames } from "../../src/media/frames.js";
import { probeMedia } from "../../src/media/probe.js";
import { readWebmDurationMs } from "../../extension/src/webm.js";
import { mediaTools, tempDir } from "../media/fixtures.js";
import { PipeBrowser } from "./pipe-browser.js";

// A real headless browser with the unpacked extension: heavy on a shared machine, so in CI and locally only with
// FRAMELENS_BROWSER_TESTS=1 (one browser at a time, each killed after 50 s).
const browser = findBrowser();
const tools = mediaTools();
const dist = resolve("extension/dist");
const canRun = Boolean(browser && tools && existsSync(join(dist, "manifest.json")) && (globalThis as { WebSocket?: unknown }).WebSocket && (process.env.CI || process.env.FRAMELENS_BROWSER_TESTS));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><title>Extension motion test</title><style>
body { margin: 0; background: #0E0F1A; color: #F2E94E; font: 800 72px/1 Arial, sans-serif; }
h1 { font-weight: 800; text-transform: uppercase; animation: rise 600ms cubic-bezier(0.16, 1, 0.3, 1) 200ms both; }
@keyframes rise { from { opacity: 0; transform: translateY(80px); } to { opacity: 1; transform: none; } }
.spacer { height: 1500px; }
.card { width: 300px; height: 200px; background: #2F6FE0; transition: opacity 700ms ease-out; }
.card.on { animation: pop 400ms ease-in-out both; opacity: 0.9; }
@keyframes pop { from { transform: scale(0.8); } to { transform: none; } }
</style></head><body><h1>Hello motion</h1><div class="box" id="box">box</div><div class="spacer"></div><div class="card" id="card"></div>
<script>
document.getElementById("box").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 100, easing: "ease-in", fill: "both", iterations: Infinity });
new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("on"))).observe(document.getElementById("card"));
window.gsap = { globalTimeline: { getChildren: () => [{ vars: { x: 200, ease: "expo.out", duration: 1.2 }, startTime: () => 0.5, duration: () => 1.2, targets: () => [document.querySelector("h1")] }] } };
</script></body></html>`;

/** Starts the browser with the extension and returns its worker's session, or undefined when it cannot load one. */
async function withExtension(b: PipeBrowser, path: string): Promise<{ id: string; worker: string } | undefined> {
  const findWorker = async () => {
    const { targetInfos } = await b.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url))) {
      const { sessionId } = await b.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const name = await b.evaluate<string>(sessionId, "chrome.runtime.getManifest().name").catch(() => "");
      if (name === "Frame Lens" && (await b.evaluate<boolean>(sessionId, "typeof framelens === 'object'").catch(() => false))) return { id: t.url.split("/")[2]!, worker: sessionId };
    }
    return undefined;
  };
  const poll = async (tries: number) => {
    for (let i = 0; i < tries; i++) {
      const found = await findWorker();
      if (found) return found;
      await wait(300);
    }
    return undefined;
  };
  // Loaded through the protocol (branded Chrome ignores --load-extension since version 137). The worker starts when
  // something talks to it, so the popup page is opened once (it asks the worker for the recording status).
  const loaded = await b.send<{ id?: string }>("Extensions.loadUnpacked", { path }).catch(() => undefined);
  if (!loaded?.id) return undefined;
  await b.send("Target.createTarget", { url: `chrome-extension://${loaded.id}/popup.html` });
  return poll(20);
}

describe.skipIf(!canRun)("the browser extension in a real browser", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let ext: string;

  beforeAll(async () => {
    dir = tempDir();
    // activeTab grants the extension the tab the user opened it on; a test has no user, so this copy holds the same
    // grant as a host permission for the local test page. The code under test is the built extension unchanged.
    ext = join(dir, "extension");
    cpSync(dist, ext, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({ ...manifest, host_permissions: ["http://127.0.0.1/*"] }));
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows can hold a file the killed browser had open a moment longer; it is a temp folder.
    }
  });

  it("reads a page in the browser the way the web tool does, and Frame Lens turns the saved file into the same spec", async (ctx) => {
    const downloads = join(dir, "downloads");
    let saved: { reading: PageReading; filename: string };
    const b = PipeBrowser.launch(browser!, { downloads });
    try {
      const loaded = await withExtension(b, ext);
      if (!loaded) return ctx.skip("this browser does not load unpacked extensions headless");
      await b.send("Target.createTarget", { url: `${base}/` });
      await wait(1500);
      saved = await b.evaluate(loaded.worker, `(async () => { const [tab] = await chrome.tabs.query({ url: "${base}/*" }); return framelens.readTab(tab.id, { maxScroll: 2000 }); })()`, 40_000);
      for (let i = 0; i < 40 && !existsSync(join(downloads, saved.filename)); i++) await wait(250);
    } finally {
      b.close();
    }
    const file = join(downloads, saved.filename);
    expect(saved.filename).toMatch(/^FrameLens\/page-127\.0\.0\.1-\d{8}-\d{6}\.framelens\.json$/);
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.framelens).toBe("framelens.page-reading/1");

    // The same page read by the web tool, in its own headless browser (after the first one closed).
    const live = await readPage(`${base}/`, dir, tools!, { maxScroll: 2000 });
    const key = (a: PageAnimation) => `${a.kind}|${a.name}|${a.target}|${a.duration}|${a.delay}|${a.easing}|${a.iterations}|${Boolean(a.scrollTriggered)}`;
    expect(json.animations.map(key).sort()).toEqual(live.reading.animations.map(key).sort());
    expect(json.animations.map(key).join("\n")).toMatch(/css-animation\|rise\|.*\|600\|200\|/);
    expect(json.animations.some((a: PageAnimation) => a.name === "pop" && a.scrollTriggered)).toBe(true);
    expect(json.gsap).toBe(true);
    expect(json.fonts).toEqual(live.reading.fonts);
    expect(json.colors[0].hex).toBe(live.reading.colors[0]!.hex);

    // Frame Lens: the saved reading by path and through the inbox gives the measured spec, and export works on it.
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const fromFile = await engine.web(file, "test");
    const fromInbox = await engine.web("inbox", "test", { FRAMELENS_DOWNLOADS: downloads });
    expect(fromInbox.savedReading).toBe(resolve(file));
    expect(fromFile.spec.events.length).toBe(live.reading.animations.filter((a) => a.duration > 0 && a.duration < 60_000).length);
    expect(fromFile.spec.events.find((e) => (e as { name?: string }).name === "rise")).toMatchObject({ start: 0.2, end: 0.8, easing: "ease-out", evidence: "measured" });
    const exported = await engine.export(file, "css", "test");
    expect(exported.files.some((f) => f.endsWith("motion.css"))).toBe(true);
  }, 120_000);

  it("records a WebM with its duration, saves it to Downloads/FrameLens, and Frame Lens reads its real, variable frame times", async (ctx) => {
    let recorded: { base64: string; durationMs: number; bytes: number; saved: { ok: boolean; filename?: string; error?: string } };
    const downloads = join(dir, "rec-downloads");
    const b = PipeBrowser.launch(browser!, { downloads, args: ["--autoplay-policy=no-user-gesture-required"] });
    try {
      const loaded = await withExtension(b, ext);
      if (!loaded) return ctx.skip("this browser does not load unpacked extensions headless");
      // The offscreen recorder page, opened as a tab: the tab stream itself needs a person to open the extension, so
      // a canvas that changes at uneven times stands in for it (MediaRecorder writes the same kind of file).
      const { targetId } = await b.send<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${loaded.id}/offscreen.html` });
      const { sessionId } = await b.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await wait(800);
      recorded = await b.evaluate(
        sessionId,
        `(async () => {
          const c = document.createElement("canvas"); c.width = 320; c.height = 180; document.body.append(c);
          const g = c.getContext("2d");
          framelensRecorder.record(c.captureStream(), "https://example.test/reel/1");
          const t0 = performance.now();
          for (let i = 0; performance.now() - t0 < 2500; i++) {
            g.fillStyle = "hsl(" + ((i * 47) % 360) + " 80% 50%)"; g.fillRect(0, 0, 320, 180);
            await new Promise((r) => setTimeout(r, i % 3 ? 33 : 150));
          }
          const file = await framelensRecorder.stop();
          const buf = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
          let s = ""; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
          // The message the recorder sends when it stops: the service worker saves the blob: file as a download.
          const saved = await chrome.runtime.sendMessage({ target: "background", type: "recorded", url: file.url, pageUrl: "https://example.test/reel/1" });
          return { durationMs: file.durationMs, bytes: file.bytes, base64: btoa(s), saved };
        })()`,
        40_000,
      );
    } finally {
      b.close();
    }
    expect(recorded.saved).toMatchObject({ ok: true, filename: expect.stringMatching(/^FrameLens\/recording-example\.test-\d{8}-\d{6}\.webm$/) });
    const file = join(downloads, recorded.saved.filename!);
    const data = Buffer.from(recorded.base64, "base64");
    expect(readFileSync(file)).toEqual(data);
    expect(data.length).toBe(recorded.bytes);
    const written = readWebmDurationMs(new Uint8Array(data.subarray(0, 64 * 1024)));
    expect(written).toBeGreaterThan(2300);
    expect(Math.abs(written! - recorded.durationMs)).toBeLessThan(5);

    const probe = await probeMedia(file, tools!);
    expect(probe.duration).toBeGreaterThan(2.2);
    expect(probe.duration).toBeLessThan(3.2);
    expect(probe.vfr).toBe(true);
    const frames = await extractFrames(file, join(dir, "rec-frames"), { everyFrame: true, start: 0, end: 2, width: 160 }, probe, tools!);
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i]!.t);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.05);
    expect(readdirSync(join(dir, "rec-frames")).length).toBe(frames.length);
  }, 120_000);
});

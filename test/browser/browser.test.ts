import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureVideo, chooseMedia } from "../../src/browser/capture.js";
import { findBrowser } from "../../src/browser/cdp.js";
import { readPage } from "../../src/browser/read.js";
import { easingFamily, effectiveEasing, mergeReadings, specFromPage, type PageAnimation, type PageReading } from "../../src/browser/web.js";
import { createHash } from "node:crypto";
import { Engine } from "../../src/engine.js";
import { exportSpec } from "../../src/export/exporters.js";
import { silentLogger } from "../../src/logger.js";
import { Workspace } from "../../src/workspace/workspace.js";
import { cutsVideo, mediaTools, tempDir } from "../media/fixtures.js";

const anim = (over: Partial<PageAnimation>): PageAnimation => ({
  kind: "css-animation",
  name: "rise",
  target: "h1.title",
  delay: 200,
  duration: 600,
  iterations: 1,
  easing: "linear",
  keyframes: [{ offset: 0, easing: "cubic-bezier(0.16, 1, 0.3, 1)", opacity: "0" }, { offset: 1, opacity: "1" }],
  properties: ["opacity"],
  scrollY: 0,
  ...over,
});

const reading = (animations: PageAnimation[], colors = [{ hex: "#0E0F1A", area: 900 }, { hex: "#F2E94E", area: 100 }]): PageReading => ({
  url: "https://example.test/",
  title: "Example",
  viewport: { width: 1440, height: 900 },
  scrollHeight: 3000,
  animations,
  fonts: [{ selector: "h1.title", family: "Inter, sans-serif", weight: "800", size: "72px", lineHeight: "76px", letterSpacing: "-1.5px", transform: "uppercase", sample: "Hello" }],
  colors,
  gsap: false,
});

describe("web animation data", () => {
  it("names easing families from CSS keywords, cubic-bezier and GSAP names", () => {
    expect(easingFamily("cubic-bezier(0.16, 1, 0.3, 1)")).toBe("ease-out");
    expect(easingFamily("cubic-bezier(0.7, 0, 0.84, 0)")).toBe("ease-in");
    expect(easingFamily("cubic-bezier(0.65, 0, 0.35, 1)")).toBe("ease-in-out");
    expect(easingFamily("ease-out")).toBe("ease-out");
    expect(easingFamily("power3.out")).toBe("ease-out");
    expect(easingFamily("expo.inOut")).toBe("ease-in-out");
    expect(easingFamily("none")).toBe("linear");
    expect(easingFamily("steps(4)")).toBe("unclear");
  });

  it("takes a CSS animation's curve from its keyframes", () => {
    expect(effectiveEasing(anim({}))).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(effectiveEasing(anim({ kind: "waapi", easing: "ease-in" }))).toBe("ease-in");
  });

  it("merges scroll readings, marks scroll-triggered animations and builds a measured spec", () => {
    const merged = mergeReadings([reading([anim({})]), reading([anim({}), anim({ name: "card-in", target: "div.card", scrollY: 900 })])]);
    expect(merged.animations).toHaveLength(2);
    expect(merged.animations[1]!.scrollTriggered).toBe(true);
    const spec = specFromPage(merged, "test");
    expect(spec.source.kind).toBe("web");
    expect(spec.events[0]).toMatchObject({ start: 0.2, end: 0.8, frames: 36, easing: "ease-out", suggestion: "cubic-bezier(0.16, 1, 0.3, 1)", evidence: "measured" });
    expect(spec.palette[0]).toMatchObject({ hex: "#0E0F1A", share: 0.9, evidence: "measured" });
    expect(spec.typography[0]).toMatchObject({ family_guess: "Inter, sans-serif", weight: 800, evidence: "measured" });
  });

  it("feeds the exporters like a video spec", () => {
    const dir = tempDir();
    try {
      const files = exportSpec(specFromPage(reading([anim({})]), "test"), "css", dir);
      expect(readFileSync(files.find((f) => f.endsWith("motion.css"))!, "utf8")).toContain("cubic-bezier(0.16, 1, 0.3, 1)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks the whole video and its separate sound from what a page loaded", () => {
    const picked = chooseMedia([
      { url: "https://cdn.test/v.mp4?x=1&bytestart=0&byteend=999", mimeType: "video/mp4", length: 1000 },
      { url: "https://cdn.test/v.mp4?x=1&bytestart=1000&byteend=1999", mimeType: "video/mp4", length: 1000 },
      { url: "https://cdn.test/hd.mp4", mimeType: "video/mp4", length: 9000 },
      { url: "https://cdn.test/a.m4a", mimeType: "audio/mp4", length: 300 },
      { url: "https://cdn.test/list.m3u8", mimeType: "video/mp4", length: 99999 },
    ]);
    expect(picked.video?.url).toBe("https://cdn.test/hd.mp4");
    expect(picked.audio?.url).toBe("https://cdn.test/a.m4a");
    expect(chooseMedia([{ url: "https://cdn.test/v.mp4?bytestart=0&byteend=9", mimeType: "video/mp4", length: 9 }]).video?.url).toBe("https://cdn.test/v.mp4");
  });

  it("exports a page read earlier by its address, without treating it as a video link", async () => {
    const dir = tempDir();
    try {
      const url = "https://example.test/";
      const engine = new Engine({
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", exec: async () => ({ stdout: "", stderr: "" }) },
        resolve: async () => {
          throw new Error("must not resolve a web page as a video");
        },
        root: dir,
        logger: silentLogger,
      });
      const ws = new Workspace(dir, `web-${createHash("sha1").update(url).digest("hex").slice(0, 10)}`);
      ws.writeJson("motion-spec.json", specFromPage(reading([anim({})]), "test"));
      const { files } = await engine.export(url, "css", "test");
      expect(files.some((f) => f.endsWith("motion.css"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no browser where none is configured", () => {
    expect(findBrowser({ FRAMELENS_BROWSER: "/nope/chrome" })).toBeUndefined();
  });
});

const browser = findBrowser();
const tools = mediaTools();
// Headless browsers are heavy on a shared machine: these run in CI, and locally only with FRAMELENS_BROWSER_TESTS=1.
const canRun = Boolean(browser && tools && (globalThis as { WebSocket?: unknown }).WebSocket && (process.env.CI || process.env.FRAMELENS_BROWSER_TESTS));

const PAGE = `<!doctype html><html><head><title>Motion test</title><style>
body { margin: 0; background: #0E0F1A; color: #F2E94E; font: 800 72px/1 Arial, sans-serif; }
h1 { font-weight: 800; text-transform: uppercase; animation: rise 600ms cubic-bezier(0.16, 1, 0.3, 1) 200ms both; }
@keyframes rise { from { opacity: 0; transform: translateY(80px); } to { opacity: 1; transform: none; } }
.spacer { height: 1500px; }
.card { width: 300px; height: 200px; background: #2F6FE0; }
.card.on { animation: pop 400ms ease-in-out both; }
@keyframes pop { from { transform: scale(0.8); } to { transform: none; } }
</style></head><body><h1>Hello motion</h1><div class="box" id="box">box</div><div class="spacer"></div><div class="card" id="card"></div>
<script>
document.getElementById("box").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 100, easing: "ease-in", fill: "both" });
new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("on"))).observe(document.getElementById("card"));
window.gsap = { globalTimeline: { getChildren: () => [{ vars: { x: 200, ease: "expo.out", duration: 1.2 }, startTime: () => 0.5, duration: () => 1.2, targets: () => [document.querySelector("h1")] }] } };
</script></body></html>`;

describe.skipIf(!canRun)("with a real browser", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = tempDir();
    const video = readFileSync(cutsVideo(dir));
    server = createServer((req, res) => {
      if (req.url === "/clip.mp4") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": video.length });
        res.end(video);
      } else if (req.url === "/post") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><video src="/clip.mp4" muted autoplay playsinline></video>`);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads CSS, Web Animations, scroll-triggered and GSAP animations exactly, and films the opening", async () => {
    const result = await readPage(`${base}/`, dir, tools!, { maxScroll: 2000 });
    const byName = (name: string) => result.reading.animations.find((a) => a.name === name);
    expect(byName("rise")).toMatchObject({ kind: "css-animation", duration: 600, delay: 200 });
    expect(effectiveEasing(byName("rise")!)).toMatch(/cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
    expect(result.reading.animations.find((a) => a.kind === "waapi")).toMatchObject({ duration: 900, delay: 100, easing: "ease-in" });
    expect(byName("pop")).toMatchObject({ duration: 400, scrollTriggered: true });
    expect(result.reading.animations.find((a) => a.kind === "gsap")).toMatchObject({ easing: "expo.out", duration: 1200, delay: 500 });
    expect(result.reading.gsap).toBe(true);
    expect(result.reading.fonts[0]).toMatchObject({ weight: "800", transform: "uppercase" });
    expect(result.reading.colors[0]!.hex).toBe("#0E0F1A");
    expect(result.sheet && existsSync(result.sheet.file)).toBe(true);
  }, 120_000);

  it("captures the video a page plays through the browser", async () => {
    process.env.FRAMELENS_BROWSER_PROFILE = join(dir, "profile");
    try {
      const out = await captureVideo(`${base}/post`, join(dir, "captured"), tools!, 50 * 1024 * 1024);
      expect(existsSync(out)).toBe(true);
    } finally {
      delete process.env.FRAMELENS_BROWSER_PROFILE;
    }
  }, 120_000);
});

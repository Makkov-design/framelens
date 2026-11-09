// Renders the README banner and screenshots of the site's sections into docs/assets/readme/.
// One headless Chrome or Edge, one page visited in turn, killed after 60 s whatever happens.
// Needs Node 22+ (global WebSocket) and ffmpeg on PATH for the WebP/PNG encoding.
//   node scripts/site/readme-shots.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const out = join(root, "docs/assets/readme");
mkdirSync(out, { recursive: true });

const browsers = [
  process.env.FRAMELENS_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const browser = browsers.find((b) => existsSync(b));
if (!browser) throw new Error("No Chrome or Edge found; set FRAMELENS_BROWSER.");

const shots = [
  { page: "scripts/site/banner.html", selector: ".banner", name: "banner", scale: 1, pad: 0, format: "png" },
  { page: "docs/index.html", selector: ".loupe", name: "loupe", scale: 1.5, pad: 24, format: "webp" },
  { page: "docs/index.html", selector: ".versus .container", name: "measured", scale: 1.5, pad: 32, format: "webp" },
  { page: "docs/index.html", selector: ".goals .sheet", name: "contact-sheet", scale: 2, pad: 16, format: "webp" },
  { page: "docs/index.html", selector: ".sources .container", name: "readings", scale: 1.5, pad: 32, format: "webp" },
  { page: "docs/index.html", selector: ".export .container", name: "export", scale: 1.5, pad: 32, format: "webp" },
];

const profile = mkdtempSync(join(tmpdir(), "framelens-shots-"));
const chrome = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,4000", "about:blank",
], { stdio: "ignore" });
const killer = setTimeout(() => { console.error("timed out"); chrome.kill(); process.exit(1); }, 60_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await sleep(100); }
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg);
});
const send = (method, params = {}) => new Promise((ok, fail) => {
  const n = ++id;
  pending.set(n, (msg) => (msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");
let current = "";
try {
  for (const shot of shots) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: shot.scale, mobile: false });
    if (current !== shot.page) {
      events.length = 0;
      await send("Page.navigate", { url: pathToFileURL(join(root, shot.page)).href });
      for (let i = 0; i < 100 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(100);
      await evaluate("document.fonts.ready.then(() => true)");
      // Lazy images: load them all before measuring.
      await evaluate("Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); })).then(() => true)");
      await sleep(800);
      current = shot.page;
    }
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(shot.selector)}).getBoundingClientRect(); const p = ${shot.pad}; const x = Math.max(0, r.left + scrollX - p); return { x, y: Math.max(0, r.top + scrollY - p), width: Math.min(r.width + 2 * p, document.documentElement.clientWidth - x), height: r.height + 2 * p }; })()`);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: shot.scale } });
    const raw = join(profile, `${shot.name}.png`);
    writeFileSync(raw, Buffer.from(data, "base64"));
    const file = join(out, `${shot.name}.${shot.format}`);
    const args = shot.format === "webp" ? ["-c:v", "libwebp", "-quality", "86", "-compression_level", "6"] : ["-pix_fmt", "rgb24", "-compression_level", "9"];
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, ...args, file]);
    console.log(`${shot.name}: ${Math.round(box.width)}×${Math.round(box.height)} → ${file}`);
  }
} finally {
  clearTimeout(killer);
  ws.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

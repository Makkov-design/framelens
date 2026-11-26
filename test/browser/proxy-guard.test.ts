// The `web` request proxy in a real browser: every kind of request a page can make to this computer is refused, and
// pages that only use their own host keep working (2.3.0).
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../../src/browser/cdp.js";
import { readPage } from "../../src/browser/read.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const browser = findBrowser();
const tools = mediaTools();
const canRun = Boolean(browser && tools && (globalThis as { WebSocket?: unknown }).WebSocket && (process.env.CI || process.env.FRAMELENS_BROWSER_TESTS));

describe.skipIf(!canRun)("web request proxy, in a real browser", () => {
  let dir: string;
  let server: Server;
  let port: number;
  let base: string;
  /** Requests that reached the server under a name other than the page's own (127.0.0.1): each one is a leak. */
  const leaks: string[] = [];
  /** Headers of every request the server saw. */
  const seen: IncomingHttpHeaders[] = [];

  const js = (res: import("node:http").ServerResponse, body: string) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
  };

  beforeAll(async () => {
    dir = tempDir();
    server = createServer((req, res) => {
      seen.push(req.headers);
      const host = String(req.headers.host ?? "");
      const url = req.url ?? "";
      if (!host.startsWith("127.0.0.1:")) leaks.push(`${host}${url}`);
      const inside = (name: string) => `http://localhost:${port}/internal-${name}`;
      const fetchInside = (name: string) => `fetch(${JSON.stringify(inside(name))}).catch(() => {});`;
      if (url === "/everything") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Everything</title>
<img src="${inside("img")}"><script src="${inside("script")}"></script>
<iframe src="${inside("iframe")}"></iframe>
<iframe sandbox="allow-scripts" srcdoc="<script>${fetchInside("sandboxed").replace(/"/g, "&quot;")}</script>"></iframe>
<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: "list", urls: [inside("prefetch")] }] })}</script>
<script>
${fetchInside("fetch")}
fetch("/redirect").catch(() => {});
fetch("http://rebind.example:${port}/internal-rebind").catch(() => {});
fetch("http://[::1]:${port}/internal-v6").catch(() => {});
fetch("http://[::ffff:127.0.0.1]:${port}/internal-mapped").catch(() => {});
try { const ws = new WebSocket("ws://localhost:${port}/internal-ws"); ws.onerror = () => {}; } catch (e) {}
new Worker("/dedicated.js");
new Worker(URL.createObjectURL(new Blob([${JSON.stringify(fetchInside("blob"))}], { type: "text/javascript" })));
try { new SharedWorker("/shared.js").port.start(); } catch (e) {}
navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then((r) => r.active.postMessage("go")).catch(() => {});
// A site that asks for credentials gets none of the proxy's.
fetch("/auth401").catch(() => {});
fetch("/auth407").catch(() => {});
const frame = document.createElement("iframe"); frame.src = "/auth401"; document.body.appendChild(frame);
// A worker of the page's own host still runs and reports back.
new Worker("/own.js").onmessage = (e) => { document.title = e.data; };
</script>`);
      } else if (url === "/dedicated.js") js(res, `${fetchInside("dedicated")} new Worker("/nested.js");`);
      else if (url === "/nested.js") js(res, fetchInside("nested"));
      else if (url === "/shared.js") js(res, `${fetchInside("shared")} self.onconnect = () => { ${fetchInside("shared-connect")} };`);
      else if (url === "/sw.js") {
        js(res, `self.addEventListener("install", (e) => { ${fetchInside("sw-install")} self.skipWaiting(); }); self.addEventListener("activate", (e) => e.waitUntil(clients.claim())); self.addEventListener("message", () => { ${fetchInside("sw-message")} });`);
      } else if (url === "/own.js") js(res, `fetch("/data.json").then((r) => r.json()).then((d) => postMessage(d.title));`);
      else if (url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ title: "Own worker ran" }));
      } else if (url === "/redirect") {
        res.writeHead(302, { location: inside("redirect") });
        res.end();
      } else if (url === "/auth401") {
        res.writeHead(401, { "www-authenticate": 'Basic realm="site"' });
        res.end();
      } else if (url === "/auth407") {
        res.writeHead(407, { "proxy-authenticate": 'Basic realm="site"' });
        res.end();
      } else if (url === "/plain") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Plain</title><h1 style="animation: a 300ms">Hi</h1><style>@keyframes a { from { opacity: 0 } }</style>`);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Internal</title>`);
      }
    });
    // A WebSocket handshake that reaches the server is a leak too.
    server.on("upgrade", (req, socket) => {
      leaks.push(`${req.headers.host}${req.url} (websocket)`);
      const key = String(req.headers["sec-websocket-key"] ?? "");
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses every kind of request to another host on this computer, and the page's own workers still run", async () => {
    leaks.length = 0;
    // rebind.example is a public-looking name that resolves to this computer.
    const lookup = async (host: string) => (host === "rebind.example" ? ["127.0.0.1"] : ["203.0.113.10"]);
    const result = await readPage(`${base}/everything`, dir, tools!, { maxScroll: 0, lookup });
    // Late worker requests get a moment to arrive before the check.
    await new Promise((r) => setTimeout(r, 1000));
    expect(leaks).toEqual([]);
    expect(result.reading.title).toBe("Own worker ran");
    const blocked = result.blocked ?? [];
    expect(blocked).toEqual(expect.arrayContaining([`localhost:${port}`, `rebind.example:${port}`, `[::1]:${port}`]));
    expect(blocked.some((h) => /^\[::ffff:/.test(h))).toBe(true);
    // The per-run proxy credentials never reach a site.
    expect(seen.some((h) => "proxy-authorization" in h || "authorization" in h)).toBe(false);
  }, 120_000);

  it("reads a plain page about as fast as it reads other pages", async () => {
    const started = Date.now();
    const result = await readPage(`${base}/plain`, dir, tools!, { maxScroll: 0 });
    expect(result.reading.title).toBe("Plain");
    // The reading itself waits about 1.5 s on purpose; the proxy must not add seconds to it.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);
});

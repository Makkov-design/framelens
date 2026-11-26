// The `web` request proxy in a real browser: every kind of request a page can make to this computer is refused, and
// pages that only use their own host keep working (2.3.0).
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
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

  it("turns WebRTC off in every frame, so TURN over TCP cannot reach this computer around the proxy (audit H1 of #51)", async () => {
    // Chrome opens WebRTC's TCP connections to 127.0.0.1 directly, not through the proxy: count what reaches a listener.
    let turnHits = 0;
    const turn = createTcpServer((socket) => {
      turnHits++;
      socket.destroy();
    });
    await new Promise<void>((r) => turn.listen(0, "127.0.0.1", r));
    const turnPort = (turn.address() as AddressInfo).port;
    const attempt = (realm: string) =>
      `(() => { try { const pc = new (${realm}.RTCPeerConnection)({ iceTransportPolicy: "relay", iceServers: [{ urls: ["turn:127.0.0.1:${turnPort}?transport=tcp", "turns:127.0.0.1:${turnPort}?transport=tcp", "stun:127.0.0.1:${turnPort}"], username: "u", credential: "p" }] }); pc.createDataChannel("x"); pc.addEventListener("icecandidateerror", () => {}); pc.createOffer().then((o) => pc.setLocalDescription(o)); return "made"; } catch (e) { return "blocked"; } })()`;
    const frame = (name: string) => `<!doctype html><script>parent.postMessage(${JSON.stringify(name)} + ":" + ${attempt("window")}, "*");</script>`;
    const pages = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/oopif") res.end(frame("cross-site"));
      else
        res.end(`<!doctype html><title>Waiting</title><body><script>
const out = ["top:" + ${attempt("window")}];
const blank = document.createElement("iframe"); document.body.appendChild(blank); out.push("about-blank:" + ${attempt("blank.contentWindow")});
addEventListener("message", (e) => { out.push(String(e.data)); document.title = out.sort().join(" "); });
new Worker(URL.createObjectURL(new Blob(["postMessage(typeof RTCPeerConnection)"]))).onmessage = (e) => { out.push("worker:" + e.data); document.title = out.sort().join(" "); };
document.title = out.sort().join(" ");
</script>
<iframe sandbox="allow-scripts" srcdoc="${frame("sandboxed").replace(/"/g, "&quot;")}"></iframe>
<iframe src="http://other.example:${(pages.address() as AddressInfo).port}/oopif"></iframe>`);
    });
    await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
    const pagePort = (pages.address() as AddressInfo).port;
    try {
      // A public page (not the exempt host): its names resolve to a public address, and the proxy's connection to that
      // address lands on the local test server.
      const result = await readPage(`http://public.example:${pagePort}/`, dir, tools!, {
        maxScroll: 0,
        env: {},
        lookup: async () => ["203.0.113.10"],
        dial: (_address, port) => ({ host: "127.0.0.1", port }),
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(result.reading.title).toBe("about-blank:blocked cross-site:blocked sandboxed:blocked top:blocked worker:undefined");
      expect(turnHits).toBe(0);
    } finally {
      await new Promise<void>((r) => turn.close(() => r()));
      await new Promise<void>((r) => pages.close(() => r()));
    }
  }, 120_000);

  it("does not exempt a public name the user gave when it resolves to this computer (document guard and proxy)", async () => {
    // Only a literal localhost or local IP is exempt. Exempting the name as given would let the document through to the
    // proxy's empty refusal page instead of refusing it with a reason.
    await expect(readPage(`http://page.example:${port}/plain`, dir, tools!, { maxScroll: 0, env: {}, lookup: async () => ["127.0.0.1"] })).rejects.toThrow(
      /page\.example.*on this computer or the local network; it was not opened/,
    );
  }, 120_000);

  it("reads a plain page about as fast as it reads other pages", async () => {
    const started = Date.now();
    const result = await readPage(`${base}/plain`, dir, tools!, { maxScroll: 0 });
    expect(result.reading.title).toBe("Plain");
    // The reading itself waits about 1.5 s on purpose; the proxy must not add seconds to it.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);
});

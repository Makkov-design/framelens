// `web` refuses the browser's own DevTools port to the page it reads, also when the page is on the user's exempt
// local host (audit low of #51): fails if read.ts stops calling proxy.blockLocalPort(session.debugPort).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findBrowser } from "../../src/browser/cdp.js";
import { readPage } from "../../src/browser/read.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

/** The DevTools port of the browser readPage started, read from the real launch. */
let debugPort = 0;

vi.mock("../../src/browser/cdp.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/browser/cdp.js")>();
  return {
    ...real,
    launchBrowser: async (...args: Parameters<typeof real.launchBrowser>) => {
      const session = await real.launchBrowser(...args);
      debugPort = session.debugPort ?? 0;
      return session;
    },
  };
});

const browser = findBrowser();
const tools = mediaTools();
const canRun = Boolean(browser && tools && (globalThis as { WebSocket?: unknown }).WebSocket && (process.env.CI || process.env.FRAMELENS_BROWSER_TESTS));

describe.skipIf(!canRun)("web and the browser's DevTools port, in a real browser", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/port") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(debugPort));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      // The page asks its own server for the port (it cannot know it), then calls the DevTools endpoints on it.
      res.end(`<!doctype html><title>Waiting</title><script>
fetch("/port").then((r) => r.text()).then(async (port) => {
  const tries = ["/json/version", "/json/list"].map((p) => fetch("http://127.0.0.1:" + port + p, { mode: "no-cors" }).then(() => "answered", () => "refused"));
  document.title = "port " + port + ": " + (await Promise.all(tries)).join(" ");
});
</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses a page on the exempt local host that calls the DevTools port", async () => {
    const result = await readPage(`${base}/`, tempDir(), tools!, { maxScroll: 0 });
    expect(debugPort).toBeGreaterThan(0);
    // The page ran and reached the port's turn; the proxy refused the port and says so.
    expect(result.reading.title).toMatch(new RegExp(`^port ${debugPort}: `));
    expect(result.blocked ?? []).toContain(`127.0.0.1:${debugPort}`);
  }, 120_000);
});

// The `web` request proxy on its own (no browser): who may use it, what it forwards, and that it closes cleanly.
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exemptHost, startProxy, type RequestProxy } from "../../src/browser/proxy.js";

const basic = (p: RequestProxy) => `Basic ${Buffer.from(`${p.username}:${p.password}`).toString("base64")}`;

/** One plain-http request through the proxy; resolves with the status and body. */
function viaProxy(p: RequestProxy, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: p.host, port: p.port, method: "GET", path: url, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT through the proxy; resolves with the proxy's status line. */
function tunnel(p: RequestProxy, authority: string, auth?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(p.port, p.host, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    let data = "";
    socket.on("data", (c) => {
      data += c;
      if (data.includes("\r\n")) {
        resolve(data.split("\r\n")[0]!);
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

describe("web request proxy", () => {
  let origin: Server;
  let port: number;
  const hits: { url: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    origin = createServer((req, res) => {
      hits.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive", "keep-alive": "timeout=5" });
      res.end(`host=${req.headers.host}`);
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    port = (origin.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => origin.close(() => r())));

  it("exempts only a literally local input: localhost or a loopback or private IP, not a name that resolves there", () => {
    expect(exemptHost(new URL("http://localhost:3000/"))).toBe("localhost");
    expect(exemptHost(new URL("http://app.localhost/"))).toBe("app.localhost");
    expect(exemptHost(new URL("http://127.0.0.1:8080/"))).toBe("127.0.0.1");
    expect(exemptHost(new URL("http://192.168.1.20/"))).toBe("192.168.1.20");
    expect(exemptHost(new URL("http://[::1]:8080/"))).toBe("::1");
    expect(exemptHost(new URL("https://example.com/"))).toBeUndefined();
    expect(exemptHost(new URL("http://intranet.corp.example/"))).toBeUndefined();
    expect(exemptHost(new URL("http://8.8.8.8/"))).toBeUndefined();
  });

  it("forwards nothing without the per-run credentials: 407, and no connection to the site", async () => {
    const proxy = await startProxy({ exempt: "127.0.0.1" });
    try {
      hits.length = 0;
      expect((await viaProxy(proxy, `http://127.0.0.1:${port}/x`)).status).toBe(407);
      expect((await viaProxy(proxy, `http://127.0.0.1:${port}/x`, { "proxy-authorization": "Basic d3Jvbmc6d3Jvbmc=" })).status).toBe(407);
      expect(await tunnel(proxy, `127.0.0.1:${port}`)).toMatch(/^HTTP\/1\.1 407/);
      expect(hits).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("never sends its credentials or other hop-by-hop headers on, and uses the URL's host, not a Host header", async () => {
    const proxy = await startProxy({ exempt: "127.0.0.1" });
    try {
      hits.length = 0;
      const res = await viaProxy(proxy, `http://127.0.0.1:${port}/echo?a=1`, {
        "proxy-authorization": basic(proxy),
        "proxy-connection": "keep-alive",
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "drop me",
        host: "attacker.example",
        "x-kept": "yes",
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe(`host=127.0.0.1:${port}`);
      expect(hits).toHaveLength(1);
      const sent = hits[0]!.headers;
      for (const name of ["proxy-authorization", "proxy-connection", "x-secret-hop", "keep-alive"]) expect(sent[name]).toBeUndefined();
      expect(sent.host).toBe(`127.0.0.1:${port}`);
      expect(sent["x-kept"]).toBe("yes");
      expect(hits[0]!.url).toBe("/echo?a=1");
    } finally {
      await proxy.close();
    }
  });

  it("refuses every local, private, metadata and mapped address unless it is the exempt host, for http and CONNECT", async () => {
    // public.example resolves to a private address: a public name is never exempt.
    const lookup = async (host: string) => (host === "public.example" ? ["10.1.2.3"] : host === "mixed.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
    const proxy = await startProxy({ exempt: "127.0.0.1", lookup });
    try {
      hits.length = 0;
      const auth = basic(proxy);
      for (const target of [`localhost:${port}`, `public.example:${port}`, `mixed.example:${port}`, `169.254.169.254:80`, `[::1]:${port}`, `[::ffff:127.0.0.1]:${port}`, `100.64.0.1:80`, `192.168.0.1:80`]) {
        expect(await tunnel(proxy, target, auth), target).toMatch(/^HTTP\/1\.1 403/);
        expect((await viaProxy(proxy, `http://${target}/`, { "proxy-authorization": auth })).status, target).toBe(403);
      }
      expect(hits).toEqual([]);
      expect(proxy.refused).toEqual(expect.arrayContaining([`localhost:${port}`, `public.example:${port}`, "169.254.169.254:80", `[::1]:${port}`]));
      // The exempt host, any port.
      expect(await tunnel(proxy, `127.0.0.1:${port}`, auth)).toMatch(/^HTTP\/1\.1 200/);
    } finally {
      await proxy.close();
    }
  });

  it("never passes on a site's own 407, which would make the browser offer the proxy's credentials", async () => {
    const site = createServer((_req, res) => {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="site"' });
      res.end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const proxy = await startProxy({ exempt: "127.0.0.1" });
    try {
      const res = await viaProxy(proxy, `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, { "proxy-authorization": basic(proxy) });
      expect(res.status).toBe(502);
    } finally {
      await proxy.close();
      await new Promise<void>((r) => site.close(() => r()));
    }
  });

  it("closes with no listener left behind", async () => {
    const proxy = await startProxy();
    await proxy.close();
    await expect(new Promise((resolve, reject) => connect(proxy.port, "127.0.0.1").on("connect", resolve).on("error", reject))).rejects.toThrow();
  });

  it("refuses connections beyond its limit", async () => {
    const proxy = await startProxy({ maxSockets: 1, exempt: "127.0.0.1" });
    try {
      const first = connect(proxy.port, proxy.host);
      await new Promise((r) => first.on("connect", r));
      await new Promise((r) => setTimeout(r, 50));
      const closed = await new Promise<boolean>((resolve) => {
        const second = connect(proxy.port, proxy.host);
        second.on("close", () => resolve(true));
        second.on("error", () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      });
      expect(closed).toBe(true);
      first.destroy();
    } finally {
      await proxy.close();
    }
  });
});

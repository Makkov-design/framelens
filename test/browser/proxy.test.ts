// The `web` request proxy on its own (no browser): who may use it, what it forwards, and that it closes cleanly.
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exemptHost, skipsProxy, startProxy, upstreamFromEnv, upstreamLabel, type RequestProxy } from "../../src/browser/proxy.js";

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

  it("refuses the browser's own DevTools port on this computer, also for the exempt local host", async () => {
    const proxy = await startProxy({ exempt: "127.0.0.1", lookup: async () => ["127.0.0.1"] });
    try {
      proxy.blockLocalPort(port);
      hits.length = 0;
      const auth = basic(proxy);
      for (const target of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) expect(await tunnel(proxy, target, auth), target).toMatch(/^HTTP\/1\.1 403/);
      expect((await viaProxy(proxy, `http://127.0.0.1:${port}/json/version`, { "proxy-authorization": auth })).status).toBe(403);
      expect(hits).toEqual([]);
    } finally {
      await proxy.close();
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

describe("web request proxy behind the network's own proxy", () => {
  let origin: Server;
  let originPort: number;
  let upstream: Server;
  let upstreamPort: number;
  const originHits: IncomingHttpHeaders[] = [];
  /** What the upstream proxy was asked for, and with which credentials. */
  const asked: { target: string; auth?: string }[] = [];

  beforeAll(async () => {
    origin = createServer((req, res) => {
      originHits.push(req.headers);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`origin ${req.headers.host}`);
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    originPort = (origin.address() as AddressInfo).port;
    // A stand-in for a corporate proxy: every target ends up at the test origin.
    upstream = createServer((req, res) => {
      asked.push({ target: req.url ?? "", auth: req.headers["proxy-authorization"] });
      const { "proxy-authorization": _drop, ...headers } = req.headers;
      const forward = request({ host: "127.0.0.1", port: originPort, method: req.method, path: new URL(req.url ?? "").pathname, headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      req.pipe(forward);
    });
    upstream.on("connect", (req, client) => {
      asked.push({ target: req.url ?? "", auth: req.headers["proxy-authorization"] });
      const socket = connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(client);
        client.pipe(socket);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => origin.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const lookup = async (host: string) => {
    if (host === "unresolvable.example") throw new Error("ENOTFOUND");
    if (host === "private.example") return ["10.1.2.3"];
    return ["93.184.216.34"];
  };
  const start = () =>
    startProxy({
      lookup,
      upstream: { https: new URL(`http://corp%20user:p%40ss@127.0.0.1:${upstreamPort}`), http: new URL(`http://corp%20user:p%40ss@127.0.0.1:${upstreamPort}`), noProxy: ["direct.example"] },
      // A direct connection to a checked public address lands on the test origin.
      dial: () => ({ host: "127.0.0.1", port: originPort }),
    });
  const corpAuth = `Basic ${Buffer.from("corp user:p@ss").toString("base64")}`;

  /** A tunnel through the guard, then one plain request inside it; resolves with the answer's first line and body. */
  function throughTunnel(p: RequestProxy, authority: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(p.port, p.host, () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basic(p)}\r\n\r\n`);
      });
      let data = "";
      let sent = false;
      socket.on("data", (c) => {
        data += c;
        if (!sent && data.startsWith("HTTP/1.1 200") && data.includes("\r\n\r\n")) {
          sent = true;
          data = "";
          socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
        } else if (!sent && data.includes("\r\n\r\n")) {
          resolve(data.split("\r\n")[0]!);
          socket.destroy();
        }
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
  }

  it("reads the upstream proxy from the environment, curl's way, and refuses a kind it cannot use", () => {
    const up = upstreamFromEnv({ HTTPS_PROXY: "http://u:p@proxy.corp:3128", http_proxy: "proxy.corp:8080", NO_PROXY: "localhost, .corp.example,10.0.0.0/8" })!;
    expect(up.https!.host).toBe("proxy.corp:3128");
    expect(up.http!.href).toBe("http://proxy.corp:8080/");
    expect(up.noProxy).toEqual(["localhost", ".corp.example", "10.0.0.0/8"]);
    expect(upstreamFromEnv({ ALL_PROXY: "http://all:1" })!.https!.host).toBe("all:1");
    expect(upstreamFromEnv({})).toBeUndefined();
    expect(() => upstreamFromEnv({ ALL_PROXY: "socks5://s:1080" })).toThrow(/socks5 proxy; web supports only http and https/);
    expect(skipsProxy("intranet.corp.example", 443, up.noProxy)).toBe(true);
    expect(skipsProxy("corp.example", 443, up.noProxy)).toBe(true);
    expect(skipsProxy("10.4.5.6", 80, up.noProxy)).toBe(true);
    expect(skipsProxy("example.com", 443, up.noProxy)).toBe(false);
    expect(skipsProxy("example.com", 443, ["*"])).toBe(true);
    expect(skipsProxy("example.com", 443, ["example.com:8443"])).toBe(false);
    expect(upstreamLabel(up.https!)).toBe("http://proxy.corp:3128");
  });

  it("chains https tunnels and plain http through it with its own credentials, never the per-run ones", async () => {
    const proxy = await start();
    try {
      asked.length = 0;
      originHits.length = 0;
      expect(await throughTunnel(proxy, "public.example:443")).toContain("origin public.example:443");
      const plain = await viaProxy(proxy, "http://public.example/page", { "proxy-authorization": basic(proxy) });
      expect(plain).toEqual({ status: 200, body: "origin public.example" });
      expect(asked).toEqual([
        { target: "public.example:443", auth: corpAuth },
        { target: "http://public.example/page", auth: corpAuth },
      ]);
      // The site never sees a proxy's credentials, ours or the network's.
      expect(originHits.every((h) => !("proxy-authorization" in h))).toBe(true);
      expect(proxy.upstream).toBe(`http://127.0.0.1:${upstreamPort}`);
    } finally {
      await proxy.close();
    }
  });

  it("still refuses local, private and metadata targets before anything reaches the upstream proxy", async () => {
    const proxy = await start();
    try {
      asked.length = 0;
      for (const target of ["127.0.0.1:80", "10.0.0.1:443", "169.254.169.254:80", "[::1]:443", "localhost:8080", "private.example:443", "intranet:80"]) {
        expect(await tunnel(proxy, target, basic(proxy)), target).toMatch(/^HTTP\/1\.1 403/);
      }
      expect((await viaProxy(proxy, "http://192.168.1.1/admin", { "proxy-authorization": basic(proxy) })).status).toBe(403);
      expect(asked).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("honours NO_PROXY, and sends a name it cannot resolve to the upstream proxy by name, saying the pin is gone", async () => {
    const proxy = await start();
    try {
      asked.length = 0;
      expect(await throughTunnel(proxy, "direct.example:443")).toContain("origin direct.example:443");
      expect(asked).toEqual([]);
      expect(await throughTunnel(proxy, "unresolvable.example:443")).toContain("origin unresolvable.example:443");
      expect(asked.map((a) => a.target)).toEqual(["unresolvable.example:443"]);
      // Every host sent to the upstream proxy goes by name (it resolves it again); one could not be resolved here at all.
      expect([...proxy.viaUpstream]).toEqual(["unresolvable.example"]);
      expect([...proxy.unresolved]).toEqual(["unresolvable.example"]);
    } finally {
      await proxy.close();
    }
  });
});

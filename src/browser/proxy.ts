import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { hostAddresses, isPrivateAddress, systemLookup, type Lookup } from "../sources/cobalt.js";
import { oneLine } from "../text.js";

/**
 * The one place every request of `web`'s browser goes through. Chrome is started with this proxy and loopback is
 * not bypassed, so the page, its frames of any kind, every worker, prefetches and WebSockets all arrive here. Each host
 * is resolved once; a host with any address on this computer, the local network, a metadata address or another
 * non-public range is refused, and the connection goes to the address that was checked (DNS rebinding cannot swap it).
 *
 * Only the browser that Frame Lens started may use it: each run has its own random user name and password, sent by
 * Chrome as Basic proxy credentials (answered over CDP). Without them the proxy answers 407 and forwards nothing, so it
 * is never an open proxy, not even to public hosts.
 */
export interface RequestProxy {
  /** The address to give Chrome: `http://127.0.0.1:<port>`. */
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Hosts (with ports) refused because they lead to this computer or the local network, each once. */
  refused: string[];
  close(): Promise<void>;
}

export interface ProxyOptions {
  /**
   * The one host that may be on this computer or the local network: the user's own input, when it is literally
   * `localhost` (or a name under `.localhost`) or a loopback or private IP. Any port of that exact host.
   */
  exempt?: string;
  lookup?: Lookup;
  connectTimeoutMs?: number;
  /** Most connections at once, browser side; more are refused with 503. */
  maxSockets?: number;
  /** A tunnel or request with no traffic for this long is closed. */
  idleTimeoutMs?: number;
}

/** Headers that belong to one hop and are never forwarded (RFC 9110 §7.6.1), the proxy credentials first of all. */
const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The host the user gave may be local only when it says so itself: `localhost` or a loopback or private IP. */
export function exemptHost(input: URL): string | undefined {
  const host = input.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return host;
  if (isIP(host) && isPrivateAddress(host)) return host;
  return undefined;
}

/** `host:port` of a CONNECT target, with IPv6 brackets removed from the host. */
function splitAuthority(authority: string): { host: string; port: number } | undefined {
  const m = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(authority) ?? /^([^:\[\]\s/]+):(\d{1,5})$/.exec(authority);
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return undefined;
  return { host: m[1]!.toLowerCase().replace(/\.+$/, ""), port };
}

/** Request headers for the origin: hop-by-hop ones and those the Connection header names are dropped, Host is the URL's. */
function forwardHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const named = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean));
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || name === "host") continue;
    out[name] = value;
  }
  out.host = host;
  return out;
}

export async function startProxy(options: ProxyOptions = {}): Promise<RequestProxy> {
  const lookup = options.lookup ?? systemLookup;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const maxSockets = options.maxSockets ?? 256;
  const username = `fl-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const refused: string[] = [];
  const sockets = new Set<Socket | Duplex>();

  const authorized = (header: string | string[] | undefined): boolean => {
    const given = Buffer.from(typeof header === "string" ? header : "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  // One answer per host for the whole reading: the address checked is the address connected to.
  const verdicts = new Map<string, Promise<string | undefined>>();
  const addressFor = (host: string): Promise<string | undefined> => {
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = (async () => {
        let addresses: string[];
        try {
          addresses = await hostAddresses(host, lookup);
        } catch {
          return undefined;
        }
        if (!addresses.length) return undefined;
        if (host !== options.exempt && addresses.some(isPrivateAddress)) return undefined;
        return addresses[0];
      })();
      verdicts.set(host, verdict);
    }
    return verdict;
  };
  const refuse = (host: string, port: number) => {
    const name = oneLine(`${host.includes(":") ? `[${host}]` : host}:${port}`, 120);
    if (!refused.includes(name) && refused.length < 200) refused.push(name);
  };

  const track = (socket: Socket | Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const server = createServer({ requireHostHeader: false });
  server.headersTimeout = connectTimeoutMs;
  server.requestTimeout = 0;
  server.on("connection", (socket: Socket) => {
    if (sockets.size >= maxSockets) {
      socket.destroy();
      return;
    }
    track(socket);
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  });

  // Plain http: an absolute-form request. The URL's host is checked and connected to; a different Host header is
  // replaced by the URL's, so it cannot smuggle a second destination.
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req.headers["proxy-authorization"])) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="framelens"', connection: "close", "content-length": "0" });
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { connection: "close", "content-length": "0" }).end();
      return;
    }
    if (target.protocol !== "http:" || target.username || target.password) {
      res.writeHead(400, { connection: "close", "content-length": "0" }).end();
      return;
    }
    const host = target.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
    const port = Number(target.port || 80);
    void addressFor(host).then((address) => {
      if (!address) {
        refuse(host, port);
        res.writeHead(403, { "content-type": "text/plain", "content-length": "0" }).end();
        return;
      }
      const upstream = httpRequest({
        host: address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders(req.headers, target.host),
        timeout: connectTimeoutMs,
        setHost: false,
      });
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.on("response", (answer) => {
        const headers: Record<string, string | string[]> = {};
        const named = new Set(String(answer.headers.connection ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean));
        for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name) && !named.has(name)) headers[name] = value;
        // Only this proxy asks for proxy credentials: a site's 407 would make the browser offer them again.
        const status = answer.statusCode === 407 ? 502 : (answer.statusCode ?? 502);
        if (status === 502) delete headers["proxy-authenticate"];
        res.writeHead(status, headers);
        answer.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-length": "0" }).end();
        else res.destroy();
      });
      req.pipe(upstream);
    });
  });

  // https and WebSockets: a tunnel to the checked address; TLS (and the name it is for) stays between the browser and
  // the site.
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    if (!authorized(req.headers["proxy-authorization"])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="framelens"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const authority = splitAuthority(req.url ?? "");
    if (!authority) {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    void addressFor(authority.host).then((address) => {
      if (!address) {
        refuse(authority.host, authority.port);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connect({ host: address, port: authority.port });
      track(upstream);
      const timer = setTimeout(() => upstream.destroy(), connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        clearTimeout(timer);
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  });
  // A WebSocket or other upgrade sent as a plain request (not a tunnel) is not supported: refused.
  server.on("upgrade", (_req: IncomingMessage, client: Duplex) => {
    client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    username,
    password,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

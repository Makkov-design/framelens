import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
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
  /** The network's own proxy that checked requests went on through (without its credentials), when there is one. */
  upstream?: string;
  /**
   * Hosts sent to the upstream proxy by name. That proxy resolves each name again itself, so none of them is pinned to
   * the address checked here; `unresolved` are those this computer could not resolve at all.
   */
  viaUpstream: Set<string>;
  unresolved: Set<string>;
  /** Refuses every request to `port` on this computer (the browser's own DevTools port). */
  blockLocalPort(port: number): void;
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
  /**
   * The proxy this network requires (from HTTPS_PROXY, HTTP_PROXY or ALL_PROXY, see `upstreamFromEnv`): checked
   * requests go on through it instead of straight to the site.
   */
  upstream?: Upstream;
  /** Tests only: where a direct connection to a checked address really goes. */
  dial?: (address: string, port: number) => { host: string; port: number };
}

/** A proxy the network requires, and the hosts that skip it (NO_PROXY). */
export interface Upstream {
  /** For https and WebSocket tunnels. */
  https?: URL;
  /** For plain http requests. */
  http?: URL;
  noProxy: string[];
}

/**
 * The upstream proxy the environment names, the way curl reads it: HTTPS_PROXY for https (and WebSocket) tunnels,
 * HTTP_PROXY for plain http, ALL_PROXY for both when those are unset, NO_PROXY for hosts that skip it. Only http and
 * https proxies are supported; another scheme (socks) is an error, so `web` refuses rather than bypass it.
 */
export function upstreamFromEnv(env: NodeJS.ProcessEnv = process.env): Upstream | undefined {
  const get = (name: string) => env[name.toLowerCase()] || env[name.toUpperCase()] || undefined;
  const parse = (value: string | undefined, name: string): URL | undefined => {
    if (!value) return undefined;
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    } catch {
      throw new Error(`${name} is not a proxy address`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} names a ${url.protocol.replace(":", "")} proxy; web supports only http and https proxies`);
    return url;
  };
  const all = parse(get("all_proxy"), "ALL_PROXY");
  const https = parse(get("https_proxy"), "HTTPS_PROXY") ?? all;
  const http = parse(get("http_proxy"), "HTTP_PROXY") ?? all;
  if (!https && !http) return undefined;
  const noProxy = (get("no_proxy") ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return { ...(https && { https }), ...(http && { http }), noProxy };
}

/** Whether NO_PROXY sends `host:port` straight to the site: `*`, a name and its subdomains, an IP, an IPv4 CIDR. */
export function skipsProxy(host: string, port: number, noProxy: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  for (const raw of noProxy) {
    if (raw === "*") return true;
    let entry = raw;
    const withPort = /^(.*?):(\d+)$/.exec(entry);
    if (withPort && !entry.includes("::") && !/^\[/.test(entry)) {
      if (Number(withPort[2]) !== port) continue;
      entry = withPort[1]!;
    }
    entry = entry.replace(/^\[|\]$/g, "");
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(entry);
    if (cidr) {
      if (isIP(h) === 4 && inCidr(h, cidr[1]!, Number(cidr[2]))) return true;
      continue;
    }
    if (isIP(entry)) {
      if (entry === h) return true;
      continue;
    }
    const domain = entry.replace(/^\*?\./, "");
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const n = (a: string) => a.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
  if (bits <= 0) return true;
  const size = 2 ** (32 - Math.min(32, bits));
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}

/** The upstream proxy's own credentials, from its URL, for its Proxy-Authorization header. */
function upstreamAuth(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
}

/** The upstream proxy without its credentials, for messages. */
export function upstreamLabel(proxy: URL): string {
  return `${proxy.protocol}//${proxy.host}`;
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

  type Route = { kind: "refuse" } | { kind: "unresolved" } | { kind: "direct"; address: string } | { kind: "upstream"; proxy: URL };
  // One answer per host for the whole reading: the address checked is the address connected to.
  const verdicts = new Map<string, Promise<{ addresses?: string[]; local: boolean }>>();
  const resolveOnce = (host: string) => {
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = (async () => {
        let addresses: string[];
        try {
          addresses = await hostAddresses(host, lookup);
        } catch {
          return { local: false };
        }
        return { addresses, local: addresses.some(isPrivateAddress) };
      })();
      verdicts.set(host, verdict);
    }
    return verdict;
  };
  /**
   * Where a request goes. A local, private or metadata address is refused before anything is sent, also behind an
   * upstream proxy; so is a name that resolves there. A public answer is connected to as checked, or, when the network
   * requires a proxy, sent on through it by name. A name this computer cannot resolve can only go through that proxy,
   * which then decides what is reachable (no address pin there).
   */
  const route = async (host: string, port: number, tunnel: boolean): Promise<Route> => {
    const { addresses, local } = await resolveOnce(host);
    if (blockedPorts.has(port) && (local || host === options.exempt || addresses?.some(isPrivateAddress))) return { kind: "refuse" };
    if (host === options.exempt) return addresses?.length ? { kind: "direct", address: addresses[0]! } : { kind: "unresolved" };
    if (local) return { kind: "refuse" };
    const proxy = tunnel ? options.upstream?.https : options.upstream?.http;
    if (proxy && !skipsProxy(host, port, options.upstream!.noProxy)) {
      viaUpstream.add(host);
      if (!addresses?.length) unresolved.add(host);
      return { kind: "upstream", proxy };
    }
    return addresses?.length ? { kind: "direct", address: addresses[0]! } : { kind: "unresolved" };
  };
  const viaUpstream = new Set<string>();
  const unresolved = new Set<string>();
  const blockedPorts = new Set<number>();
  const dial = (address: string, port: number) => options.dial?.(address, port) ?? { host: address, port };
  /** A socket to the upstream proxy itself (TLS for an https proxy, with the system's and NODE_EXTRA_CA_CERTS' CAs). */
  const toUpstream = (proxy: URL): Socket => {
    const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const host = proxy.hostname.replace(/^\[|\]$/g, "");
    return proxy.protocol === "https:" ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host }) : connect({ host, port });
  };
  /** A tunnel to `host:port`: straight to the checked address, or through the upstream proxy by name. */
  const openTunnel = (to: Route, host: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, connectTimeoutMs);
      let socket: Socket;
      if (to.kind === "direct") {
        socket = connect(dial(to.address, port));
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(socket);
        });
      } else if (to.kind === "upstream") {
        socket = toUpstream(to.proxy);
        const auth = upstreamAuth(to.proxy);
        const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
        socket.once(to.proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
          socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
        });
        let answer = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          answer = Buffer.concat([answer, chunk]);
          const end = answer.indexOf("\r\n\r\n");
          if (end === -1) {
            if (answer.length > 16_384) socket.destroy(new Error("upstream answer too long"));
            return;
          }
          socket.off("data", onData);
          clearTimeout(timer);
          if (!/^HTTP\/1\.[01] 200/.test(answer.subarray(0, end).toString("latin1"))) {
            socket.destroy();
            reject(new Error("upstream refused"));
            return;
          }
          const rest = answer.subarray(end + 4);
          if (rest.length) socket.unshift(rest);
          resolve(socket);
        };
        socket.on("data", onData);
      } else {
        clearTimeout(timer);
        reject(new Error("not routable"));
        return;
      }
      track(socket);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
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
    void route(host, port, false).then((to) => {
      if (to.kind === "refuse") {
        refuse(host, port);
        res.writeHead(403, { "content-type": "text/plain", "content-length": "0" }).end();
        return;
      }
      if (to.kind === "unresolved") {
        res.writeHead(502, { "content-length": "0" }).end();
        return;
      }
      const headers = forwardHeaders(req.headers, target.host);
      const viaProxy = to.kind === "upstream" ? to.proxy : undefined;
      const auth = viaProxy && upstreamAuth(viaProxy);
      if (auth) headers["proxy-authorization"] = auth;
      const direct = to.kind === "direct" ? dial(to.address, port) : undefined;
      const upstream = httpRequest({
        ...(viaProxy
          ? { createConnection: () => toUpstream(viaProxy), path: target.href }
          : { host: direct!.host, port: direct!.port, path: `${target.pathname}${target.search}` }),
        method: req.method,
        headers,
        timeout: connectTimeoutMs,
        setHost: false,
        // Without an agent, Node uses `createConnection` (the upstream proxy) for this one request.
        ...(viaProxy ? {} : { agent: false }),
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
    void route(authority.host, authority.port, true).then(async (to) => {
      if (to.kind === "refuse") {
        refuse(authority.host, authority.port);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      if (to.kind === "unresolved") {
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      let upstream: Socket;
      try {
        upstream = await openTunnel(to, authority.host, authority.port);
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
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
    ...(options.upstream && { upstream: upstreamLabel((options.upstream.https ?? options.upstream.http)!) }),
    viaUpstream,
    unresolved,
    blockLocalPort: (port: number) => {
      blockedPorts.add(port);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/doctor.js";
import { capturableLogin } from "../../src/browser/capture.js";
import { checkCobaltInstance, cobaltMayRetry, fetchWithCobalt, isPrivateAddress, pinnedGet } from "../../src/sources/cobalt.js";
import { SourceError } from "../../src/sources/errors.js";
import { resolveSource } from "../../src/sources/resolve.js";
import { mapYtDlpFailure } from "../../src/sources/ytdlp.js";

const fake = resolve("test/fixtures/fake-ytdlp.mjs");
const root = mkdtempSync(join(tmpdir(), "framelens-cobalt-"));
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.from("fake mp4 bytes ".repeat(100))]);

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body?: Record<string, unknown>;
}
const seen: Seen[] = [];
let answer: (base: string) => { status?: number; json?: unknown; headers?: Record<string, string> } = () => ({ json: {} });
let tunnel: (res: import("node:http").ServerResponse) => void = (res) => {
  res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length });
  res.end(VIDEO);
};
let server: Server;
let base: string;
// A service on this computer that must never be reached through cobalt (cloud metadata, an admin page, …).
const internalHits: string[] = [];
let internal: Server;
let internalBase: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, ...(raw && { body: JSON.parse(raw) as Record<string, unknown> }) });
      if (req.method === "GET" && req.url?.startsWith("/tunnel")) return tunnel(res);
      const a = answer(base);
      res.writeHead(a.status ?? 200, { "content-type": "application/json", ...a.headers });
      res.end(JSON.stringify(a.json));
    });
  });
  internal = createServer((req, res) => {
    internalHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(VIDEO);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  internalBase = `http://localhost:${(internal.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  internal.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
let ws: string;
beforeEach(() => {
  ws = join(root, `ws${++n}`);
  seen.length = 0;
  internalHits.length = 0;
  answer = (b) => ({ json: { status: "tunnel", url: `${b}/tunnel?id=1`, filename: "reel_by_someone.mp4" } });
  tunnel = (res) => {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length });
    res.end(VIDEO);
  };
});
afterEach(() => delete process.env.FAKE_YTDLP_MODE);

const env = (extra: Record<string, string> = {}) => ({ FRAMELENS_YTDLP: fake, FRAMELENS_FFMPEG: fake, PATH: "", FRAMELENS_COBALT_URL: `${base}/`, ...extra });
const REEL = "https://www.instagram.com/reel/Cx1/";
const publicLookup = async () => ["93.184.216.34"];

// Real yt-dlp error texts (2026 extractors) that are, or may be, access control: none of them may reach cobalt.
const ACCESS: [string, string, string][] = [
  ["YouTube age gate", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication."],
  ["YouTube bot check", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."],
  ["Cloudflare challenge", "https://example.com/video", 'ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge; try again with  --extractor-args "generic:impersonate"'],
  ["Instagram rate limit or login", REEL, "ERROR: [Instagram] C123: Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (instagram) to provide account credentials"],
  ["X NSFW", "https://x.com/a/status/1", "ERROR: [twitter] 1: NSFW tweet requires authentication. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (twitter) to provide account credentials"],
  ["TikTok IP block", "https://www.tiktok.com/@a/video/1", "ERROR: [TikTok] 1: Your IP address is blocked from accessing this post"],
  ["HTTP 429", "https://vimeo.com/1", "ERROR: [vimeo] 1: Unable to download JSON metadata: HTTP Error 429: Too Many Requests"],
  ["HTTP 403", "https://example.com/v", "ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"],
  ["HTTP 401", "https://example.com/v", "ERROR: [generic] Unable to download webpage: HTTP Error 401: Unauthorized"],
  ["Geo", "https://vimeo.com/1", "ERROR: [vimeo] 1: This video is not available in your country"],
  ["Members only", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content like this video"],
  ["Private", "https://vimeo.com/1", "ERROR: [vimeo] 1: This video is private"],
  ["Unsupported, but behind a 403", "https://example.com/v", "WARNING: [generic] Falling back on generic information extractor\nWARNING: HTTP Error 403: Forbidden\nERROR: Unsupported URL: https://example.com/v"],
  ["Vimeo password", "https://vimeo.com/1", "ERROR: [vimeo] 1: This video is protected by a password, use the --video-password option"],
  ["Vimeo wrong password", "https://vimeo.com/1", "ERROR: [vimeo] 1: Wrong password"],
  ["Vimeo album password", "https://vimeo.com/showcase/1", "ERROR: [vimeo:album] 1: This album is protected by a password, use the --video-password option"],
  ["No access to a post", "https://www.patreon.com/posts/1", "ERROR: [patreon] 1: You do not have access to this post"],
  ["DRM", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] dQw4w9WgXcQ: This video is DRM protected"],
  ["Known DRM site", "https://www.netflix.com/watch/1", "ERROR: The requested site is known to use DRM protection. It will NOT be supported."],
  ["Payment", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] dQw4w9WgXcQ: This video requires payment to watch."],
  ["Rental", "https://vimeo.com/1", "ERROR: [vimeo] 1: This video is available for rent or purchase only"],
  ["HTTP 451", "https://example.com/v", "ERROR: [generic] Unable to download webpage: HTTP Error 451: Unavailable For Legal Reasons"],
  ["YouTube session rate limit", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: [youtube] abc: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour."],
  ["TikTok JS challenge", "https://www.tiktok.com/@a/video/1", "ERROR: [TikTok] 1: Unable to solve JS challenge"],
  ["X protected tweet", "https://x.com/a/status/1", "ERROR: [twitter] 1: You are not authorized to view this protected tweet"],
  ["Instagram logged-in only", "https://www.instagram.com/reel/C1/", "ERROR: [Instagram] C1: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in."],
  ["PO token", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "WARNING: [youtube] abc: web client https formats require a GVS PO Token which was not provided.\nERROR: [youtube] abc: Requested format is not available."],
];

// Failures that say nothing about access: these may go to the user's own instance.
const NOT_ACCESS: [string, string, string][] = [
  ["Unable to extract (the report link mentions nothing)", "https://www.instagram.com/reel/C1/", "ERROR: [Instagram] C1: Unable to extract video url; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template."],
  ["certificate verify failed", "https://vimeo.com/1", "ERROR: [vimeo] 1: Unable to download JSON metadata: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1006)>"],
  ["DNS", "https://example.com/v", "ERROR: [generic] Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed> (caused by URLError(gaierror(11001, 'getaddrinfo failed')))"],
  ["TikTok status code", "https://www.tiktok.com/@a/video/1", "ERROR: [TikTok] 1: Video not available, status code 0"],
  ["X no video", "https://x.com/a/status/1", "ERROR: [twitter] 1: No video could be found in this tweet"],
  ["Requested format alone", "https://www.youtube.com/watch?v=abc", "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats"],
];

describe("which failures may go to cobalt", () => {
  it.each(ACCESS)("never after %s", (_name, url, stderr) => {
    const error = mapYtDlpFailure(stderr, url);
    expect(error.accessControl).toBe(true);
    expect(cobaltMayRetry(error, env())).toBe(false);
  });

  it("only when yt-dlp has no extractor, or failed for a reason that is not access control", () => {
    const unsupported = mapYtDlpFailure("ERROR: Unsupported URL: https://cdn.example.com/watch/account/login", "https://cdn.example.com/watch/account/login");
    expect(unsupported.code).toBe("unsupported_url");
    // Words in the link itself say nothing about access control.
    expect(cobaltMayRetry(unsupported, env())).toBe(true);
    expect(cobaltMayRetry(mapYtDlpFailure("ERROR: [generic] Unable to extract video data", "https://example.com/v"), env())).toBe(true);
    expect(cobaltMayRetry(mapYtDlpFailure("ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found", "https://example.com/v"), env())).toBe(true);
    expect(cobaltMayRetry(new SourceError("login_required", "x"), env())).toBe(false);
    expect(cobaltMayRetry(new SourceError("too_large", "x"), env())).toBe(false);
    expect(cobaltMayRetry(unsupported, { FRAMELENS_YTDLP: fake })).toBe(false);
  });

  it.each(NOT_ACCESS)("may after %s", (_name, url, stderr) => {
    expect(cobaltMayRetry(mapYtDlpFailure(stderr, url), env())).toBe(true);
  });

  it("agrees with the login profile tier: nothing it excludes is sent either", () => {
    for (const [, url, stderr] of ACCESS) {
      const error = mapYtDlpFailure(stderr, url);
      if (!capturableLogin(url, error.detail ?? "")) expect(cobaltMayRetry(error, env())).toBe(false);
    }
  });

  it("lets the login profile decide on yt-dlp's own words, not on Frame Lens's help text", () => {
    const limited = mapYtDlpFailure(ACCESS.find(([n]) => n === "Instagram rate limit or login")![2], REEL);
    expect(limited.code).toBe("login_required");
    // The help text says nothing about a rate limit, so reading it would have let the login profile answer one.
    expect(capturableLogin(REEL, limited.message)).toBe(true);
    expect(capturableLogin(REEL, limited.detail!)).toBe(false);
    const wall = mapYtDlpFailure("ERROR: [Instagram] C1: This content requires login. Use --cookies-from-browser", REEL);
    expect(capturableLogin(REEL, wall.detail!)).toBe(true);
  });
});

describe("cobalt, the user's own instance", () => {
  it("fetches a link yt-dlp has no extractor for, through the configured instance with its API key", async () => {
    process.env.FAKE_YTDLP_MODE = "unsupported";
    const record = await resolveSource("https://example.com/page", { workspaceRoot: ws, env: env({ FRAMELENS_COBALT_KEY: "secret-key" }) });
    expect(record).toMatchObject({ kind: "url", title: "reel_by_someone", tools: { cobalt: base } });
    expect(readFileSync(record.mediaPath)).toEqual(VIDEO);
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.headers.authorization).toBe("Api-Key secret-key");
    expect(post.headers.accept).toBe("application/json");
    expect(post.body).toEqual({ url: "https://example.com/page", videoQuality: "1080", downloadMode: "auto", filenameStyle: "basic", alwaysProxy: true });
    // The key goes to the API only, never with the media request.
    expect(seen.find((s) => s.method === "GET")!.headers.authorization).toBeUndefined();
  });

  it("changes nothing when FRAMELENS_COBALT_URL is not set", async () => {
    process.env.FAKE_YTDLP_MODE = "unsupported";
    const { FRAMELENS_COBALT_URL: _, ...plain } = env();
    await expect(resolveSource("https://example.com/page", { workspaceRoot: ws, env: plain })).rejects.toMatchObject({ code: "unsupported_url" });
    expect(seen).toEqual([]);
  });

  it("sends no login wall, bot check, rate limit, private or geo-blocked video to cobalt", async () => {
    for (const mode of ["login", "bot", "limited", "private", "geo"]) {
      process.env.FAKE_YTDLP_MODE = mode;
      const url = mode === "login" ? REEL : "https://www.youtube.com/watch?v=jNQXAC9IVRw";
      await expect(resolveSource(url, { workspaceRoot: ws, env: env() })).rejects.toBeInstanceOf(SourceError);
    }
    expect(seen).toEqual([]);
  });

  it("reports both failures when the instance cannot fetch it either", async () => {
    process.env.FAKE_YTDLP_MODE = "unsupported";
    answer = () => ({ status: 400, json: { status: "error", error: { code: "error.api.link.unsupported" } } });
    const error = await resolveSource("https://example.com/page", { workspaceRoot: ws, env: env() }).catch((e) => e);
    expect(error.code).toBe("unsupported_url");
    expect(error.message).toContain("cannot read a video from this link");
    expect(error.message).toMatch(/cobalt instance could not fetch it: it does not support this link/);
  });

  it("takes the video from a post with several items, and refuses a post with only pictures", async () => {
    answer = (b) => ({ json: { status: "picker", picker: [{ type: "photo", url: `${b}/tunnel?p` }, { type: "video", url: `${b}/tunnel?v` }] } });
    const got = await fetchWithCobalt({ url: REEL, mediaDir: join(ws, "m"), env: env(), maxBytes: 1e6 });
    expect(seen.at(-1)!.url).toBe("/tunnel?v");
    expect(existsSync(got.mediaPath)).toBe(true);
    answer = (b) => ({ json: { status: "picker", picker: [{ type: "photo", url: `${b}/tunnel?p` }] } });
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "m2"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/only pictures/);
  });

  it("stops at the size limit and leaves no partial file", async () => {
    const dir = join(ws, "small");
    await expect(fetchWithCobalt({ url: REEL, mediaDir: dir, env: env(), maxBytes: 100 })).rejects.toMatchObject({ code: "too_large" });
    expect(existsSync(join(dir, "source.mp4")) || existsSync(join(dir, "source.mp4.part"))).toBe(false);
  });
});

describe("where the media download may go", () => {
  it("does not follow a tunnel redirect to another service on this computer", async () => {
    tunnel = (res) => {
      res.writeHead(302, { location: `${internalBase}/latest/meta-data/` });
      res.end();
    };
    const dir = join(ws, "redirect");
    await expect(fetchWithCobalt({ url: REEL, mediaDir: dir, env: env({ FRAMELENS_COBALT_KEY: "KEY" }), maxBytes: 1e6 })).rejects.toThrow(/not https/);
    expect(internalHits).toEqual([]);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("refuses https addresses on this computer or the local network, by name, address or what the name resolves to", async () => {
    for (const media of ["https://localhost:8443/admin", "https://169.254.169.254/latest/meta-data/", "https://[::1]/x", "https://10.0.0.5/v.mp4", "https://router/v.mp4", "https://nas.local/v.mp4"]) {
      answer = () => ({ json: { status: "redirect", url: media } });
      await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "p"), env: env(), maxBytes: 1e6, lookup: publicLookup }), media).rejects.toThrow(/this computer or the local network/);
    }
    answer = () => ({ json: { status: "redirect", url: "https://cdn.example.test/v.mp4" } });
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "p"), env: env(), maxBytes: 1e6, lookup: async () => ["192.168.1.20"] })).rejects.toThrow(/local network/);
    expect(seen.filter((s) => s.method === "GET")).toEqual([]);
  });

  it("checks every hop of a public redirect, and accepts a public https host", async () => {
    const hops: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return fetch(url, init);
      hops.push(url);
      if (url === "https://cdn.example.test/v.mp4") return new Response(null, { status: 302, headers: { location: "https://cdn2.example.test/v.mp4" } });
      if (url === "https://cdn2.example.test/v.mp4") return new Response(VIDEO, { headers: { "content-type": "video/mp4" } });
      return new Response(null, { status: 302, headers: { location: `${internalBase}/x` } });
    }) as unknown as typeof fetch;
    answer = () => ({ json: { status: "redirect", url: "https://cdn.example.test/v.mp4", filename: "a.mp4" } });
    const ok = await fetchWithCobalt({ url: REEL, mediaDir: join(ws, "hop"), env: env(), maxBytes: 1e6, lookup: publicLookup, fetchFn });
    expect(readFileSync(ok.mediaPath)).toEqual(VIDEO);
    expect(hops).toEqual(["https://cdn.example.test/v.mp4", "https://cdn2.example.test/v.mp4"]);
    answer = () => ({ json: { status: "redirect", url: "https://cdn3.example.test/v.mp4" } });
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "hop2"), env: env(), maxBytes: 1e6, lookup: publicLookup, fetchFn })).rejects.toThrow(/not https/);
    expect(internalHits).toEqual([]);
  });

  it("keeps only video or audio: a web page or an unknown binary is not saved", async () => {
    tunnel = (res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    };
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "html"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/not a video or audio file/);
    tunnel = (res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("<html>not media</html>");
    };
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "bin"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/not a video or audio file/);
    tunnel = (res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(VIDEO);
    };
    expect(existsSync((await fetchWithCobalt({ url: REEL, mediaDir: join(ws, "mp4"), env: env(), maxBytes: 1e6 })).mediaPath)).toBe(true);
    expect(readdirSync(join(ws, "html"))).toEqual([]);
  });

  it("tells addresses on this computer and the local network from public ones, IPv4 inside IPv6 included", () => {
    const local = [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fe80::1", "fd00::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1",
      "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::5db8:d822", "2002:7f00:1::1", "2001:db8::1", "2001:0:1::1", "[::1]", "not:an:ipv6::addr:at:all:x",
    ];
    for (const a of local) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.0.43.10", "2606:4700::1111", "::ffff:93.184.216.34", "64:ff9b::5db8:d822", "2002:5db8:d822::1"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("refuses IPv4-compatible and NAT64 forms of local addresses in a redirect, and explains a broken Location", async () => {
    for (const media of ["https://[::127.0.0.1]/x", "https://[64:ff9b::7f00:1]/x", "https://[fec0::1]/x", "https://2130706433/x", "https://0x7f.0.0.1/x"]) {
      answer = () => ({ json: { status: "redirect", url: media } });
      await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "v6"), env: env(), maxBytes: 1e6, lookup: publicLookup }), media).rejects.toThrow(/this computer or the local network/);
    }
    answer = (b) => ({ json: { status: "tunnel", url: `${b}/tunnel?id=1` } });
    tunnel = (res) => {
      res.writeHead(302, { location: "https://[::1" });
      res.end();
    };
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "loc"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/redirected to an address that is not valid/);
  });

  it("connects to the address it checked, not to a second DNS answer", async () => {
    // media.example.test does not exist in DNS: the request can only arrive here through the checked address.
    const port = (server.address() as AddressInfo).port;
    const got = await pinnedGet(new URL(`http://media.example.test:${port}/tunnel?pinned`), "127.0.0.1", AbortSignal.timeout(10_000));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await new Response(got.body).arrayBuffer())).toEqual(VIDEO);
    expect(seen.at(-1)).toMatchObject({ url: "/tunnel?pinned", headers: { host: `media.example.test:${port}` } });
  });
});

describe("the instance setting", () => {
  it("refuses the official public instance however its name is written, before any request", async () => {
    for (const raw of ["https://api.cobalt.tools/", "https://API.COBALT.TOOLS/", "https://api.cobalt.tools./", "https://cobalt.tools.:443/"]) {
      const calls: string[] = [];
      const fetchFn = (async (u: string) => (calls.push(u), new Response("{}"))) as unknown as typeof fetch;
      await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "pub"), env: { FRAMELENS_COBALT_URL: raw }, maxBytes: 1e6, fetchFn }), raw).rejects.toThrow(/official public cobalt instance/);
      expect(calls).toEqual([]);
    }
  });

  it("never repeats a key, a password or a query from the setting", () => {
    for (const raw of ["not a url ?key=SECRET-KEY-123", "https://user:SECRET-KEY-123@cobalt.home.example/", "https://cobalt.home.example/?key=SECRET-KEY-123"]) {
      const checked = checkCobaltInstance({ FRAMELENS_COBALT_URL: raw });
      expect("error" in checked && checked.error, raw).toBeTruthy();
      expect(JSON.stringify(checked)).not.toContain("SECRET-KEY-123");
    }
  });

  it("doctor shows the instance only as the server would use it", async () => {
    const lines: string[] = [];
    await runDoctor({ env: { PATH: "", FRAMELENS_HOME: join(root, "h"), FRAMELENS_COBALT_URL: "https://api.cobalt.tools/", FRAMELENS_DOWNLOADS: join(root, "dl") }, write: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/Self-hosted cobalt \(FRAMELENS_COBALT_URL\): not used: .*official public cobalt instance/);
    lines.length = 0;
    await runDoctor({ env: { PATH: "", FRAMELENS_HOME: join(root, "h"), FRAMELENS_COBALT_URL: "x ?key=SECRET-KEY-123" }, write: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("not used: FRAMELENS_COBALT_URL is not a valid address");
    expect(lines.join("\n")).not.toContain("SECRET-KEY-123");
  });
});

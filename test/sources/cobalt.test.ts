import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cobaltMayRetry, fetchWithCobalt } from "../../src/sources/cobalt.js";
import { SourceError } from "../../src/sources/errors.js";
import { resolveSource } from "../../src/sources/resolve.js";

const fake = resolve("test/fixtures/fake-ytdlp.mjs");
const root = mkdtempSync(join(tmpdir(), "framelens-cobalt-"));
const VIDEO = Buffer.from("fake mp4 bytes ".repeat(100));

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body?: Record<string, unknown>;
}
const seen: Seen[] = [];
let answer: (base: string) => { status?: number; json?: unknown; headers?: Record<string, string> } = () => ({ json: {} });
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, ...(raw && { body: JSON.parse(raw) as Record<string, unknown> }) });
      if (req.method === "GET" && req.url?.startsWith("/tunnel")) {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": VIDEO.length });
        res.end(VIDEO);
        return;
      }
      const a = answer(base);
      res.writeHead(a.status ?? 200, { "content-type": "application/json", ...a.headers });
      res.end(JSON.stringify(a.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
let ws: string;
beforeEach(() => {
  ws = join(root, `ws${++n}`);
  seen.length = 0;
  answer = (b) => ({ json: { status: "tunnel", url: `${b}/tunnel?id=1`, filename: "reel_by_someone.mp4" } });
});
afterEach(() => delete process.env.FAKE_YTDLP_MODE);

const env = (extra: Record<string, string> = {}) => ({ FRAMELENS_YTDLP: fake, FRAMELENS_FFMPEG: fake, PATH: "", FRAMELENS_COBALT_URL: `${base}/`, ...extra });
const REEL = "https://www.instagram.com/reel/Cx1/";

describe("cobalt, the user's own instance", () => {
  it("fetches a link yt-dlp cannot, through the configured instance with its API key", async () => {
    process.env.FAKE_YTDLP_MODE = "unsupported";
    const record = await resolveSource("https://example.com/page", { workspaceRoot: ws, env: env({ FRAMELENS_COBALT_KEY: "secret-key" }) });
    expect(record).toMatchObject({ kind: "url", title: "reel_by_someone", tools: { cobalt: base } });
    expect(readFileSync(record.mediaPath)).toEqual(VIDEO);
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.headers.authorization).toBe("Api-Key secret-key");
    expect(post.headers.accept).toBe("application/json");
    expect(post.body).toMatchObject({ url: "https://example.com/page", alwaysProxy: true, localProcessing: "disabled" });
    expect(JSON.parse(readFileSync(join(ws, record.id, "source.json"), "utf8")).tools.cobalt).toBe(base);
  });

  it("changes nothing when FRAMELENS_COBALT_URL is not set", async () => {
    process.env.FAKE_YTDLP_MODE = "unsupported";
    const { FRAMELENS_COBALT_URL: _, ...plain } = env();
    await expect(resolveSource("https://example.com/page", { workspaceRoot: ws, env: plain })).rejects.toMatchObject({ code: "unsupported_url" });
    expect(seen).toEqual([]);
  });

  it("never sends a bot check, a private or geo-blocked video to cobalt", async () => {
    for (const mode of ["bot", "private", "geo"]) {
      process.env.FAKE_YTDLP_MODE = mode;
      await expect(resolveSource("https://www.youtube.com/watch?v=jNQXAC9IVRw", { workspaceRoot: ws, env: env() })).rejects.toBeInstanceOf(SourceError);
    }
    expect(seen).toEqual([]);
    expect(cobaltMayRetry(new SourceError("login_required", "x", { botCheck: true }), env())).toBe(false);
    expect(cobaltMayRetry(new SourceError("login_required", "x"), env())).toBe(true);
  });

  it("reports both failures when the instance cannot fetch it either", async () => {
    process.env.FAKE_YTDLP_MODE = "login";
    answer = () => ({ status: 400, json: { status: "error", error: { code: "error.api.content.post.private" } } });
    const error = await resolveSource(REEL, { workspaceRoot: ws, env: env() }).catch((e) => e);
    expect(error.code).toBe("login_required");
    expect(error.message).toContain("FRAMELENS_INBOX");
    expect(error.message).toMatch(/cobalt instance could not fetch it: the post is private/);
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

  it("refuses public instances, media over plain http elsewhere, and a redirecting instance", async () => {
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "p"), env: env({ FRAMELENS_COBALT_URL: "https://api.cobalt.tools/" }), maxBytes: 1e6, fetchFn: (async () => { throw new Error("must not call"); }) as unknown as typeof fetch })).rejects.toThrow(/public cobalt instance/);
    answer = () => ({ json: { status: "redirect", url: "http://cdn.example.com/v.mp4" } });
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "h"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/not https/);
    answer = () => ({ status: 301, json: {}, headers: { location: "https://cobalt.home.example/" } });
    await expect(fetchWithCobalt({ url: REEL, mediaDir: join(ws, "r"), env: env(), maxBytes: 1e6 })).rejects.toThrow(/redirects to https:\/\/cobalt\.home\.example/);
  });

  it("says when the instance wants a key, and never puts the key in a message", async () => {
    answer = () => ({ status: 401, json: { status: "error", error: { code: "error.api.auth.key.invalid" } } });
    const error = await fetchWithCobalt({ url: REEL, mediaDir: join(ws, "k"), env: env({ FRAMELENS_COBALT_KEY: "top-secret" }), maxBytes: 1e6 }).catch((e) => e);
    expect(error.message).toMatch(/FRAMELENS_COBALT_KEY/);
    expect(error.message).not.toContain("top-secret");
  });
});

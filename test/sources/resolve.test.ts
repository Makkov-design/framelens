import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyInput, resolveSource } from "../../src/sources/resolve.js";
import { run } from "../../src/tools/run.js";
import { findTool } from "../../src/tools/find.js";

const fake = resolve("test/fixtures/fake-ytdlp.mjs");
const root = mkdtempSync(join(tmpdir(), "framelens-src-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let ws: string;
let argLog: string;
let n = 0;
beforeEach(() => {
  ws = join(root, `ws${++n}`);
  argLog = join(root, `args${n}.log`);
  process.env.FAKE_YTDLP_LOG = argLog;
  delete process.env.FAKE_YTDLP_MODE;
});
afterEach(() => {
  delete process.env.FAKE_YTDLP_MODE;
  delete process.env.FAKE_YTDLP_LOG;
});

const env = (extra: Record<string, string> = {}) => ({ FRAMELENS_YTDLP: fake, FRAMELENS_FFMPEG: fake, PATH: "", FRAMELENS_DOWNLOADS: join(root, "no-downloads"), ...extra });
const calls = () => (existsSync(argLog) ? readFileSync(argLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL123";

describe("classifyInput", () => {
  it("recognises YouTube links, IDs and other links", () => {
    expect(classifyInput(YT)).toEqual({ kind: "youtube", id: "yt-jNQXAC9IVRw", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" });
    expect(classifyInput("https://youtu.be/jNQXAC9IVRw").id).toBe("yt-jNQXAC9IVRw");
    expect(classifyInput("jNQXAC9IVRw").kind).toBe("youtube");
    expect(classifyInput("youtube.com/shorts/jNQXAC9IVRw").kind).toBe("youtube");
    const other = classifyInput("https://www.tiktok.com/@a/video/1");
    expect(other.kind).toBe("url");
    expect(other.id).toMatch(/^url-[0-9a-f]{10}$/);
  });

  it("gives a local file a stable id that changes with the file", () => {
    const file = join(root, "clip.mp4");
    writeFileSync(file, "abc");
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const a = classifyInput(file);
    expect(a).toMatchObject({ kind: "file", path: file });
    expect(a.id).toMatch(/^file-[0-9a-f]{10}$/);
    expect(classifyInput(`"${file}"`).id).toBe(a.id);
    writeFileSync(file, "abcd");
    expect(classifyInput(file).id).not.toBe(a.id);
  });

  it("rejects nonsense with a clear message", () => {
    expect(() => classifyInput("")).toThrow(/empty/);
    expect(() => classifyInput(join(root, "no-such-file.mp4"))).toThrow(/no such file/i);
    expect(() => classifyInput(root)).toThrow(/folder/);
    expect(() => classifyInput("not a thing")).toThrow();
  });

  it("says a relative path is taken from the server's working folder, and asks for an absolute one", () => {
    // Claude Desktop starts the server in System32, where "clips/promo.mp4" never is.
    expect(() => classifyInput("clips/promo-that-is-not-here.mp4")).toThrow(/relative path is taken from the server's working folder.*System32.*absolute path/s);
    expect(() => classifyInput(join(root, "no-such-file.mp4"))).not.toThrow(/relative path/);
  });
});

describe("resolveSource: local files and the inbox", () => {
  it("references a local file without copying it and writes source.json", async () => {
    const file = join(root, "local.mp4");
    writeFileSync(file, "video");
    const record = await resolveSource(file, { workspaceRoot: ws, env: env() });
    expect(record).toMatchObject({ kind: "file", mediaPath: file, title: "local", input: file });
    expect(existsSync(join(ws, record.id, "media"))).toBe(false);
    const stored = JSON.parse(readFileSync(join(ws, record.id, "source.json"), "utf8"));
    expect(stored.mediaPath).toBe(file);
  });

  it("takes the newest video or GIF from FRAMELENS_INBOX and ignores other files", async () => {
    const inbox = join(root, "inbox");
    mkdirSync(inbox, { recursive: true });
    const old = join(inbox, "old.mp4");
    const fresh = join(inbox, "fresh.gif");
    const note = join(inbox, "notes.txt");
    for (const f of [old, fresh, note]) writeFileSync(f, "x");
    utimesSync(old, 1_700_000_000, 1_700_000_000);
    utimesSync(fresh, 1_700_000_100, 1_700_000_100);
    utimesSync(note, 1_700_000_200, 1_700_000_200);
    const record = await resolveSource("inbox", { workspaceRoot: ws, env: env({ FRAMELENS_INBOX: inbox }) });
    expect(record.mediaPath).toBe(resolve(fresh));
    expect(record.input).toBe("inbox");
  });

  it("explains an unset or empty inbox", async () => {
    await expect(resolveSource("inbox", { workspaceRoot: ws, env: env() })).rejects.toThrow(/FRAMELENS_INBOX is not set/);
    const empty = join(root, "empty-inbox");
    mkdirSync(empty, { recursive: true });
    await expect(resolveSource("inbox", { workspaceRoot: ws, env: env({ FRAMELENS_INBOX: empty }) })).rejects.toThrow(/No video, GIF or recording/);
  });

  it.skipIf(!findTool("ffmpeg"))("handles a real ffmpeg-generated clip", async () => {
    const clip = join(root, "real.mp4");
    const ffmpeg = findTool("ffmpeg")!.path;
    const made = await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=1", "-pix_fmt", "yuv420p", "-y", clip], { timeoutMs: 60_000 });
    expect(made.code).toBe(0);
    const record = await resolveSource(clip, { workspaceRoot: ws, env: env() });
    expect(record.kind).toBe("file");
    expect(existsSync(record.mediaPath)).toBe(true);
  });
});

describe("resolveSource: links through yt-dlp", () => {
  it("downloads a YouTube video into the workspace with captions and tool versions", async () => {
    const logs: string[] = [];
    const record = await resolveSource(YT, { workspaceRoot: ws, env: env(), log: (l) => logs.push(l) });
    expect(record).toMatchObject({ id: "yt-jNQXAC9IVRw", kind: "youtube", title: "Fake video", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" });
    expect(record.mediaPath).toBe(join(ws, "yt-jNQXAC9IVRw", "media", "source.mp4"));
    expect(readFileSync(record.mediaPath, "utf8")).toBe("fake-video");
    expect(record.captions).toEqual([{ path: join(ws, "yt-jNQXAC9IVRw", "media", "source.en-orig.json3"), language: "en-orig", auto: true }]);
    expect(record.tools).toEqual({ ytDlp: "0.0.0-fake", ffmpeg: "0.0-fake" });
    expect(JSON.parse(readFileSync(join(ws, record.id, "source.json"), "utf8")).reused).toBeUndefined();

    const [info, download] = calls().filter((c) => !c.includes("--version") && !c.includes("-version"));
    expect(info).toContain("--dump-single-json");
    for (const args of [info!, download!]) {
      expect(args).toEqual(expect.arrayContaining(["--no-playlist", "--ignore-config", "--ffmpeg-location", fake]));
      expect(args[args.indexOf("--sleep-requests") + 1]).toBe("1");
      expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
    }
    expect(download![download!.indexOf("--merge-output-format") + 1]).toBe("mp4");
    expect(download![download!.indexOf("--max-filesize") + 1]).toBe("2048M");
    expect(download![download!.indexOf("-f") + 1]).toContain("height<=1080");
    expect(download![download!.indexOf("--sub-langs") + 1]).toBe("en-orig");
    expect(download![download!.indexOf("--sub-format") + 1]).toBe("json3/vtt/best");
  });

  it("leaves no empty workspace folder behind when a link cannot be fetched", async () => {
    // 2.1.0 left an empty yt-<id> folder for every failed probe.
    process.env.FAKE_YTDLP_MODE = "private";
    await expect(resolveSource(YT, { workspaceRoot: ws, env: env() })).rejects.toThrow();
    expect(existsSync(join(ws, "yt-jNQXAC9IVRw"))).toBe(false);
    // A workspace that was there before (an earlier download, its media since deleted) is kept.
    delete process.env.FAKE_YTDLP_MODE;
    const first = await resolveSource(YT, { workspaceRoot: ws, env: env() });
    rmSync(first.mediaPath);
    process.env.FAKE_YTDLP_MODE = "private";
    await expect(resolveSource(YT, { workspaceRoot: ws, env: env() })).rejects.toThrow();
    expect(existsSync(join(ws, "yt-jNQXAC9IVRw", "source.json"))).toBe(true);
  });

  it("marks uploader-made captions as not automatic", async () => {
    process.env.FAKE_YTDLP_MODE = "manual-subs";
    const record = await resolveSource(YT, { workspaceRoot: ws, env: env() });
    expect(record.captions?.map((c) => [c.language, c.auto])).toEqual([["en", false]]);
  });

  it("reuses the workspace copy without calling yt-dlp again", async () => {
    await resolveSource(YT, { workspaceRoot: ws, env: env() });
    const before = calls().length;
    const again = await resolveSource("jNQXAC9IVRw", { workspaceRoot: ws, env: env() });
    expect(again.reused).toBe(true);
    expect(again.title).toBe("Fake video");
    expect(calls().length).toBe(before);
  });

  it("downloads again when the media file was deleted", async () => {
    const first = await resolveSource(YT, { workspaceRoot: ws, env: env() });
    rmSync(first.mediaPath);
    const again = await resolveSource(YT, { workspaceRoot: ws, env: env() });
    expect(again.reused).toBeUndefined();
    expect(existsSync(again.mediaPath)).toBe(true);
  });

  it("fetches other links with the generic id and the page's canonical url", async () => {
    const record = await resolveSource("https://cdn.example.com/clip.mp4", { workspaceRoot: ws, env: env() });
    expect(record.kind).toBe("url");
    expect(record.id).toMatch(/^url-/);
    expect(record.url).toBe("https://example.com/watch/1");
  });

  it("passes opt-in cookies to yt-dlp and never logs their value", async () => {
    const jar = join(root, "secret-cookies.txt");
    writeFileSync(jar, "# Netscape\n");
    const logs: string[] = [];
    await resolveSource(YT, { workspaceRoot: ws, env: env({ FRAMELENS_COOKIES_FILE: jar }), log: (l) => logs.push(l) });
    expect(calls().some((c) => c.includes("--cookies") && c.includes(jar))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret-cookies");
    await resolveSource("https://example.org/other", { workspaceRoot: ws, env: env({ FRAMELENS_COOKIES_FROM_BROWSER: "firefox" }) });
    expect(calls().some((c) => c.includes("--cookies-from-browser") && c.includes("firefox"))).toBe(true);
  });

  it("sends no cookie arguments unless the user opted in", async () => {
    await resolveSource(YT, { workspaceRoot: ws, env: env() });
    expect(calls().some((c) => c.some((a) => a.startsWith("--cookies")))).toBe(false);
  });

  it("refuses Chrome cookies on Windows and a missing cookies file", async () => {
    const { cookieArgs } = await import("../../src/sources/cookies.js");
    expect(() => cookieArgs({ FRAMELENS_COOKIES_FROM_BROWSER: "chrome" }, "win32")).toThrow(/cannot work on Windows/);
    expect(cookieArgs({ FRAMELENS_COOKIES_FROM_BROWSER: "chrome" }, "linux")).toEqual(["--cookies-from-browser", "chrome"]);
    expect(() => cookieArgs({ FRAMELENS_COOKIES_FILE: join(root, "nope.txt") })).toThrow(/not a file/);
  });

  it("stops before downloading when the size is over the cap", async () => {
    process.env.FAKE_YTDLP_MODE = "huge";
    const error = await resolveSource(YT, { workspaceRoot: ws, env: env() }).catch((e) => e);
    expect(error.code).toBe("too_large");
    expect(error.message).toMatch(/FRAMELENS_MAX_DOWNLOAD_MB/);
    expect(calls().some((c) => c.includes("--max-filesize"))).toBe(false);
    process.env.FAKE_YTDLP_MODE = "ok";
    expect((await resolveSource(YT, { workspaceRoot: ws, env: env({ FRAMELENS_MAX_DOWNLOAD_MB: "100" }) })).kind).toBe("youtube");
    expect(calls().find((c) => c.includes("--max-filesize"))![calls().find((c) => c.includes("--max-filesize"))!.indexOf("--max-filesize") + 1]).toBe("100M");
  });

  it("reports a download that produced no file", async () => {
    process.env.FAKE_YTDLP_MODE = "nofile";
    await expect(resolveSource(YT, { workspaceRoot: ws, env: env() })).rejects.toThrow(/no media file/);
  });

  it("points to doctor --prepare when yt-dlp is missing", async () => {
    await expect(
      resolveSource(YT, { workspaceRoot: ws, env: { PATH: "", FRAMELENS_HOME: join(root, "nohome"), FRAMELENS_FFMPEG: fake }, find: { platform: "linux" } }),
    ).rejects.toThrow(/doctor --prepare/);
  });

  it.each([
    ["login", "login_required", /Instagram|folder named in FRAMELENS_INBOX/],
    ["bot", "login_required", /YouTube asks for a login/],
    ["private", "unavailable", /private, removed or unavailable/],
    ["geo", "geo_blocked", /blocks this video in your country/],
    ["unsupported", "unsupported_url", /cannot read a video from this link/],
    ["limited", "download_failed", /HTTP 429/],
  ])("maps the %s failure to %s", async (mode, code, message) => {
    process.env.FAKE_YTDLP_MODE = mode;
    const url = mode === "login" ? "https://www.instagram.com/reel/Cx1/" : YT;
    const error = await resolveSource(url, { workspaceRoot: ws, env: env() }).catch((e) => e);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it("names the platform and lists the tiers for a login wall", async () => {
    process.env.FAKE_YTDLP_MODE = "login";
    const error = await resolveSource("https://www.instagram.com/reel/Cx1/", { workspaceRoot: ws, env: env() }).catch((e) => e);
    expect(error.message).toContain("Instagram");
    expect(error.message).toContain("FRAMELENS_INBOX");
    expect(error.message).toContain("FRAMELENS_COOKIES_FROM_BROWSER");
    expect(error.message).toContain("FRAMELENS_COOKIES_FILE");
  });
});

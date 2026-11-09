import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ffmpegPinnedPath, FFMPEG_PIN, prepareFfmpeg, type FfmpegAsset } from "../../src/tools/ffmpeg.js";
import { findTool } from "../../src/tools/find.js";
import { autoInstallEnabled, ToolSetup } from "../../src/tools/setup.js";
import { withSetupNotes } from "../../src/local-tools.js";
import { makeZip } from "../fixtures/zip.js";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const ffmpegBody = Buffer.from("pretend ffmpeg ".repeat(5000));
const ffprobeBody = Buffer.from("pretend ffprobe ".repeat(4000));
const archive = makeZip([
  { name: "build/bin/ffmpeg.exe", data: ffmpegBody },
  { name: "build/bin/ffprobe.exe", data: ffprobeBody, store: true },
  { name: "build/doc/readme.txt", data: "docs" },
]);

let server: Server;
let base: string;
const requests: string[] = [];
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/ffmpeg.zip") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": archive.length });
      res.end(archive);
    } else if (req.url === "/tampered.zip") {
      const bad = Buffer.from(archive);
      bad[40] = bad[40]! ^ 0xff;
      res.end(bad);
    } else if (req.url === "/huge.zip") {
      res.end(Buffer.concat([archive, Buffer.alloc(archive.length)]));
    } else {
      res.writeHead(404);
      res.end("missing");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
const homes: string[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "framelens-ffmpeg-"));
  homes.push(home);
  requests.length = 0;
});

const asset = (url = `${base}/ffmpeg.zip`, over: Partial<FfmpegAsset["archives"][number]> = {}): FfmpegAsset => ({
  source: "test server",
  archives: [
    {
      url,
      sha256: sha(archive),
      bytes: archive.length,
      files: [
        { tool: "ffmpeg", entry: "build/bin/ffmpeg.exe", sha256: sha(ffmpegBody) },
        { tool: "ffprobe", entry: "build/bin/ffprobe.exe", sha256: sha(ffprobeBody) },
      ],
      ...over,
    },
  ],
});

describe("pinned ffmpeg", () => {
  it("pins one FFmpeg version with archive and binary hashes for Windows x64, macOS arm64 and x64, and Linux x64", () => {
    expect(FFMPEG_PIN.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(Object.keys(FFMPEG_PIN.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    for (const a of Object.values(FFMPEG_PIN.assets)) {
      const tools = a.archives.flatMap((x) => x.files.map((f) => f.tool)).sort();
      expect(tools).toEqual(["ffmpeg", "ffprobe"]);
      for (const x of a.archives) {
        expect(x.url).toMatch(/^https:\/\//);
        expect(x.url).toContain(FFMPEG_PIN.version);
        expect(x.sha256).toMatch(/^[0-9a-f]{64}$/);
        for (const f of x.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("downloads from the server, checks the archive and each binary, and installs both under the version folder", async () => {
    const result = await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset() });
    expect(result).toMatchObject({ downloaded: true, version: FFMPEG_PIN.version, ffmpeg: ffmpegPinnedPath(home, "ffmpeg", "win32", "x64") });
    expect(readFileSync(result.ffmpeg)).toEqual(ffmpegBody);
    expect(readFileSync(result.ffprobe)).toEqual(ffprobeBody);
    // Nothing but the two binaries is left: no archive, no partial files, no docs.
    expect(readdirSync(join(result.ffmpeg, "..")).sort()).toEqual(["ffmpeg.exe", "ffprobe.exe"]);
    expect(requests).toEqual(["/ffmpeg.zip"]);
  });

  it("does nothing when verified copies are there, and replaces a copy that was changed", async () => {
    const env = { FRAMELENS_HOME: home };
    const first = await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() });
    requests.length = 0;
    expect((await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() })).downloaded).toBe(false);
    expect(requests).toEqual([]);
    writeFileSync(first.ffprobe, "changed");
    expect((await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() })).downloaded).toBe(true);
    expect(readFileSync(first.ffprobe)).toEqual(ffprobeBody);
  });

  it("rejects an archive whose hash differs and keeps nothing", async () => {
    const error = await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/tampered.zip`) }).catch((e) => e);
    expect(error.code).toBe("checksum");
    const dir = join(home, "tools", "ffmpeg", FFMPEG_PIN.version);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("rejects a binary whose hash differs from its pin, and an archive without the binary", async () => {
    const wrong = asset(undefined, { files: [{ tool: "ffmpeg", entry: "build/bin/ffmpeg.exe", sha256: "0".repeat(64) }, { tool: "ffprobe", entry: "build/bin/ffprobe.exe", sha256: sha(ffprobeBody) }] });
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: wrong })).rejects.toMatchObject({ code: "checksum" });
    expect(existsSync(ffmpegPinnedPath(home, "ffmpeg", "win32", "x64")!)).toBe(false);
    const absent = asset(undefined, { files: [{ tool: "ffmpeg", entry: "elsewhere/ffmpeg.exe", sha256: sha(ffmpegBody) }] });
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: absent })).rejects.toThrow(/does not contain/);
  });

  it("stops a download that is larger than the pinned archive, and reports HTTP errors and unsupported platforms", async () => {
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/huge.zip`) })).rejects.toThrow(/larger than the pinned/);
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/nope.zip`) })).rejects.toMatchObject({ code: "download_failed" });
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "linux", arch: "arm64" })).rejects.toMatchObject({ code: "unsupported_platform" });
  });

  it("is found after PATH and WinGet, so an ffmpeg the user installed wins", async () => {
    const env = { FRAMELENS_HOME: home, PATH: "" };
    expect(findTool("ffmpeg", { env, platform: "win32" })).toBeUndefined();
    await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() });
    expect(findTool("ffprobe", { env, platform: "win32" })).toMatchObject({ source: "pinned" });
    const own = join(home, "own");
    mkdirSync(own);
    writeFileSync(join(own, "ffmpeg.exe"), "mine");
    expect(findTool("ffmpeg", { env: { ...env, PATH: own }, platform: "win32" })).toMatchObject({ source: "path" });
  });
});

describe("automatic setup", () => {
  const fakeInstall = (calls: string[]) => async () => {
    calls.push("ffmpeg");
    await new Promise((r) => setTimeout(r, 20));
    const dir = join(home, "tools", "ffmpeg", FFMPEG_PIN.version);
    mkdirSync(dir, { recursive: true });
    for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(dir, process.platform === "win32" ? `${t}.exe` : t), "#!/bin/sh\n", { mode: 0o755 });
    return { ffmpeg: join(dir, "ffmpeg"), ffprobe: join(dir, "ffprobe"), version: FFMPEG_PIN.version, source: "test", downloaded: true };
  };

  it("is on unless FRAMELENS_AUTO_INSTALL turns it off", () => {
    expect(autoInstallEnabled({})).toBe(true);
    expect(autoInstallEnabled({ FRAMELENS_AUTO_INSTALL: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", "no"]) expect(autoInstallEnabled({ FRAMELENS_AUTO_INSTALL: off })).toBe(false);
  });

  it("installs a missing ffmpeg once for parallel calls, continues, and leaves one note for the agent", async () => {
    const calls: string[] = [];
    const platform = process.platform === "win32" ? "win32" : "linux";
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform, arch: "x64", prepareFfmpeg: fakeInstall(calls) });
    const [a, b] = await Promise.all([setup.locate("ffmpeg"), setup.locate("ffprobe")]);
    expect(calls).toEqual(["ffmpeg"]);
    expect(a.source).toBe("pinned");
    expect(b.path).toMatch(/ffprobe/);
    const notes = setup.takeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/downloaded FFmpeg .* and continued\. FRAMELENS_AUTO_INSTALL=0 turns this off/);
    expect(setup.takeNotes()).toEqual([]);
  });

  it("does not download when FRAMELENS_AUTO_INSTALL=0, and says how to get the tool", async () => {
    const calls: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "", FRAMELENS_AUTO_INSTALL: "0" }, platform: "linux", arch: "x64", prepareFfmpeg: fakeInstall(calls) });
    await expect(setup.locate("ffmpeg")).rejects.toThrow(/doctor --prepare.*Automatic setup is off/s);
    expect(calls).toEqual([]);
  });

  it("explains a failed download, and installs yt-dlp the same way", async () => {
    const failing = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform: "linux", arch: "x64", prepareFfmpeg: async () => Promise.reject(new Error("offline")) });
    await expect(failing.locate("ffmpeg")).rejects.toThrow(/downloading the pinned build failed: offline/);
    const ytCalls: string[] = [];
    const setup = new ToolSetup({
      env: { FRAMELENS_HOME: home, PATH: "" },
      platform: "linux",
      arch: "x64",
      prepareYtDlp: async () => {
        ytCalls.push("yt-dlp");
        const path = join(home, "tools", "yt-dlp", "2026.10.21", "yt-dlp");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
        return { path, version: "2026.10.21", downloaded: true };
      },
    });
    expect((await setup.locate("yt-dlp")).source).toBe("pinned");
    expect(ytCalls).toEqual(["yt-dlp"]);
    expect(setup.takeNotes()[0]).toMatch(/downloaded yt-dlp/);
  });

  it("resolves the bare program names the engine uses when nothing was found at start", async () => {
    const seen: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform: process.platform === "win32" ? "win32" : "linux", arch: "x64", prepareFfmpeg: fakeInstall([]) });
    const exec = setup.wrapExec(async (file) => {
      seen.push(file);
      return { stdout: "", stderr: "" };
    });
    await exec("ffprobe", ["-version"]);
    await exec("/usr/bin/other", []);
    expect(seen[0]).toMatch(/[\\/]ffprobe(\.exe)?$/);
    expect(seen[1]).toBe("/usr/bin/other");
  });

  it("adds the notes to a tool result's text and structured content", () => {
    const result = withSetupNotes({ content: [{ type: "text", text: "done" }], structuredContent: { a: 1 } }, ["installed ffmpeg"]);
    expect(result.content[0]).toEqual({ type: "text", text: "done\n\ninstalled ffmpeg" });
    expect(result.structuredContent).toEqual({ a: 1, setup: ["installed ffmpeg"] });
    expect(withSetupNotes({ content: [] }, [])).toEqual({ content: [] });
  });
});

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

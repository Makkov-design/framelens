import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanStalePartials, placeVerified } from "../../src/tools/download.js";
import { ffmpegPinnedPath, FFMPEG_PIN, prepareFfmpeg, type FfmpegAsset } from "../../src/tools/ffmpeg.js";
import { findTool } from "../../src/tools/find.js";
import { autoInstallEnabled, collectSetupNotes, ToolSetup } from "../../src/tools/setup.js";
import { prepareYtDlp, YTDLP_PIN } from "../../src/tools/ytdlp.js";
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
// A process id no process has (the highest Windows and Linux allow are far below it).
const DEAD_PID = 2_000_000_000;

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
    } else if (req.url === "/slow.zip") {
      // Sent in pieces, so two installs at once overlap.
      res.writeHead(200, { "content-length": archive.length });
      let at = 0;
      const step = () => {
        res.write(archive.subarray(at, at + 8192));
        at += 8192;
        if (at < archive.length) setTimeout(step, 2);
        else res.end();
      };
      step();
    } else if (req.url === "/stall.zip") {
      res.writeHead(200, { "content-length": archive.length });
      res.write(archive.subarray(0, 1000));
    } else if (req.url === "/tampered.zip") {
      const bad = Buffer.from(archive);
      bad[40] = bad[40]! ^ 0xff;
      res.end(bad);
    } else if (req.url === "/huge.zip") {
      res.end(Buffer.concat([archive, Buffer.alloc(archive.length)]));
    } else if (req.url === "/yt/yt-dlp.exe" || req.url === "/yt/yt-dlp") {
      res.end("pretend-yt-dlp-binary");
    } else if (req.url === "/yt/SHA2-256SUMS") {
      res.end(`${sha("pretend-yt-dlp-binary")}  yt-dlp.exe\n`);
    } else if (req.url === "/big/yt-dlp.exe") {
      res.writeHead(200, { "content-length": String(500 * 1024 * 1024) });
      res.write("x");
    } else {
      res.writeHead(404);
      res.end("missing");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
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
const pinnedDir = () => join(home, "tools", "ffmpeg", FFMPEG_PIN.version);

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
    expect(existsSync(pinnedDir()) ? readdirSync(pinnedDir()) : []).toEqual([]);
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

  it("gives up on a stalled or too slow download with a clear message and leaves nothing behind", async () => {
    const stalled = await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/stall.zip`), stallMs: 300 }).catch((e) => e);
    expect(stalled.message).toMatch(/The ffmpeg download from 127\.0\.0\.1:\d+ stalled \(no data for 1 s\)\. Try again, or run `npx framelens doctor --prepare`/);
    const slow = await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/stall.zip`), timeoutMs: 200 }).catch((e) => e);
    expect(slow.message).toMatch(/did not finish in 1 minute/);
    const aborted = new AbortController();
    setTimeout(() => aborted.abort(), 100);
    await expect(prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset(`${base}/stall.zip`), signal: aborted.signal })).rejects.toThrow(/was stopped/);
    expect(readdirSync(pinnedDir())).toEqual([]);
  });

  it("clears what an install killed mid-way left behind, and leaves a live process's download alone", async () => {
    const dir = pinnedDir();
    mkdirSync(dir, { recursive: true });
    const stale = [`.download-${DEAD_PID}-1762660000000.zip`, `ffmpeg.exe.${DEAD_PID}-abcd1234.part`, "yt-dlp.exe.part"];
    for (const name of stale) writeFileSync(join(dir, name), "partial");
    utimesSync(join(dir, "yt-dlp.exe.part"), 1_700_000_000, 1_700_000_000);
    const live = `.download-${process.ppid}-abcd1234.zip`;
    writeFileSync(join(dir, live), "someone else's download in progress");
    await prepareFfmpeg({ env: { FRAMELENS_HOME: home }, platform: "win32", arch: "x64", asset: asset() });
    expect(readdirSync(dir).sort()).toEqual([live, "ffmpeg.exe", "ffprobe.exe"].sort());
    expect(cleanStalePartials(join(home, "nowhere"))).toEqual([]);
  });

  it("clears a killed session's partial file even when another session already finished the install", async () => {
    const env = { FRAMELENS_HOME: home };
    await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() });
    const left = `.download-${DEAD_PID}-deadbeef.zip`;
    writeFileSync(join(pinnedDir(), left), "half an archive");
    requests.length = 0;
    expect((await prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset() })).downloaded).toBe(false);
    expect(requests).toEqual([]);
    expect(readdirSync(pinnedDir()).sort()).toEqual(["ffmpeg.exe", "ffprobe.exe"]);
    // The server's own lookup of the pinned binary clears it too (it does not call prepareFfmpeg then).
    writeFileSync(join(pinnedDir(), left), "half an archive");
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform: "win32", arch: "x64", intact: () => true });
    expect((await setup.locate("ffmpeg")).source).toBe("pinned");
    expect(readdirSync(pinnedDir()).sort()).toEqual(["ffmpeg.exe", "ffprobe.exe"]);
  });

  it("lets two installs run at once without either one breaking the other, and never deletes a good binary", async () => {
    const env = { FRAMELENS_HOME: home };
    const results = await Promise.all([
      prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset(`${base}/slow.zip`) }),
      prepareFfmpeg({ env, platform: "win32", arch: "x64", asset: asset(`${base}/slow.zip`) }),
    ]);
    expect(results.map((r) => r.ffmpeg)).toEqual([results[0]!.ffmpeg, results[0]!.ffmpeg]);
    expect(readFileSync(results[0]!.ffmpeg)).toEqual(ffmpegBody);
    expect(readFileSync(results[0]!.ffprobe)).toEqual(ffprobeBody);
    expect(readdirSync(pinnedDir()).sort()).toEqual(["ffmpeg.exe", "ffprobe.exe"]);
  });

  it("keeps a target that is already right and drops the new copy; replaces a wrong one in one step", () => {
    const dir = join(home, "place");
    mkdirSync(dir);
    const target = join(dir, "tool");
    writeFileSync(target, "good");
    writeFileSync(join(dir, "a.part"), "good");
    expect(placeVerified(join(dir, "a.part"), target, sha("good"))).toBe("kept");
    writeFileSync(target, "bad");
    writeFileSync(join(dir, "b.part"), "good");
    expect(placeVerified(join(dir, "b.part"), target, sha("good"))).toBe("placed");
    expect(readFileSync(target, "utf8")).toBe("good");
    expect(readdirSync(dir)).toEqual(["tool"]);
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

describe("pinned yt-dlp downloads", () => {
  const yt = { platform: "win32" as const, arch: "x64", expectedSha256: sha("pretend-yt-dlp-binary") };

  it("caps the download size and runs two installs at once safely", async () => {
    await expect(prepareYtDlp({ ...yt, env: { FRAMELENS_HOME: home }, baseUrl: `${base}/big` })).rejects.toThrow(/larger than the pinned file/);
    const env = { FRAMELENS_HOME: home };
    const both = await Promise.all([prepareYtDlp({ ...yt, env, baseUrl: `${base}/yt` }), prepareYtDlp({ ...yt, env, baseUrl: `${base}/yt` })]);
    expect(readFileSync(both[0].path, "utf8")).toBe("pretend-yt-dlp-binary");
    expect(readdirSync(join(both[0].path, ".."))).toEqual(["yt-dlp.exe"]);
    expect(both[0].path).toContain(YTDLP_PIN.version);
  });
});

describe("automatic setup", () => {
  const exe = process.platform === "win32" ? ".exe" : "";
  const platform = process.platform === "win32" ? "win32" : "linux";
  const fakeInstall = (calls: string[], body = "good") => async () => {
    calls.push("ffmpeg");
    await new Promise((r) => setTimeout(r, 20));
    const dir = pinnedDir();
    mkdirSync(dir, { recursive: true });
    for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(dir, `${t}${exe}`), body, { mode: 0o755 });
    return { ffmpeg: join(dir, "ffmpeg"), ffprobe: join(dir, "ffprobe"), version: FFMPEG_PIN.version, source: "test", downloaded: true };
  };
  // Stands in for the real hash check: a pinned file counts as intact when it holds "good".
  const intact = (l: { path: string }) => readFileSync(l.path, "utf8") === "good";

  it("is on unless FRAMELENS_AUTO_INSTALL turns it off", () => {
    expect(autoInstallEnabled({})).toBe(true);
    expect(autoInstallEnabled({ FRAMELENS_AUTO_INSTALL: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", "no"]) expect(autoInstallEnabled({ FRAMELENS_AUTO_INSTALL: off })).toBe(false);
  });

  it("installs a missing ffmpeg once for parallel calls and notes it on each call that waited for it, and only those", async () => {
    const calls: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform, arch: "x64", prepareFfmpeg: fakeInstall(calls), intact });
    const [a, b, other] = await Promise.all([
      collectSetupNotes(() => setup.locate("ffmpeg")),
      collectSetupNotes(() => setup.locate("ffprobe")),
      collectSetupNotes(async () => "a tool that needed nothing"),
    ]);
    expect(calls).toEqual(["ffmpeg"]);
    expect(a.value.source).toBe("pinned");
    expect(b.value.path).toMatch(/ffprobe/);
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0]).toMatch(/downloaded FFmpeg .* and continued\. FRAMELENS_AUTO_INSTALL=0 turns this off/);
    expect(b.notes).toEqual(a.notes);
    expect(other.notes).toEqual([]);
    // A later call finds it installed and gets no note.
    expect((await collectSetupNotes(() => setup.locate("ffmpeg"))).notes).toEqual([]);
  });

  it("does not trust a pinned binary whose hash is wrong: it installs again", async () => {
    mkdirSync(pinnedDir(), { recursive: true });
    for (const t of ["ffmpeg", "ffprobe"]) writeFileSync(join(pinnedDir(), `${t}${exe}`), "tampered", { mode: 0o755 });
    const calls: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform, arch: "x64", prepareFfmpeg: fakeInstall(calls), intact });
    expect(setup.startPath("ffmpeg")).toBe("ffmpeg");
    expect(readFileSync((await setup.locate("ffmpeg")).path, "utf8")).toBe("good");
    expect(calls).toEqual(["ffmpeg"]);
    // With the real check, a file that is not the pinned build is never accepted.
    const real = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform, arch: "x64", prepareFfmpeg: fakeInstall([], "still not the pinned build") });
    await expect(real.locate("ffprobe")).rejects.toThrow(/not installed/);
  });

  it("does not download when FRAMELENS_AUTO_INSTALL=0, and says how to get the tool", async () => {
    const calls: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "", FRAMELENS_AUTO_INSTALL: "0" }, platform: "linux", arch: "x64", prepareFfmpeg: fakeInstall(calls) });
    await expect(setup.locate("ffmpeg")).rejects.toThrow(/doctor --prepare.*Automatic setup is off/s);
    expect(calls).toEqual([]);
  });

  it("explains a failed download, and installs yt-dlp the same way", async () => {
    const failing = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform: "linux", arch: "x64", prepareFfmpeg: async () => Promise.reject(new Error("offline")) });
    const failed = await collectSetupNotes(() => failing.locate("ffmpeg")).catch((e) => e);
    expect(failed.message).toMatch(/downloading the pinned build failed: offline/);
    const ytCalls: string[] = [];
    const setup = new ToolSetup({
      env: { FRAMELENS_HOME: home, PATH: "" },
      platform: "linux",
      arch: "x64",
      intact,
      prepareYtDlp: async () => {
        ytCalls.push("yt-dlp");
        const path = join(home, "tools", "yt-dlp", YTDLP_PIN.version, "yt-dlp");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "good", { mode: 0o755 });
        return { path, version: YTDLP_PIN.version, downloaded: true };
      },
    });
    const { value, notes } = await collectSetupNotes(() => setup.locate("yt-dlp"));
    expect(value.source).toBe("pinned");
    expect(ytCalls).toEqual(["yt-dlp"]);
    expect(notes[0]).toMatch(/downloaded yt-dlp/);
  });

  it("resolves the bare program names the engine uses when nothing was found at start", async () => {
    const seen: string[] = [];
    const setup = new ToolSetup({ env: { FRAMELENS_HOME: home, PATH: "" }, platform, arch: "x64", prepareFfmpeg: fakeInstall([]), intact });
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

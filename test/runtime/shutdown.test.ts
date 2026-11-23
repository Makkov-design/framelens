import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../media/fixtures.js";

// The real server over stdio, built from the current source: how it ends when the client goes away.
const fake = resolve("test/fixtures/fake-ytdlp.mjs");
const LINK = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

let dir: string;
let bundle: string;
beforeAll(async () => {
  dir = tempDir();
  bundle = join(dir, "server.mjs");
  await build({
    entryPoints: ["src/index.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: 'import { createRequire as __r } from "node:module"; const require = __r(import.meta.url);' },
    logLevel: "error",
  });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 50));
  return check();
};

function start(name: string, delayMs: number): { server: ChildProcess; pids: string; responses: () => { id?: number }[]; exited: Promise<number | null> } {
  const cwd = join(dir, name);
  mkdirSync(cwd, { recursive: true });
  const pids = join(cwd, "pids.txt");
  const server = spawn(process.execPath, [bundle], {
    cwd,
    env: {
      ...process.env,
      FRAMELENS_YTDLP: fake,
      FRAMELENS_FFMPEG: fake,
      FRAMELENS_FFPROBE: fake,
      FRAMELENS_AUTO_INSTALL: "0",
      FRAMELENS_HOME: join(cwd, "home"),
      FAKE_YTDLP_DELAY_MS: String(delayMs),
      FAKE_YTDLP_PIDS: pids,
      GEMINI_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let out = "";
  server.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const exited = new Promise<number | null>((done) => server.once("exit", (code, signal) => done(code ?? (signal ? -1 : null))));
  const send = (message: object) => server.stdin!.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe", arguments: { source: LINK } } });
  const responses = () =>
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number });
  return { server, pids, responses, exited };
}

const downloaderPids = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

describe("server shutdown", () => {
  it("answers the calls a client sent before closing stdin, then exits 0 (a piped one-shot client)", async () => {
    const run = start("piped", 1200);
    run.server.stdin!.end();
    const code = await run.exited;
    expect(code).toBe(0);
    // Every request got its answer, the call that was still downloading included (an error here: the fake ffprobe).
    expect(run.responses().map((r) => r.id).sort()).toEqual([1, 2, 3]);
    for (const pid of downloaderPids(run.pids)) expect(alive(pid)).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === "win32")("kills a running download with its process group on SIGTERM and exits 143", async () => {
    const run = start("sigterm", 60_000);
    expect(await until(() => downloaderPids(run.pids).length >= 2, 15_000)).toBe(true);
    const pids = downloaderPids(run.pids);
    run.server.kill("SIGTERM");
    expect(await run.exited).toBe(143);
    expect(await until(() => pids.every((pid) => !alive(pid)), 5_000)).toBe(true);
  }, 30_000);
});

describe("server shutdown when the client is gone", () => {
  it("exits and stops the download when the client dies with both pipes closed during a call", async () => {
    const cwd = join(dir, "orphan");
    mkdirSync(cwd, { recursive: true });
    const pids = join(cwd, "pids.txt");
    // A stand-in client: starts the server, sends a call whose download takes a minute, then dies. Nobody reads the
    // answer any more, so the server must not run on until the download's own limit.
    const client = `
      const { spawn } = require("node:child_process");
      const server = spawn(process.execPath, [${JSON.stringify(bundle)}], { cwd: ${JSON.stringify(cwd)}, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env,
        FRAMELENS_YTDLP: ${JSON.stringify(fake)}, FRAMELENS_FFMPEG: ${JSON.stringify(fake)}, FRAMELENS_FFPROBE: ${JSON.stringify(fake)}, FRAMELENS_AUTO_INSTALL: "0",
        FRAMELENS_HOME: ${JSON.stringify(join(cwd, "home"))}, FAKE_YTDLP_DELAY_MS: "60000", FAKE_YTDLP_PIDS: ${JSON.stringify(pids)}, GEMINI_API_KEY: "" } });
      const send = (m) => server.stdin.write(JSON.stringify(m) + "\\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "probe", arguments: { source: ${JSON.stringify(LINK)} } } });
      process.stdout.write(String(server.pid) + "\\n");
      setTimeout(() => process.exit(0), 2500);
    `;
    const parent = spawn(process.execPath, ["-e", client], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    parent.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((done) => parent.once("exit", done));
    const serverPid = Number(out.trim());
    expect(serverPid).toBeGreaterThan(0);
    expect(await until(() => !alive(serverPid), 10_000)).toBe(true);
    const children = downloaderPids(pids);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(await until(() => children.every((pid) => !alive(pid)), 5_000)).toBe(true);
  }, 30_000);

  it("kills the children it started from the exit handler (taskkill on Windows, the process group elsewhere)", async () => {
    const entry = join(dir, "exit-entry.ts");
    writeFileSync(
      entry,
      `import { PassThrough } from "node:stream";
       import { installChildCleanup, spawnTracked } from ${JSON.stringify(resolve("src/tools/children.ts"))};
       installChildCleanup(undefined, new PassThrough(), new PassThrough());
       const child = spawnTracked(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
       process.stdout.write(String(child.pid) + "\\n");
       setTimeout(() => process.exit(0), 500);`,
    );
    const script = join(dir, "exit-entry.mjs");
    await build({ entryPoints: [entry], outfile: script, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "error" });
    const runner = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    runner.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const code = await new Promise<number | null>((done) => runner.once("exit", done));
    expect(code).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
  }, 30_000);
});

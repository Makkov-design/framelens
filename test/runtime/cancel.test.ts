import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoAnalyzer } from "../../src/analyzer.js";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { execTool, formatLimit } from "../../src/media/exec.js";
import { CancelledError, mcpCallContext, withCall } from "../../src/runtime/call.js";
import { createServer } from "../../src/server.js";
import { motionProfile } from "../../src/style/motion.js";
import { runningChildren } from "../../src/tools/children.js";
import { run } from "../../src/tools/run.js";
import { hasDrawtext } from "../../src/media/sheets.js";
import { existsSync as exists } from "node:fs";
import { Workspace } from "../../src/workspace/workspace.js";
import { callSignal, singleFlight } from "../../src/runtime/call.js";
import { decodeGray } from "../../src/track/decode.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const node = process.execPath;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
  return check();
};

describe("external programs follow the tool call", () => {
  it("stops a program when the call is cancelled, with its own children (the process group)", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "grandchild.pid");
    // The program starts a grandchild (as yt-dlp starts ffmpeg) and waits.
    const script = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setTimeout(() => {}, 60000);`;
    const controller = new AbortController();
    const pending = withCall({ signal: controller.signal }, () => execTool(node, ["-e", script]));
    let grandchild = 0;
    await until(() => {
      try {
        grandchild = Number(readFileSync(pidFile, "utf8"));
      } catch {
        // not yet
      }
      return grandchild > 0;
    });
    expect(grandchild).toBeGreaterThan(0);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(runningChildren()).toBe(0);
    if (process.platform !== "win32") expect(await until(() => !alive(grandchild))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says a program hit its time limit, and which limit, instead of reporting a failed command", async () => {
    const error = await execTool(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/hit the 300 ms time limit for this step and was stopped/);
    expect(runningChildren()).toBe(0);
    expect(formatLimit(10 * 60_000)).toBe("10 min");
    expect(formatLimit(90 * 60_000)).toBe("90 min");
    expect(formatLimit(150 * 60_000)).toBe("2 h 30 min");
  });

  it("fails rather than return output it had to cut off (64 MiB per stream)", async () => {
    const error = await execTool(node, ["-e", "process.stdout.write(Buffer.alloc(65 * 1024 * 1024, 97))"]).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/wrote more than 64 MiB of output/);
  });

  it("settles when the program exits even if a descendant outside its group holds the pipes", async () => {
    // The descendant leaves the process group (detached: a new session on POSIX) and keeps stdout open.
    const script = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] }).unref(); process.exit(0);`;
    const started = Date.now();
    const result = await run(node, ["-e", script], { timeoutMs: 15_000 });
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Said, not silent: what the descendant writes from here on is missing.
    expect(result.heldOpen).toBe(true);
    expect((await run(node, ["-e", "0"])).heldOpen).toBeUndefined();
  });

  it("does not start a program for a call that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withCall({ signal: controller.signal }, () => execTool(node, ["-e", "0"]))).rejects.toBeInstanceOf(CancelledError);
  });

  it("caches nothing under a cancelled call: no workspace file, no memoized ffmpeg answer", async () => {
    const dir = tempDir();
    const ws = new Workspace(dir, "file-test");
    const controller = new AbortController();
    controller.abort();
    await expect(withCall({ signal: controller.signal }, async () => ws.writeJson("boundaries-x.json", { candidates: [] }))).rejects.toBeInstanceOf(CancelledError);
    expect(exists(ws.path("boundaries-x.json"))).toBe(false);
    // hasDrawtext: the one shared check runs outside any call. A cancelled caller stops waiting; the check itself is
    // not cancelled, so another call sharing it (and every later one) gets the real answer.
    let checks = 0;
    let release!: () => void;
    const slow = new Promise<void>((done) => (release = done));
    // Like the real exec, the fake stops when the call it runs in is cancelled: only a check outside any call survives.
    let ranInCall = false;
    const tools = {
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      exec: async () => {
        checks++;
        const signal = callSignal();
        ranInCall ||= signal !== undefined;
        await Promise.race([slow, new Promise((_, fail) => signal?.addEventListener("abort", () => fail(new CancelledError("ffmpeg"))))]);
        return { stdout: " .. drawtext  V->V  Draw text\n", stderr: "" };
      },
    };
    const cancelling = new AbortController();
    const cancelled = withCall({ signal: cancelling.signal }, () => hasDrawtext(tools));
    const other = withCall({ signal: new AbortController().signal }, () => hasDrawtext(tools));
    cancelling.abort();
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
    release();
    expect(await other).toBe(true);
    expect(await hasDrawtext(tools)).toBe(true);
    expect(checks).toBe(1);
    expect(ranInCall).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("singleFlight: waiters share the run, a cancelled waiter leaves at once, a cancelled leader is run again by a waiter", async () => {
    const flights = new Map();
    let runs = 0;
    const work = (ms: number) => () => new Promise<string>((done) => {
      runs++;
      setTimeout(() => done(`run ${runs}`), ms);
    });
    const [a, b] = await Promise.all([singleFlight(flights, "k", undefined, work(100)), singleFlight(flights, "k", undefined, work(100))]);
    expect([a.shared, b.shared].sort()).toEqual([false, true]);
    expect(runs).toBe(1);
    const leader = new AbortController();
    const cancellable = () => new Promise<string>((done, fail) => {
      runs++;
      const t = setTimeout(() => done("done"), 300);
      leader.signal.addEventListener("abort", () => {
        clearTimeout(t);
        fail(new CancelledError());
      });
    });
    const first = singleFlight(flights, "j", leader.signal, cancellable);
    const waiter = singleFlight(flights, "j", undefined, work(50));
    leader.abort();
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    expect((await waiter).shared).toBe(false);
  });

  it("sends progress only when the client asked for it, with a heartbeat while a step runs", async () => {
    const sent: { progress: number; message?: string }[] = [];
    const extra = { signal: new AbortController().signal, _meta: { progressToken: "t1" }, sendNotification: async (n: { params: { progress: number; message?: string } }) => void sent.push(n.params) };
    const call = mcpCallContext("style", extra, 50);
    call.context.progress?.("boundaries: 3 changes");
    await new Promise((done) => setTimeout(done, 130));
    call.stop();
    expect(sent[0]).toEqual({ progressToken: "t1", progress: 1, message: "style: started" });
    expect(sent[1]?.message).toBe("style: boundaries: 3 changes");
    expect(sent.slice(2).every((p) => /still working, \d+ s\)$/.test(p.message ?? ""))).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    // Increasing progress values, as the protocol requires.
    expect(sent.map((p) => p.progress)).toEqual(sent.map((_, i) => i + 1));
    // Nothing after the call has ended (shared work started inside it can still log).
    const count = sent.length;
    call.context.progress?.("late line");
    expect(sent.length).toBe(count);
    const silent = mcpCallContext("style", { ...extra, _meta: {} }, 50);
    silent.context.progress?.("x");
    silent.stop();
    expect(silent.context.progress).toBeUndefined();
  });
});

const tools = mediaTools();

describe.skipIf(!tools)("ffmpeg pipes and tools over MCP", () => {
  let dir: string;
  let video: string;
  let client: Client;

  beforeAll(async () => {
    dir = tempDir();
    video = join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x36:r=10:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const noGemini: VideoAnalyzer = { model: "none", analyze: async () => Promise.reject(new Error("not used")), listModels: async () => [] };
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const server = createServer({ analyzer: noGemini, logger: silentLogger, engine });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "test", version: "0" });
    await client.connect(a);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stops the decoding pipes of style and track when the call is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const range = { start: 0, end: 3 };
    await expect(withCall({ signal: controller.signal }, () => motionProfile(video, tools!, range, { expectedFrames: 30 }))).rejects.toBeInstanceOf(CancelledError);
    await expect(withCall({ signal: controller.signal }, () => decodeGray(video, tools!, range, { width: 64, height: 36 }, { maxFrames: 100, fps: 10 }))).rejects.toBeInstanceOf(CancelledError);
    expect(runningChildren()).toBe(0);
  });

  it("sends MCP progress notifications to a client that passed a progress token", async () => {
    const messages: string[] = [];
    const result = await client.callTool({ name: "boundaries", arguments: { source: video, rate: 4 } }, CallToolResultSchema, {
      onprogress: (p) => messages.push(p.message ?? ""),
    });
    expect(result.isError).toBeFalsy();
    expect(messages[0]).toBe("boundaries: started");
    expect(messages.some((m) => /^boundaries: (probed|boundaries):/.test(m))).toBe(true);
  });

  it("answers a cancelled call and leaves no program running", async () => {
    const controller = new AbortController();
    const pending = client.callTool({ name: "style", arguments: { source: video } }, CallToolResultSchema, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow();
    expect(await until(() => runningChildren() === 0)).toBe(true);
  });
});

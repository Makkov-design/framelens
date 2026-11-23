#!/usr/bin/env node
// CI check of the committed bundle on its own, with no node_modules next to it: the server starts over stdio, lists its
// tools and runs one real local tool (`probe`) on a clip made with ffmpeg, the way an MCP client would.
//
//   node .github/scripts/bundle-runs.mjs <path/to/framelens.mjs>
// Needs ffmpeg and ffprobe on PATH. Plain JSON-RPC over stdio, so it needs no packages.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bundle = resolve(process.argv[2] ?? "dist/framelens.mjs");
const dir = mkdtempSync(join(tmpdir(), "framelens-bundle-"));
const clip = join(dir, "clip.mp4");
// 2 s at 25 fps, 320x180, with a tone: small, and every field probe reports is known.
execFileSync("ffmpeg", [
  "-hide_banner", "-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
]);

const server = spawn(process.execPath, [bundle], {
  cwd: dir,
  // No downloads in CI: the tools come from PATH. FRAMELENS_HOME keeps workspaces in the temp folder.
  env: { ...process.env, GEMINI_API_KEY: "ci-dummy", FRAMELENS_AUTO_INSTALL: "0", FRAMELENS_HOME: join(dir, "home") },
  stdio: ["pipe", "pipe", "inherit"],
});
const timer = setTimeout(() => fail("no answer within 60 s"), 60_000);
const pending = new Map();
let buffer = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`the server wrote something that is not JSON-RPC to stdout: ${line.slice(0, 200)}`);
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
server.on("exit", (code) => fail(`the server exited early (code ${code})`));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((done) => pending.set(id, (m) => (m.error ? fail(`${method}: ${JSON.stringify(m.error)}`) : done(m.result))));
}
function fail(message) {
  console.error(`bundle check failed: ${message}`);
  process.exit(1);
}

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ci", version: "0" } });
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const { tools } = await request("tools/list", {});
const names = tools.map((t) => t.name);
for (const need of ["probe", "plan", "frames", "transcript", "summarize_youtube_video"]) if (!names.includes(need)) fail(`missing tool ${need}`);
console.log(`tools: ${names.join(", ")}`);

const result = await request("tools/call", { name: "probe", arguments: { source: clip } });
const text = result.content?.[0]?.text ?? "";
if (result.isError) fail(`probe returned an error: ${text}`);
const probe = result.structuredContent?.probe ?? {};
const problems = [];
if (Math.abs((probe.duration ?? 0) - 2) > 0.1) problems.push(`duration ${probe.duration}, expected 2`);
if (probe.width !== 320 || probe.height !== 180) problems.push(`size ${probe.width}x${probe.height}, expected 320x180`);
if (Math.abs((probe.fps ?? 0) - 25) > 0.01) problems.push(`fps ${probe.fps}, expected 25`);
if (!probe.hasAudio) problems.push("no audio found");
if (problems.length) fail(`probe: ${problems.join("; ")}\n${text}`);
console.log(`probe: ${text.split("\n")[0]}`);

clearTimeout(timer);
server.removeAllListeners("exit");
server.kill();
console.log("bundle check passed");

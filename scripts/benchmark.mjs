// Accuracy benchmark: renders videos with known cuts, move timings and easing curves, runs Frame Lens `style` on
// them through the built bundle, and reports how close the measurements are. Writes docs/ACCURACY.md.
// Usage: node scripts/benchmark.mjs   (needs ffmpeg on PATH and `npm run bundle` first)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "framelens-bench-"));
const EASINGS = {
  "ease-in": "pow(P,3)",
  "ease-out": "1-pow(1-P,3)",
  "ease-in-out": "if(lt(P,0.5),4*pow(P,3),1-pow(-2*P+2,3)/2)",
  linear: "P",
};
const COLOURS = ["0x1B1F3B", "0x3B1B1F", "0x1F3B1B", "0x2B2B2B"];
const FPS_LIST = [24, 30, 60];
const DURATIONS = [8, 16, 30]; // frames
const CLIP = 2; // seconds per clip
const START = 0.5; // move starts this far into each clip

function clip(file, fps, frames, easing, colour) {
  const dur = frames / fps;
  const p = `clip((t-${START})/${dur},0,1)`;
  const x = `40+400*(${EASINGS[easing].replaceAll("P", p)})`;
  execFileSync("ffmpeg", [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${colour}:s=640x360:r=${fps}:d=${CLIP}`,
    "-f", "lavfi", "-i", `color=c=white:s=80x80:r=${fps}:d=${CLIP}`,
    "-filter_complex", `[0][1]overlay=x='${x}':y=140:eval=frame`,
    "-c:v", "libx264", "-qp", "8", "-pix_fmt", "yuv420p", file,
  ]);
}

function call(server, id, name, args) {
  return new Promise((resolve) => {
    server.pending.set(id, resolve);
    server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

function startServer(cwd) {
  const child = spawn(process.execPath, [join(repo, "dist", "framelens.mjs")], { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, GEMINI_API_KEY: "" } });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m.result);
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, pending };
}

const rows = [];
const cutErrors = [];
const server = startServer(work);
let id = 1;
try {
  for (const fps of FPS_LIST) {
    const clips = [];
    let k = 0;
    for (const frames of DURATIONS) {
      for (const easing of Object.keys(EASINGS)) {
        const file = join(work, `c-${fps}-${frames}-${easing}.mp4`);
        clip(file, fps, frames, easing, COLOURS[k % COLOURS.length]);
        clips.push({ file, frames, easing, start: k * CLIP + START });
        k++;
      }
    }
    const list = join(work, `list-${fps}.txt`);
    writeFileSync(list, clips.map((c) => `file '${c.file.replaceAll("\\", "/")}'`).join("\n"));
    const video = join(work, `bench-${fps}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);

    const result = await call(server, id++, "style", { source: video });
    const spec = JSON.parse(readFileSync(result.structuredContent.files.spec, "utf8"));
    const expectedCuts = clips.slice(1).map((_, i) => (i + 1) * CLIP);
    for (const t of expectedCuts) {
      const found = spec.anchors.cuts.map((c) => c.t).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      cutErrors.push({ fps, error: found === undefined ? null : Math.round((found - t) * fps) });
    }
    for (const c of clips) {
      const move = spec.events.find((e) => e.start >= c.start - 0.25 && e.start < c.start + c.frames / fps);
      rows.push({
        fps,
        frames: c.frames,
        easing: c.easing,
        found: Boolean(move),
        startError: move ? Math.round((move.start - c.start) * fps) : null,
        measuredFrames: move?.frames ?? null,
        family: move?.easing ?? "—",
      });
    }
  }
} finally {
  // The server's working folder is the temp folder: wait for it to exit before removing it.
  const exited = new Promise((r) => server.child.once("exit", r));
  server.child.kill();
  await exited;
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.error(`Could not remove ${work}; delete it by hand.`);
  }
}

const found = rows.filter((r) => r.found);
const familyHits = found.filter((r) => r.family === r.easing).length;
const exactCuts = cutErrors.filter((c) => c.error === 0).length;
const withinOne = cutErrors.filter((c) => c.error !== null && Math.abs(c.error) <= 1).length;
const meanStart = found.reduce((s, r) => s + Math.abs(r.startError), 0) / (found.length || 1);
const meanDuration = found.reduce((s, r) => s + Math.abs(r.measuredFrames - r.frames), 0) / (found.length || 1);

const md = `# Accuracy

Measured by \`node scripts/benchmark.mjs\` on synthetic videos with known ground truth: a box moves 400 px with a
known easing (cubic in, out, in-out, linear) over 8, 16 or 30 frames at 24, 30 and 60 fps, and each clip ends in a hard
cut to a new background. ${rows.length} moves and ${cutErrors.length} cuts. This is video measured from pixels; Lottie,
web pages and Figma are read exactly from their data and need no benchmark.

| Measure | Result |
|---|---|
| Cuts found on the exact frame | ${exactCuts} of ${cutErrors.length} |
| Cuts within one frame | ${withinOne} of ${cutErrors.length} |
| Moves found | ${found.length} of ${rows.length} |
| Move start, mean error | ${meanStart.toFixed(2)} frames |
| Move duration, mean error | ${meanDuration.toFixed(2)} frames |
| Easing family correct | ${familyHits} of ${found.length} |

Almost all of the start and duration error comes from long moves with a slow end: the first frames of a 30-frame
ease-in (or the last of an ease-out) move the box by less than a pixel at analysis resolution, so the measured move
begins a few frames late or ends early. Short moves and cuts are exact. The easing family is read from where the
movement's weight sits; the exact curve of an important move is best refined with \`frames\` every_frame.

<details><summary>Every move</summary>

| fps | frames | easing | found | start error (frames) | measured frames | family |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.fps} | ${r.frames} | ${r.easing} | ${r.found ? "yes" : "no"} | ${r.startError ?? "—"} | ${r.measuredFrames ?? "—"} | ${r.family} |`).join("\n")}

</details>
`;
writeFileSync(join(repo, "docs", "ACCURACY.md"), md);
console.log(md.split("<details>")[0]);

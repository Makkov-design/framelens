// Accuracy benchmark: renders videos with known cuts, move timings and easing curves, runs Frame Lens `style` on
// them through the built bundle, and reports how close the measurements are. Then renders a square moving with known
// cubic-beziers and springs (clean, noisy, on a busy background) and checks the curves `track` fits. Writes
// docs/ACCURACY.md.
// Usage: node scripts/benchmark.mjs   (needs ffmpeg on PATH and `npm run bundle` first)
//        node scripts/benchmark.mjs --track-only   (only the `track` clips; prints, writes nothing)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bezierAt, clipFrames, encode, springAt } from "./synth.mjs";

const TRACK_ONLY = process.argv.includes("--track-only");
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

// Known curves for `track`. Each clip: 0.4 s of rest, the move, then rest until it has settled.
const TRACK_CURVES = [
  { name: "ease", kind: "bezier", bezier: [0.25, 0.1, 0.25, 1] },
  { name: "ease-in-out", kind: "bezier", bezier: [0.42, 0, 0.58, 1] },
  { name: "custom", kind: "bezier", bezier: [0.7, 0.1, 0.2, 0.95] },
  { name: "overshoot (back-out)", kind: "bezier", bezier: [0.34, 1.56, 0.64, 1] },
  { name: "spring 170/12 (bouncy)", kind: "spring", stiffness: 170, damping: 12 },
  { name: "spring 100/10 (Remotion default)", kind: "spring", stiffness: 100, damping: 10 },
];
const TRACK_CONDITIONS = [
  { name: "clean", noise: 0, busy: false },
  { name: "noise σ=4", noise: 4, busy: false },
  { name: "busy background + noise σ=3", noise: 3, busy: true },
];
const MOVE_SECONDS = 0.5; // bezier moves
const REST = 0.4;

async function trackClip(file, fps, curve, condition) {
  const startFrame = Math.round(REST * fps);
  const moveFrames = Math.round(MOVE_SECONDS * fps);
  const seconds = curve.kind === "spring" ? 2 : REST + MOVE_SECONDS + 0.5;
  const progress = curve.kind === "spring" ? (i) => springAt(curve.stiffness, curve.damping, (i - startFrame) / fps) : (i) => bezierAt(curve.bezier, (i - startFrame) / moveFrames);
  await encode(file, clipFrames({ total: Math.round(seconds * fps), progress, from: [120, 180], to: [500, 180], size: 70, busy: condition.busy, noise: condition.noise, seed: fps }), { fps, timeoutMs: 120_000 });
  return { startFrame, moveFrames, seconds };
}

const rows = [];
const cutErrors = [];
const trackRows = [];
const server = startServer(work);
let id = 1;
try {
  for (const fps of TRACK_ONLY ? [] : FPS_LIST) {
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

  for (const fps of FPS_LIST) {
    for (const condition of TRACK_CONDITIONS) {
      for (const curve of TRACK_CURVES) {
        const file = join(work, `t-${fps}-${condition.noise}-${condition.busy ? "busy" : "plain"}-${curve.name.replace(/\W+/g, "_")}.mp4`);
        const truth = await trackClip(file, fps, curve, condition);
        const result = await call(server, id++, "track", { source: file, start: 0, end: truth.seconds });
        const track = result?.structuredContent?.track;
        const x = track?.properties?.find((p) => p.property === "x");
        const row = { fps, condition: condition.name, curve: curve.name, expected: curve.kind, kind: x?.curve.kind ?? "none", startError: x ? (x.start * fps - truth.startFrame) : null };
        if (x && curve.kind === "bezier") {
          row.durationError = x.frames - truth.moveFrames;
          row.controlError = x.curve.kind === "bezier" ? Math.max(...x.curve.bezier.map((c, i) => Math.abs(c - curve.bezier[i]))) : null;
          row.fitted = x.curve.kind === "bezier" ? `cubic-bezier(${x.curve.bezier.join(", ")})` : x.curve.kind;
        }
        if (x && curve.kind === "spring") {
          row.stiffnessError = x.curve.kind === "spring" ? Math.abs(x.curve.stiffness - curve.stiffness) / curve.stiffness : null;
          row.dampingError = x.curve.kind === "spring" ? Math.abs(x.curve.damping - curve.damping) / curve.damping : null;
          row.fitted = x.curve.kind === "spring" ? `stiffness ${x.curve.stiffness}, damping ${x.curve.damping}` : x.curve.kind;
        }
        row.rmse = x?.rmse ?? null;
        trackRows.push(row);
        console.error(`track ${fps} fps, ${condition.name}, ${curve.name}: ${row.fitted ?? row.kind}`);
      }
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

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const max = (xs) => (xs.length ? Math.max(...xs) : NaN);
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : "—");
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : "—");
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)} %` : "—");
const trackSummary = TRACK_CONDITIONS.map((c) => {
  const all = trackRows.filter((r) => r.condition === c.name);
  const bez = all.filter((r) => r.expected === "bezier" && r.kind === "bezier");
  const spr = all.filter((r) => r.expected === "spring" && r.kind === "spring");
  const timed = all.filter((r) => r.startError !== null);
  const durations = all.filter((r) => r.durationError !== undefined && r.durationError !== null).map((r) => Math.abs(r.durationError));
  return `| ${c.name} | ${all.filter((r) => r.kind === r.expected).length} of ${all.length} | ${f3(mean(bez.map((r) => r.controlError)))} / ${f3(max(bez.map((r) => r.controlError)))} | ${f2(mean(durations))} / ${f2(max(durations))} | ${f2(mean(timed.map((r) => Math.abs(r.startError))))} / ${f2(max(timed.map((r) => Math.abs(r.startError))))} | ${pct(mean(spr.map((r) => r.stiffnessError)))} / ${pct(mean(spr.map((r) => r.dampingError)))} |`;
});

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
movement's weight sits; the exact curve of an important move is measured with \`track\` (below).

<details><summary>Every move</summary>

| fps | frames | easing | found | start error (frames) | measured frames | family |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.fps} | ${r.frames} | ${r.easing} | ${r.found ? "yes" : "no"} | ${r.startError ?? "—"} | ${r.measuredFrames ?? "—"} | ${r.family} |`).join("\n")}

</details>

## Tracked curves (\`track\`)

A 70×70 px square on a 640×360 frame travels 380 px with a known timing curve: four cubic-beziers (CSS \`ease\`,
\`ease-in-out\`, a custom \`cubic-bezier(0.7, 0.1, 0.2, 0.95)\` and an overshooting back-out) over ${MOVE_SECONDS} s, and two
damped springs (stiffness/damping 170/12 and 100/10, mass 1), at 24, 30 and 60 fps. Frames are rendered with
antialiasing and encoded as H.264: clean, with pixel noise, and over a busy textured background with noise. \`track\`
finds the square on its own (\`element: auto\`) and fits its x curve. ${trackRows.length} clips.

| Condition | Model chosen right | Bezier control points, mean / max error | Duration error, mean / max (frames) | Start error, mean / max (frames) | Spring stiffness / damping, mean error |
|---|---|---|---|---|---|
${trackSummary.join("\n")}

Durations and control points are compared for the beziers; a spring is defined by its stiffness and damping, so those
are compared instead (its length on the timeline is the time it takes to settle within 0.5 % of the travel). Targets
for clean renders: duration within one frame, control points within 0.05.

Limits: these renders are a sharp-edged square without motion blur, moving in a straight line over a static
background. Real footage adds motion blur, rotation, occlusion, a moving camera and elements that change shape; the
tracker follows position, size and brightness only, and the fit error it reports for each property is the honest
measure of how well the curve explains that footage.

<details><summary>Every tracked clip</summary>

| fps | condition | curve | chosen | fitted | control error | duration error (frames) | start error (frames) | fit error |
|---|---|---|---|---|---|---|---|---|
${trackRows.map((r) => `| ${r.fps} | ${r.condition} | ${r.curve} | ${r.kind} | ${r.fitted ?? "—"} | ${f3(r.controlError ?? NaN)} | ${f2(r.durationError ?? NaN)} | ${f2(r.startError ?? NaN)} | ${pct(r.rmse ?? NaN)} |`).join("\n")}

</details>
`;
if (!TRACK_ONLY) writeFileSync(join(repo, "docs", "ACCURACY.md"), md);
console.log(md.split("<details>")[0]);
console.log(["| Condition | Model | Control mean / max | Duration mean / max | Start mean / max | Spring k / c |", "|---|---|---|---|---|---|", ...trackSummary].join("\n"));

// Accuracy benchmark: renders videos with known cuts, move timings and easing curves, runs Frame Lens `style` on
// them through the built bundle, and reports how close the measurements are. Then renders dissolves, dips and wipes
// with known boundaries for the transitions `style` reports, and a square moving with known cubic-beziers and springs
// (clean, noisy, on a busy background) and checks the curves `track` fits. Writes docs/ACCURACY.md.
// Usage: node scripts/benchmark.mjs   (needs ffmpeg on PATH and `npm run bundle` first)
//        node scripts/benchmark.mjs --track-only   (only the `track` clips; prints, writes nothing)
//        node scripts/benchmark.mjs --transitions-only   (only the montage and transition clips; prints, writes nothing)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bezierAt, busyBackground, clipFrames, encode, springAt } from "./synth.mjs";

const TRACK_ONLY = process.argv.includes("--track-only");
const TRANSITIONS_ONLY = process.argv.includes("--transitions-only");
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

// Gradual transitions with known boundaries, between two still test pictures and between two moving ones. Each clip:
// 1 s of the first picture, the transition, then the second picture. Encoded near-losslessly like the cut clips.
const TRANSITION_KINDS = [
  { name: "dissolve", kind: "dissolve", xfade: "fade" },
  { name: "dip through black", kind: "dip", via: "black" },
  { name: "dip through white", kind: "dip", via: "white" },
  { name: "wipe left", kind: "wipe", xfade: "wipeleft", direction: "left" },
  { name: "wipe down", kind: "wipe", xfade: "wipedown", direction: "down" },
];
const TRANSITION_FRAMES = [12, 24];
const TRANSITION_PICTURES = {
  still: (fps, d) => [`smptehdbars=s=640x360:r=${fps}:d=${d}`, `rgbtestsrc=s=640x360:r=${fps}:d=${d},hue=h=40`],
  moving: (fps, d) => [`testsrc2=s=640x360:r=${fps}:d=${d}`, `mandelbrot=s=640x360:r=${fps}:end_scale=0.6,trim=duration=${d}`],
};
const LEAD = 1; // seconds of the first picture before the transition

/**
 * Renders one transition clip and returns its truth: the last frame of the first picture (start), the first frame of
 * the second (end), and where the shot boundary belongs (a dissolve's or wipe's halfway frame; a dip's black or white
 * hold, three frames long here).
 */
function transitionClip(file, fps, frames, t, pictures) {
  const seconds = frames / fps;
  const [a, b] = pictures(fps, LEAD + seconds + 1.5);
  const encode = ["-c:v", "libx264", "-qp", "8", "-pix_fmt", "yuv420p", file];
  if (t.kind !== "dip") {
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", a, "-f", "lavfi", "-i", b,
      "-filter_complex", `[0]format=yuv420p,setsar=1[a];[1]format=yuv420p,setsar=1[b];[a][b]xfade=transition=${t.xfade}:duration=${seconds}:offset=${LEAD},format=yuv420p[v]`,
      "-map", "[v]", ...encode,
    ], { timeout: 60_000 });
    return { start: LEAD, end: LEAD + seconds, at: [LEAD + seconds / 2, LEAD + seconds / 2] };
  }
  // Fade out over half the frames, two more frames of the colour, then the second picture fades in from the colour.
  const half = Math.round(frames / 2) / fps;
  const outEnd = LEAD + half + 2 / fps;
  execFileSync("ffmpeg", [
    "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", a, "-f", "lavfi", "-i", b,
    "-filter_complex",
    `[0]format=yuv420p,setsar=1,trim=duration=${outEnd},fade=t=out:st=${LEAD}:d=${half}:color=${t.via}[a];` +
      `[1]format=yuv420p,setsar=1,fade=t=in:st=0:d=${half}:color=${t.via}[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p[v]`,
    "-map", "[v]", ...encode,
  ], { timeout: 60_000 });
  return { start: LEAD, end: outEnd + half, at: [LEAD + half, outEnd] };
}

/**
 * A montage: a 1 s shot, then shots of 2, 3, 2, 3 and 2 frames, then a 1 s shot with a 2-frame white flash in it and a
 * 1 s shot with a 3-frame black flash in it. Every shot is its own textured picture. Returns the frames of the cuts
 * (where a new shot starts) and of the flashes (which are not cuts).
 */
async function montageClip(file, fps) {
  // Each shot: blocks of its own over waves of its own, at its own brightness.
  const picture = (seed) => {
    const bg = busyBackground(640, 360, seed);
    const offset = ((seed * 37) % 90) - 45;
    return Uint8Array.from(bg, (v, i) => {
      const x = i % 640;
      const y = Math.floor(i / 640);
      const wave = 128 + 80 * Math.sin((x * ((seed % 3) + 1)) / 23 + seed) * Math.cos(y / (9 + seed));
      return Math.max(0, Math.min(255, Math.round((v + wave) / 2 + offset)));
    });
  };
  const flat = (v) => new Uint8Array(640 * 360).fill(v);
  const half = Math.round(fps / 2);
  const seven = picture(7);
  const eight = picture(8);
  const plan = [
    [picture(1), fps], [picture(2), 2], [picture(3), 3], [picture(4), 2], [picture(5), 3], [picture(6), 2],
    [seven, half], [flat(250), 2], [seven, half], [eight, half], [flat(5), 3], [eight, half],
  ];
  const startOf = (i) => plan.slice(0, i).reduce((s, p) => s + p[1], 0);
  // New shots start at entries 1–6 and 9; entries 7 and 10 are flashes inside a shot.
  const cuts = [1, 2, 3, 4, 5, 6, 9].map(startOf);
  const flashes = [7, 10].map(startOf);
  function* frames() {
    for (const [frame, n] of plan) for (let k = 0; k < n; k++) yield frame;
  }
  await encode(file, frames(), { fps, timeoutMs: 120_000 });
  return { cuts, flashes };
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

// More kinds of motion, at 30 fps, clean and on a busy background: other directions, y, a diagonal spring, scale,
// opacity, a fade-out, and a window that is mostly rest after the move. All found with `element: auto` unless a box
// is given; `property` is the one compared with the truth.
const VARIETY = [
  { name: "left, custom bezier", property: "x", curve: TRACK_CURVES[2], from: [500, 180], to: [120, 180] },
  { name: "up, ease-in-out", property: "y", curve: TRACK_CURVES[1], from: [320, 300], to: [320, 60] },
  { name: "diagonal, spring 170/12", property: "x", curve: TRACK_CURVES[4], from: [120, 80], to: [480, 280] },
  { name: "scale 1 → 1.6, ease", property: "scale", curve: TRACK_CURVES[0], from: [320, 180], to: [320, 180], scale: (i, p) => 1 + 0.6 * p },
  { name: "fade in, ease-in-out", property: "opacity", curve: TRACK_CURVES[1], from: [320, 180], to: [320, 180], opacity: (i, p) => p },
  { name: "fade out (box given), ease", property: "opacity", curve: TRACK_CURVES[0], from: [320, 180], to: [320, 180], opacity: (i, p) => 1 - p, box: { x: 285, y: 145, w: 70, h: 70 } },
  { name: "right, then 1.5 s of rest", property: "x", curve: TRACK_CURVES[0], from: [120, 180], to: [500, 180], tail: 1.5 },
  { name: "right, identical twin 110 px above the start", property: "x", curve: TRACK_CURVES[0], from: [120, 220], to: [500, 220], twin: [120, 110] },
];
const VARIETY_CONDITIONS = [TRACK_CONDITIONS[0], TRACK_CONDITIONS[2]];

async function trackClip(file, fps, curve, condition, motion = { from: [120, 180], to: [500, 180] }) {
  const startFrame = Math.round(REST * fps);
  const moveFrames = Math.round(MOVE_SECONDS * fps);
  const seconds = (curve.kind === "spring" ? 2 : REST + MOVE_SECONDS + 0.5) + (motion.tail ?? 0);
  const progress = curve.kind === "spring" ? (i) => springAt(curve.stiffness, curve.damping, (i - startFrame) / fps) : (i) => bezierAt(curve.bezier, (i - startFrame) / moveFrames);
  await encode(
    file,
    clipFrames({ total: Math.round(seconds * fps), progress, from: motion.from, to: motion.to, size: 70, busy: condition.busy, noise: condition.noise, seed: fps, ...(motion.scale && { scale: motion.scale }), ...(motion.opacity && { opacity: motion.opacity }), ...(motion.twin && { twin: motion.twin }) }),
    { fps, timeoutMs: 120_000 },
  );
  return { startFrame, moveFrames, seconds };
}

/** Value progress of a fitted curve (as `track` reports it) at move progress u. */
function fittedAt(curve, u, seconds) {
  if (u <= 0) return 0;
  if (curve.kind === "spring") return springAt(curve.stiffness, curve.damping, u * seconds);
  if (u >= 1) return 1;
  if (curve.kind === "linear") return u;
  if (curve.kind === "steps") return Math.floor(u * curve.steps) / curve.steps;
  return bezierAt(curve.bezier, u);
}

/**
 * Largest difference between the fitted and the true motion over time, as a share of the travel: shape and timing
 * together. Control points are not unique (different points can draw nearly the same curve), this is.
 */
function shapeError(p, curve, truth, fps) {
  const t0 = truth.startFrame / fps;
  const length = truth.moveFrames / fps;
  const span = curve.kind === "spring" ? 1.6 : length;
  let worst = 0;
  for (let k = 0; k <= 400; k++) {
    const t = t0 - 0.1 + ((span + 0.2) * k) / 400;
    const truthValue = curve.kind === "spring" ? springAt(curve.stiffness, curve.damping, t - t0) : bezierAt(curve.bezier, (t - t0) / length);
    const fitted = fittedAt(p.curve, (t - p.start) / Math.max(1e-6, p.end - p.start), p.end - p.start);
    worst = Math.max(worst, Math.abs(fitted - truthValue));
  }
  return worst;
}

/** One tracked clip compared with its truth. */
function trackRow(base, result, curve, truth, fps, property) {
  const track = result?.structuredContent?.track;
  const p = track?.properties?.find((q) => q.property === property);
  const row = { ...base, expected: curve.kind, kind: p?.curve.kind ?? "none", quality: p?.quality ?? "—", startError: p ? p.start * fps - truth.startFrame : null };
  if (!p) {
    row.fitted = track?.unfitted?.map((u) => `${u.property}: ${u.reason}`).join("; ") || (result?.isError ? "error" : "not found");
    return row;
  }
  row.shapeError = shapeError(p, curve, truth, fps);
  if (curve.kind === "bezier") {
    row.durationError = p.frames - truth.moveFrames;
    row.controlError = p.curve.kind === "bezier" ? Math.max(...p.curve.bezier.map((c, i) => Math.abs(c - curve.bezier[i]))) : null;
    row.fitted = p.curve.kind === "bezier" ? `cubic-bezier(${p.curve.bezier.join(", ")})` : p.curve.kind;
  } else {
    row.stiffnessError = p.curve.kind === "spring" ? Math.abs(p.curve.stiffness - curve.stiffness) / curve.stiffness : null;
    row.dampingError = p.curve.kind === "spring" ? Math.abs(p.curve.damping - curve.damping) / curve.damping : null;
    row.fitted = p.curve.kind === "spring" ? `stiffness ${p.curve.stiffness}, damping ${p.curve.damping}` : p.curve.kind;
  }
  row.rmse = p.rmse;
  return row;
}

const rows = [];
const cutErrors = [];
const trackRows = [];
const varietyRows = [];
const transitionRows = [];
const falseTransitions = [];
const montageRows = [];
const server = startServer(work);
let id = 1;
try {
  for (const fps of TRACK_ONLY || TRANSITIONS_ONLY ? [] : FPS_LIST) {
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
    // These clips hold moves and hard cuts only: a gradual transition found in them is a false one.
    falseTransitions.push(...(spec.transitions ?? []).filter((x) => x.kind !== "cut").map((x) => ({ fps, ...x })));
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

  for (const fps of TRACK_ONLY ? [] : FPS_LIST) {
    const file = join(work, `montage-${fps}.mp4`);
    const truth = await montageClip(file, fps);
    const result = await call(server, id++, "style", { source: file });
    const spec = JSON.parse(readFileSync(result.structuredContent.files.spec, "utf8"));
    const found = spec.anchors.cuts.map((c) => Math.round(c.t * fps));
    const row = {
      fps,
      cuts: truth.cuts.length,
      exact: truth.cuts.filter((f) => found.includes(f)).length,
      withinOne: truth.cuts.filter((f) => found.some((g) => Math.abs(g - f) <= 1)).length,
      flashCuts: found.filter((g) => truth.flashes.some((f) => g >= f && g <= f + 3)).length,
      extra: found.filter((g) => !truth.cuts.some((f) => Math.abs(g - f) <= 1) && !truth.flashes.some((f) => g >= f && g <= f + 3)).length,
    };
    montageRows.push(row);
    console.error(`montage ${fps} fps: ${row.exact} of ${row.cuts} cuts exact, ${row.flashCuts} flash frames read as cuts, ${row.extra} other extra cuts`);
  }

  for (const fps of TRACK_ONLY ? [] : FPS_LIST) {
    for (const [condition, pictures] of Object.entries(TRANSITION_PICTURES)) {
      for (const t of TRANSITION_KINDS) {
        for (const frames of TRANSITION_FRAMES) {
          const file = join(work, `x-${fps}-${condition}-${t.name.replace(/\W+/g, "_")}-${frames}.mp4`);
          const truth = transitionClip(file, fps, frames, t, pictures);
          const result = await call(server, id++, "style", { source: file });
          const spec = JSON.parse(readFileSync(result.structuredContent.files.spec, "utf8"));
          const gradual = (spec.transitions ?? []).filter((x) => x.kind !== "cut");
          const hit = gradual.find((x) => x.start < truth.end && x.end > truth.start);
          const frameOf = (v) => Math.round(v * fps);
          // A dissolve's or wipe's boundary is one frame; a dip's is any frame of its hold.
          const outside = (v) => (v < truth.at[0] ? truth.at[0] - v : v > truth.at[1] ? v - truth.at[1] : 0);
          const row = {
            fps,
            condition,
            name: t.name,
            frames,
            kind: hit ? `${hit.kind}${hit.via ? ` ${hit.via}` : ""}${hit.direction ? ` ${hit.direction}` : ""}` : "none",
            right: Boolean(hit && hit.kind === t.kind && (!t.via || hit.via === t.via) && (!t.direction || hit.direction === t.direction)),
            startError: hit ? frameOf(hit.start) - frameOf(truth.start) : null,
            endError: hit ? frameOf(hit.end) - frameOf(truth.end) : null,
            boundaryError: hit ? Math.round(outside(hit.at) * fps) : null,
            extra: gradual.length - (hit ? 1 : 0) + spec.anchors.cuts.length,
          };
          transitionRows.push(row);
          console.error(`transition ${fps} fps, ${condition}, ${t.name}, ${frames} frames: ${row.kind} (start ${row.startError}, end ${row.endError}, boundary ${row.boundaryError}, extra ${row.extra})`);
        }
      }
    }
  }

  for (const fps of TRANSITIONS_ONLY ? [] : FPS_LIST) {
    for (const condition of TRACK_CONDITIONS) {
      for (const curve of TRACK_CURVES) {
        const file = join(work, `t-${fps}-${condition.noise}-${condition.busy ? "busy" : "plain"}-${curve.name.replace(/\W+/g, "_")}.mp4`);
        const truth = await trackClip(file, fps, curve, condition);
        const result = await call(server, id++, "track", { source: file, start: 0, end: truth.seconds });
        const row = trackRow({ fps, condition: condition.name, curve: curve.name }, result, curve, truth, fps, "x");
        trackRows.push(row);
        console.error(`track ${fps} fps, ${condition.name}, ${curve.name}: ${row.fitted ?? row.kind}`);
      }
    }
  }

  for (const condition of TRANSITIONS_ONLY ? [] : VARIETY_CONDITIONS) {
    for (const v of VARIETY) {
      const fps = 30;
      const file = join(work, `v-${condition.busy ? "busy" : "plain"}-${v.name.replace(/\W+/g, "_")}.mp4`);
      const truth = await trackClip(file, fps, v.curve, condition, v);
      const result = await call(server, id++, "track", { source: file, start: 0, end: truth.seconds, ...(v.box && { element: v.box }) });
      const row = trackRow({ fps, condition: condition.name, curve: v.name }, result, v.curve, truth, fps, v.property);
      varietyRows.push(row);
      console.error(`variety ${condition.name}, ${v.name}: ${row.fitted ?? row.kind} (${row.quality})`);
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
  return `| ${c.name} | ${all.filter((r) => r.kind === r.expected).length} of ${all.length} | ${pct(mean(all.filter((r) => r.shapeError !== undefined).map((r) => r.shapeError)))} / ${pct(max(all.filter((r) => r.shapeError !== undefined).map((r) => r.shapeError)))} | ${f3(mean(bez.map((r) => r.controlError)))} / ${f3(max(bez.map((r) => r.controlError)))} | ${f2(mean(durations))} / ${f2(max(durations))} | ${f2(mean(timed.map((r) => Math.abs(r.startError))))} / ${f2(max(timed.map((r) => Math.abs(r.startError))))} | ${pct(mean(spr.map((r) => r.stiffnessError)))} / ${pct(mean(spr.map((r) => r.dampingError)))} |`;
});

/** Short shots: cuts around 2–3 frame shots, and flashes that are not cuts. */
function montageMarkdown() {
  return `### Short shots and flashes

A montage of textured pictures at 24, 30 and 60 fps: a 1 s shot, then shots of 2, 3, 2, 3 and 2 frames, then a shot
with a 2-frame white flash in it and one with a 3-frame black flash (the picture comes back after each flash). Two cuts
three frames apart look like a flash in the per-frame change alone; the frames tell them apart (after a flash the
picture is the one before it, after a short shot it is a new one).

| fps | Cuts on the exact frame | Within one frame | Flash frames read as cuts | Other extra cuts |
|---|---|---|---|---|
${montageRows.map((r) => `| ${r.fps} | ${r.exact} of ${r.cuts} | ${r.withinOne} of ${r.cuts} | ${r.flashCuts} | ${r.extra} |`).join("\n")}

Limit: a cut inside part of the frame only (a picture-in-picture or a loupe that changes its image while the rest
stays) is judged on the whole frame. Between two similar pictures in a third of the frame (white card to white card
in Frame Lens's own demo) the whole-frame change is 2 on a 0–255 scale and the cut is not found, although the cell of
a 4×4 grid that holds it changes by 10 against about 1 on the frames around it. A per-region check over the 64×36
frames is cheap, but it would also fire on text and interface changes inside one region (a slide's next bullet, a
screen recording's new window), so it is not used to find cuts.`;
}

/** The transitions section of ACCURACY.md: a summary per picture kind and transition, then every clip. */
function transitionsMarkdown() {
  const abs = (xs) => xs.filter((v) => v !== null).map((v) => Math.abs(v));
  const summary = Object.keys(TRANSITION_PICTURES).flatMap((condition) =>
    TRANSITION_KINDS.map((t) => {
      const all = transitionRows.filter((r) => r.condition === condition && r.name === t.name);
      const hits = all.filter((r) => r.right);
      return `| ${condition} | ${t.name} | ${hits.length} of ${all.length} | ${f2(mean(abs(hits.map((r) => r.startError))))} / ${f2(max(abs(hits.map((r) => r.startError))))} | ${f2(mean(abs(hits.map((r) => r.endError))))} / ${f2(max(abs(hits.map((r) => r.endError))))} | ${f2(mean(abs(hits.map((r) => r.boundaryError))))} / ${f2(max(abs(hits.map((r) => r.boundaryError))))} | ${all.reduce((s, r) => s + r.extra, 0)} |`;
    }),
  );
  const right = transitionRows.filter((r) => r.right).length;
  return `Two test pictures meet in a transition of 12 or 24 frames at 24, 30 and 60 fps: a dissolve (ffmpeg \`xfade\`
fade), a dip through black and one through white (the first picture fades out over half the frames, three frames of
the colour, the second fades in), and wipes to the left and downwards. "Still" pictures are SMPTE bars and an RGB test
pattern; "moving" ones are ffmpeg's animated \`testsrc2\` and a zooming Mandelbrot set, so the shots move during the
transition. ${transitionRows.length} clips; ${right} found with the right kind (and colour or direction). Errors are in
frames against the truth: the start is the last frame of the first picture, the end the first frame of the second, and
the shot boundary belongs on a dissolve's or wipe's halfway frame or on any frame of a dip's hold. "Extra" counts other
transitions and cuts reported in the same clips. In the ${FPS_LIST.length} move-and-cut videos above, ${falseTransitions.length} gradual transitions were reported where there are none.

| Pictures | Transition | Found right | Start error, mean / max | End error, mean / max | Boundary error, mean / max | Extra |
|---|---|---|---|---|---|---|
${summary.join("\n")}

Dissolves, fades and dips are recognised by their frames being blends of the two pictures (or of a picture and flat
black or white), so motion inside the shots makes them harder: the blend is checked against the pictures on both
sides, and the frames at its ends that barely move towards the other picture are left out. A wipe is recognised when
each frame is part one picture, part the other, split by a straight edge; on moving pictures its start can be a frame
early here, and more on busier footage. A push (the new picture sliding the old one out) is not recognised as a transition: it is reported as
a move. Wipes and pushes in real footage are rarer than cuts, dissolves and fades, and less tested here.

On real footage, \`test/style/real-clip.test.ts\` checks the Big Buck Bunny trailer (CC BY 3.0, Blender Foundation;
25 fps, 33 s) against frame-by-frame reading: its two title-card dissolves (3.48–4.44 s and 6.24–7.12 s), five dips to
black (boundaries on the black frames at 18.88, 19.88, 20.88, 21.88 and 22.88 s) and a flash to white (26.72 s) are
found with the boundaries on those frames, and its 11 hard cuts stay where they were.

<details><summary>Every transition clip</summary>

| fps | pictures | transition | frames | found | start error | end error | boundary error | extra |
|---|---|---|---|---|---|---|---|---|
${transitionRows.map((r) => `| ${r.fps} | ${r.condition} | ${r.name} | ${r.frames} | ${r.kind}${r.right ? "" : " (wrong)"} | ${r.startError ?? "—"} | ${r.endError ?? "—"} | ${r.boundaryError ?? "—"} | ${r.extra} |`).join("\n")}

</details>`;
}

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

${montageMarkdown()}

<details><summary>Every move</summary>

| fps | frames | easing | found | start error (frames) | measured frames | family |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.fps} | ${r.frames} | ${r.easing} | ${r.found ? "yes" : "no"} | ${r.startError ?? "—"} | ${r.measuredFrames ?? "—"} | ${r.family} |`).join("\n")}

</details>

## Transitions (\`style\`)

${transitionsMarkdown()}

## Tracked curves (\`track\`)

A 70×70 px square on a 640×360 frame travels 380 px with a known timing curve: four cubic-beziers (CSS \`ease\`,
\`ease-in-out\`, a custom \`cubic-bezier(0.7, 0.1, 0.2, 0.95)\` and an overshooting back-out) over ${MOVE_SECONDS} s, and two
damped springs (stiffness/damping 170/12 and 100/10, mass 1), at 24, 30 and 60 fps. Frames are rendered with
antialiasing and encoded as H.264: clean, with pixel noise, and over a busy textured background with noise. \`track\`
finds the square on its own (\`element: auto\`) and fits its x curve. ${trackRows.length} clips.

| Condition | Model chosen right | Shape error, mean / max | Bezier control points, mean / max error | Duration error, mean / max (frames) | Start error, mean / max (frames) | Spring stiffness / damping, mean error |
|---|---|---|---|---|---|---|
${trackSummary.join("\n")}

The shape error is the largest gap between the fitted and the true motion over time, as a share of the travel: it
covers shape and timing together, and it is the number that matters, since different control points can draw nearly
the same curve (CSS \`ease-out\` and a fitted \`cubic-bezier(0.31, 0.51, 0.73, 1)\` differ by about 1 %). Durations and
control points are also compared for the beziers; a spring is defined by its stiffness and damping, so those are
compared instead (its length on the timeline is the time it takes to settle within 0.5 % of the travel). Targets for
clean renders: duration within one frame, control points within 0.05.

### Other motion (30 fps)

Other directions, the y axis, a diagonal spring, scale, a fade-in, a fade-out and a window that is mostly rest after
the move, and a move next to an identical static square (a look-alike the tracker must not jump to); clean and over
the busy background with noise. The element is found automatically except for the fade-out,
which ends invisible (a box is given). ${varietyRows.length} clips.

| Condition | Motion | Property | Chosen | Quality | Shape error | Duration error (frames) | Start error (frames) | Spring k / c error |
|---|---|---|---|---|---|---|---|---|
${varietyRows.map((r) => `| ${r.condition} | ${r.curve} | ${VARIETY.find((v) => v.name === r.curve)?.property} | ${r.kind} | ${r.quality} | ${pct(r.shapeError ?? NaN)} | ${f2(r.durationError ?? NaN)} | ${f2(r.startError ?? NaN)} | ${r.stiffnessError !== undefined ? `${pct(r.stiffnessError ?? NaN)} / ${pct(r.dampingError ?? NaN)}` : "—"} |`).join("\n")}

Scale is measured to about 1–2 % of its value and opacity from the element's brightness against its surroundings, so
their curves are less exact than position (here the duration of a scale or opacity move is off by up to about 1.3
frames, while position stays within a frame): read the shape error above, and the fit error \`track\` reports.
Springs with a damping ratio of about 0.85 or more barely overshoot (under 1 % of the travel): they are reported as
the cubic-bezier that matches them within the stated error, not as a spring. Moves of 5 frames or fewer are marked
unreliable: too short to tell curves apart. Grades: \`exact\` needs a fit error within 1 % of the travel, sample
noise within 0.4 % of it and at least 8 moving frames; \`approximate\` within 3 % and 1.5 %; opacity read against a
busy surrounding is at best approximate (a fade-out that ends invisible is measured against the background it leaves,
which removes the surrounding's bias; its noise can still keep it approximate). A 6-frame move is therefore graded approximate even when it is fitted closely.

Limits: these renders are a sharp-edged square without motion blur, moving in a straight line over a static
background. Real footage adds motion blur, rotation, occlusion, a moving camera and elements that change shape; the
tracker follows position, size and brightness only, and the fit error it reports for each property is the honest
measure of how well the curve explains that footage.

<details><summary>Every tracked clip</summary>

| fps | condition | curve | chosen | fitted | shape error | control error | duration error (frames) | start error (frames) | fit error |
|---|---|---|---|---|---|---|---|---|---|
${[...trackRows, ...varietyRows].map((r) => `| ${r.fps} | ${r.condition} | ${r.curve} | ${r.kind} | ${r.fitted ?? "—"} | ${pct(r.shapeError ?? NaN)} | ${f3(r.controlError ?? NaN)} | ${f2(r.durationError ?? NaN)} | ${f2(r.startError ?? NaN)} | ${pct(r.rmse ?? NaN)} |`).join("\n")}

</details>
`;
if (TRANSITIONS_ONLY) {
  console.log(montageMarkdown());
  console.log(transitionsMarkdown().split("<details>")[0]);
  process.exit(0);
}
if (!TRACK_ONLY) writeFileSync(join(repo, "docs", "ACCURACY.md"), md);
console.log(md.split("<details>")[0]);
console.log(["| Condition | Model | Shape mean / max | Control mean / max | Duration mean / max | Start mean / max | Spring k / c |", "|---|---|---|---|---|---|---|", ...trackSummary].join("\n"));
console.log(varietyRows.map((r) => `${r.condition} | ${r.curve} | ${r.kind} | ${r.quality} | shape ${pct(r.shapeError ?? NaN)} | dur ${f2(r.durationError ?? NaN)} | ${r.fitted}`).join("\n"));

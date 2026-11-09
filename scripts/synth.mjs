// Synthetic test renders for `track`: an antialiased square moving with a known curve over a plain or busy background,
// as grey frames in memory or encoded to a video through ffmpeg. Shared by the tests and scripts/benchmark.mjs.
import { spawn } from "node:child_process";

/** A deterministic random number generator in −0.5..0.5. */
export function random(seed = 7) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

/** A static textured background: soft stripes and random blocks, the kind of detail that confuses a naive tracker. */
export function busyBackground(width, height, seed = 3) {
  const rand = random(seed);
  const bg = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bg[y * width + x] = 70 + 25 * Math.sin(x / 9) * Math.cos(y / 13) + 15 * Math.sin((x + y) / 23);
  for (let k = 0; k < 160; k++) {
    const bx = Math.floor((rand() + 0.5) * width);
    const by = Math.floor((rand() + 0.5) * height);
    const bw = 4 + Math.floor((rand() + 0.5) * 30);
    const bh = 4 + Math.floor((rand() + 0.5) * 30);
    const level = 40 + (rand() + 0.5) * 120;
    for (let y = by; y < Math.min(height, by + bh); y++) for (let x = bx; x < Math.min(width, bx + bw); x++) bg[y * width + x] = level;
  }
  return bg;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * One grey frame with a square of side `size` centred at (cx, cy), scaled and faded. Pixels are covered by area,
 * so subpixel positions render the way a real renderer antialiases them.
 */
export function renderFrame(width, height, { cx, cy, size, scale = 1, opacity = 1, background, level = 235, noise = 0, rand }) {
  const out = new Uint8Array(width * height);
  const half = (size * scale) / 2;
  const x0 = cx - half;
  const x1 = cx + half;
  const y0 = cy - half;
  const y1 = cy + half;
  for (let y = 0; y < height; y++) {
    const cy1 = overlap(y, y + 1, y0, y1);
    for (let x = 0; x < width; x++) {
      const base = typeof background === "number" ? background : background[y * width + x];
      const cover = cy1 ? cy1 * overlap(x, x + 1, x0, x1) * opacity : 0;
      let v = base + (level - base) * cover;
      if (noise) v += noise * rand() * 3.4641; // uniform noise with standard deviation `noise`
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

export function bezierAt([x1, y1, x2, y2], u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const bx = (s) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s ** 2 * x2 + s ** 3;
  let lo = 0;
  let hi = 1;
  let s = u;
  for (let i = 0; i < 60; i++) {
    if (bx(s) < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;
}

/** Spring progress after tau seconds, mass 1, released at rest. */
export function springAt(stiffness, damping, tau) {
  if (tau <= 0) return 0;
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + ((zeta * omega) / wd) * Math.sin(wd * tau));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * tau) * (1 + omega * tau);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r2 - r1);
}

/**
 * The frames of a clip: `total` frames, the move starting `startFrame` frames in. `progress(frameIndex)` gives the
 * value progress (0..1, may overshoot). The square travels from (fromX, fromY) to (toX, toY).
 */
export function* clipFrames({ width = 640, height = 360, total, progress, from = [120, 180], to = [500, 180], size = 70, busy = false, noise = 0, seed = 11, opacity, scale, twin }) {
  let background = busy ? busyBackground(width, height) : 40;
  // An identical static square somewhere else: a look-alike the tracker must not jump to.
  if (twin) background = Float32Array.from(renderFrame(width, height, { cx: twin[0], cy: twin[1], size, background }));
  const rand = random(seed);
  for (let i = 0; i < total; i++) {
    const p = progress(i);
    yield renderFrame(width, height, {
      cx: from[0] + (to[0] - from[0]) * p,
      cy: from[1] + (to[1] - from[1]) * p,
      size,
      scale: scale ? scale(i, p) : 1,
      opacity: opacity ? opacity(i, p) : 1,
      background,
      noise,
      rand,
    });
  }
}

/** Encodes grey frames to an H.264 file through ffmpeg (time-limited). */
export function encode(file, frames, { width = 640, height = 360, fps, ffmpeg = "ffmpeg", crf = 12, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", "-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv420p", file],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(file);
      else reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").slice(-3).join("\n")}`));
    });
    child.stdin.on("error", () => {});
    (async () => {
      for (const frame of frames) {
        if (!child.stdin.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))) await new Promise((r) => child.stdin.once("drain", r));
      }
      child.stdin.end();
    })();
  });
}

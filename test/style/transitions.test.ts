import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import type { PictureFrames } from "../../src/style/motion.js";
import { detectTransitions, visibleMoves } from "../../src/style/transitions.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const W = 64;
const H = 36;
const FPS = 25;
type Picture = Float32Array; // RGB 0–255, W×H×3

/** A textured picture: smooth waves plus blocks, different for every seed. */
function texture(seed: number, shift = 0): Picture {
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x + shift;
      for (let c = 0; c < 3; c++) {
        const wave = 128 + 70 * Math.sin(u / (3 + seed + c)) * Math.cos(y / (4 + ((seed * 3 + c) % 5)));
        // Blocks on a grid of their own per seed: two pictures do not share their edges.
        const block = ((Math.floor((u + seed * 3) / (5 + seed)) + Math.floor((y + seed) / (4 + (seed % 3))) + seed + c) % 3) * 25 - 25;
        out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, wave + block));
      }
    }
  }
  return out;
}

const flat = (v: number): Picture => new Float32Array(W * H * 3).fill(v);
const mix = (a: Picture, b: Picture, t: number): Picture => a.map((v, i) => v + (b[i]! - v) * t);
const scale = (a: Picture, s: number): Picture => a.map((v) => v * s);

/** Packs pictures into the tiny frames `motionProfile` returns, with a little noise like a real encode. */
function frames(pictures: Picture[], noise = 1.5): PictureFrames {
  const data = new Uint8Array(pictures.length * W * H * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  pictures.forEach((p, k) => p.forEach((v, i) => (data[k * W * H * 3 + i] = Math.max(0, Math.min(255, Math.round(v + rand() * noise))))));
  return { width: W, height: H, times: pictures.map((_, k) => Math.round((k / FPS) * 1000) / 1000), data };
}

const t = (k: number) => Math.round((k / FPS) * 1000) / 1000;
const repeat = (p: Picture, n: number) => Array.from({ length: n }, () => p);

describe("transitions from frames", () => {
  const A = texture(1);
  const B = texture(4);

  it("finds a dissolve with its first and last picture and splits at its halfway frame", () => {
    // 10 frames of A, 11 blended frames (1/12 … 11/12), then B.
    const pics = [...repeat(A, 10), ...Array.from({ length: 11 }, (_, i) => mix(A, B, (i + 1) / 12)), ...repeat(B, 10)];
    const found = detectTransitions(frames(pics), FPS);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "dissolve", start: t(9), end: t(21), frames: 12, at: t(15), easing: "linear" });
    expect(found[0]!.fit).toBeLessThan(0.1);
  });

  it("finds a dip through black, with the shot boundary on the black frame", () => {
    const pics = [
      ...repeat(A, 8),
      ...Array.from({ length: 5 }, (_, i) => scale(A, 1 - (i + 1) / 6)),
      flat(0),
      ...Array.from({ length: 5 }, (_, i) => scale(B, (i + 1) / 6)),
      ...repeat(B, 8),
    ];
    const found = detectTransitions(frames(pics, 0.5), FPS);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "dip", via: "black", start: t(7), at: t(13), end: t(19), frames: 12 });
  });

  it("finds a fade out to white at the end and a fade in from black at the start", () => {
    const pics = [
      flat(0),
      ...Array.from({ length: 5 }, (_, i) => scale(A, (i + 1) / 6)),
      ...repeat(A, 8),
      ...Array.from({ length: 5 }, (_, i) => mix(A, flat(255), (i + 1) / 6)),
      ...repeat(flat(255), 6),
    ];
    const found = detectTransitions(frames(pics, 0.5), FPS);
    expect(found.map((x) => [x.kind, x.via, x.at])).toEqual([
      ["fade-in", "black", t(0)],
      // White to the end: the fade belongs to the last shot (its boundary is the last frame, which splits nothing).
      ["fade-out", "white", t(24)],
    ]);
  });

  it("finds a wipe and the way its edge travels", () => {
    const wipe = (k: number): Picture => {
      const edge = Math.round((W * k) / 12);
      return A.map((v, i) => (Math.floor(i / 3) % W < edge ? B[i]! : v));
    };
    const pics = [...repeat(A, 8), ...Array.from({ length: 11 }, (_, i) => wipe(i + 1)), ...repeat(B, 8)];
    const found = detectTransitions(frames(pics), FPS, { windows: [{ start: t(7), end: t(19) }] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "wipe", direction: "right", start: t(7), end: t(19) });
    expect(Math.abs(found[0]!.at - t(13))).toBeLessThanOrEqual(0.041);
  });

  it("does not call a slow pan, a brightening, a small element fading in or noise a transition", () => {
    const pan = Array.from({ length: 20 }, (_, k) => texture(2, k * 0.08));
    const brighten = [...repeat(A, 5), ...Array.from({ length: 10 }, (_, i) => scale(A, 1 - 0.04 * (i + 1))), ...repeat(scale(A, 0.6), 5)];
    const square = (alpha: number) => A.map((v, i) => {
      const p = Math.floor(i / 3);
      return p % W >= 20 && p % W < 30 && Math.floor(p / W) >= 10 && Math.floor(p / W) < 20 ? v + (255 - v) * alpha : v;
    });
    const element = [...repeat(A, 5), ...Array.from({ length: 10 }, (_, i) => square((i + 1) / 10)), ...repeat(square(1), 5)];
    const noise = repeat(A, 30);
    for (const pics of [pan, brighten, element]) expect(detectTransitions(frames(pics), FPS)).toEqual([]);
    expect(detectTransitions(frames(noise, 6), FPS)).toEqual([]);
  });

  it("does not run a transition across a cut", () => {
    const pics = [...repeat(A, 8), ...Array.from({ length: 6 }, (_, i) => mix(A, B, (i + 1) / 7)), ...repeat(B, 8)];
    expect(detectTransitions(frames(pics), FPS, { cuts: [t(11)] }).every((x) => x.end <= t(11) || x.start >= t(11))).toBe(true);
  });

  it("drops moves whose picture never leaves its first frame (grain on a still shot)", () => {
    const box = (x: number) => A.map((v, i) => (Math.floor(i / 3) % W >= x && Math.floor(i / 3) % W < x + 8 && Math.floor(i / 3 / W) < 8 ? 255 : v));
    const moving = frames([...repeat(A, 5), ...Array.from({ length: 10 }, (_, k) => box(k * 4)), ...repeat(box(40), 5)]);
    expect(visibleMoves([{ start: t(4), end: t(15) }], moving)).toHaveLength(1);
    const still = frames(repeat(A, 20), 1);
    expect(visibleMoves([{ start: t(2), end: t(15) }], still)).toEqual([]);
  });
});

const tools = mediaTools();

describe.skipIf(!tools)("transitions in encoded video", () => {
  let dir: string;
  let video: string;

  beforeAll(() => {
    dir = tempDir();
    video = join(dir, "transitions.mp4");
    // Bars dissolve into a test pattern at 1.6–2.4 s (on frame times at 25 fps), which dips through black (fade out
    // 3.6–4.1 s, black to 4.2 s, fade in 4.2–4.7 s) into a third picture.
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "smptehdbars=s=320x180:r=25:d=2.4",
      "-f", "lavfi", "-i", "rgbtestsrc=s=320x180:r=25:d=2.6",
      "-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=2",
      "-filter_complex",
      "[0]format=yuv420p,setsar=1[a];[1]format=yuv420p,setsar=1,fade=t=out:st=2:d=0.5[b];[2]format=yuv420p,setsar=1,fade=t=in:st=0:d=0.5[c];" +
        "[a][b]xfade=transition=fade:duration=0.8:offset=1.6[ab];[ab][c]concat=n=2:v=1:a=0,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", "-qp", "8", "-pix_fmt", "yuv420p", video,
    ], { windowsHide: true, timeout: 60_000 });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports the dissolve and the dip, splits the shots at them and keeps them out of the moves", async () => {
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const { spec } = await engine.style(video, { version: "test" });
    const gradual = (spec.transitions ?? []).filter((x) => x.kind !== "cut");
    expect(gradual.map((x) => x.kind)).toEqual(["dissolve", "dip"]);
    const [dissolve, dip] = gradual;
    expect(dissolve).toMatchObject({ start: 1.6, end: 2.4, frames: 20, evidence: "derived", from: "s1", to: "s2" });
    expect(Math.abs(dissolve!.at - 2)).toBeLessThanOrEqual(0.041);
    expect(dip).toMatchObject({ via: "black", from: "s2", to: "s3" });
    expect(dip!.at).toBeGreaterThanOrEqual(4.08);
    expect(dip!.at).toBeLessThanOrEqual(4.2);
    expect(Math.abs(dip!.start - 3.6)).toBeLessThanOrEqual(0.041);
    expect(Math.abs(dip!.end - 4.7)).toBeLessThanOrEqual(0.041);
    expect(spec.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(spec.events.filter((e) => e.start < 4.7 && e.end > 1.6)).toEqual([]);
  }, 60_000);
});

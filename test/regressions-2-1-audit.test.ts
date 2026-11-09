// Regressions from the independent audit of PR #22 (transitions in `style`), on clips like the auditor's. Each failed
// before its fix.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, localFileResolver } from "../src/engine.js";
import { silentLogger } from "../src/logger.js";
import type { MotionSpec } from "../src/style/spec.js";
import { mediaTools, tempDir } from "./media/fixtures.js";

const tools = mediaTools();
const S = "320x180";

describe.skipIf(!tools)("audit of #22: transitions on clips that move, recolour and slide", () => {
  let dir: string;
  let engine: Engine;
  const clip = (name: string, args: string[]) => {
    const file = join(dir, `${name}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args, "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-an", file], { windowsHide: true, timeout: 60_000 });
    return file;
  };
  const style = async (file: string): Promise<MotionSpec> => (await engine.style(file, { version: "test" })).spec;
  const gradual = (spec: MotionSpec) => (spec.transitions ?? []).filter((x) => x.kind !== "cut");

  beforeAll(() => {
    dir = tempDir();
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("1: a hue turn or a white-balance shift inside one shot is not a dissolve", async () => {
    const hue = clip("hue", ["-f", "lavfi", "-i", `testsrc2=s=${S}:r=30:d=2.5`, "-vf", "hue=h='70*min(1,max(0,(t-0.6)/0.3))'"]);
    const balance = clip("balance", [
      "-f", "lavfi", "-i", `mandelbrot=s=${S}:r=30:end_scale=0.9999:start_scale=1:maxiter=200,trim=duration=2.5`,
      "-vf", "geq=r='r(X,Y)*(1-0.35*min(1,max(0,(T-0.6)/0.4)))':g='g(X,Y)':b='min(255,b(X,Y)*(1+0.5*min(1,max(0,(T-0.6)/0.4))))'",
    ]);
    for (const file of [hue, balance]) {
      const spec = await style(file);
      expect(gradual(spec), file).toEqual([]);
      expect(spec.shots).toHaveLength(1);
    }
  }, 60_000);

  it("2: fades in and out of black on footage that keeps moving are found, and split no shot", async () => {
    const file = clip("fades-moving", ["-f", "lavfi", "-i", `testsrc2=s=${S}:r=30:d=3`, "-vf", "fade=t=in:st=0:d=1,fade=t=out:st=2:d=0.967"]);
    const spec = await style(file);
    const kinds = gradual(spec).map((x) => `${x.kind} ${x.via}`);
    expect(kinds).toEqual(["fade-in black", "fade-out black"]);
    const [fadeIn, fadeOut] = gradual(spec);
    expect(fadeIn!.end).toBeGreaterThanOrEqual(0.9);
    expect(fadeIn!.end).toBeLessThanOrEqual(1.04);
    expect(fadeOut!.start).toBeGreaterThanOrEqual(1.96);
    expect(fadeOut!.start).toBeLessThanOrEqual(2.04);
    expect(spec.shots).toHaveLength(1);
  }, 60_000);

  it("3: a wipe into a moving picture is found without a move around it", async () => {
    const file = clip("wipe-moving", [
      "-f", "lavfi", "-i", `smptehdbars=s=${S}:r=30:d=4`, "-f", "lavfi", "-i", `testsrc2=s=${S}:r=30:d=4`,
      "-filter_complex", "[0]format=yuv420p,setsar=1[a];[1]format=yuv420p,setsar=1[b];[a][b]xfade=transition=wiperight:duration=0.5:offset=1.5",
    ]);
    const spec = await style(file);
    expect(gradual(spec).map((x) => `${x.kind} ${x.direction}`)).toEqual(["wipe right"]);
    expect(Math.abs(gradual(spec)[0]!.start - 1.5)).toBeLessThanOrEqual(0.041);
  }, 60_000);

  it("4: a flat panel sliding over most of the frame stays a move, not a wipe", async () => {
    const file = clip("flat-panel", [
      "-f", "lavfi", "-i", `smptehdbars=s=${S}:r=30:d=3`, "-f", "lavfi", "-i", "color=0x1E2A44:s=210x180:r=30:d=3",
      "-filter_complex", "[0][1]overlay=x='if(lt(t,1.5),-210,if(lt(t,1.9),-210+(t-1.5)/0.4*210,0))':y=0",
    ]);
    const spec = await style(file);
    expect(gradual(spec)).toEqual([]);
    expect(spec.events.some((e) => e.start < 1.9 && e.end > 1.5)).toBe(true);
  }, 60_000);

  it("a flash inside one shot (the picture comes back) does not split it", async () => {
    const file = clip("flash-in-shot", [
      "-f", "lavfi", "-i", `testsrc2=s=${S}:r=30:d=2.5`,
      "-vf", "geq=r='min(255,r(X,Y)+255*max(0,1-abs(N-33)/3))':g='min(255,g(X,Y)+255*max(0,1-abs(N-33)/3))':b='min(255,b(X,Y)+255*max(0,1-abs(N-33)/3))'",
    ]);
    const spec = await style(file);
    expect(gradual(spec)).toEqual([]);
    expect(spec.shots).toHaveLength(1);
  }, 60_000);

  it("a fast pan over a smooth picture and a smooth picture dimming are not dissolves", async () => {
    const pan = clip("pan-smooth", ["-f", "lavfi", "-i", "gradients=s=960x540:r=30:d=3:speed=0:n=3:seed=5", "-vf", "crop=320:180:x='min(600,max(0,(t-1)*600))':y=100"]);
    const dim = clip("dim-smooth", ["-f", "lavfi", "-i", `gradients=s=${S}:r=30:d=4:speed=0:n=3:seed=2`, "-vf", "geq=r='r(X,Y)*(1-0.85*min(1,max(0,(T-1)/2)))':g='g(X,Y)*(1-0.85*min(1,max(0,(T-1)/2)))':b='b(X,Y)*(1-0.85*min(1,max(0,(T-1)/2)))'"]);
    for (const file of [pan, dim]) expect(gradual(await style(file)).filter((x) => x.kind === "dissolve"), file).toEqual([]);
  }, 60_000);
});

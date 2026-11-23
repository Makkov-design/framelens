import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, localFileResolver, PLAN_FULL_SECONDS } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { mergeBoundaries } from "../../src/media/boundaries.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();

describe("plan on a long source", () => {
  it("merges sample windows into one reading", () => {
    const part = (t: number, dynamics: number) => ({ rate: 2, threshold: 0.3, candidates: [{ t, score: 0.5 }], dynamics, changesPerMinute: 2 });
    const merged = mergeBoundaries([part(40, 0.1), part(5, 0.3)], 2, 0.3, 30);
    expect(merged.candidates.map((c) => c.t)).toEqual([5, 40]);
    expect(merged.dynamics).toBe(0.2);
    expect(merged.changesPerMinute).toBe(2);
    expect(merged.sampled).toEqual({ windows: 2, seconds: 60 });
  });
});

describe.skipIf(!tools)("plan on a long source", () => {
  let dir: string;
  let video: string;

  beforeAll(() => {
    dir = tempDir();
    video = join(dir, "long.mp4");
    // Longer than PLAN_FULL_SECONDS; tiny and at 2 fps so it encodes in a moment.
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=64x36:r=2:d=${PLAN_FULL_SECONDS + 60}`, "-c:v", "libx264", "-g", "20", "-pix_fmt", "yuv420p", video]);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads sample windows instead of every second, and says so", async () => {
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const { source, plan } = await engine.plan(video, {});
    expect(plan.notes.some((n) => /read in 12 windows of 30 s spread over it \(360 s in all\), not every second/.test(n))).toBe(true);
    const files = readdirSync(source.ws.dir);
    expect(files).toContain("boundaries-sampled-r2-t0.3-12x30.json");
    // No whole-video reading was made (and so none is mistaken for one by later steps).
    expect(files.some((f) => /^boundaries-r2-t0\.3-0-/.test(f))).toBe(false);
    expect(existsSync(join(source.ws.dir, "plan.json"))).toBe(true);
  }, 60_000);
});

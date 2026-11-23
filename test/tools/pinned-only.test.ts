import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipFrames, encode } from "../../scripts/synth.mjs";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { execTool } from "../../src/media/exec.js";
import { FFMPEG_PIN } from "../../src/tools/ffmpeg.js";
import { findTool } from "../../src/tools/find.js";
import { ToolSetup } from "../../src/tools/setup.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const real = mediaTools() && process.platform !== "win32" ? findTool("ffmpeg") : undefined;

// The pinned build is the only ffmpeg: it lives in FRAMELENS_HOME/tools/ffmpeg/<version>, not on PATH. `style` and
// `track` spawn ffmpeg themselves (a pipe), so they must locate it rather than spawn the bare name.
describe.skipIf(!real)("ffmpeg installed only as the pinned build", () => {
  let dir: string;
  let clip: string;
  let engine: Engine;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    dir = tempDir();
    clip = await encode(join(dir, "move.mp4"), clipFrames({ width: 160, height: 90, total: 30, size: 16, from: [20, 45], to: [140, 45], progress: (i) => Math.min(1, Math.max(0, (i - 5) / 15)) }), {
      width: 160,
      height: 90,
      fps: 30,
      timeoutMs: 30_000,
    });
    const home = join(dir, "home");
    const pinned = join(home, "tools", "ffmpeg", FFMPEG_PIN.version);
    mkdirSync(pinned, { recursive: true });
    const probe = findTool("ffprobe")!;
    symlinkSync(real!.path, join(pinned, "ffmpeg"));
    symlinkSync(probe.path, join(pinned, "ffprobe"));
    const setup = new ToolSetup({ env: { PATH: "", FRAMELENS_HOME: home }, intact: () => true });
    const tools = setup.mediaTools(execTool);
    expect(tools.ffmpeg).toBe("ffmpeg");
    engine = new Engine({ tools, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    // Nothing on the process PATH either: a bare `spawn("ffmpeg")` fails as it does on a machine without ffmpeg.
    process.env.PATH = "";
  }, 60_000);

  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs style (motionProfile) and track (decodeGray)", async () => {
    await engine.style(clip, { version: "test" });
    const { track } = await engine.track(clip, { start: 0, end: 1 });
    expect(track).toBeDefined();
  });
});

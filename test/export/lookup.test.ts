import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specFromPage } from "../../src/browser/web.js";
import { Engine } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { Workspace } from "../../src/workspace/workspace.js";
import { tempDir } from "../media/fixtures.js";

describe("export finds specs read by exact and web", () => {
  it("exports a Lottie file read earlier by its path, without resolving it as a video", async () => {
    const dir = tempDir();
    try {
      const engine = new Engine({
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", exec: async () => ({ stdout: "", stderr: "" }) },
        resolve: async () => {
          throw new Error("must not resolve a Lottie file as a video");
        },
        root: dir,
        logger: silentLogger,
      });
      const lottie = join(dir, "anim.json");
      const ws = new Workspace(dir, "lottie-0123456789");
      ws.writeJson("source.json", { id: ws.id, kind: "lottie", input: lottie });
      const spec = specFromPage(
        {
          url: lottie,
          title: "anim",
          viewport: { width: 512, height: 512 },
          scrollHeight: 512,
          animations: [{ kind: "waapi", name: "in", target: "layer", delay: 0, duration: 500, iterations: 1, easing: "ease-out", keyframes: [], properties: ["opacity"], scrollY: 0 }],
          fonts: [],
          colors: [{ hex: "#112233", area: 1 }],
          gsap: false,
        },
        "test",
      );
      ws.writeJson("motion-spec.json", spec);
      const { files, ws: used } = await engine.export(lottie, "remotion", "test");
      expect(used.id).toBe("lottie-0123456789");
      expect(files.some((f) => f.endsWith("timing.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoAnalyzer } from "../../src/analyzer.js";
import { Engine, localFileResolver, MAX_STYLE_SECONDS } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { createServer } from "../../src/server.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();
const noGemini: VideoAnalyzer = {
  model: "none",
  analyze: async () => {
    throw new Error("not used");
  },
  listModels: async () => [],
};

// A reference longer than one style pass: `style` analyzes the first 180 s and must say so in its result, and
// `compare` must say that its cuts and palette cover less than its SSIM does.
describe.skipIf(!tools)("style and compare tell what they did not analyze", () => {
  let dir: string;
  let video: string;
  let client: Client;

  beforeAll(async () => {
    dir = tempDir();
    video = join(dir, "long.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=64x36:r=2:d=${MAX_STYLE_SECONDS + 6}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const server = createServer({ analyzer: noGemini, logger: silentLogger, engine });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "test", version: "0" });
    await client.connect(a);
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

  it("style returns its notes, not only PROGRESS.md", async () => {
    const result = await call("style", { source: video });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(`Note: Analyzed the first ${MAX_STYLE_SECONDS} s`);
    expect((result.structuredContent as { notes: string[] }).notes).toEqual([expect.stringMatching(/Analyzed the first/)]);
  });

  it("compare says its cuts and palette cover the analyzed range while SSIM covers the whole file", async () => {
    const result = await call("compare", { reference: video, render: video });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/Note: reference: Analyzed the first/);
    expect(text(result)).toMatch(/Note: Cuts and palette are compared over the analyzed ranges .*SSIM\) covers the whole files/);
    const report = (result.structuredContent as { files: { report: string } }).files.report;
    expect(readFileSync(report, "utf8")).toMatch(/Note: Cuts and palette/);
  });
});

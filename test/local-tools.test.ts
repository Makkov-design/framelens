import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoAnalyzer } from "../src/analyzer.js";
import { Engine, localFileResolver, type SourceResolver } from "../src/engine.js";
import { parseTime } from "../src/local-tools.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { cutsVideo, mediaTools, tempDir } from "./media/fixtures.js";

const tools = mediaTools();
const noGemini: VideoAnalyzer = {
  model: "none",
  analyze: async () => {
    throw new Error("not used");
  },
  listModels: async () => [],
};

describe("parseTime", () => {
  it("accepts decimal seconds and clock formats", () => {
    expect(parseTime(12.48)).toBe(12.48);
    expect(parseTime("12.5")).toBe(12.5);
    expect(parseTime("1:05.25")).toBe(65.25);
    expect(parseTime("1:02:03")).toBe(3723);
    expect(() => parseTime("abc")).toThrow(/Invalid time/);
    expect(() => parseTime(-1)).toThrow(/Invalid time/);
  });
});

describe.skipIf(!tools)("local tools over MCP", () => {
  let dir: string;
  let video: string;
  let client: Client;

  /** The fixture with a caption file, the way the sources layer hands one over. */
  const withCaptions: SourceResolver = async (input, options) => {
    const record = await localFileResolver(input, options);
    const vtt = join(dir, "cuts.en.vtt");
    writeFileSync(vtt, "WEBVTT\n\n00:00:00.500 --> 00:00:02.500\nred <00:00:01.200><c>then</c><00:00:01.800><c>blue</c>\n\n00:00:03.000 --> 00:00:05.500\nand finally green\n");
    return { ...record, captions: [{ path: vtt, language: "en", auto: true }] };
  };

  beforeAll(async () => {
    dir = tempDir();
    video = cutsVideo(dir);
    const engine = new Engine({ tools: tools!, resolve: withCaptions, root: join(dir, ".framelens"), logger: silentLogger });
    const server = createServer({ analyzer: noGemini, logger: silentLogger, engine });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "test", version: "0" });
    await client.connect(a);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

  it("lists the local tools next to the Gemini ones", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["probe", "plan", "transcript", "frames", "boundaries", "track", "summarize_youtube_video"]));
  });

  it("probes a file into its workspace", async () => {
    const result = await call("probe", { source: video });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/6\.\d+ s · 320×180 · 25 fps/);
    expect(text(result)).toContain("Captions: en (auto)");
    const workspace = (result.structuredContent as { workspace: string }).workspace;
    expect(existsSync(join(workspace, "probe.json"))).toBe(true);
    expect(readFileSync(join(workspace, "PROGRESS.md"), "utf8")).toMatch(/probed: 6\.\d s/);
  });

  it("builds a word-timed transcript from captions", async () => {
    const result = await call("transcript", { source: video });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("[0:00] red then blue");
    expect(result.structuredContent).toMatchObject({ source: "auto-captions", words: 3, segments: 2 });
  });

  it("finds the cuts", async () => {
    const result = await call("boundaries", { source: video, rate: 10 });
    expect(text(result)).toMatch(/2 changes/);
    expect(text(result)).toMatch(/2\.00 s .*4\.00 s/);
  });

  it("returns labelled sheets inline and on disk, around a phrase too", async () => {
    const result = await call("frames", { source: video, every: 0.5, inline: 1 });
    expect(result.isError).toBeFalsy();
    const images = result.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    const sheets = (result.structuredContent as { sheets: { file: string; cells: { t: number; label: string }[] }[] }).sheets;
    expect(sheets.length).toBe(1);
    // Real frame times: at 25 fps the first frame at or after 1.5 s is at 1.52 s (frame 38).
    expect(sheets[0]!.cells.find((c) => c.t >= 1.5 && c.t < 1.6)!.label).toMatch(/^1\.520 s · f38 · then$/);
    expect(sheets[0]!.cells.find((c) => c.t >= 2 && c.t < 2.1)!.label).toMatch(/blue/);
    expect(existsSync(sheets[0]!.file)).toBe(true);

    const around = await call("frames", { source: video, around: "and finally", every_frame: true, padding: 0.1, inline: 0 });
    expect(around.isError).toBeFalsy();
    expect(text(around)).toMatch(/frames from 2\.900 s/);
  });

  it("plans by goal and explains bad requests", async () => {
    const plan = await call("plan", { source: video, request: "use it as a motion style reference" });
    expect(text(plan)).toMatch(/Goal: \*\*style\*\*/);
    expect(text(plan)).toMatch(/every_frame/);

    const bad = await call("frames", { source: video, every: 1, fps: 2 });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/exactly one/);

    const missing = await call("probe", { source: join(dir, "nope.mp4") });
    expect(missing.isError).toBe(true);
  });
});

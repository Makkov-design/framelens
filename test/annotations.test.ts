// Tool annotations say what a tool does to the machine: the local tools write workspaces and may download videos and
// install ffmpeg or yt-dlp, so they are not read-only (a client that runs read-only tools without asking must ask
// for these); the Gemini tools write nothing locally and stay read-only. None is destructive.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import type { VideoAnalyzer } from "../src/analyzer.js";
import { Engine, localFileResolver } from "../src/engine.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "framelens-annotations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GEMINI = ["summarize_youtube_video", "extract_key_moments", "ask_about_youtube_video", "get_video_transcript", "list_supported_models"];

describe("tool annotations", () => {
  it("mark every local tool as writing, not read-only, and the Gemini tools as read-only", async () => {
    const engine = new Engine({ tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as never, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const server = createServer({ analyzer: {} as VideoAnalyzer, logger: silentLogger, engine });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(a);
    const { tools } = await client.listTools();
    const local = tools.filter((t) => !GEMINI.includes(t.name));
    expect(local.map((t) => t.name)).toEqual(expect.arrayContaining(["probe", "plan", "transcript", "frames", "style", "track", "audio", "export", "compare", "boundaries", "web", "exact"]));
    for (const tool of local) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of GEMINI) {
      expect(tools.find((t) => t.name === name)!.annotations, name).toMatchObject({ readOnlyHint: true });
    }
    await client.close();
  });
});

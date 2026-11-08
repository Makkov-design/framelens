#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGeminiAnalyzer } from "./analyzer.js";
import { CachedAnalyzer } from "./cache.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ConfigError,InvalidInputError, MissingKeyError } from "./errors.js";
import { INIT_NEXT_STEPS, initProject } from "./init.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { createSetupAnalyzer } from "./setup.js";
import { VERSION } from "./version.js";
import { Engine, type TranscriptFallback } from "./engine.js";
import { execTool } from "./media/exec.js";
import { createHash } from "node:crypto";
import { captureVideo, hasLoginProfile, login, logout } from "./browser/capture.js";
import { maxDownloadMb, resolveSource, SourceError } from "./sources/index.js";
import { geminiTranscriptFallback } from "./speech/gemini.js";
import { findTool } from "./tools/index.js";
import { Workspace, workspaceRoot } from "./workspace/workspace.js";
import type { Logger } from "./logger.js";

function createEngine(logger: Logger, transcriptFallback?: TranscriptFallback): Engine {
  // Found once at start: env override, then the pinned copy, PATH and WinGet folders. A missing ffmpeg surfaces as a
  // clear tool error on first use, pointing at `framelens doctor`.
  const ffmpeg = findTool("ffmpeg")?.path ?? "ffmpeg";
  const ffprobe = findTool("ffprobe")?.path ?? "ffprobe";
  const tools = { ffmpeg, ffprobe, exec: execTool };
  return new Engine({
    tools,
    resolve: async (input, options) => {
      try {
        return await resolveSource(input, { ...options, log: (line) => logger.info(line) });
      } catch (error) {
        // Tier 3: a site that needs a login, and the user has logged in to the Frame Lens browser profile.
        if (!(error instanceof SourceError) || error.code !== "login_required" || !hasLoginProfile()) throw error;
        const id = `url-${createHash("sha1").update(input.trim()).digest("hex").slice(0, 10)}`;
        const ws = new Workspace(options.workspaceRoot, id);
        logger.info("login required; capturing through the Frame Lens browser profile", { id });
        const mediaPath = await captureVideo(input.trim(), ws.ensure("media"), tools, maxDownloadMb(process.env) * 1024 * 1024);
        const record = { id, kind: "url" as const, input, url: input.trim(), mediaPath, fetchedAt: new Date().toISOString(), tools: {} };
        ws.writeJson("source.json", record);
        return record;
      }
    },
    root: workspaceRoot(),
    logger,
    ...(transcriptFallback && { transcriptFallback }),
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "init") {
    const { files } = initProject(process.cwd());
    process.stderr.write(`framelens ${VERSION}: added ${files.join(" and ")} to ${process.cwd()}\n${INIT_NEXT_STEPS}`);
    return;
  }
  if (command === "doctor") {
    process.exitCode = await runDoctor({ prepare: process.argv.slice(3).includes("--prepare") });
    return;
  }
  if (command === "login") {
    const site = process.argv[3];
    if (!site) throw new InvalidInputError("Say which site: framelens login instagram (or facebook, x, threads, linkedin, vimeo, tiktok).");
    await login(site, (line) => process.stderr.write(line));
    return;
  }
  if (command === "logout") {
    process.stderr.write(logout() ? "The Frame Lens browser profile and its logins were deleted.\n" : "There was no Frame Lens browser profile.\n");
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  if (command !== undefined) {
    throw new ConfigError(`Unknown command "${command}". Run without arguments to start the MCP server, or "init" to add framelens to the current project.`);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof MissingKeyError)) throw error;
    // Start anyway: local tools work without a key, and every Gemini tool answers with the setup steps,
    // so the agent can pass them on instead of the tools silently missing from the session.
    const setupLogger = createLogger("info");
    const setupServer = createServer({
      analyzer: createSetupAnalyzer(error.message),
      logger: setupLogger,
      engine: createEngine(setupLogger),
    });
    await setupServer.connect(new StdioServerTransport());
    setupLogger.warn(`framelens ${VERSION} started without a Gemini key; local tools work, Gemini tools explain how to add one`);
    return;
  }
  const logger = createLogger(config.logLevel, undefined, [config.apiKey]);
  const analyzer = new CachedAnalyzer(createGeminiAnalyzer(config, logger), { ttlMs: config.cacheTtlMs });
  const server = createServer({ analyzer, logger, engine: createEngine(logger, geminiTranscriptFallback(analyzer)) });

  await server.connect(new StdioServerTransport());
  logger.info(`framelens ${VERSION} ready`, { model: config.model });
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError || error instanceof InvalidInputError
      ? error.message
      : `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[framelens] ERROR ${message}\n`);
  process.exit(1);
});

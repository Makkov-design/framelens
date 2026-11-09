#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGeminiAnalyzer } from "./analyzer.js";
import { CachedAnalyzer } from "./cache.js";
import { runCommand } from "./cli.js";
import { loadConfig } from "./config.js";
import { ConfigError, InvalidInputError, MissingKeyError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { createSetupAnalyzer } from "./setup.js";
import { VERSION } from "./version.js";
import { Engine, type TranscriptFallback } from "./engine.js";
import { execTool } from "./media/exec.js";
import { createHash } from "node:crypto";
import { capturableLogin, captureVideo, hasLoginProfile } from "./browser/capture.js";
import { maxDownloadMb, resolveSource, SourceError } from "./sources/index.js";
import { geminiTranscriptFallback } from "./speech/gemini.js";
import { ToolSetup } from "./tools/index.js";
import { chooseWorkspaceRoot, Workspace } from "./workspace/workspace.js";
import type { Logger } from "./logger.js";

function createEngine(logger: Logger, transcriptFallback?: TranscriptFallback): Engine {
  // Found once at start: env override, PATH, WinGet folders, then the pinned copy. When ffmpeg is nowhere, the bare
  // name stays and automatic setup downloads the pinned build on first use (unless FRAMELENS_AUTO_INSTALL=0).
  const setup = new ToolSetup({ log: (line) => logger.info(line) });
  const ffmpeg = setup.startPath("ffmpeg");
  const ffprobe = setup.startPath("ffprobe");
  const tools = { ffmpeg, ffprobe, exec: setup.wrapExec(execTool) };
  const workspace = chooseWorkspaceRoot();
  if (workspace.from !== "cwd") logger.info(`workspace folder ${workspace.root}: ${workspace.reason}`);
  return new Engine({
    tools,
    resolve: async (input, options) => {
      try {
        return await resolveSource(input, { ...options, log: (line) => logger.info(line), locate: (name, signal) => setup.locate(name, signal) });
      } catch (error) {
        // Tier 3: a site that needs a login, and the user has logged in to the Frame Lens browser profile.
        if (!(error instanceof SourceError) || error.code !== "login_required" || !hasLoginProfile() || !capturableLogin(input, error.detail ?? error.message)) throw error;
        const id = `url-${createHash("sha1").update(input.trim()).digest("hex").slice(0, 10)}`;
        const ws = new Workspace(options.workspaceRoot, id);
        logger.info("login required; capturing through the Frame Lens browser profile", { id });
        const mediaPath = await captureVideo(input.trim(), ws.ensure("media"), tools, maxDownloadMb(process.env) * 1024 * 1024);
        const record = { id, kind: "url" as const, input, url: input.trim(), mediaPath, fetchedAt: new Date().toISOString(), tools: {} };
        ws.writeJson("source.json", record);
        return record;
      }
    },
    root: workspace.root,
    logger,
    ...(transcriptFallback && { transcriptFallback }),
  });
}

async function main(): Promise<void> {
  const command = await runCommand(process.argv.slice(2));
  if (command.handled) {
    if (command.exitCode !== undefined) process.exitCode = command.exitCode;
    return;
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

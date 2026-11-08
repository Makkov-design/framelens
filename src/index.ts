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
import { resolveSource } from "./sources/index.js";
import { geminiTranscriptFallback } from "./speech/gemini.js";
import { findTool } from "./tools/index.js";
import { workspaceRoot } from "./workspace/workspace.js";
import type { Logger } from "./logger.js";

function createEngine(logger: Logger, transcriptFallback?: TranscriptFallback): Engine {
  // Found once at start: env override, then the pinned copy, PATH and WinGet folders. A missing ffmpeg surfaces as a
  // clear tool error on first use, pointing at `framelens doctor`.
  const ffmpeg = findTool("ffmpeg")?.path ?? "ffmpeg";
  const ffprobe = findTool("ffprobe")?.path ?? "ffprobe";
  return new Engine({
    tools: { ffmpeg, ffprobe, exec: execTool },
    resolve: (input, options) => resolveSource(input, { ...options, log: (line) => logger.info(line) }),
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

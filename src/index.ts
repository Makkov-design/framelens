#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGeminiAnalyzer } from "./analyzer.js";
import { CachedAnalyzer } from "./cache.js";
import { loadConfig } from "./config.js";
import { ConfigError, InvalidInputError, MissingKeyError } from "./errors.js";
import { INIT_NEXT_STEPS, initProject } from "./init.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { createSetupAnalyzer } from "./setup.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "init") {
    const { files } = initProject(process.cwd());
    process.stderr.write(`ytlens ${VERSION}: added ${files.join(" and ")} to ${process.cwd()}\n${INIT_NEXT_STEPS}`);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  if (command !== undefined) {
    throw new ConfigError(`Unknown command "${command}". Run without arguments to start the MCP server, or "init" to add ytlens to the current project.`);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof MissingKeyError)) throw error;
    // Start anyway: every tool answers with the setup steps, so the agent can pass them on
    // instead of the tools silently missing from the session.
    const setupLogger = createLogger("info");
    const setupServer = createServer({ analyzer: createSetupAnalyzer(error.message), logger: setupLogger });
    await setupServer.connect(new StdioServerTransport());
    setupLogger.warn(`ytlens ${VERSION} started without a Gemini key; every tool explains how to add one`);
    return;
  }
  const logger = createLogger(config.logLevel, undefined, [config.apiKey]);
  const analyzer = new CachedAnalyzer(createGeminiAnalyzer(config, logger), { ttlMs: config.cacheTtlMs });
  const server = createServer({ analyzer, logger });

  await server.connect(new StdioServerTransport());
  logger.info(`ytlens ${VERSION} ready`, { model: config.model });
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError || error instanceof InvalidInputError
      ? error.message
      : `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[ytlens] ERROR ${message}\n`);
  process.exit(1);
});

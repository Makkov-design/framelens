import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { Engine } from "../../src/engine.js";
import { registerLocalTools } from "../../src/local-tools.js";
import { silentLogger } from "../../src/logger.js";

/** The input schemas the local tools register, by tool name (nothing runs: the engine is only used by the handlers). */
export function toolShapes(): Record<string, z.ZodRawShape> {
  const shapes: Record<string, z.ZodRawShape> = {};
  const server = { registerTool: (name: string, config: { inputSchema: z.ZodRawShape }) => void (shapes[name] = config.inputSchema) };
  registerLocalTools(server as unknown as McpServer, {} as Engine, silentLogger);
  return shapes;
}

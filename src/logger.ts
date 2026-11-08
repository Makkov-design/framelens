import { LOG_LEVELS, type LogLevel } from "./config.js";

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

/**
 * stdout carries the MCP protocol, so logs must only ever go to stderr.
 * Every line passes through redaction so the API key cannot leak into logs.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  secrets: string[] = [],
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const redact = (text: string) =>
    secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), text);

  const log = (lvl: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (LOG_LEVELS.indexOf(lvl) > threshold) return;
    const suffix = fields ? ` ${JSON.stringify(fields, replacer)}` : "";
    write(redact(`[framelens] ${lvl.toUpperCase()} ${message}${suffix}`));
  };

  return { error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") };
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? `${value.name}: ${value.message}` : value;
}

export const silentLogger: Logger = createLogger("error", () => {});

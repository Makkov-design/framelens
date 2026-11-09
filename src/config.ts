import { ConfigError, MissingKeyError } from "./errors.js";

/** Flash-Lite: the free tier allows about 500 requests a day for it, against 20 for Flash. */
export const DEFAULT_MODEL = "gemini-flash-lite-latest";
/** Tried in order when a model's daily quota is used up or the model is unavailable. */
export const DEFAULT_FALLBACK_MODELS = ["gemini-flash-latest"];

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  apiKey: string;
  model: string;
  /** Models tried after `model` when its daily quota is used up or it does not exist. */
  fallbackModels: string[];
  timeoutMs: number;
  /** Retries after the first attempt on timeouts, server errors and per-minute rate limits. */
  maxRetries: number;
  /** 0 disables the result cache. */
  cacheTtlMs: number;
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  // Settings written for ytlens, the earlier name of this project, keep working.
  if (name.startsWith("FRAMELENS_")) {
    const legacy = env[`YTLENS_${name.slice("FRAMELENS_".length)}`]?.trim();
    if (legacy) return legacy;
  }
  return undefined;
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  }
  return value;
}

export function loadConfig(env: Env): Config {
  const apiKey = read(env, "GEMINI_API_KEY") ?? read(env, "GOOGLE_API_KEY");
  // Only the reason: the server then starts without the Gemini tools' key, and those tools add how to set one
  // (setup.ts), so the steps are said once.
  if (!apiKey) throw new MissingKeyError("GEMINI_API_KEY is not set.");

  if (apiKey.startsWith("${")) {
    // Claude Code passes `${VAR}` through literally when VAR is not set.
    throw new MissingKeyError(`GEMINI_API_KEY is not set in this environment (the MCP config passed the placeholder ${apiKey} through).`);
  }

  const logLevel = (read(env, "FRAMELENS_LOG_LEVEL") ?? "info").toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new ConfigError(`FRAMELENS_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}.`);
  }

  const model = read(env, "GEMINI_MODEL_NAME") ?? DEFAULT_MODEL;
  // Unlike the other settings, an empty value is meaningful here: it turns fallback models off.
  const fallbacks = env.FRAMELENS_FALLBACK_MODELS ?? env.YTLENS_FALLBACK_MODELS;
  const fallbackModels = (fallbacks === undefined ? DEFAULT_FALLBACK_MODELS : fallbacks.split(","))
    .map((name) => name.trim())
    .filter((name, i, all) => name && name !== model && all.indexOf(name) === i);

  return {
    apiKey,
    model,
    fallbackModels,
    timeoutMs: readInt(env, "FRAMELENS_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
    maxRetries: readInt(env, "FRAMELENS_MAX_RETRIES", 3, 0, 10),
    cacheTtlMs: readInt(env, "FRAMELENS_CACHE_TTL_MINUTES", 60, 0, 7 * 24 * 60) * 60_000,
    logLevel: logLevel as LogLevel,
  };
}

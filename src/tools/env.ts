import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/** Reads FRAMELENS_X, falling back to the legacy YTLENS_X (same rule as config.ts). */
export function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  if (name.startsWith("FRAMELENS_")) {
    const legacy = env[`YTLENS_${name.slice("FRAMELENS_".length)}`]?.trim();
    if (legacy) return legacy;
  }
  return undefined;
}

/** `~/.framelens`, or FRAMELENS_HOME when set (tests and portable installs). */
export function framelensHome(env: Env = process.env): string {
  return readEnv(env, "FRAMELENS_HOME") ?? join(homedir(), ".framelens");
}

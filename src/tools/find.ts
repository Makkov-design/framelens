import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ToolError } from "./errors.js";
import { framelensHome, readEnv, type Env } from "./env.js";
import { run } from "./run.js";
import { ytDlpPinnedPath } from "./ytdlp.js";

export type ToolName = "ffmpeg" | "ffprobe" | "yt-dlp";

export const TOOL_ENV: Record<ToolName, string> = {
  ffmpeg: "FRAMELENS_FFMPEG",
  ffprobe: "FRAMELENS_FFPROBE",
  "yt-dlp": "FRAMELENS_YTDLP",
};

export interface ToolLocation {
  name: ToolName;
  path: string;
  /** env: FRAMELENS_* override, pinned: downloaded by `doctor --prepare`, path: PATH, winget: WinGet folders */
  source: "env" | "pinned" | "path" | "winget";
}

export interface FindOptions {
  env?: Env;
  platform?: NodeJS.Platform;
}

function isFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Scripts are started through Node (see run.ts), so they need no execute bit.
    if (platform !== "win32" && !/\.(c|m)?js$/i.test(path)) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromPath(name: string, env: Env, platform: NodeJS.Platform): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  // spawn cannot start .cmd/.bat without a shell, so only real executables count on Windows.
  const exts = platform === "win32" ? [".exe", ".com"] : [""];
  for (const raw of pathValue.split(platform === "win32" ? ";" : delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** WinGet installs often are not on the PATH of an already-running app: look in its link and package folders. */
function fromWinget(name: ToolName, env: Env): string | undefined {
  const local = env.LOCALAPPDATA;
  if (!local) return undefined;
  const root = join(local, "Microsoft", "WinGet");
  const exe = `${name}.exe`;
  const link = join(root, "Links", exe);
  if (existsSync(link)) return link;
  const family = name === "yt-dlp" ? /yt-dlp/i : /ffmpeg/i;
  let packages: string[];
  try {
    packages = readdirSync(join(root, "Packages")).filter((p) => family.test(p));
  } catch {
    return undefined;
  }
  for (const pkg of packages) {
    const base = join(root, "Packages", pkg);
    const candidates = [join(base, exe), join(base, "bin", exe)];
    try {
      for (const d of readdirSync(base)) candidates.push(join(base, d, "bin", exe), join(base, d, exe));
    } catch {
      // unreadable package folder
    }
    for (const candidate of candidates) if (isFile(candidate, "win32")) return candidate;
  }
  return undefined;
}

/**
 * Looks for a tool: FRAMELENS_* override, then (yt-dlp only) the pinned copy, then PATH, then WinGet folders.
 * Returns undefined when it is nowhere. Throws when an override points at a missing file.
 */
export function findTool(name: ToolName, options: FindOptions = {}): ToolLocation | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const override = readEnv(env, TOOL_ENV[name]);
  if (override) {
    if (!isFile(override, platform)) {
      throw new ToolError("bad_override", `${TOOL_ENV[name]} points to "${override}", which is not an executable file.`);
    }
    return { name, path: override, source: "env" };
  }

  if (name === "yt-dlp") {
    const pinned = ytDlpPinnedPath(framelensHome(env), platform);
    if (pinned && isFile(pinned, platform)) return { name, path: pinned, source: "pinned" };
  }

  const found = fromPath(name, env, platform);
  if (found) return { name, path: found, source: "path" };

  if (platform === "win32") {
    const winget = fromWinget(name, env);
    if (winget) return { name, path: winget, source: "winget" };
  }
  return undefined;
}

const versionCache = new Map<string, string>();

/** The version a tool reports (`-version` / `--version`); undefined when it does not answer. */
export async function readToolVersion(location: ToolLocation, signal?: AbortSignal): Promise<string | undefined> {
  const key = `${location.name}:${location.path}`;
  const cached = versionCache.get(key);
  if (cached) return cached;
  try {
    const args = location.name === "yt-dlp" ? ["--version"] : ["-version"];
    const result = await run(location.path, args, { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
    if (result.code !== 0) return undefined;
    const line = result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    const version = location.name === "yt-dlp" ? line : /^\w+ version (\S+)/.exec(line)?.[1];
    if (version) versionCache.set(key, version);
    return version || undefined;
  } catch {
    return undefined;
  }
}

/** Like findTool, but throws a message that says how to get the tool. */
export function requireTool(name: ToolName, options: FindOptions = {}): ToolLocation {
  const found = findTool(name, options);
  if (found) return found;
  throw new ToolError("not_found", missingToolMessage(name));
}

export function missingToolMessage(name: ToolName): string {
  if (name === "yt-dlp") {
    return "yt-dlp is not installed. Run `npx framelens doctor --prepare` to download the pinned version, or set FRAMELENS_YTDLP to its path.";
  }
  return (
    `${name} is not installed. Install ffmpeg (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg, ` +
    `Linux: apt install ffmpeg) or set ${TOOL_ENV[name]} to its path. \`npx framelens doctor\` shows what is found.`
  );
}

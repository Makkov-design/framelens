import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError } from "./errors.js";
import { framelensHome, type Env } from "./env.js";

/**
 * The yt-dlp release Frame Lens downloads. Chosen more than two weeks after its release (2026-10-21), so a broken
 * or hijacked release would have been noticed; hashes are from that release's SHA2-256SUMS.
 */
export const YTDLP_PIN = {
  version: "2026.10.21",
  assets: {
    "win32-x64": { file: "yt-dlp.exe", sha256: "33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555" },
    "linux-x64": { file: "yt-dlp_linux", sha256: "d8bd33fca9d5b23bd5b9952b3fca36db5c46331933fda9f598a3da14ce2c243f" },
    "linux-arm64": { file: "yt-dlp_linux_aarch64", sha256: "e137c2171b0b8ef648e6136e86aa70c65923e93e434f01c93901d64744b190aa" },
    "darwin-x64": { file: "yt-dlp_macos", sha256: "7a6fe71d7d680f1fb0ac18d4949873d77db2859e90017c0f44bd94b23be4ee40" },
    "darwin-arm64": { file: "yt-dlp_macos", sha256: "7a6fe71d7d680f1fb0ac18d4949873d77db2859e90017c0f44bd94b23be4ee40" },
  },
} as const;

type AssetKey = keyof typeof YTDLP_PIN.assets;

function assetFor(platform: NodeJS.Platform, arch: string) {
  return YTDLP_PIN.assets[`${platform}-${arch}` as AssetKey];
}

/** Where the pinned binary lives (it may not exist yet). undefined on platforms with no pinned build. */
export function ytDlpPinnedPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (!assetFor(platform, arch)) return undefined;
  return join(home, "tools", "yt-dlp", YTDLP_PIN.version, platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

export interface PrepareOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  /** Replaces the GitHub releases URL (tests). */
  baseUrl?: string;
  /** Replaces the pinned hash (tests). */
  expectedSha256?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface PrepareResult {
  path: string;
  version: string;
  /** false when the verified file was already there. */
  downloaded: boolean;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Downloads the pinned yt-dlp into ~/.framelens/tools/yt-dlp/<version>/ and checks it against the hash recorded in
 * code and against the release's own SHA2-256SUMS. A file that fails either check is never kept.
 */
export async function prepareYtDlp(options: PrepareOptions = {}): Promise<PrepareResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = assetFor(platform, arch);
  const target = ytDlpPinnedPath(framelensHome(options.env ?? process.env), platform, arch);
  if (!asset || !target) {
    throw new ToolError(
      "unsupported_platform",
      `No pinned yt-dlp build for ${platform}/${arch}. Install yt-dlp yourself and set FRAMELENS_YTDLP to its path.`,
    );
  }
  const expected = options.expectedSha256 ?? asset.sha256;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchFn ?? fetch;
  const base = options.baseUrl ?? `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_PIN.version}`;

  if (existsSync(target)) {
    if (sha256(readFileSync(target)) === expected) return { path: target, version: YTDLP_PIN.version, downloaded: false };
    log("The yt-dlp file on disk does not match the pinned hash; downloading it again.");
    rmSync(target, { force: true });
  }

  const get = async (url: string): Promise<Uint8Array> => {
    let response: Response;
    try {
      response = await doFetch(url, { redirect: "follow", signal: options.signal });
    } catch (error) {
      throw new ToolError("download_failed", `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new ToolError("download_failed", `Could not download ${url}: HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  };

  log(`Downloading yt-dlp ${YTDLP_PIN.version} (${asset.file}) from github.com/yt-dlp/yt-dlp ...`);
  const binary = await get(`${base}/${asset.file}`);
  const actual = sha256(binary);
  if (actual !== expected) {
    throw new ToolError("checksum", `The downloaded yt-dlp has SHA-256 ${actual}, expected ${expected}. It was discarded.`);
  }
  const sums = new TextDecoder().decode(await get(`${base}/SHA2-256SUMS`));
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${asset.file}`) || l.trim().endsWith(`*${asset.file}`));
  const published = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (published !== actual) {
    throw new ToolError("checksum", `The release's SHA2-256SUMS does not list ${actual} for ${asset.file}. The download was discarded.`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  writeFileSync(partial, binary);
  if (platform !== "win32") chmodSync(partial, 0o755);
  renameSync(partial, target);
  log(`Saved ${target}`);
  return { path: target, version: YTDLP_PIN.version, downloaded: true };
}

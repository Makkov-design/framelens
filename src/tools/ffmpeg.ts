import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { createInflateRaw } from "node:zlib";
import { ToolError } from "./errors.js";
import { framelensHome, type Env } from "./env.js";

export interface FfmpegFile {
  tool: "ffmpeg" | "ffprobe";
  /** Path of the binary inside the archive. */
  entry: string;
  /** SHA-256 of the unpacked binary. */
  sha256: string;
}

export interface FfmpegArchive {
  url: string;
  /** SHA-256 of the archive as published. */
  sha256: string;
  bytes: number;
  files: FfmpegFile[];
}

export interface FfmpegAsset {
  /** Who builds it, for messages. */
  source: string;
  archives: FfmpegArchive[];
}

const RIEDL = "https://ffmpeg.martin-riedl.de/download";

/**
 * The ffmpeg and ffprobe builds Frame Lens downloads when neither is installed: FFmpeg 9.0.2 (released 2026-09-20)
 * from the static builders linked on ffmpeg.org's download page, Gyan Doshi's essentials build for Windows (from his
 * GitHub release) and Martin Riedl's build server for macOS and Linux. Each archive was fetched once and hashed; the
 * hashes match the ones the builders publish (GitHub's asset digest, the server's .sha256 files). The binaries'
 * own hashes are checked again after unpacking.
 */
export const FFMPEG_PIN: { version: string; assets: Record<string, FfmpegAsset> } = {
  version: "9.0.2",
  assets: {
    "win32-x64": {
      source: "gyan.dev (github.com/GyanD/codexffmpeg)",
      archives: [
        {
          url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
          sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
          bytes: 114_768_076,
          files: [
            { tool: "ffmpeg", entry: "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe", sha256: "3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec" },
            { tool: "ffprobe", entry: "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe", sha256: "f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52" },
          ],
        },
      ],
    },
    "darwin-arm64": {
      source: "ffmpeg.martin-riedl.de",
      archives: [
        {
          url: `${RIEDL}/macos/arm64/1789931890_9.0.2/ffmpeg.zip`,
          sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
          bytes: 28_395_699,
          files: [{ tool: "ffmpeg", entry: "ffmpeg", sha256: "2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384" }],
        },
        {
          url: `${RIEDL}/macos/arm64/1789931890_9.0.2/ffprobe.zip`,
          sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
          bytes: 28_317_701,
          files: [{ tool: "ffprobe", entry: "ffprobe", sha256: "2738aa46a7f9acbc8ab09a6715554c90f7de603171ac403726765685df6a0059" }],
        },
      ],
    },
    "darwin-x64": {
      source: "ffmpeg.martin-riedl.de",
      archives: [
        {
          url: `${RIEDL}/macos/amd64/1789931006_9.0.2/ffmpeg.zip`,
          sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
          bytes: 33_816_391,
          files: [{ tool: "ffmpeg", entry: "ffmpeg", sha256: "b25689cf2211c0582d317e849912769a1f1c93904fe102c485b5364a425633d1" }],
        },
        {
          url: `${RIEDL}/macos/amd64/1789931006_9.0.2/ffprobe.zip`,
          sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
          bytes: 33_719_233,
          files: [{ tool: "ffprobe", entry: "ffprobe", sha256: "b5df9964b0c2048318fafedcd4e3bbafbc561033cee77de8da1840685d8a9d0d" }],
        },
      ],
    },
    "linux-x64": {
      source: "ffmpeg.martin-riedl.de",
      archives: [
        {
          url: `${RIEDL}/linux/amd64/1789931100_9.0.2/ffmpeg.zip`,
          sha256: "fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f",
          bytes: 33_326_445,
          files: [{ tool: "ffmpeg", entry: "ffmpeg", sha256: "2624cfce1acdb259fe72b6d020dac937a1e7e66cf3578d8c4d43704e69a42cba" }],
        },
        {
          url: `${RIEDL}/linux/amd64/1789931100_9.0.2/ffprobe.zip`,
          sha256: "3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32",
          bytes: 33_223_234,
          files: [{ tool: "ffprobe", entry: "ffprobe", sha256: "fa300ee31cd55e7a8d052f16d017fde3b68d842dff39e0c29575ced5278947d6" }],
        },
      ],
    },
  },
};

export function ffmpegAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch, pin = FFMPEG_PIN): FfmpegAsset | undefined {
  return pin.assets[`${platform}-${arch}`];
}

/** Where the pinned ffmpeg or ffprobe lives (it may not exist yet); undefined on platforms with no pinned build. */
export function ffmpegPinnedPath(home: string, tool: "ffmpeg" | "ffprobe", platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (!ffmpegAsset(platform, arch)) return undefined;
  return join(home, "tools", "ffmpeg", FFMPEG_PIN.version, platform === "win32" ? `${tool}.exe` : tool);
}

export interface PrepareFfmpegOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  /** Replaces the pinned archives (tests). */
  asset?: FfmpegAsset;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface PrepareFfmpegResult {
  ffmpeg: string;
  ffprobe: string;
  version: string;
  source: string;
  /** false when verified copies were already there. */
  downloaded: boolean;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Streams a download to `file`, hashing it on the way; stops past `maxBytes`. Returns the SHA-256. */
async function downloadTo(url: string, file: string, maxBytes: number, doFetch: typeof fetch, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await doFetch(url, { redirect: "follow", ...(signal && { signal }) });
  } catch (error) {
    throw new ToolError("download_failed", `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) throw new ToolError("download_failed", `Could not download ${url}: HTTP ${response.status}.`);
  const hash = createHash("sha256");
  const fd = openSync(file, "w");
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ToolError("download_failed", `${url} is larger than the pinned archive; the download was stopped.`);
      }
      hash.update(value);
      writeSync(fd, value);
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("download_failed", `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Finds one file in a ZIP on disk by its central-directory name (stored or deflate; no ZIP64). */
function findZipEntry(path: string, name: string): ZipEntry {
  const fd = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const tailLength = Math.min(length, 22 + 65_535);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, length - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ToolError("checksum", "The downloaded archive is not a ZIP file.");
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);
    for (let i = 0, p = 0; i < count && p + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) break;
      const nameLength = dir.readUInt16LE(p + 28);
      const entryName = dir.toString("utf8", p + 46, p + 46 + nameLength);
      if (entryName === name) {
        const entry = { method: dir.readUInt16LE(p + 10), compressedSize: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24), localOffset: dir.readUInt32LE(p + 42) };
        const local = Buffer.alloc(30);
        readSync(fd, local, 0, 30, entry.localOffset);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new ToolError("checksum", `The archive entry ${name} is corrupt.`);
        return { ...entry, localOffset: entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) };
      }
      p += 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
  } finally {
    closeSync(fd);
  }
  throw new ToolError("checksum", `The archive does not contain ${name}.`);
}

/** Unpacks one entry of a ZIP on disk to `out`, hashing it; returns the SHA-256 of what was written. */
async function unzipEntry(archive: string, name: string, out: string): Promise<string> {
  const entry = findZipEntry(archive, name);
  if (entry.method !== 0 && entry.method !== 8) throw new ToolError("checksum", `The archive entry ${name} uses compression ${entry.method}.`);
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const input = createReadStream(archive, { start: entry.localOffset, end: entry.localOffset + entry.compressedSize - 1 });
  if (entry.method === 8) await pipeline(input, createInflateRaw(), tap, createWriteStream(out));
  else await pipeline(input, tap, createWriteStream(out));
  return hash.digest("hex");
}

/**
 * Downloads the pinned ffmpeg and ffprobe into ~/.framelens/tools/ffmpeg/<version>/: every archive is checked
 * against its pinned SHA-256 before anything is unpacked, and every binary against its own pinned SHA-256 before it
 * is put in place. Nothing that fails a check is kept, and nothing downloaded is run here.
 */
export async function prepareFfmpeg(options: PrepareFfmpegOptions = {}): Promise<PrepareFfmpegResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? ffmpegAsset(platform, arch);
  if (!asset) {
    throw new ToolError(
      "unsupported_platform",
      `No pinned ffmpeg build for ${platform}/${arch}. Install ffmpeg yourself and set FRAMELENS_FFMPEG and FRAMELENS_FFPROBE to its programs.`,
    );
  }
  const dir = join(framelensHome(options.env ?? process.env), "tools", "ffmpeg", FFMPEG_PIN.version);
  const exe = platform === "win32" ? ".exe" : "";
  const target = { ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) };
  const { ffmpeg, ffprobe } = target;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchFn ?? fetch;
  const files = asset.archives.flatMap((a) => a.files);
  const verified = (f: FfmpegFile) => existsSync(target[f.tool]) && hashFile(target[f.tool]) === f.sha256;
  if (files.every(verified)) return { ffmpeg, ffprobe, version: FFMPEG_PIN.version, source: asset.source, downloaded: false };

  mkdirSync(dir, { recursive: true });
  for (const archive of asset.archives) {
    const missing = archive.files.filter((f) => !verified(f));
    if (!missing.length) continue;
    const download = join(dir, `.download-${process.pid}-${Date.now()}.zip`);
    try {
      log(`Downloading ffmpeg ${FFMPEG_PIN.version} (${Math.round(archive.bytes / 1024 / 1024)} MB) from ${new URL(archive.url).host} ...`);
      const actual = await downloadTo(archive.url, download, Math.ceil(archive.bytes * 1.01) + 1024, doFetch, options.signal);
      if (actual !== archive.sha256) {
        throw new ToolError("checksum", `The downloaded ffmpeg archive has SHA-256 ${actual}, expected ${archive.sha256}. It was discarded.`);
      }
      for (const file of missing) {
        const partial = `${target[file.tool]}.part`;
        try {
          const unpacked = await unzipEntry(download, file.entry, partial);
          if (unpacked !== file.sha256) {
            throw new ToolError("checksum", `The unpacked ${file.tool} has SHA-256 ${unpacked}, expected ${file.sha256}. It was discarded.`);
          }
          if (platform !== "win32") chmodSync(partial, 0o755);
          rmSync(target[file.tool], { force: true });
          renameSync(partial, target[file.tool]);
        } finally {
          rmSync(partial, { force: true });
        }
      }
    } finally {
      rmSync(download, { force: true });
    }
  }
  log(`Saved ffmpeg and ffprobe ${FFMPEG_PIN.version} in ${dir}`);
  return { ffmpeg, ffprobe, version: FFMPEG_PIN.version, source: asset.source, downloaded: true };
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidInputError } from "../errors.js";
import { parseVideoRef } from "../youtube.js";
import { readToolVersion, requireTool, type Env, type ToolLocation } from "../tools/index.js";
import { cobaltMayRetry, fetchWithCobalt } from "./cobalt.js";
import { SourceError } from "./errors.js";
import { newestInboxFile } from "./inbox.js";
import type { ResolveOptions, SourceKind, SourceRecord } from "./types.js";
import { fetchWithYtDlp, maxDownloadMb, type FetchResult } from "./ytdlp.js";

export type Classified =
  | { kind: "youtube"; id: string; url: string }
  | { kind: "url"; id: string; url: string }
  | { kind: "file"; id: string; path: string };

const sha10 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 10);
const HTTP = /^https?:\/\//i;
const BARE_ID = /^[A-Za-z0-9_-]{11}$/;

/** `file-<sha1 of path+size+mtime, 10 hex>` */
export function fileId(path: string): string {
  const stat = statSync(path);
  return `file-${sha10(`${path}|${stat.size}|${Math.floor(stat.mtimeMs)}`)}`;
}

/** Decides what an input is, without touching the network. Throws SourceError for input that is nothing usable. */
export function classifyInput(rawInput: string, env: Env = process.env): Classified {
  let input = rawInput.trim().replace(/^["']|["']$/g, "");
  if (!input) throw new SourceError("bad_input", "The source is empty. Pass a YouTube link or ID, any video link, a file path, or \"inbox\".");

  if (input.toLowerCase() === "inbox") return fileClassification(newestInboxFile(env));
  if (/^file:\/\//i.test(input)) input = fileURLToPath(input);

  if (HTTP.test(input)) {
    try {
      return { kind: "youtube", id: ytId(input), url: parseVideoRef(input).url };
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
    }
    try {
      new URL(input);
    } catch {
      throw new SourceError("bad_input", `"${input.slice(0, 200)}" is not a valid link.`);
    }
    return { kind: "url", id: `url-${sha10(input)}`, url: input };
  }

  const path = resolve(input);
  if (existsSync(path)) {
    if (!statSync(path).isFile()) throw new SourceError("bad_input", `"${path}" is a folder, not a video file.`);
    return fileClassification(path);
  }
  // A bare video ID or a scheme-less YouTube link.
  if (BARE_ID.test(input) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(input)) {
    const ref = parseVideoRef(input);
    return { kind: "youtube", id: `yt-${ref.videoId}`, url: ref.url };
  }
  throw new SourceError("file_missing", `Not a link and no such file: "${input.slice(0, 300)}". Check the path, or pass a YouTube link or ID.`);
}

function ytId(input: string): string {
  return `yt-${parseVideoRef(input).videoId}`;
}

function fileClassification(path: string): Classified {
  const abs = resolve(path);
  return { kind: "file", id: fileId(abs), path: abs };
}

function readRecord(dir: string): SourceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as SourceRecord;
    return record && typeof record.mediaPath === "string" && typeof record.id === "string" ? record : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(dir: string, record: SourceRecord): void {
  const { reused: _reused, ...stored } = record;
  const tmp = join(dir, "source.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
  renameSync(tmp, join(dir, "source.json"));
}

/**
 * Turns a YouTube link/ID, any http(s) link, a local path or the keyword `inbox` into a local media file and writes
 * `<workspaceRoot>/<id>/source.json`. Links are downloaded once; asking again reuses the workspace copy.
 */
export async function resolveSource(input: string, options: ResolveOptions): Promise<SourceRecord> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const target = classifyInput(input, env);
  const dir = join(resolve(options.workspaceRoot), target.id);
  mkdirSync(dir, { recursive: true });
  const fetchedAt = new Date().toISOString();

  if (target.kind === "file") {
    const record: SourceRecord = {
      id: target.id,
      kind: "file",
      input,
      title: basename(target.path, extname(target.path)),
      mediaPath: target.path,
      fetchedAt,
      tools: {},
    };
    writeRecord(dir, record);
    return record;
  }

  const previous = readRecord(dir);
  if (previous && previous.id === target.id && previous.kind === target.kind && existsSync(previous.mediaPath)) {
    log(`Reusing ${previous.mediaPath}`);
    const captions = previous.captions?.filter((c) => existsSync(c.path));
    return { ...previous, input, captions: captions?.length ? captions : undefined, reused: true };
  }

  const locate = options.locate ?? (async (name) => requireTool(name, { env, ...options.find }));
  let ytdlp: ToolLocation;
  let ffmpeg: ToolLocation;
  let fetched: FetchResult;
  try {
    ytdlp = await locate("yt-dlp", options.signal);
    ffmpeg = await locate("ffmpeg", options.signal);
    fetched = await fetchWithYtDlp({
      url: target.url,
      mediaDir: join(dir, "media"),
      ytdlp,
      ffmpeg,
      env,
      signal: options.signal,
      log,
      timeoutMs: options.downloadTimeoutMs ?? 30 * 60_000,
    });
  } catch (error) {
    // Opt-in: the user's own cobalt instance gets the links yt-dlp could not fetch (never a bot check).
    if (!cobaltMayRetry(error, env)) throw error;
    const first = error instanceof Error ? error.message : String(error);
    log(`yt-dlp could not fetch the link; trying the cobalt instance in FRAMELENS_COBALT_URL`);
    let viaCobalt;
    try {
      viaCobalt = await fetchWithCobalt({
        url: target.url,
        mediaDir: join(dir, "media"),
        env,
        maxBytes: maxDownloadMb(env) * 1024 * 1024,
        log,
        ...(options.signal && { signal: options.signal }),
        ...(options.fetchFn && { fetchFn: options.fetchFn }),
        timeoutMs: options.downloadTimeoutMs ?? 30 * 60_000,
      });
    } catch (cobaltError) {
      const second = cobaltError instanceof Error ? cobaltError.message : String(cobaltError);
      const code = error instanceof SourceError ? error.code : "download_failed";
      throw new SourceError(code, `${first} (${second})`);
    }
    const record: SourceRecord = {
      id: target.id,
      kind: target.kind as SourceKind,
      input,
      url: target.url,
      title: viaCobalt.title,
      mediaPath: viaCobalt.mediaPath,
      fetchedAt,
      tools: { cobalt: viaCobalt.instance },
    };
    writeRecord(dir, record);
    return record;
  }

  const record: SourceRecord = {
    id: target.id,
    kind: target.kind as SourceKind,
    input,
    url: target.kind === "youtube" ? target.url : (fetched.canonicalUrl ?? target.url),
    title: fetched.title,
    mediaPath: fetched.mediaPath,
    captions: fetched.captions.length ? fetched.captions : undefined,
    fetchedAt,
    tools: {
      ytDlp: await readToolVersion(ytdlp, options.signal),
      ffmpeg: await readToolVersion(ffmpeg, options.signal),
    },
  };
  writeRecord(dir, record);
  return record;
}

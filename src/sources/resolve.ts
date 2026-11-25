import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidInputError, quotesThirdParty } from "../errors.js";
import { CancelledError, callSignal, singleFlight, throwIfCancelled } from "../runtime/call.js";
import { parseVideoRef } from "../youtube.js";
import { realInside } from "../workspace/workspace.js";
import { readToolVersion, requireTool, type Env, type ToolLocation } from "../tools/index.js";
import { anySignal } from "../tools/download.js";
import { checkHop, cobaltMayRetry, fetchWithCobalt, pinnedGet, systemLookup, type Lookup } from "./cobalt.js";
import { SourceError } from "./errors.js";
import { inboxNote, newestInboxFile } from "./inbox.js";
import type { ResolveOptions, SourceKind, SourceRecord } from "./types.js";
import { captionLanguage, fetchWithYtDlp, maxDownloadMb, type FetchResult } from "./ytdlp.js";
import { hideCredentials, oneLine } from "../text.js";

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
  if (/^file:\/\//i.test(input)) {
    try {
      input = fileURLToPath(input);
    } catch {
      throw new SourceError("bad_input", `"${input.slice(0, 200)}" is not a file on this computer: a file:// link must have no host (file:///path/to/video.mp4). Pass the path instead.`);
    }
  }

  if (HTTP.test(input)) {
    try {
      return { kind: "youtube", id: ytId(input), url: parseVideoRef(input).url };
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
    }
    try {
      new URL(input);
    } catch {
      throw new SourceError("bad_input", `"${hideCredentials(input).slice(0, 200)}" is not a valid link.`);
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
  throw new SourceError("file_missing", `Not a link and no such file: "${input.slice(0, 300)}". Check the path, or pass a YouTube link or ID.${relativeHint(input)}`);
}

/**
 * A relative path is taken from the server's working folder, which is rarely the user's project: Claude Desktop starts
 * servers in C:\Windows\System32 on Windows and in / on macOS.
 */
function relativeHint(input: string): string {
  if (isAbsolute(input)) return "";
  return (
    ` A relative path is taken from the server's working folder, ${process.cwd()}, not from your project ` +
    "(Claude Desktop starts servers in C:\\Windows\\System32 on Windows and in / on macOS): pass the file's absolute path."
  );
}

function ytId(input: string): string {
  return `yt-${parseVideoRef(input).videoId}`;
}

function fileClassification(path: string): Classified {
  const abs = resolve(path);
  return { kind: "file", id: fileId(abs), path: abs };
}

/**
 * The stored record, or undefined when it is missing or not in the shape Frame Lens writes (a hand-edited or planted
 * file): then the link is downloaded again instead of failing on a field of the wrong type.
 */
function readRecord(dir: string): SourceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as SourceRecord;
    if (!record || typeof record !== "object" || typeof record.mediaPath !== "string" || typeof record.id !== "string") return undefined;
    const text = (v: unknown) => v === undefined || typeof v === "string";
    if (!text(record.url) || !text(record.title) || !text(record.sourceUrl) || !text(record.fetchedAt)) return undefined;
    if (record.tools !== undefined && (typeof record.tools !== "object" || record.tools === null || Array.isArray(record.tools))) return undefined;
    if (record.captions !== undefined) {
      if (!Array.isArray(record.captions)) return undefined;
      if (!record.captions.every((c) => c && typeof c === "object" && typeof c.path === "string" && typeof c.language === "string")) return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

/** `stored` is an http(s) link on the same host as `link`, the shape yt-dlp's canonical page address has. */
function sameSiteLink(stored: unknown, link: string): stored is string {
  if (typeof stored !== "string") return false;
  try {
    const a = new URL(stored);
    const b = new URL(link);
    const site = (h: string) => h.toLowerCase().replace(/^(www|m)\./, "");
    return (a.protocol === "http:" || a.protocol === "https:") && !a.username && !a.password && site(a.hostname) === site(b.hostname);
  } catch {
    return false;
  }
}

/** `path` is a file whose real location is inside `folder`, itself really inside `root` (no `..`, no link out). */
function insideFolder(path: string, folder: string, root: string): boolean {
  try {
    return realInside(folder, root) && realInside(path, folder) && realpathSync(path) !== realpathSync(folder) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeRecord(dir: string, record: SourceRecord): void {
  // A cancelled call records nothing: a later call would take it for a finished download.
  throwIfCancelled();
  const { reused: _reused, inboxNote: _note, ...stored } = record;
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
  const target = classifyInput(input, env);
  const dir = join(resolve(options.workspaceRoot), target.id);
  if (target.kind === "file") {
    mkdirSync(dir, { recursive: true });
    return recordFile(dir, target, input, new Date().toISOString(), env);
  }
  // One download per workspace at a time: agents often call `transcript` and `frames` on a new link together, and a
  // second download would delete the first one's files (and a failing first call would remove the workspace).
  const signal = options.signal ?? callSignal();
  const { value, shared } = await singleFlight(inFlight, dir, signal, () => fetchIntoWorkspace(dir, target, input, env, { ...options, ...(signal && { signal }) }), "The download");
  return shared ? { ...value, input, reused: true } : value;
}

const LINK_WORDING = { who: "The link", what: "an address" };
const MAX_REDIRECTS = 5;

/**
 * yt-dlp follows a link's redirects itself, with no check of where they go. For a link that is not YouTube, the
 * redirects its server sends to a plain GET are walked first with the check the cobalt and \`exact\` downloads use
 * (\`checkHop\`): a hop to another host must be https to a public address, so a public link cannot send the download to
 * this computer, the local network or a cloud metadata address. The link's own host may be local (the user's choice).
 * Not covered (README, SECURITY.md): a server that answers yt-dlp differently from this request, the requests a site
 * extractor makes on its own, and a link this computer cannot reach directly (behind a proxy), which yt-dlp is left
 * to report.
 */
export async function checkLinkRedirects(link: string, signal?: AbortSignal, lookup: Lookup = systemLookup): Promise<void> {
  const first = new URL(link);
  const stop = anySignal(signal, AbortSignal.timeout(15_000));
  let current = first;
  for (let hop = 0; ; hop++) {
    // The user's own link may carry a user name and password (theirs to give). A redirect on the link's own origin may
    // keep exactly those (a relative Location inherits them); any other credentials, or any on another origin, are
    // refused: a redirect may not add or change them.
    let address: string | undefined;
    if (hop > 0 && (current.username || current.password)) {
      if (current.origin !== first.origin || current.username !== first.username || current.password !== first.password) {
        throw new SourceError("download_failed", "The link redirected to an address with a user name or password; it was not downloaded.");
      }
    } else if (hop > 0) address = await checkHop(current, first, lookup, LINK_WORDING);
    let res;
    try {
      res = await pinnedGet(current, address, stop);
    } catch {
      if (signal?.aborted) throw new CancelledError();
      throwIfCancelled();
      return;
    }
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return;
    if (hop === MAX_REDIRECTS) throw new SourceError("download_failed", `The link redirects more than ${MAX_REDIRECTS} times; it was not downloaded.`);
    try {
      current = new URL(location, current);
    } catch {
      throw new SourceError("download_failed", "The link redirected to an address that is not valid; it was not downloaded.");
    }
  }
}

/** Downloads in progress, by workspace folder. */
const inFlight = new Map<string, { promise: Promise<SourceRecord>; signal?: AbortSignal }>();

async function fetchIntoWorkspace(dir: string, target: Exclude<Classified, { kind: "file" }>, input: string, env: Env, options: ResolveOptions): Promise<SourceRecord> {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  // yt-dlp writes into media/ and stale source.* files there are removed first: never through a link out of the
  // workspace folder (one that came with a project's .framelens).
  const media = join(dir, "media");
  if (!realInside(dir, options.workspaceRoot) || (existsSync(media) && !realInside(media, options.workspaceRoot))) {
    throw new SourceError("bad_input", `${dir} leads out of the workspace folder through a link, so nothing is downloaded into it. Remove it and try again.`);
  }
  const fetchedAt = new Date().toISOString();
  try {
    return await fetchLink(dir, target, input, fetchedAt, env, options);
  } catch (error) {
    // A link that could not be fetched leaves no empty workspace behind (only the one this call made).
    if (!existed) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function recordFile(dir: string, target: Extract<Classified, { kind: "file" }>, input: string, fetchedAt: string, env: Env): SourceRecord {
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
  // `inbox` took the newest video; say so when a page reading is there too.
  const note = input.trim().replace(/^["']|["']$/g, "").toLowerCase() === "inbox" ? inboxNote(env, "media") : undefined;
  return note ? { ...record, inboxNote: note } : record;
}

async function fetchLink(
  dir: string,
  target: Exclude<Classified, { kind: "file" }>,
  input: string,
  fetchedAt: string,
  env: Env,
  options: ResolveOptions,
): Promise<SourceRecord> {
  const log = options.log ?? (() => {});
  const previous = readRecord(dir);
  // A `.framelens/` folder can come with a project someone else made: a record is only reused for the same link, and
  // only files inside its own media folder are read.
  const media = join(dir, "media");
  if (previous && previous.id === target.id && previous.kind === target.kind && previous.sourceUrl === target.url && insideFolder(previous.mediaPath, media, options.workspaceRoot)) {
    log(`Reusing ${previous.mediaPath}`);
    const captions = previous.captions?.filter((c) => insideFolder(c.path, media, options.workspaceRoot));
    // Only the fields Frame Lens writes are carried over, its text on one line: a planted record's free text (an
    // inbox note, a warning) is not shown as Frame Lens's own words.
    const record: SourceRecord = {
      id: previous.id,
      kind: previous.kind,
      input,
      // The page's own address as yt-dlp reported it may differ from the link (a canonical link); a stored one must be
      // an http(s) link on the same site, else it is dropped.
      ...(sameSiteLink(previous.url, target.url) && { url: oneLine(previous.url, 2000) }),
      sourceUrl: target.url,
      ...(typeof previous.title === "string" && { title: oneLine(previous.title, 500) }),
      mediaPath: previous.mediaPath,
      ...(captions?.length && { captions: captions.map((c) => ({ path: c.path, language: captionLanguage(String(c.language)), auto: c.auto === true })) }),
      fetchedAt: oneLine(previous.fetchedAt, 40),
      tools: Object.fromEntries(Object.entries(previous.tools ?? {}).filter(([k]) => ["ytDlp", "ffmpeg", "cobalt"].includes(k)).map(([k, v]) => [k, oneLine(v, 200)])),
      reused: true,
    };
    return record;
  }

  // yt-dlp follows redirects without a hop check: the link's own redirects are walked first.
  if (target.kind === "url") await (options.checkRedirects ?? checkLinkRedirects)(target.url, options.signal);
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
      throw new SourceError(code, `${first} (${second})`, {
        ...(error instanceof SourceError && { accessControl: error.accessControl, ...(error.detail && { detail: error.detail }) }),
        thirdParty: quotesThirdParty(error) || quotesThirdParty(cobaltError),
      });
    }
    const record: SourceRecord = {
      id: target.id,
      kind: target.kind as SourceKind,
      input,
      url: target.url,
      sourceUrl: target.url,
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
    sourceUrl: target.url,
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

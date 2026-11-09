import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { readEnv, run, ToolError, type Env, type ToolLocation } from "../tools/index.js";
import { cookieArgs, redactArgs } from "./cookies.js";
import { SourceError } from "./errors.js";
import type { CaptionTrack } from "./types.js";

/** Best video up to 1080p plus best audio; falls back to a single file, then to anything. */
export const FORMAT = "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b";
const SUB_EXTENSIONS = new Set([".json3", ".vtt", ".srt", ".ttml", ".srv1", ".srv2", ".srv3", ".ass", ".lrc"]);

export const DEFAULT_MAX_DOWNLOAD_MB = 2048;

export function maxDownloadMb(env: Env): number {
  const raw = readEnv(env, "FRAMELENS_MAX_DOWNLOAD_MB");
  if (raw === undefined) return DEFAULT_MAX_DOWNLOAD_MB;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1) {
    throw new SourceError("bad_input", `FRAMELENS_MAX_DOWNLOAD_MB must be a whole number of megabytes, got "${raw}".`);
  }
  return value;
}

/** A readable platform name for a link, for messages. */
export function platformName(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  } catch {
    return "this site";
  }
  const known: [RegExp, string][] = [
    [/(^|\.)instagram\.com$/, "Instagram"],
    [/(^|\.)tiktok\.com$/, "TikTok"],
    [/(^|\.)(facebook|fb)\.com$|^fb\.watch$/, "Facebook"],
    [/(^|\.)(twitter|x)\.com$/, "X (Twitter)"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
    [/(^|\.)vimeo\.com$/, "Vimeo"],
    [/(^|\.)reddit\.com$/, "Reddit"],
    [/(^|\.)(linkedin)\.com$/, "LinkedIn"],
    [/(^|\.)(pinterest)\.[a-z.]+$/, "Pinterest"],
    [/(^|\.)(threads)\.(net|com)$/, "Threads"],
  ];
  return known.find(([re]) => re.test(host))?.[1] ?? host;
}

const LOGIN_TIERS = (platform: string) =>
  `${platform} asks for a login before it shows this video. Options, easiest first: ` +
  `(1) open the video yourself, save the file with ${platform}'s own download or save button into the folder named in FRAMELENS_INBOX, and use source "inbox" (or pass the file path); ` +
  "(2) opt in to your own cookies: set FRAMELENS_COOKIES_FROM_BROWSER=firefox (a Firefox profile where you are signed in) or FRAMELENS_COOKIES_FILE=<path to a cookies.txt> and try again. " +
  "Chrome and Edge cookies cannot be read on Windows.";

const GEO = /available in your (country|region)|geo.?(restrict|block)|blocked it in your country/i;
const GONE = /private video|video is private|has been removed|has been deleted|video unavailable|video is unavailable|no longer available|terminated|does not exist|isn.t available/i;
const BOT_CHECK = /not a bot|bot check|captcha|unusual traffic/i;
const LOGIN = /not a bot|confirm your age|age.?restrict|login required|log ?in|sign in|cookies|authenticat|registered users|rate-limit reached/i;

/** Turns yt-dlp's stderr into an error that tells the user what to do. */
export function mapYtDlpFailure(stderr: string, url: string): SourceError {
  const text = stderr.replace(/\r/g, "");
  const platform = platformName(url);
  const errorLine = [...text.split("\n")].reverse().find((l) => /^ERROR:/i.test(l.trim()))?.trim() ?? text.trim().split("\n").pop() ?? "";
  const brief = errorLine.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]*:?\s*)?/i, "").slice(0, 300);

  if (/unsupported url/i.test(text)) {
    return new SourceError(
      "unsupported_url",
      `Frame Lens cannot read a video from this link (${platform}). Open the page, save the video file yourself and pass its path, or put it in the inbox folder. Detail: ${brief}`,
    );
  }
  if (GEO.test(text)) {
    return new SourceError("geo_blocked", `${platform} blocks this video in your country. Save the file another way and pass its path or use the inbox folder. Detail: ${brief}`);
  }
  if (GONE.test(text)) {
    return new SourceError("unavailable", `${platform} says this video is private, removed or unavailable, so it cannot be fetched. Detail: ${brief}`);
  }
  if (LOGIN.test(text)) return new SourceError("login_required", LOGIN_TIERS(platform), { botCheck: BOT_CHECK.test(text) });
  if (/http error 429|too many requests/i.test(text)) {
    return new SourceError("download_failed", `${platform} is limiting requests from this connection (HTTP 429). Wait a while and try again, or save the file yourself into the inbox folder.`);
  }
  return new SourceError("download_failed", `yt-dlp could not fetch this link. ${brief || "No error text was reported."}`);
}

interface Info {
  title?: string;
  webpage_url?: string;
  language?: string | null;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
  requested_formats?: { filesize?: number | null; filesize_approx?: number | null }[];
  filesize?: number | null;
  filesize_approx?: number | null;
}

/** Which caption tracks to download: the video's own language (manual, or automatic) and English if a person wrote it. */
export function pickCaptionLanguages(info: Info): string[] {
  const manual = Object.keys(info.subtitles ?? {});
  const auto = Object.keys(info.automatic_captions ?? {});
  const base = (k: string) => k.split("-")[0]!.toLowerCase();
  const origKey = auto.find((k) => k.endsWith("-orig"));
  const own = (info.language ? base(info.language) : undefined) ?? (origKey ? base(origKey) : undefined);

  const wanted = new Set<string>();
  for (const k of manual) if (base(k) === own || base(k) === "en") wanted.add(k);
  if (own) {
    // YouTube lists the original-language automatic track twice: "xx-orig" and plain "xx". One is enough.
    const ownAuto = auto.filter((k) => base(k) === own);
    const pick = ownAuto.find((k) => k.endsWith("-orig")) ?? ownAuto[0];
    if (pick && !manual.some((k) => base(k) === own)) wanted.add(pick);
  }
  return [...wanted];
}

export interface FetchResult {
  title?: string;
  canonicalUrl?: string;
  mediaPath: string;
  captions: CaptionTrack[];
}

export interface FetchParams {
  url: string;
  mediaDir: string;
  ytdlp: ToolLocation;
  ffmpeg: ToolLocation;
  env: Env;
  signal?: AbortSignal;
  log?: (line: string) => void;
  timeoutMs: number;
  platform?: NodeJS.Platform;
}

/** Downloads one video (never a playlist) with yt-dlp into `mediaDir` as source.<ext> plus caption files. */
export async function fetchWithYtDlp(params: FetchParams): Promise<FetchResult> {
  const { url, mediaDir, ytdlp, ffmpeg, env, signal, timeoutMs } = params;
  const log = params.log ?? (() => {});
  const maxMb = maxDownloadMb(env);
  const cookies = cookieArgs(env, params.platform);

  const common = [
    "--ignore-config", // a personal yt-dlp.conf must not change what we fetch
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--sleep-requests", "1",
    "--ffmpeg-location", ffmpeg.path,
    ...cookies,
  ];
  const runEnv = { PYTHONIOENCODING: "utf-8", NO_COLOR: "1" };
  const exec = async (args: string[], limit: number) => {
    log(`yt-dlp ${redactArgs(args).slice(0, 40).join(" ")}`);
    try {
      return await run(ytdlp.path, args, { timeoutMs: limit, signal, env: runEnv, maxOutputBytes: 32 * 1024 * 1024 });
    } catch (error) {
      if (error instanceof ToolError && error.code === "timeout") {
        throw new SourceError("download_failed", `yt-dlp did not finish in ${Math.round(limit / 60_000)} minutes and was stopped. The video may be too long or the connection too slow.`);
      }
      throw error;
    }
  };

  // 1. Metadata first: gives the title, the caption tracks to ask for, and the size before anything is downloaded.
  const probe = await exec([...common, "--dump-single-json", "--skip-download", "-f", FORMAT, "--", url], 120_000);
  if (probe.code !== 0) throw mapYtDlpFailure(probe.stderr, url);
  let info: Info;
  try {
    info = JSON.parse(probe.stdout) as Info;
  } catch {
    throw new SourceError("download_failed", "yt-dlp answered with something that is not video information. Try updating Frame Lens (framelens doctor --prepare) and retry.");
  }
  const sizes = (info.requested_formats?.length ? info.requested_formats : [info]).map((f) => f.filesize ?? f.filesize_approx ?? 0);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  if (totalBytes > maxMb * 1024 * 1024) {
    throw new SourceError(
      "too_large",
      `The video is about ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${maxMb} MB limit. Raise FRAMELENS_MAX_DOWNLOAD_MB or use a shorter video.`,
    );
  }

  // 2. Download. Leftovers from an interrupted run are removed so they cannot be mistaken for the result.
  mkdirSync(mediaDir, { recursive: true });
  for (const name of readdirSync(mediaDir)) if (name.startsWith("source.")) rmSync(join(mediaDir, name), { force: true });
  const langs = pickCaptionLanguages(info);
  const args = [
    ...common,
    "-f", FORMAT,
    "--merge-output-format", "mp4",
    "--max-filesize", `${maxMb}M`,
    "--no-mtime",
    ...(langs.length ? ["--write-subs", "--write-auto-subs", "--sub-langs", langs.join(","), "--sub-format", "json3/vtt/best"] : []),
    "-o", join(mediaDir, "source.%(ext)s"),
    "--", url,
  ];
  const result = await exec(args, timeoutMs);
  if (result.code !== 0) throw mapYtDlpFailure(result.stderr, url);

  // 3. Find what was written.
  let media: { path: string; size: number } | undefined;
  const captions: CaptionTrack[] = [];
  const manual = new Set(Object.keys(info.subtitles ?? {}));
  for (const name of readdirSync(mediaDir)) {
    if (!name.startsWith("source.")) continue;
    const ext = extname(name).toLowerCase();
    const path = join(mediaDir, name);
    if (SUB_EXTENSIONS.has(ext)) {
      const language = name.slice("source.".length, name.length - ext.length);
      if (language) captions.push({ path, language, auto: !manual.has(language) });
    } else if (![".part", ".ytdl", ".temp", ".tmp"].includes(ext)) {
      const size = statSync(path).size;
      if (!media || size > media.size) media = { path, size };
    }
  }
  if (!media) {
    throw new SourceError("download_failed", `yt-dlp finished but no media file was written (it may be over the ${maxMb} MB limit).`);
  }
  captions.sort((a, b) => a.language.localeCompare(b.language));
  return { title: info.title, canonicalUrl: info.webpage_url, mediaPath: media.path, captions };
}

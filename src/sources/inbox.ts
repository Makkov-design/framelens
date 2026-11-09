import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { readEnv, type Env } from "../tools/env.js";
import { SourceError } from "./errors.js";

/** Videos and animations the analysis can read. */
export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".flv", ".wmv", ".3gp",
  ".gif", ".apng", ".webp",
]);

/** What the Frame Lens browser extension names a page reading it saves. */
export const READING_SUFFIX = ".framelens.json";

/** The folder the browser extension saves into, inside the Downloads folder (FRAMELENS_DOWNLOADS overrides ~/Downloads). */
export function extensionFolder(env: Env): string {
  return join(readEnv(env, "FRAMELENS_DOWNLOADS") ?? join(homedir(), "Downloads"), "FrameLens");
}

/**
 * Where the inbox looks: FRAMELENS_INBOX and its FrameLens subfolder, and Downloads/FrameLens, where the browser
 * extension saves page readings and tab recordings. Only folders that exist.
 */
export function inboxFolders(env: Env): string[] {
  const configured = readEnv(env, "FRAMELENS_INBOX");
  const folders = [...(configured ? [configured, join(configured, "FrameLens")] : []), extensionFolder(env)].map((f) => resolve(f));
  return [...new Set(folders)].filter((f) => {
    try {
      return statSync(f).isDirectory();
    } catch {
      return false;
    }
  });
}

function newest(folders: string[], wanted: (name: string) => boolean): { path: string; mtime: number } | undefined {
  let best: { path: string; mtime: number } | undefined;
  for (const dir of folders) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!wanted(name)) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { path, mtime: stat.mtimeMs };
      } catch {
        // vanished while listing
      }
    }
  }
  return best && { path: resolve(best.path), mtime: best.mtime };
}

function nothingThere(env: Env, what: string): SourceError {
  const configured = readEnv(env, "FRAMELENS_INBOX");
  if (configured && !existsSync(configured)) return new SourceError("inbox_empty", `FRAMELENS_INBOX points to "${configured}", which cannot be read.`);
  if (!configured && !existsSync(extensionFolder(env))) {
    return new SourceError(
      "inbox_empty",
      "FRAMELENS_INBOX is not set and there is no Downloads/FrameLens folder yet. Save the file with the Frame Lens browser " +
        `extension (it saves to Downloads/FrameLens), or set FRAMELENS_INBOX to the folder where you put ${what}, then use source "inbox".`,
    );
  }
  return new SourceError("inbox_empty", `No ${what} found in the inbox (${inboxFolders(env).join(", ") || extensionFolder(env)}). Save it there and try again.`);
}

const isMedia = (name: string) => MEDIA_EXTENSIONS.has(extname(name).toLowerCase());
const isReading = (name: string) => name.toLowerCase().endsWith(READING_SUFFIX);

export interface InboxItem {
  path: string;
  kind: "media" | "reading";
  mtime: number;
}

/** The newest video (or GIF) and the newest page reading in the inbox, each when there is one. */
export function inboxContents(env: Env): { media?: InboxItem; reading?: InboxItem } {
  const folders = inboxFolders(env);
  const media = newest(folders, isMedia);
  const reading = newest(folders, isReading);
  return { ...(media && { media: { ...media, kind: "media" as const } }), ...(reading && { reading: { ...reading, kind: "reading" as const } }) };
}

/** The newest item of either kind (what `export inbox` starts from). */
export function newestInboxItem(env: Env): InboxItem {
  const { media, reading } = inboxContents(env);
  const item = media && reading ? (reading.mtime > media.mtime ? reading : media) : (media ?? reading);
  if (!item) throw nothingThere(env, "video, GIF or page reading");
  return item;
}

/**
 * One line about the inbox item of the other kind, when there is one: a tool that took the newest video says that a
 * page reading is there too (and the other way round), so the agent knows which `inbox` it got.
 */
export function inboxNote(env: Env, used: "media" | "reading"): string | undefined {
  const contents = inboxContents(env);
  const mine = contents[used];
  const other = contents[used === "media" ? "reading" : "media"];
  if (!other) return undefined;
  const has = mine && other.mtime > mine.mtime ? "has a newer" : "also has a";
  return used === "media"
    ? `The inbox ${has} page reading, ${other.path}: \`web\` with "inbox" reads it.`
    : `The inbox ${has} video, ${other.path}: the video tools with "inbox" use it.`;
}

/** The newest video or GIF in the inbox (the video tools); a newer page reading is left for `web`. */
export function newestInboxFile(env: Env): string {
  const { media, reading } = inboxContents(env);
  if (media) return media.path;
  if (reading) throw new SourceError("bad_input", `The inbox holds no video, only a page reading (${reading.path}): use \`web\` or \`export\` with "inbox" for it.`);
  throw nothingThere(env, "video or GIF");
}

/** The newest page reading the browser extension saved (`*.framelens.json`), for `web`; a newer video is left alone. */
export function newestInboxReading(env: Env): string {
  const { media, reading } = inboxContents(env);
  if (reading) return reading.path;
  if (media) throw new SourceError("bad_input", `The inbox holds no page reading, only a video (${media.path}): use the video tools with "inbox" for it.`);
  throw nothingThere(env, "page reading (*.framelens.json from the browser extension)");
}

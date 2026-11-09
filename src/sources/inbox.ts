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

function newest(folders: string[], wanted: (name: string) => boolean): string | undefined {
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
  return best && resolve(best.path);
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
}

/**
 * The newest item in the inbox, a video (or GIF) or a page reading. `inbox` means this one item for every tool, so
 * `web inbox` and then `export inbox` work on the same thing.
 */
export function newestInboxItem(env: Env): InboxItem {
  const found = newest(inboxFolders(env), (name) => isMedia(name) || isReading(name));
  if (!found) throw nothingThere(env, "video, GIF or page reading");
  return { path: found, kind: isReading(found) ? "reading" : "media" };
}

/** The newest inbox item, which must be a video or GIF (the video tools). */
export function newestInboxFile(env: Env): string {
  const item = newestInboxItem(env);
  if (item.kind === "media") return item.path;
  const video = newest(inboxFolders(env), isMedia);
  throw new SourceError(
    "bad_input",
    `The newest item in the inbox is a page reading (${item.path}): use \`web\` or \`export\` with "inbox" for it.` +
      (video ? ` For the newest video, pass its path: ${video}` : ""),
  );
}

/** The newest inbox item, which must be a page reading the browser extension saved (`*.framelens.json`). */
export function newestInboxReading(env: Env): string {
  const item = newestInboxItem(env);
  if (item.kind === "reading") return item.path;
  const reading = newest(inboxFolders(env), isReading);
  throw new SourceError(
    "bad_input",
    `The newest item in the inbox is a video (${item.path}): use the video tools with "inbox" for it.` +
      (reading ? ` For the newest page reading, pass its path: ${reading}` : ""),
  );
}

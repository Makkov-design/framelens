import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { readEnv, type Env } from "../tools/env.js";
import { SourceError } from "./errors.js";

/** Videos and animations the analysis can read. */
export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".flv", ".wmv", ".3gp",
  ".gif", ".apng", ".webp",
]);

/** The newest video or GIF in the folder named by FRAMELENS_INBOX. */
export function newestInboxFile(env: Env): string {
  const dir = readEnv(env, "FRAMELENS_INBOX");
  if (!dir) {
    throw new SourceError(
      "inbox_empty",
      "FRAMELENS_INBOX is not set. Set it to a folder where you drop downloaded videos (for example the folder your browser saves to), then use source \"inbox\".",
    );
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new SourceError("inbox_empty", `FRAMELENS_INBOX points to "${dir}", which cannot be read.`);
  }
  let best: { path: string; mtime: number } | undefined;
  for (const name of names) {
    if (!MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { path, mtime: stat.mtimeMs };
    } catch {
      // vanished while listing
    }
  }
  if (!best) {
    throw new SourceError("inbox_empty", `No video or GIF found in the inbox folder "${dir}". Save the file there and try again.`);
  }
  return resolve(best.path);
}

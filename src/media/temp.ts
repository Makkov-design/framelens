import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A file or folder name no other process can guess or collide with (concurrent calls, other users on the machine). */
export function uniqueName(prefix: string, suffix = ""): string {
  return `${prefix}${randomBytes(12).toString("hex")}${suffix}`;
}

/** A path in the system temp folder with an unguessable name (ffmpeg writes its side files there). */
export function tempPath(prefix: string, suffix = ""): string {
  return join(tmpdir(), uniqueName(prefix, suffix));
}

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "./errors.js";

/** An AbortSignal that fires when any of the given ones does (AbortSignal.any needs Node 20.3). */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

export function hashFile(path: string): string {
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

/** Whether `path` exists and has this SHA-256. */
export function hasHash(path: string, sha256: string): boolean {
  try {
    return statSync(path).isFile() && hashFile(path) === sha256;
  } catch {
    return false;
  }
}

/**
 * A temporary name next to `target` that no other process uses: two servers (two sessions) may install the same
 * pinned tool at once, and a shared name let one delete or overwrite the other's file mid-way.
 */
export function partialName(target: string): string {
  return `${target}.${process.pid}-${randomBytes(4).toString("hex")}.part`;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes what killed installs left in `dir`: partial binaries and archives whose process is gone (or, without a
 * process id in the name, older than an hour). A download in progress in another live process is left alone.
 */
export function cleanStalePartials(dir: string, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".part") && !/^\.download-.*\.zip$/.test(name)) continue;
    const pid = Number(/(?:^\.download-|\.)(\d+)-[0-9a-f]+\.(?:part|zip)$/.exec(name)?.[1]);
    const path = join(dir, name);
    let stale: boolean;
    if (Number.isInteger(pid) && pid > 0) stale = pid !== process.pid && !alive(pid);
    else {
      try {
        stale = now - statSync(path).mtimeMs > 60 * 60_000;
      } catch {
        continue;
      }
    }
    if (!stale) continue;
    try {
      rmSync(path, { force: true });
      removed.push(name);
    } catch {
      // Still held open somewhere; the next install tries again.
    }
  }
  return removed;
}

export interface DownloadOptions {
  /** What is being downloaded, for messages ("ffmpeg", "yt-dlp"). */
  what: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** The whole download (default 15 minutes). */
  timeoutMs?: number;
  /** No data for this long ends it (default 60 s). */
  stallMs?: number;
}

/**
 * Streams a download to `file`, hashing on the way. It stops past `maxBytes`, after `timeoutMs`, after `stallMs`
 * without data, or when `signal` fires, and then removes what it wrote. Returns the SHA-256 and the size.
 */
export async function downloadToFile(url: string, file: string, o: DownloadOptions): Promise<{ sha256: string; bytes: number }> {
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const stallMs = o.stallMs ?? 60_000;
  const controller = new AbortController();
  let why = "";
  const stop = (reason: string) => {
    if (!why) why = reason;
    controller.abort(new Error(reason));
  };
  const total = setTimeout(() => stop(`did not finish in ${Math.round(timeoutMs / 60_000) || 1} minute(s)`), timeoutMs);
  let stall = setTimeout(() => stop(`stalled (no data for ${Math.max(1, Math.round(stallMs / 1000))} s)`), stallMs);
  const onAbort = () => stop("was stopped");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) stop("was stopped");
  const fail = (detail: string) => new ToolError("download_failed", `The ${o.what} download from ${new URL(url).host} ${detail}. Try again, or run \`npx framelens doctor --prepare\`.`);
  let fd: number | undefined;
  try {
    let response: Response;
    try {
      response = await (o.fetchFn ?? fetch)(url, { redirect: "follow", signal: controller.signal });
    } catch (error) {
      throw fail(why || `failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok || !response.body) throw fail(`answered HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > o.maxBytes) throw fail("is larger than the pinned file");
    const hash = createHash("sha256");
    fd = openSync(file, "w");
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw fail(why || `broke off: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (chunk.done) break;
      clearTimeout(stall);
      stall = setTimeout(() => stop(`stalled (no data for ${Math.max(1, Math.round(stallMs / 1000))} s)`), stallMs);
      size += chunk.value.length;
      if (size > o.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw fail("is larger than the pinned file; it was stopped");
      }
      hash.update(chunk.value);
      writeSync(fd, chunk.value);
    }
    if (why) throw fail(why);
    return { sha256: hash.digest("hex"), bytes: size };
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    try {
      rmSync(file, { force: true });
    } catch {
      // Cleaned up by the next install.
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    clearTimeout(total);
    clearTimeout(stall);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Puts a verified file in place. A target that already has the right hash (another process installed it) is kept
 * and ours dropped; otherwise ours replaces it in one rename, and the target is never deleted first. When the
 * rename fails (Windows refuses to replace a program that is running), the target is accepted if it is right.
 */
export function placeVerified(partial: string, target: string, sha256: string): "placed" | "kept" {
  const drop = () => {
    try {
      rmSync(partial, { force: true });
    } catch {
      // Cleaned up by the next install.
    }
  };
  if (existsSync(target) && hasHash(target, sha256)) {
    drop();
    return "kept";
  }
  try {
    renameSync(partial, target);
    return "placed";
  } catch (error) {
    drop();
    if (hasHash(target, sha256)) return "kept";
    throw new ToolError("download_failed", `Could not put ${target} in place: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

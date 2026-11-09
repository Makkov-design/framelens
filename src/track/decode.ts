import { spawn } from "node:child_process";
import { InvalidInputError } from "../errors.js";
import { parseShowinfo } from "../media/frames.js";
import type { MediaTools } from "../media/exec.js";
import type { GrayFrames } from "./tracker.js";

/** Most bytes of decoded frames held for one window. */
export const FRAME_BUDGET = 64 * 1024 * 1024;
/** Widest working picture: tracking is subpixel, so more pixels add little beyond this. */
export const MAX_WORK_WIDTH = 960;

/** The working size for a window: as large as the budget allows for its frame count, never above the source. */
export function workSize(width: number, height: number, frameCount: number, budget = FRAME_BUDGET): { width: number; height: number; factor: number } {
  const perFrame = budget / Math.max(1, frameCount);
  let factor = Math.min(1, MAX_WORK_WIDTH / width, Math.sqrt(perFrame / (width * height)));
  factor = Math.max(factor, Math.min(1, 64 / width));
  const w = Math.max(2, Math.round((width * factor) / 2) * 2);
  const h = Math.max(2, Math.round((height * factor) / 2) * 2);
  return { width: w, height: h, factor: w / width };
}

/**
 * Decodes every frame of `range` as 8-bit grey at `size`, through a pipe: nothing is written to disk and only this
 * window is held in memory. Times come from ffmpeg's showinfo, so variable-rate files keep their real timestamps.
 */
export function decodeGray(
  source: string,
  tools: MediaTools,
  range: { start: number; end: number },
  size: { width: number; height: number },
  options: { maxFrames: number; fps: number; timeoutMs?: number },
): Promise<GrayFrames> {
  const frameBytes = size.width * size.height;
  const args = [
    "-hide_banner", "-nostdin", "-v", "info",
    "-ss", String(range.start), "-t", String(Math.max(0.001, range.end - range.start)), "-i", source, "-an", "-sn",
    "-vf", `scale=${size.width}:${size.height}:flags=area,format=gray,showinfo`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const frames: Uint8Array[] = [];
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let stderr = "";
    let tooMany = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 5 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameBytes) {
        const all = Buffer.concat(pending, pendingBytes);
        const frame = new Uint8Array(frameBytes);
        frame.set(all.subarray(0, frameBytes));
        if (frames.length < options.maxFrames) frames.push(frame);
        else tooMany = true;
        pending = [all.subarray(frameBytes)];
        pendingBytes -= frameBytes;
      }
      if (tooMany) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // Keep the log small: only showinfo lines matter, the rest is the tail of an error.
      if (stderr.length > 4_000_000) stderr = stderr.slice(-4_000_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new InvalidInputError("ffmpeg was not found on this computer. Run `npx framelens doctor` to see how to install it.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tooMany) {
        reject(new InvalidInputError(`The window has more than ${options.maxFrames} frames; track a shorter window (start/end).`));
        return;
      }
      if (code !== 0 && !frames.length) {
        const tail = stderr.trim().split("\n").filter((l) => !l.includes("Parsed_showinfo")).slice(-6).join("\n");
        reject(new Error(`ffmpeg failed: ${tail || `exit code ${code}`}`));
        return;
      }
      const times = parseShowinfo(stderr);
      resolve({
        width: size.width,
        height: size.height,
        frames: frames.map((data, i) => ({ t: Math.round(((times[i] ?? i / options.fps) + range.start) * 10000) / 10000, data })),
      });
    });
  });
}

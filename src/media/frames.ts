import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "./exec.js";
import type { ProbeInfo } from "./probe.js";

export interface FrameRequest {
  /** Exact moments, in seconds. */
  at?: number[];
  start?: number;
  end?: number;
  /** One frame every N seconds over the range. */
  every?: number;
  /** N frames per second over the range. */
  fps?: number;
  /** Every original frame over the range, with its real timestamp. */
  everyFrame?: boolean;
  /** Output width in pixels; height keeps the aspect ratio. */
  width?: number;
}

export interface ExtractedFrame {
  /** Source time in seconds. */
  t: number;
  file: string;
}

/** A safety cap: dense sampling of a whole long video belongs in several narrower requests. */
export const MAX_FRAMES = 900;

export function frameFileName(t: number): string {
  return `${t.toFixed(3).padStart(10, "0")}.jpg`;
}

/** Works out the range and how many frames a request will produce, without running ffmpeg. */
/** The one error for a request that names no way to sample, or more than one. */
export const ONE_MODE =
  "Choose exactly one of `at`, `every`, `fps` or `every_frame`. `around` (a phrase from the transcript) picks the range itself and takes " +
  "`every`, `fps` or `every_frame` with it (4 frames a second when none is given), but not `at`.";

export function planFrames(request: FrameRequest, probe: ProbeInfo): { start: number; end: number; count: number } {
  const modes = [Boolean(request.at?.length), request.every !== undefined, request.fps !== undefined, Boolean(request.everyFrame)].filter(Boolean).length;
  // `at` with `every` used to take the moments and drop `every` without a word.
  if (modes !== 1) throw new InvalidInputError(ONE_MODE);
  if (request.at?.length) {
    const bad = request.at.find((t) => !(t >= 0) || t > probe.duration);
    if (bad !== undefined) throw new InvalidInputError(`Time ${bad} s is outside the video (0–${probe.duration.toFixed(2)} s).`);
    return { start: Math.min(...request.at), end: Math.max(...request.at), count: request.at.length };
  }
  const start = Math.max(0, request.start ?? 0);
  const end = Math.min(probe.duration, request.end ?? probe.duration);
  if (!(end > start)) throw new InvalidInputError(`Empty range: start ${start} s must be before end ${end} s.`);
  const perSecond = request.everyFrame ? (probe.fps ?? probe.nominalFps ?? 30) : request.fps ?? 1 / request.every!;
  if (!(perSecond > 0) || perSecond > 240) throw new InvalidInputError("The sampling rate must be above 0 and at most 240 frames per second.");
  const count = Math.max(1, Math.ceil((end - start) * perSecond));
  if (count > MAX_FRAMES) {
    throw new InvalidInputError(
      `That is about ${count} frames, more than ${MAX_FRAMES} in one request. Narrow the range or lower the rate ` +
        "(overview first, dense frames only around the moments that matter).",
    );
  }
  return { start, end, count };
}

/** Reads `pts_time` of each frame from ffmpeg's showinfo log. */
export function parseShowinfo(stderr: string): number[] {
  const times: number[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("Parsed_showinfo")) continue;
    const match = /pts_time:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (match) times.push(Number(match[1]));
  }
  return times;
}

/** Extracts frames into `outDir`, named by source time. */
export async function extractFrames(
  source: string,
  outDir: string,
  request: FrameRequest,
  probe: ProbeInfo,
  tools: MediaTools,
): Promise<ExtractedFrame[]> {
  const { start, end } = planFrames(request, probe);
  const width = Math.round(Math.min(Math.max(request.width ?? 640, 64), 3840));
  const scale = `scale=${width}:-2:flags=bicubic`;
  mkdirSync(outDir, { recursive: true });

  if (request.at?.length) {
    // Each frame is named by the time of the frame actually shown (the first at or after the moment), not the
    // moment asked for: at 25 fps, 0.01 s shows the frame at 0.04 s.
    const tmp = join(outDir, `.tmp-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const frames: ExtractedFrame[] = [];
      for (const t of [...new Set(request.at)].sort((a, b) => a - b)) {
        const shot = join(tmp, "f.jpg");
        const grab = async (seek: number, last: boolean) => {
          const { stderr } = await tools.exec(tools.ffmpeg, [
            "-hide_banner", "-nostdin", "-y",
            "-ss", String(seek), "-i", source, "-an",
            ...(last ? [] : ["-frames:v", "1"]),
            "-vf", `${scale},showinfo`, "-fps_mode", "passthrough", "-q:v", "3",
            ...(last ? ["-update", "1"] : []),
            shot,
          ]);
          const times = parseShowinfo(stderr);
          return existsSync(shot) && times.length ? seek + times[last ? times.length - 1 : 0]! : undefined;
        };
        // A moment inside the last frame's display time (up to the duration) has no frame at or after it: the
        // frame on screen then is the last one, so decode the end of the file and keep its final frame.
        // ffmpeg fails ("Could not open encoder before EOF") when the seek finds no frame.
        const real = (await grab(t, false).catch(() => undefined)) ?? (await grab(Math.max(0, t - 10), true));
        if (real === undefined) throw new InvalidInputError(`No frame could be read at ${t} s.`);
        const time = Math.round(real * 1000) / 1000;
        const file = join(outDir, frameFileName(time));
        renameSync(shot, file);
        frames.push({ t: time, file });
      }
      return frames;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // One continuous decode of the range; showinfo reports each written frame's real timestamp.
  const tmp = join(outDir, `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // The fps filter keeps the last frame of each interval, so a "0.0 s" sample would really show 0.23 s.
    // select keeps the first frame at or after each grid point instead, and its real time is reported.
    const perSecond = request.fps ?? 1 / request.every!;
    const sampling = request.everyFrame ? [] : [`select='eq(n,0)+gt(floor(t*${perSecond}+0.0005),floor(prev_t*${perSecond}+0.0005))'`];
    const { stderr } = await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-y",
      "-ss", String(start), "-t", String(end - start), "-i", source,
      "-an", "-vf", [...sampling, scale, "showinfo"].join(","),
      "-fps_mode", "passthrough",
      "-q:v", "3", join(tmp, "f_%06d.jpg"),
    ]);
    const times = parseShowinfo(stderr);
    const written = readdirSync(tmp).filter((f) => f.endsWith(".jpg")).sort();
    // Times are measured, never computed from the rate: a mismatch means the log cannot be trusted.
    if (times.length !== written.length) throw new Error(`ffmpeg reported ${times.length} frame times for ${written.length} frames.`);
    const frames: ExtractedFrame[] = [];
    written.forEach((name, i) => {
      const t = Math.round((start + times[i]!) * 1000) / 1000;
      const file = join(outDir, frameFileName(t));
      renameSync(join(tmp, name), file);
      frames.push({ t, file });
    });
    return frames;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

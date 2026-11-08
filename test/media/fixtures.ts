import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execTool, type MediaTools } from "../../src/media/exec.js";

/** ffmpeg and ffprobe from PATH, or undefined so media tests can skip. */
export function mediaTools(): MediaTools | undefined {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true });
    return { ffmpeg: "ffmpeg", ffprobe: "ffprobe", exec: execTool };
  } catch {
    return undefined;
  }
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "framelens-test-"));
}

/** A 2 s, 25 fps grey video whose brightness is 4 × the frame number, so a frame's pixels tell which frame it is. */
export function rampVideo(dir: string): string {
  const file = join(dir, "ramp.mp4");
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=64x64:r=25:d=2,geq=lum='4*N':cb=128:cr=128", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", file],
    { windowsHide: true },
  );
  return file;
}

/** Writes frame number `n` of a video to `out`, selected by index rather than by time. */
export function frameByNumber(video: string, n: number, out: string): string {
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", video, "-vf", `select='eq(n,${n})'`, "-frames:v", "1", "-fps_mode", "passthrough", out], { windowsHide: true });
  return out;
}

/** Mean brightness (0–255) of an image file. */
export function brightness(file: string): number {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { windowsHide: true });
  return raw[0]!;
}

/**
 * A 6 s, 25 fps video with three solid colour shots that cut at exactly 2 s and 4 s (frames 50 and 100),
 * plus a 440 Hz tone.
 */
export function cutsVideo(dir: string): string {
  const file = join(dir, "cuts.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0xE0402F:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "color=c=0x2F6FE0:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "color=c=0x2FE07A:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest", file,
    ],
    { windowsHide: true },
  );
  return file;
}

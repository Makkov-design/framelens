import type { MediaTools } from "../media/exec.js";

/**
 * Optional on the engine's MediaTools: finds (or installs) ffmpeg or ffprobe and returns its path. `exec` already
 * does this for the bare names; code that spawns ffmpeg itself (a pipe) needs the path first.
 */
export interface ToolLocator {
  locate?: (name: "ffmpeg" | "ffprobe", signal?: AbortSignal) => Promise<string>;
}

/**
 * The path to spawn for ffmpeg or ffprobe. The engine keeps the bare name until a tool is located (for example when
 * only the pinned, auto-installed build exists, which is not on PATH), so a direct spawn of the bare name would fail.
 */
export async function spawnPath(tools: MediaTools & ToolLocator, name: "ffmpeg" | "ffprobe", signal?: AbortSignal): Promise<string> {
  const file = tools[name];
  return file === name && tools.locate ? tools.locate(name, signal) : file;
}

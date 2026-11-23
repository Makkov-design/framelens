import { InvalidInputError } from "../errors.js";
import { CancelledError } from "../runtime/call.js";
import { ToolError } from "../tools/errors.js";
import { run } from "../tools/run.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs an external program; rejects with its stderr when it fails or exceeds the timeout. */
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

const MAX_BUFFER = 64 * 1024 * 1024;
/** The limit a step gets when its caller names none. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

/** "90 s", "10 min", "1 h 30 min": how long a time limit is, for messages. */
export function formatLimit(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${Math.round(ms / 100) / 10} s`;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/**
 * Runs ffmpeg or ffprobe through `run`: no shell, its own process group (killed whole), stopped when the tool call is
 * cancelled. A run that hits its time limit says so and names the limit, instead of reading as a failed command.
 */
export const execTool: Exec = async (file, args, options = {}) => {
  const name = file.split(/[\\/]/).pop();
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  let result;
  try {
    result = await run(file, args, { timeoutMs, maxOutputBytes: MAX_BUFFER, ...(options.signal && { signal: options.signal }) });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    if (error.code === "not_found") throw new InvalidInputError(`${name} was not found on this computer. Run \`npx framelens doctor\` to see how to install it.`);
    if (error.code === "timeout") {
      throw new InvalidInputError(
        `${name} hit the ${formatLimit(timeoutMs)} time limit for this step and was stopped: the source is too long for one pass on this computer. ` +
          "A tool that takes start and end can be run on a shorter range.",
      );
    }
    if (error.code === "aborted") throw new CancelledError(name);
    throw error;
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`${name} failed: ${tail || (result.code === null ? "it was ended by a signal" : `exit code ${result.code}`)}`);
  }
  // A cut-off output would be read as the whole (a probe's packet list, a filter's per-frame log): fail instead.
  if (result.truncated) throw new Error(`${name} wrote more than ${MAX_BUFFER / 1024 / 1024} MiB of output, more than Frame Lens reads; analyze a shorter range (start/end).`);
  return { stdout: result.stdout, stderr: result.stderr };
};

/** The external programs the media modules call. */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  exec: Exec;
}

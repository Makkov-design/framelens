import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs an external program; rejects with its stderr when it fails or exceeds the timeout. */
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

export const execTool: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? 10 * 60_000,
        killSignal: "SIGKILL",
        ...(options.signal && { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr).trim().split("\n").slice(-6).join("\n");
          reject(new Error(`${file.split(/[\\/]/).pop()} failed: ${tail || error.message}`));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });

/** The external programs the media modules call. */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  exec: Exec;
}

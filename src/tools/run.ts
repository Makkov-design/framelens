import { spawn, execFile } from "node:child_process";
import { ToolError } from "./errors.js";
import type { Env } from "./env.js";

export interface RunOptions {
  /** Kill the process tree after this long. No limit when omitted. */
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Added to process.env; an undefined value removes the variable. */
  env?: Env;
  /** Per stream. stdout keeps its start, stderr keeps its end (errors come last). Default 8 MiB. */
  maxOutputBytes?: number;
}

export interface RunResult {
  /** Exit code; null when the process was ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Output beyond maxOutputBytes was dropped. */
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

class Collector {
  private chunks: Buffer[] = [];
  private size = 0;
  dropped = false;

  constructor(
    private readonly max: number,
    private readonly keep: "head" | "tail",
  ) {}

  push(chunk: Buffer): void {
    if (this.keep === "head") {
      if (this.size >= this.max) {
        this.dropped = true;
        return;
      }
      const room = this.max - this.size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) this.dropped = true;
      this.chunks.push(part);
      this.size += part.length;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 0) {
      this.dropped = true;
      const first = this.chunks[0]!;
      const excess = this.size - this.max;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Ends the process and everything it started. Windows has no process groups, so taskkill walks the tree. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the child leads its own group (detached below)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** A .js/.mjs/.cjs path runs under this Node, so a script can stand in for a binary (tests, custom wrappers). */
function commandFor(binary: string, args: string[]): { file: string; args: string[] } {
  return /\.(c|m)?js$/i.test(binary)
    ? { file: process.execPath, args: [binary, ...args] }
    : { file: binary, args };
}

/**
 * Runs an external program without a shell. A non-zero exit is returned, not thrown, so callers can read stderr.
 * Throws ToolError for: program missing/unrunnable, timeout, abort.
 */
export function run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, signal, cwd, env } = options;
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError("aborted", `${binary} was cancelled before it started.`));
      return;
    }
    const cmd = commandFor(binary, args);
    const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
    const child = spawn(cmd.file, cmd.args, {
      cwd,
      env: mergedEnv as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const out = new Collector(max, "head");
    const err = new Collector(max, "tail");
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    let stopped: "timeout" | "aborted" | undefined;
    let settled = false;
    const stop = (why: "timeout" | "aborted") => {
      if (stopped || settled) return;
      stopped = why;
      killTree(child.pid);
    };
    const timer = timeoutMs !== undefined ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        error.code === "ENOENT"
          ? new ToolError("not_found", `Cannot run ${binary}: file not found.`)
          : new ToolError("spawn_failed", `Cannot run ${binary}: ${error.message}`),
      );
    });
    child.on("close", (code) => {
      cleanup();
      const output = { stdout: out.text(), stderr: err.text() };
      if (stopped === "timeout") {
        reject(new ToolError("timeout", `${binary} did not finish within ${Math.round((timeoutMs ?? 0) / 1000)} s and was stopped.`, output));
      } else if (stopped === "aborted") {
        reject(new ToolError("aborted", `${binary} was cancelled.`, output));
      } else {
        resolve({ code, ...output, truncated: out.dropped || err.dropped, durationMs: Date.now() - started });
      }
    });
  });
}

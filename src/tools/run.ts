import { callSignal } from "../runtime/call.js";
import { killTree, spawnTracked } from "./children.js";
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
/** How long output may still arrive after the program exits before its pipes are closed from this side. */
const EXIT_GRACE_MS = 2000;

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
  const { timeoutMs, cwd, env } = options;
  // Without its own signal, a program stops when the tool call it runs for is cancelled.
  const signal = options.signal ?? callSignal();
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError("aborted", `${binary} was cancelled before it started.`));
      return;
    }
    const cmd = commandFor(binary, args);
    const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
    const child = spawnTracked(cmd.file, cmd.args, { ...(cwd && { cwd }), env: mergedEnv as NodeJS.ProcessEnv });

    const out = new Collector(max, "head");
    const err = new Collector(max, "tail");
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    let stopped: "timeout" | "aborted" | undefined;
    let settled = false;
    let exitCode: number | null = null;
    let grace: NodeJS.Timeout | undefined;
    const stop = (why: "timeout" | "aborted") => {
      if (stopped || settled) return;
      stopped = why;
      killTree(child);
      // A descendant outside the group can hold the pipes open after everything here is gone: stop waiting for them.
      if (child.exitCode !== null || child.signalCode !== null) finish(exitCode);
    };
    const timer = timeoutMs !== undefined ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      const output = { stdout: out.text(), stderr: err.text() };
      if (stopped === "timeout") {
        reject(new ToolError("timeout", `${binary} did not finish within ${Math.round((timeoutMs ?? 0) / 1000)} s and was stopped.`, output));
      } else if (stopped === "aborted") {
        reject(new ToolError("aborted", `${binary} was cancelled.`, output));
      } else {
        resolve({ code, ...output, truncated: out.dropped || err.dropped, durationMs: Date.now() - started });
      }
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      cleanup();
      reject(
        error.code === "ENOENT"
          ? new ToolError("not_found", `Cannot run ${binary}: file not found.`)
          : new ToolError("spawn_failed", `Cannot run ${binary}: ${error.message}`),
      );
    });
    // `close` waits for the pipes; a descendant that left the process group (setsid) can keep them open after the
    // program ended. Its exit settles the call after a short grace for the last output.
    child.on("exit", (code) => {
      exitCode = code;
      grace = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on("close", (code) => finish(code ?? exitCode));
  });
}

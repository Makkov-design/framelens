import { execFile, execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/** Every external program Frame Lens started and has not seen end: killed when the server shuts down. */
const running = new Set<ChildProcess>();

/**
 * Ends a program and everything it started. On POSIX the child leads its own process group (spawned detached), so the
 * group is signalled: that id cannot be reused while any member is alive. The child's own pid is signalled only while
 * the child is not yet reaped, never after (its pid may belong to another process by then). Windows has no process
 * groups, so taskkill walks the tree (synchronously when `sync`, as in an `exit` handler).
 */
export function killTree(child: ChildProcess, sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const alive = child.exitCode === null && child.signalCode === null;
  if (process.platform === "win32") {
    if (!alive) return;
    const args = ["/pid", String(pid), "/T", "/F"];
    if (sync) {
      try {
        execFileSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
      } catch {
        // already gone
      }
    } else execFile("taskkill", args, { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (!alive) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Spawns a program the way every Frame Lens child runs: no shell, hidden window, its own process group on POSIX (so
 * killTree reaches what it starts), and registered until it ends so shutdown can kill it.
 */
export function spawnTracked(file: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  const child = spawn(file, args, { windowsHide: true, ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }) as unknown as ChildProcessWithoutNullStreams;
  if (child.pid !== undefined) {
    running.add(child);
    // Kept until its pipes close too: a descendant in its group may still be running after the program exits.
    child.once("close", () => running.delete(child));
    child.once("error", () => running.delete(child));
  }
  return child;
}

/** How many children are running now (tests). */
export function runningChildren(): number {
  return running.size;
}

/** Kills every running child (shutdown). */
export function killAllChildren(sync = false): void {
  for (const child of running) killTree(child, sync);
  running.clear();
}

let installed = false;
/** How often a server that is finishing its calls after stdin closed checks that its client still exists. */
const ORPHAN_CHECK_MS = 1000;
/** Every this many checks (5 s), a ping is written to the client: it fails once the client's end of stdout is closed. */
const PROBE_EVERY_TICKS = 5;

/** Whether the process that started the server is still there (on POSIX an orphan is also given a new parent). */
function parentAlive(parent: number): boolean {
  if (process.platform !== "win32" && process.ppid !== parent) return false;
  try {
    process.kill(parent, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What the server tells the cleanup about the requests it is answering (see `trackRequests`). */
export interface RequestState {
  /** Requests received and not yet answered. */
  pending(): number;
  /** Calls `callback` once when nothing is pending (at once if nothing is). */
  whenIdle(callback: () => void): void;
  /** Writes a harmless message to the client; rejects (or the output errors) when the client is gone. */
  probe?(): Promise<void>;
}

/**
 * Kills the children when the server goes away: on exit, on SIGINT / SIGTERM / SIGHUP, and on a broken stdout (the
 * client is gone). When the client closes stdin, the calls it already sent still get their answers: the server exits
 * once the last one is written (a script that pipes its requests and closes stdin is a normal client). A detached
 * child would otherwise outlive the server: a 30-minute yt-dlp download or a 20-minute ffmpeg pass. A SIGKILL of the
 * server cannot be caught: its children, each in its own process group, keep running until they end.
 */
export function installChildCleanup(requests?: RequestState, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  if (installed) return;
  installed = true;
  process.once("exit", () => killAllChildren(true));
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      killAllChildren(true);
      process.exit(codes[signal]);
    });
  }
  const now = () => {
    killAllChildren(true);
    process.exit(0);
  };
  output.once("error", now);
  // Pipes to stdout are asynchronous on Windows and macOS: exit once what was written has gone out.
  const flushThenExit = () => {
    killAllChildren(true);
    output.write("", () => process.exit(0));
  };
  let ending = false;
  const parent = process.ppid;
  const drained = () => {
    if (ending) return;
    ending = true;
    if (!requests || requests.pending() === 0) {
      flushThenExit();
      return;
    }
    // Answer what was already sent, unless the client itself is gone (it died with both pipes closed): then nobody
    // reads the answers, and a 30-minute download must not run on for nobody.
    // Two signs: the process that started the server is gone (a direct child of the client), or a write to the
    // client fails (launchers such as `npx`, whose `sh -c` and `npm exec` outlive the client, hide the first one).
    let ticks = 0;
    const watch = setInterval(() => {
      if (!parentAlive(parent)) now();
      if (requests.probe && ++ticks % PROBE_EVERY_TICKS === 0) requests.probe().catch(now);
    }, ORPHAN_CHECK_MS);
    watch.unref();
    requests.whenIdle(() => {
      clearInterval(watch);
      flushThenExit();
    });
  };
  input.once("end", drained);
  input.once("close", drained);
}

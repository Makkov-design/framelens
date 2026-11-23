import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/** Every external program Frame Lens started and has not seen end: killed when the server shuts down. */
const running = new Set<number>();

/**
 * Ends a process and everything it started. On POSIX the child leads its own process group (spawned detached), so the
 * group is signalled; Windows has no process groups, so taskkill walks the tree (synchronously when `sync`, as in an
 * `exit` handler, where nothing asynchronous runs any more).
 */
export function killTree(pid: number | undefined, sync = false): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
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
  const pid = child.pid;
  if (pid !== undefined) {
    running.add(pid);
    child.once("close", () => running.delete(pid));
    child.once("error", () => running.delete(pid));
  }
  return child;
}

/** How many children are running now (tests). */
export function runningChildren(): number {
  return running.size;
}

/** Kills every running child (shutdown). */
export function killAllChildren(sync = false): void {
  for (const pid of running) killTree(pid, sync);
  running.clear();
}

let installed = false;

/**
 * Kills the children when the server goes away: on exit, on SIGINT / SIGTERM / SIGHUP, and when the client closes
 * stdin (it is gone, so nobody can read the results). A detached child would otherwise outlive the server: a
 * 30-minute yt-dlp download or a 20-minute ffmpeg pass.
 */
export function installChildCleanup(input: NodeJS.ReadableStream = process.stdin): void {
  if (installed) return;
  installed = true;
  process.once("exit", () => killAllChildren(true));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      killAllChildren(true);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  const gone = () => {
    killAllChildren(true);
    process.exit(0);
  };
  input.once("end", gone);
  input.once("close", gone);
}

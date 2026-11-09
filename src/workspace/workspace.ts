import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { framelensHome } from "../tools/env.js";

/** What the sources layer writes to `source.json` and hands to the core. */
export interface SourceRecord {
  id: string;
  kind: "youtube" | "url" | "file";
  input: string;
  url?: string;
  title?: string;
  /** Absolute path of the media file to analyze. */
  mediaPath: string;
  captions?: { path: string; language: string; auto: boolean }[];
  fetchedAt?: string;
}

type Env = Record<string, string | undefined>;

export interface WorkspaceRootChoice {
  /** Absolute folder that holds every source's workspace. */
  root: string;
  /** env: FRAMELENS_WORKSPACE; cwd: `<cwd>/.framelens`; home: `~/.framelens` because the working folder cannot be used. */
  from: "env" | "cwd" | "home" | "temp";
  /** One line saying why this folder, for `doctor` and the server log. */
  reason: string;
}

const inside = (path: string, dir: string, separator: string) => path === dir || path.startsWith(dir.endsWith(separator) ? dir : dir + separator);

/**
 * A folder no project lives in: the Windows folder (System32 and the rest), the Program Files trees, a drive's root,
 * and on macOS and Linux `/`, `/usr`, `/bin`, `/sbin`, `/etc`, `/System` and `/Library`. Apps such as Claude Desktop
 * can start the server in one of these (Windows uses System32, macOS `/`).
 */
export function isSystemFolder(dir: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  // The same folder under another name: a junction or symlink, or an 8.3 short name (C:\PROGRA~1) on Windows.
  const names = [dir];
  if (platform === process.platform) {
    try {
      names.push(realpathSync.native(dir));
    } catch {
      // Not there (or not readable): the name alone decides.
    }
  }
  return names.some((name) => systemByName(name, env, platform));
}

function systemByName(dir: string, env: Env, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    let p = dir.replaceAll("/", "\\");
    // Device and long-path prefixes (\\?\C:\…, \\.\C:\…, \\?\UNC\server\share\…) name the same folders.
    p = p.replace(/^\\\\[?.]\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\(?=[a-z]:)/i, "");
    // An administrative share (\\host\C$\Windows) is the drive itself.
    p = p.replace(/^\\\\[^\\]+\\([a-z])\$(?=\\|$)/i, "$1:");
    p = win32.resolve(p).toLowerCase();
    // A drive's root (C:\) or a share's root (\\server\share\).
    if (/^[a-z]:\\$/.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p)) return true;
    const system = [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR, "C:\\Windows", env.ProgramFiles, env.PROGRAMFILES, env["ProgramFiles(x86)"], env["PROGRAMFILES(X86)"], env.ProgramW6432, "C:\\Program Files", "C:\\Program Files (x86)"]
      .filter((d): d is string => Boolean(d && d.trim()))
      .map((d) => d.trim().replace(/[\\/]+$/, "").replaceAll("/", "\\").toLowerCase());
    return system.some((d) => inside(p, d, "\\"));
  }
  // macOS file systems ignore case by default: /system is /System.
  const fold = (s: string) => (platform === "darwin" ? s.toLowerCase() : s);
  const p = fold(posix.normalize(dir).replace(/\/+$/, "")) || "/";
  if (p === "/") return true;
  return ["/usr", "/bin", "/sbin", "/etc", "/System", "/Library"].some((d) => inside(p, fold(d), "/"));
}

/** Whether Frame Lens can create and remove a file in `<dir>/.framelens`. Leaves nothing behind that was not there. */
export function canWriteWorkspace(root: string): boolean {
  const existed = existsSync(root);
  const probe = join(root, `.write-test-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(probe, "");
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // Never written (the path runs through a file, say).
    }
    if (!existed) {
      try {
        rmdirSync(root);
      } catch {
        // Not empty or already gone: leave it.
      }
    }
  }
}

/**
 * The folder that holds every source's workspace and why: `FRAMELENS_WORKSPACE` when set; else `<cwd>/.framelens`,
 * unless the working folder is a system folder or cannot be written to, then `~/.framelens` (and the temp folder
 * as a last resort). Claude Desktop on Windows starts the server in C:\WINDOWS\system32, where every write fails.
 */
export function chooseWorkspaceRoot(
  env: Env = process.env,
  cwd = process.cwd(),
  options: { platform?: NodeJS.Platform; home?: string; userHome?: string; canWrite?: (root: string) => boolean } = {},
): WorkspaceRootChoice {
  const configured = env.FRAMELENS_WORKSPACE?.trim() || env.YTLENS_WORKSPACE?.trim();
  // A relative FRAMELENS_WORKSPACE is taken from the home folder: the working folder may be System32.
  if (configured) return { root: resolve(options.userHome ?? homedir(), configured), from: "env", reason: "FRAMELENS_WORKSPACE is set" };
  const canWrite = options.canWrite ?? canWriteWorkspace;
  const local = join(resolve(cwd), ".framelens");
  const system = isSystemFolder(cwd, env, options.platform);
  if (!system && canWrite(local)) return { root: local, from: "cwd", reason: `the folder the server was started in (${resolve(cwd)})` };
  const why = system ? `the server was started in a system folder (${resolve(cwd)})` : `the folder the server was started in cannot be written to (${resolve(cwd)})`;
  const home = resolve(options.home ?? framelensHome(env));
  if (canWrite(home)) return { root: home, from: "home", reason: `${why}; using the home folder instead` };
  return { root: join(tmpdir(), "framelens"), from: "temp", reason: `${why}, and the home folder cannot be written to either; using the temp folder` };
}

/** The folder that holds every source's workspace (see chooseWorkspaceRoot). */
export function workspaceRoot(env: Env = process.env, cwd = process.cwd()): string {
  return chooseWorkspaceRoot(env, cwd).root;
}

/** Paths inside one source's workspace. Nothing outside the folder is ever returned. */
export class Workspace {
  readonly dir: string;

  constructor(root: string, readonly id: string) {
    if (!/^[a-z]+-[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid workspace id "${id}".`);
    this.dir = join(root, id);
  }

  /** Absolute path of a file or folder in the workspace; rejects names that would escape it. */
  path(...parts: string[]): string {
    const target = resolve(this.dir, ...parts);
    const rel = relative(this.dir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes the workspace: ${parts.join("/")}`);
    return target;
  }

  /** Creates a folder in the workspace and returns its path. */
  ensure(...parts: string[]): string {
    const dir = this.path(...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  readJson<T>(name: string): T | undefined {
    const file = this.path(name);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  writeJson(name: string, value: unknown): string {
    this.ensure();
    const file = this.path(name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  }

  writeText(name: string, text: string): string {
    this.ensure();
    const file = this.path(name);
    writeFileSync(file, text);
    return file;
  }

  /**
   * The absolute path, as tool output shows it. A relative one would be read against the agent's own folder, which
   * is not the server's when the client starts it elsewhere (Claude Desktop) or the workspace moved to the home folder.
   */
  display(file: string): string {
    return resolve(file);
  }
}

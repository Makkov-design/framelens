import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/** The folder that holds every source's workspace: `FRAMELENS_WORKSPACE`, else `<cwd>/.framelens`. */
export function workspaceRoot(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const configured = env.FRAMELENS_WORKSPACE?.trim();
  return configured ? resolve(cwd, configured) : join(cwd, ".framelens");
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

  /** Path relative to the workspace root's parent, for short tool output. */
  display(file: string): string {
    return relative(join(this.dir, "..", ".."), file).replaceAll("\\", "/");
  }
}

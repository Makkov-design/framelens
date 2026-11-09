import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import type { Exec } from "../media/exec.js";
import { cleanStalePartials } from "./download.js";
import { readEnv, type Env } from "./env.js";
import { ToolError } from "./errors.js";
import { ffmpegAsset, pinnedFfmpegIntact, prepareFfmpeg, type PrepareFfmpegOptions, type PrepareFfmpegResult } from "./ffmpeg.js";
import { findTool, missingToolMessage, type ToolLocation, type ToolName } from "./find.js";
import { pinnedYtDlpIntact, prepareYtDlp, YTDLP_PIN, type PrepareOptions, type PrepareResult } from "./ytdlp.js";

/** Automatic setup is on unless FRAMELENS_AUTO_INSTALL is 0, false, no or off. */
export function autoInstallEnabled(env: Env = process.env): boolean {
  const value = readEnv(env, "FRAMELENS_AUTO_INSTALL");
  return !value || !/^(0|false|no|off)$/i.test(value);
}

const callNotes = new AsyncLocalStorage<string[]>();

/**
 * Runs one tool call and returns the setup notes that belong to it: an install it started or waited for. Calls
 * running at the same time each get their own, so a note never lands on another tool's result.
 */
export async function collectSetupNotes<T>(body: () => Promise<T>): Promise<{ value: T; notes: string[] }> {
  const notes: string[] = [];
  const value = await callNotes.run(notes, body).catch((error: unknown) => {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { setupNotes: notes });
  });
  return { value, notes };
}

/** The notes collected before a call failed (see collectSetupNotes). */
export function setupNotesOf(error: unknown): string[] {
  const notes = (error as { setupNotes?: unknown } | undefined)?.setupNotes;
  return Array.isArray(notes) ? (notes as string[]) : [];
}

export interface ToolSetupOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
  /** Injected in tests. */
  prepareFfmpeg?: (options: PrepareFfmpegOptions) => Promise<PrepareFfmpegResult>;
  prepareYtDlp?: (options: PrepareOptions) => Promise<PrepareResult>;
  /** Checks a pinned binary against its recorded hash (tests replace it). */
  intact?: (location: ToolLocation) => boolean;
}

/**
 * Finds the external tools a local tool needs and, when one is missing, downloads its pinned, checksum-verified
 * build into ~/.framelens/tools and carries on; the tool call that needed it gets a note saying so. A pinned binary
 * already on disk is trusted only after its hash matches. FRAMELENS_AUTO_INSTALL=0 turns the downloads off.
 */
export class ToolSetup {
  private readonly installing = new Map<"ffmpeg" | "yt-dlp", Promise<string>>();
  private readonly located = new Map<ToolName, ToolLocation>();

  constructor(private readonly options: ToolSetupOptions = {}) {}

  private get env(): Env {
    return this.options.env ?? process.env;
  }

  private intact(location: ToolLocation): boolean {
    if (location.source !== "pinned") return true;
    if (this.options.intact) return this.options.intact(location);
    const platform = this.options.platform ?? process.platform;
    const arch = this.options.arch ?? process.arch;
    return location.name === "yt-dlp" ? pinnedYtDlpIntact(location.path, platform, arch) : pinnedFfmpegIntact(location.path, location.name, platform, arch);
  }

  /** The tool's location, downloading the pinned build first when it is missing (or changed) and setup is on. */
  async locate(name: ToolName, signal?: AbortSignal): Promise<ToolLocation> {
    const cached = this.located.get(name);
    if (cached) return cached;
    const find = () => findTool(name, { env: this.env, ...(this.options.platform && { platform: this.options.platform }) });
    let found = find();
    if (found && !this.intact(found)) found = undefined;
    if (!found) {
      const group = name === "yt-dlp" ? "yt-dlp" : "ffmpeg";
      const platform = this.options.platform ?? process.platform;
      const arch = this.options.arch ?? process.arch;
      const pinned = group === "yt-dlp" ? Boolean(YTDLP_PIN.assets[`${platform}-${arch}` as keyof typeof YTDLP_PIN.assets]) : Boolean(ffmpegAsset(platform, arch));
      if (!autoInstallEnabled(this.env)) {
        throw new ToolError("not_found", `${missingToolMessage(name)} (Automatic setup is off: FRAMELENS_AUTO_INSTALL=0.)`);
      }
      if (!pinned) throw new ToolError("not_found", missingToolMessage(name));
      let pending = this.installing.get(group);
      if (!pending) {
        pending = this.install(group, signal);
        this.installing.set(group, pending);
        pending.then(
          () => undefined,
          () => this.installing.delete(group),
        );
      }
      const note = await pending;
      callNotes.getStore()?.push(note);
      found = find();
      if (!found || !this.intact(found)) throw new ToolError("not_found", missingToolMessage(name));
    }
    // A session killed mid-download (while another one finished the install) left its partial file next to the
    // pinned binary; this is the first time this server uses that folder, so clear it now.
    if (found.source === "pinned") cleanStalePartials(dirname(found.path));
    this.located.set(name, found);
    return found;
  }

  private async install(group: "ffmpeg" | "yt-dlp", signal?: AbortSignal): Promise<string> {
    const common = {
      env: this.env,
      ...(this.options.platform && { platform: this.options.platform }),
      ...(this.options.arch && { arch: this.options.arch }),
      ...(signal && { signal }),
      ...(this.options.log && { log: this.options.log }),
    };
    try {
      if (group === "ffmpeg") {
        const result = await (this.options.prepareFfmpeg ?? prepareFfmpeg)(common);
        return (
          `Automatic setup: ffmpeg and ffprobe were not installed, so Frame Lens downloaded FFmpeg ${result.version} ` +
          `from ${result.source}, SHA-256 verified, into ${result.ffmpeg.replace(/[\\/][^\\/]+$/, "")} and continued. ` +
          "FRAMELENS_AUTO_INSTALL=0 turns this off."
        );
      }
      const result = await (this.options.prepareYtDlp ?? prepareYtDlp)(common);
      return (
        `Automatic setup: yt-dlp was not installed, so Frame Lens downloaded yt-dlp ${result.version} ` +
        `from github.com/yt-dlp/yt-dlp, SHA-256 verified, to ${result.path} and continued. FRAMELENS_AUTO_INSTALL=0 turns this off.`
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const name = group === "ffmpeg" ? "ffmpeg" : "yt-dlp";
      throw new ToolError("download_failed", `${name} is not installed, and downloading the pinned build failed: ${reason} ${missingToolMessage(name)}`);
    }
  }

  /**
   * What the engine starts with for ffmpeg or ffprobe: the path of one the user installed, or the bare name, which
   * `wrapExec` then locates (checking a pinned copy's hash first, installing when needed) on first use.
   */
  startPath(name: "ffmpeg" | "ffprobe"): string {
    try {
      const found = findTool(name, { env: this.env, ...(this.options.platform && { platform: this.options.platform }) });
      return found && found.source !== "pinned" ? found.path : name;
    } catch {
      return name;
    }
  }

  /**
   * Wraps the media modules' Exec: a bare "ffmpeg" or "ffprobe" (what the engine uses until one is located) is
   * located, or installed, on first use. Any other program runs as given.
   */
  wrapExec(exec: Exec): Exec {
    return async (file, args, options) => {
      if (file === "ffmpeg" || file === "ffprobe") file = (await this.locate(file, options?.signal)).path;
      return exec(file, args, options);
    };
  }
}

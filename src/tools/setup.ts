import type { Exec } from "../media/exec.js";
import { readEnv, type Env } from "./env.js";
import { ToolError } from "./errors.js";
import { ffmpegAsset, prepareFfmpeg, type PrepareFfmpegOptions, type PrepareFfmpegResult } from "./ffmpeg.js";
import { findTool, missingToolMessage, type ToolLocation, type ToolName } from "./find.js";
import { prepareYtDlp, YTDLP_PIN, type PrepareOptions, type PrepareResult } from "./ytdlp.js";

/** Automatic setup is on unless FRAMELENS_AUTO_INSTALL is 0, false, no or off. */
export function autoInstallEnabled(env: Env = process.env): boolean {
  const value = readEnv(env, "FRAMELENS_AUTO_INSTALL");
  return !value || !/^(0|false|no|off)$/i.test(value);
}

export interface ToolSetupOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
  /** Injected in tests. */
  prepareFfmpeg?: (options: PrepareFfmpegOptions) => Promise<PrepareFfmpegResult>;
  prepareYtDlp?: (options: PrepareOptions) => Promise<PrepareResult>;
}

/**
 * Finds the external tools a local tool needs and, when one is missing, downloads its pinned, checksum-verified
 * build into ~/.framelens/tools and carries on. What it did is kept as a note for the agent (`takeNotes`), so the
 * tool result can say so. FRAMELENS_AUTO_INSTALL=0 turns the downloads off.
 */
export class ToolSetup {
  private readonly notes: string[] = [];
  private readonly installing = new Map<"ffmpeg" | "yt-dlp", Promise<void>>();
  private readonly located = new Map<ToolName, ToolLocation>();

  constructor(private readonly options: ToolSetupOptions = {}) {}

  private get env(): Env {
    return this.options.env ?? process.env;
  }

  /** The tool's location, downloading the pinned build first when it is missing and automatic setup is on. */
  async locate(name: ToolName, signal?: AbortSignal): Promise<ToolLocation> {
    const cached = this.located.get(name);
    if (cached) return cached;
    const find = () => findTool(name, { env: this.env, ...(this.options.platform && { platform: this.options.platform }) });
    let found = find();
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
        pending.catch(() => this.installing.delete(group));
      }
      await pending;
      found = find();
      if (!found) throw new ToolError("not_found", missingToolMessage(name));
    }
    this.located.set(name, found);
    return found;
  }

  private async install(group: "ffmpeg" | "yt-dlp", signal?: AbortSignal): Promise<void> {
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
        this.notes.push(
          `Automatic setup: ffmpeg and ffprobe were not installed, so Frame Lens downloaded FFmpeg ${result.version} ` +
            `(${result.source}, SHA-256 verified) into ${result.ffmpeg.replace(/[\\/][^\\/]+$/, "")} and continued. ` +
            "FRAMELENS_AUTO_INSTALL=0 turns this off.",
        );
      } else {
        const result = await (this.options.prepareYtDlp ?? prepareYtDlp)(common);
        this.notes.push(
          `Automatic setup: yt-dlp was not installed, so Frame Lens downloaded yt-dlp ${result.version} ` +
            `(github.com/yt-dlp/yt-dlp, SHA-256 verified) to ${result.path} and continued. FRAMELENS_AUTO_INSTALL=0 turns this off.`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const name = group === "ffmpeg" ? "ffmpeg" : "yt-dlp";
      throw new ToolError("download_failed", `${name} is not installed, and downloading the pinned build failed: ${reason} ${missingToolMessage(name)}`);
    }
  }

  /** Notes about installs since the last call; each is returned once. */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }

  /**
   * Wraps the media modules' Exec: a bare "ffmpeg" or "ffprobe" (what the engine uses when neither was found at
   * start) is located, or installed, on first use. Any other program runs as given.
   */
  wrapExec(exec: Exec): Exec {
    return async (file, args, options) => {
      if (file === "ffmpeg" || file === "ffprobe") file = (await this.locate(file, options?.signal)).path;
      return exec(file, args, options);
    };
  }
}


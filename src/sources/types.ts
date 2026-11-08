import type { Env, FindOptions } from "../tools/index.js";

export type SourceKind = "youtube" | "url" | "file";

export interface CaptionTrack {
  path: string;
  /** Language code as yt-dlp names it, e.g. "en" or "ru". */
  language: string;
  /** true for automatic (speech-recognised) captions, false for ones the uploader made. */
  auto: boolean;
}

/** What `resolveSource` returns and writes to `<workspaceRoot>/<id>/source.json`. Paths are absolute. */
export interface SourceRecord {
  /** Workspace folder name: yt-<videoId>, file-<10 hex>, url-<10 hex>. */
  id: string;
  kind: SourceKind;
  /** What the caller passed in. */
  input: string;
  /** Canonical link for youtube/url sources. */
  url?: string;
  title?: string;
  /** The media to analyse. For local files this is the original file (referenced, not copied). */
  mediaPath: string;
  captions?: CaptionTrack[];
  fetchedAt: string;
  /** Versions of the tools used to produce this record. */
  tools: { ytDlp?: string; ffmpeg?: string };
  /** Set on the returned object only (not stored): the workspace already had the media. */
  reused?: boolean;
}

export interface ResolveOptions {
  /** Folder that holds one sub-folder per source (the core passes its workspace root). */
  workspaceRoot: string;
  env?: Env;
  signal?: AbortSignal;
  /** Progress and notes, one line each. Goes to stderr in the CLI. Never gets cookie values. */
  log?: (line: string) => void;
  /** Time limit for one download. Default 30 minutes. */
  downloadTimeoutMs?: number;
  /** Where to look for tools (tests). */
  find?: FindOptions;
}

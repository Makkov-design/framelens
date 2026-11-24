import { oneLine } from "./text.js";

/** Bad tool input. The message is shown to the caller as is. */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}

/** Bad server configuration (missing key, invalid env value). */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** No Gemini key in the environment. The server still starts and every tool explains how to add one. */
export class MissingKeyError extends ConfigError {
  override name = "MissingKeyError";
}

export type AnalyzerErrorKind =
  | "auth"
  | "quota"
  | "invalid_request"
  | "video_unavailable"
  | "model_not_found"
  | "blocked"
  | "empty_response"
  | "bad_response"
  | "timeout"
  | "unavailable"
  | "unknown";

/** What a 429 says about the limit that was hit. */
export interface QuotaInfo {
  /** "day" resets at midnight Pacific time; "minute" within a minute. */
  scope: "day" | "minute" | "unknown";
  /** The limit counts input tokens per minute. If it is hit again after one wait, this request alone is bigger than it. */
  tooLarge?: boolean;
  /** Google's quota id, e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier. */
  quotaId?: string;
  /** The limit's value; "0" means the model is not available on this tier. */
  limit?: string;
  model?: string;
  retryDelayMs?: number;
}

/** A failed call to the video model, with a message safe to show to the caller. */
export class AnalyzerError extends Error {
  override name = "AnalyzerError";

  constructor(
    readonly kind: AnalyzerErrorKind,
    message: string,
    readonly status?: number,
    readonly quota?: QuotaInfo,
    /** The same request may well succeed on the next try (a proxy's page, a one-off malformed answer). */
    readonly transient = false,
  ) {
    super(message);
  }
}

/**
 * A failure whose message quotes an external program's output (ffmpeg's or yt-dlp's stderr). That output can repeat
 * text from the source (a file name in a playlist, a caption track's name): the detail is passed through `oneLine`
 * with a cap, and the tool result carries the third-party notice.
 */
export class ToolOutputError extends Error {
  override name = "ToolOutputError";
  readonly thirdParty = true;

  /** `output` is the program's stderr tail; its last 200 characters are kept on one line (errors come last). */
  constructor(prefix: string, output: string, fallback: string) {
    const line = oneLine(output, 4000);
    super(`${prefix}: ${line ? (line.length > 200 ? `…${line.slice(-199)}` : line) : fallback}`);
  }
}

/** The error, or one it was made from, quotes third-party text (see ToolOutputError, SourceError). */
export function quotesThirdParty(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { thirdParty?: unknown }).thirdParty === true) return true;
  }
  return false;
}

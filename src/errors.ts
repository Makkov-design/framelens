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
  /** The limit counts input tokens and this one request is bigger than it, so waiting cannot help. */
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
  ) {
    super(message);
  }
}

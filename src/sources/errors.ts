import { InvalidInputError } from "../errors.js";

export type SourceErrorCode =
  | "bad_input"
  | "file_missing"
  | "inbox_empty"
  | "login_required"
  | "unavailable"
  | "geo_blocked"
  | "unsupported_url"
  | "too_large"
  | "download_failed"
  | "cookies_unsupported";

/** Why a source could not be fetched. The message says what to do next and is safe to show to the user. */
export class SourceError extends InvalidInputError {
  override name = "SourceError";

  /**
   * The failure may come from access control (a login, an age gate, a bot check, a block, a rate limit, a private
   * post, HTTP 401/403/429): nothing may try to get past it another way.
   */
  readonly accessControl: boolean;

  constructor(
    readonly code: SourceErrorCode,
    message: string,
    options: { accessControl?: boolean } = {},
  ) {
    super(message);
    this.accessControl = options.accessControl === true;
  }
}

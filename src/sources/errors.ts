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

  /** The site asked to prove a human is there (a bot check or CAPTCHA): nothing may try to get past it. */
  readonly botCheck: boolean;

  constructor(
    readonly code: SourceErrorCode,
    message: string,
    options: { botCheck?: boolean } = {},
  ) {
    super(message);
    this.botCheck = options.botCheck === true;
  }
}

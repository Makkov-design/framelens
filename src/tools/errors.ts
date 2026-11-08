import { InvalidInputError } from "../errors.js";

export type ToolErrorCode = "not_found" | "bad_override" | "spawn_failed" | "timeout" | "aborted" | "unsupported_platform" | "download_failed" | "checksum";

/** A problem running or installing an external tool. The message is safe to show to the user. */
export class ToolError extends InvalidInputError {
  override name = "ToolError";

  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /** Output captured before the process was stopped, when there is any. */
    readonly output?: { stdout: string; stderr: string },
  ) {
    super(message);
  }
}

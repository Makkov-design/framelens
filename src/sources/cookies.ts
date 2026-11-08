import { existsSync, statSync } from "node:fs";
import { readEnv, type Env } from "../tools/env.js";
import { SourceError } from "./errors.js";

// Chromium browsers lock and encrypt their cookie store on Windows, so yt-dlp cannot read it there.
const CHROMIUM = /^(chrome|chromium|edge|brave|opera|vivaldi|whale)\b/i;

/**
 * yt-dlp cookie arguments, only when the user opted in with FRAMELENS_COOKIES_FILE or FRAMELENS_COOKIES_FROM_BROWSER.
 * We never open the cookie store ourselves; yt-dlp does, and only for the one request.
 */
export function cookieArgs(env: Env, platform: NodeJS.Platform = process.platform): string[] {
  const file = readEnv(env, "FRAMELENS_COOKIES_FILE");
  if (file) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new SourceError("bad_input", `FRAMELENS_COOKIES_FILE points to "${file}", which is not a file.`);
    }
    return ["--cookies", file];
  }
  const browser = readEnv(env, "FRAMELENS_COOKIES_FROM_BROWSER");
  if (browser) {
    if (platform === "win32" && CHROMIUM.test(browser)) {
      throw new SourceError(
        "cookies_unsupported",
        `FRAMELENS_COOKIES_FROM_BROWSER=${browser} cannot work on Windows (the browser locks its cookies). ` +
          "Use firefox, or export a cookies.txt and set FRAMELENS_COOKIES_FILE, or save the video into your inbox folder.",
      );
    }
    return ["--cookies-from-browser", browser];
  }
  return [];
}

/** Arguments with the cookie value removed, for logs. */
export function redactArgs(args: string[]): string[] {
  return args.map((arg, i) => (args[i - 1] === "--cookies" || args[i - 1] === "--cookies-from-browser" ? "<opt-in>" : arg));
}

import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readEnv, ToolError, type Env } from "../tools/index.js";
import { SourceError } from "./errors.js";

/**
 * cobalt (github.com/imputnet/cobalt) as an opt-in second way to fetch a link, only through the user's own instance:
 * FRAMELENS_COBALT_URL names it, FRAMELENS_COBALT_KEY is its API key when it asks for one. Public instances are not
 * supported (the main one, api.cobalt.tools, is behind bot protection and is not for other projects), and cobalt is
 * never asked to get past a bot check or a login wall the user has not opened themselves.
 */

/** The configured instance's origin without credentials or key, for messages. */
export function cobaltOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "(not a valid address)";
  }
}

export function cobaltConfigured(env: Env): boolean {
  return Boolean(readEnv(env, "FRAMELENS_COBALT_URL"));
}

/** Whether a yt-dlp failure may be retried through cobalt: never a bot check, a removed video, a geo block or a size limit. */
export function cobaltMayRetry(error: unknown, env: Env): boolean {
  if (!cobaltConfigured(env)) return false;
  if (error instanceof SourceError) return !error.botCheck && ["unsupported_url", "download_failed", "login_required"].includes(error.code);
  // yt-dlp itself missing and not installable: the instance can still fetch the link.
  return error instanceof ToolError && ["not_found", "download_failed", "unsupported_platform"].includes(error.code);
}

function instanceUrl(env: Env): URL {
  const raw = readEnv(env, "FRAMELENS_COBALT_URL")!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError("bad_input", `FRAMELENS_COBALT_URL is not a valid address: "${raw.slice(0, 200)}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceError("bad_input", "FRAMELENS_COBALT_URL must be an http(s) address of your own cobalt instance.");
  if (url.username || url.password) throw new SourceError("bad_input", "FRAMELENS_COBALT_URL must not hold a user name or password; put an API key in FRAMELENS_COBALT_KEY.");
  if (/(^|\.)cobalt\.tools$/i.test(url.hostname)) {
    throw new SourceError("bad_input", "FRAMELENS_COBALT_URL points at a public cobalt instance. Frame Lens works only with a cobalt instance you run yourself.");
  }
  url.hash = "";
  url.search = "";
  return url;
}

interface CobaltResponse {
  status?: string;
  url?: string;
  filename?: string;
  picker?: { type?: string; url?: string }[];
  error?: { code?: string; context?: { service?: string; limit?: number } };
}

const EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v", ".gif", ".mp3", ".m4a", ".ogg", ".opus", ".wav"]);

function extensionOf(filename: string | undefined): string {
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(filename ?? "")?.[0]?.toLowerCase();
  return ext && EXTENSIONS.has(ext) ? ext : ".mp4";
}

/** cobalt's error codes in plain words. */
function explain(code: string): string {
  if (/auth/.test(code)) return `the instance asks for authentication (${code}): set FRAMELENS_COBALT_KEY to an API key it accepts`;
  if (/link\.(invalid|unsupported)|service\.unsupported/.test(code)) return `it does not support this link (${code})`;
  if (/content\..*(private|unavailable|empty)|fetch\.empty/.test(code)) return `the post is private, removed or has nothing to download (${code})`;
  if (/rate_exceeded|rate/.test(code)) return `it is limiting requests (${code}); try again later`;
  return code;
}

export interface CobaltFetchParams {
  url: string;
  mediaDir: string;
  env: Env;
  maxBytes: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface CobaltFetchResult {
  mediaPath: string;
  title?: string;
  instance: string;
}

/** Asks the user's cobalt instance for the link's media and saves it as `<mediaDir>/source.<ext>`. */
export async function fetchWithCobalt(params: CobaltFetchParams): Promise<CobaltFetchResult> {
  const { env, maxBytes } = params;
  const doFetch = params.fetchFn ?? fetch;
  const log = params.log ?? (() => {});
  const instance = instanceUrl(env);
  const key = readEnv(env, "FRAMELENS_COBALT_KEY");
  const timeout = AbortSignal.timeout(params.timeoutMs ?? 30 * 60_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  log(`cobalt: asking ${instance.origin} for the media`);

  let response: Response;
  try {
    response = await doFetch(instance.href, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(key && { Authorization: `Api-Key ${key}` }) },
      // alwaysProxy: the media then comes through the user's own instance only; localProcessing off so it merges.
      body: JSON.stringify({ url: params.url, videoQuality: "1080", downloadMode: "auto", filenameStyle: "basic", alwaysProxy: true, localProcessing: "disabled" }),
      // A redirect would resend the request (and the key) somewhere else: say where instead of following it.
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
  } catch (error) {
    throw new SourceError("download_failed", `Your cobalt instance at ${instance.origin} did not answer: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get("location");
    throw new SourceError("download_failed", `Your cobalt instance at ${instance.origin} redirects${to ? ` to ${cobaltOrigin(new URL(to, instance).href)}` : ""}; set FRAMELENS_COBALT_URL to the address it answers on.`);
  }
  let body: CobaltResponse;
  try {
    body = (await response.json()) as CobaltResponse;
  } catch {
    throw new SourceError("download_failed", `Your cobalt instance at ${instance.origin} answered HTTP ${response.status} without cobalt's JSON. Check FRAMELENS_COBALT_URL.`);
  }
  if (body.status === "error" || !response.ok) {
    throw new SourceError("download_failed", `Your cobalt instance could not fetch it: ${explain(String(body.error?.code ?? `HTTP ${response.status}`))}.`);
  }
  let mediaUrl: string | undefined;
  if (body.status === "tunnel" || body.status === "redirect") mediaUrl = body.url;
  else if (body.status === "picker") {
    mediaUrl = body.picker?.find((p) => p.type === "video")?.url ?? body.picker?.find((p) => p.type === "gif")?.url;
    if (!mediaUrl) throw new SourceError("unavailable", "This post holds only pictures, no video; save the pictures yourself if you need them.");
  } else {
    throw new SourceError("download_failed", `Your cobalt instance answered "${String(body.status).slice(0, 40)}", which Frame Lens cannot use (it needs a file, not processing in a browser).`);
  }
  let media: URL;
  try {
    media = new URL(String(mediaUrl), instance);
  } catch {
    throw new SourceError("download_failed", "Your cobalt instance returned an invalid media address.");
  }
  // Plain http only from the instance itself (a home server); a file anywhere else must come over https.
  if (!(media.origin === instance.origin || media.protocol === "https:")) {
    throw new SourceError("download_failed", "Your cobalt instance pointed to a media address that is not https; it was not downloaded.");
  }

  mkdirSync(params.mediaDir, { recursive: true });
  for (const name of readdirSync(params.mediaDir)) if (name.startsWith("source.")) rmSync(join(params.mediaDir, name), { force: true });
  const out = join(params.mediaDir, `source${extensionOf(body.filename)}`);
  const partial = `${out}.part`;
  let file: Response;
  try {
    file = await doFetch(media.href, { redirect: "follow", signal });
  } catch (error) {
    throw new SourceError("download_failed", `Could not download the media from your cobalt instance: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (!file.ok || !file.body) throw new SourceError("download_failed", `Your cobalt instance's media link answered HTTP ${file.status}.`);
  const fd = openSync(partial, "w");
  let size = 0;
  try {
    const reader = file.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SourceError("too_large", `The video is over the ${Math.round(maxBytes / 1024 / 1024)} MB limit. Raise FRAMELENS_MAX_DOWNLOAD_MB or use a shorter video.`);
      }
      writeSync(fd, value);
    }
  } catch (error) {
    closeSync(fd);
    rmSync(partial, { force: true });
    if (error instanceof SourceError) throw error;
    throw new SourceError("download_failed", `The download from your cobalt instance broke off: ${error instanceof Error ? error.message : String(error)}.`);
  }
  closeSync(fd);
  if (size === 0) {
    rmSync(partial, { force: true });
    throw new SourceError("download_failed", "Your cobalt instance sent an empty file.");
  }
  renameSync(partial, out);
  log(`cobalt: saved ${size} bytes`);
  const title = body.filename?.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\r\n]+/g, " ").slice(0, 200);
  return { mediaPath: out, ...(title && { title }), instance: instance.origin };
}

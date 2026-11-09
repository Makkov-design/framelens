import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { anySignal } from "../tools/download.js";
import { readEnv, type Env } from "../tools/index.js";
import { SourceError } from "./errors.js";

/**
 * cobalt (github.com/imputnet/cobalt) as an opt-in second way to fetch a link, meant for a cobalt the user runs
 * themselves: FRAMELENS_COBALT_URL names it, FRAMELENS_COBALT_KEY is its API key when it asks for one. Frame Lens
 * cannot tell someone else's public instance from the user's own; it only refuses the official cobalt.tools hosts
 * by name. A link goes to cobalt only when yt-dlp has no extractor for it ("Unsupported URL") or fails for a reason
 * that is clearly not access control: anything that looks like a login, an age gate, a bot check, a block, a rate
 * limit, a private or members-only post, or an HTTP 401/403/429 stays with the user (principle 7, docs/DESIGN.md).
 */

/** The configured instance's origin without credentials, path or key, for messages. */
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

/** The only failures cobalt may retry: yt-dlp has no extractor, or failed for a reason that is not access control. */
export function cobaltMayRetry(error: unknown, env: Env): boolean {
  if (!cobaltConfigured(env)) return false;
  return error instanceof SourceError && (error.code === "unsupported_url" || error.code === "download_failed") && !error.accessControl;
}

const PUBLIC = /(^|\.)cobalt\.tools$/;

/** The instance address, checked, or why it cannot be used. Never repeats what was configured (it may hold a key). */
export function checkCobaltInstance(env: Env): { url: URL } | { error: string } {
  const raw = readEnv(env, "FRAMELENS_COBALT_URL");
  if (!raw) return { error: "FRAMELENS_COBALT_URL is not set." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "FRAMELENS_COBALT_URL is not a valid address (it should look like https://cobalt.example.net/)." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "FRAMELENS_COBALT_URL must be an http(s) address of your own cobalt instance." };
  if (url.username || url.password) return { error: "FRAMELENS_COBALT_URL must not hold a user name or password; put an API key in FRAMELENS_COBALT_KEY." };
  if (url.search) return { error: "FRAMELENS_COBALT_URL must not hold a query; put an API key in FRAMELENS_COBALT_KEY." };
  // "api.cobalt.tools." and "API.COBALT.TOOLS:443" are the same host.
  if (PUBLIC.test(url.hostname.toLowerCase().replace(/\.+$/, ""))) {
    return { error: "FRAMELENS_COBALT_URL points at the official public cobalt instance, which is not for other projects. Use a cobalt instance you run yourself." };
  }
  url.hash = "";
  return { url };
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
  return code.slice(0, 120);
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses (IPv4 and IPv6). */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && (c === 0 || c === 2))
    );
  }
  if (isIP(ip) === 6) return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith("::ffff:");
  return false;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/;

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Every address the media download goes to: the instance itself, or an https host on the public internet. A
 * redirect cannot point it at this computer or the local network (a cobalt answer or tunnel is third-party data).
 */
async function checkHop(url: URL, instance: URL, lookup: Lookup): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceError("download_failed", "Your cobalt instance pointed to a media address that is not http(s); it was not downloaded.");
  if (url.origin === instance.origin) return;
  if (url.protocol !== "https:") throw new SourceError("download_failed", "Your cobalt instance pointed to a media address on another host that is not https; it was not downloaded.");
  if (url.username || url.password) throw new SourceError("download_failed", "Your cobalt instance pointed to a media address with credentials; it was not downloaded.");
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (LOCAL_NAMES.test(host) || !host.includes(".")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new SourceError("download_failed", `Your cobalt instance pointed to ${host}, which does not resolve.`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new SourceError("download_failed", `Your cobalt instance pointed to ${host}, which is on this computer or the local network; it was not downloaded.`);
  }
}

/** Media types cobalt hands out; a generic binary type must start like a media file. */
function looksLikeMedia(type: string, head: Uint8Array): boolean {
  const t = type.split(";")[0]!.trim().toLowerCase();
  if (/^(video|audio)\//.test(t) || t === "image/gif") return true;
  if (t !== "application/octet-stream" && t !== "binary/octet-stream") return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  return (
    ascii(4, 8) === "ftyp" ||
    (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) ||
    ascii(0, 4) === "GIF8" ||
    ascii(0, 3) === "ID3" ||
    ascii(0, 4) === "OggS" ||
    ascii(0, 4) === "RIFF" ||
    ascii(0, 4) === "fLaC" ||
    (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)
  );
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
  lookup?: Lookup;
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
  const lookup = params.lookup ?? systemLookup;
  const log = params.log ?? (() => {});
  const checked = checkCobaltInstance(env);
  if ("error" in checked) throw new SourceError("bad_input", checked.error);
  const instance = checked.url;
  const key = readEnv(env, "FRAMELENS_COBALT_KEY");
  const signal = anySignal(params.signal, AbortSignal.timeout(params.timeoutMs ?? 30 * 60_000));
  log(`cobalt: asking ${instance.origin} for the media`);

  let response: Response;
  try {
    response = await doFetch(instance.href, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(key && { Authorization: `Api-Key ${key}` }) },
      // alwaysProxy: the media then comes through the user's own instance only. Only fields cobalt 10 already knew,
      // because it rejects unknown ones; the instance merges video and sound itself by default.
      body: JSON.stringify({ url: params.url, videoQuality: "1080", downloadMode: "auto", filenameStyle: "basic", alwaysProxy: true }),
      // A redirect would resend the request (and the key) somewhere else: say where instead of following it.
      redirect: "manual",
      signal: anySignal(signal, AbortSignal.timeout(90_000)),
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
  let current: URL;
  try {
    current = new URL(String(mediaUrl), instance);
  } catch {
    throw new SourceError("download_failed", "Your cobalt instance returned an invalid media address.");
  }

  // Redirects are followed by hand so that every hop is checked, not only the first address.
  let file: Response | undefined;
  for (let hop = 0; hop <= 5; hop++) {
    await checkHop(current, instance, lookup);
    try {
      file = await doFetch(current.href, { redirect: "manual", signal });
    } catch (error) {
      throw new SourceError("download_failed", `Could not download the media from your cobalt instance: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (file.status < 300 || file.status >= 400) break;
    const location = file.headers.get("location");
    await file.body?.cancel().catch(() => undefined);
    if (!location || hop === 5) throw new SourceError("download_failed", "The media address from your cobalt instance redirects too often; it was not downloaded.");
    current = new URL(location, current);
    file = undefined;
  }
  if (!file?.ok || !file.body) throw new SourceError("download_failed", `Your cobalt instance's media link answered HTTP ${file?.status ?? "?"}.`);
  const type = file.headers.get("content-type") ?? "";

  mkdirSync(params.mediaDir, { recursive: true });
  for (const name of readdirSync(params.mediaDir)) if (name.startsWith("source.")) rmSync(join(params.mediaDir, name), { force: true });
  const out = join(params.mediaDir, `source${extensionOf(body.filename)}`);
  const partial = `${out}.part`;
  const fd = openSync(partial, "w");
  let size = 0;
  try {
    const reader = file.body.getReader();
    for (let first = true; ; first = false) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first && !looksLikeMedia(type, value)) {
        await reader.cancel().catch(() => undefined);
        throw new SourceError("download_failed", `Your cobalt instance sent ${type.split(";")[0] || "a file without a type"}, not a video or audio file; it was not kept.`);
      }
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

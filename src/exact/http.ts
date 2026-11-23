import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkHop, pinnedGet, systemLookup, type Lookup } from "../sources/cobalt.js";

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "error" | "manual" }) => Promise<FetchResponse>;

/** What `readCapped` needs from an answer: a pinned request has a body and no `arrayBuffer`. */
type Readable = { headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer?(): Promise<ArrayBuffer> };

const MAX_DOWNLOAD = 30 * 1024 * 1024;
const MAX_FIGMA_JSON = 100 * 1024 * 1024;
const tooLarge = (max: number) => new Error(`File is larger than ${max / 1024 / 1024} MB.`);

/** Reads a response body, stopping as soon as it passes `max` bytes instead of holding all of it in memory first. */
export async function readCapped(res: Readable | FetchResponse, max: number): Promise<Buffer> {
  if (Number(res.headers?.get("content-length") ?? 0) > max) throw tooLarge(max);
  if (!res.body) {
    const data = Buffer.from((await res.arrayBuffer?.()) ?? new ArrayBuffer(0));
    if (data.length > max) throw tooLarge(max);
    return data;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const isHttpUrl = (s: string) => /^https?:\/\//i.test(s.trim());

const MAX_REDIRECTS = 5;
const LINK_WORDING = { who: "The link", what: "an address" };

/**
 * Downloads a .json / .lottie / .riv file into `dir` and returns its path. Only http(s), capped size and time.
 * The link's own host is the user's choice (a local dev server is fine). Redirects are followed by hand, like the
 * cobalt download: a hop to another host must be https on the public internet, so a hostile page cannot send the
 * download to this computer, the local network or a cloud metadata address, and each request goes to the address that
 * was checked. An injected `fetchImpl` (tests) replaces the pinned request.
 */
export async function downloadFile(url: string, dir: string, fetchImpl?: FetchLike, lookup: Lookup = systemLookup): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) links can be downloaded.");
  if (parsed.username || parsed.password) throw new Error("Links with a user name or password are not accepted.");
  const signal = AbortSignal.timeout(30_000);
  let current = parsed;
  let res: { status: number; headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer?(): Promise<ArrayBuffer> } | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await checkHop(current, parsed, lookup, LINK_WORDING);
    res = fetchImpl ? await fetchImpl(current.href, { signal, redirect: "manual" }) : await pinnedGet(current, address, signal);
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers?.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location || hop === MAX_REDIRECTS) throw new Error(`The link redirects too often, or without saying where (${parsed.host}).`);
    try {
      current = new URL(location, current);
    } catch {
      throw new Error("The link redirected to an address that is not valid.");
    }
    res = undefined;
  }
  if (!res || res.status < 200 || res.status >= 300) {
    await res?.body?.cancel().catch(() => undefined);
    throw new Error(`Download failed: HTTP ${res?.status ?? "?"} for ${current.host}.`);
  }
  const data = await readCapped(res, MAX_DOWNLOAD);
  mkdirSync(dir, { recursive: true });
  const base = basename(parsed.pathname).replace(/[^A-Za-z0-9._-]/g, "_") || "animation";
  const ext = /\.(json|lottie|riv)$/i.test(base) ? "" : data[0] === 0x50 && data[1] === 0x4b ? ".lottie" : data.subarray(0, 4).toString("latin1") === "RIVE" ? ".riv" : ".json";
  const file = join(dir, `${createHash("sha1").update(parsed.href).digest("hex").slice(0, 8)}-${base}${ext}`);
  writeFileSync(file, data);
  return file;
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ status: number; body: unknown }> {
  // The token header must reach api.figma.com only: no redirect may carry it elsewhere.
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000), redirect: "error" });
  let body: unknown;
  try {
    body = res.body ? JSON.parse((await readCapped(res, MAX_FIGMA_JSON)).toString("utf8")) : await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

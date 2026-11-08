import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "error" }) => Promise<FetchResponse>;

const MAX_DOWNLOAD = 30 * 1024 * 1024;
const MAX_FIGMA_JSON = 100 * 1024 * 1024;
const tooLarge = (max: number) => new Error(`File is larger than ${max / 1024 / 1024} MB.`);

/** Reads a response body, stopping as soon as it passes `max` bytes instead of holding all of it in memory first. */
export async function readCapped(res: FetchResponse, max: number): Promise<Buffer> {
  if (Number(res.headers?.get("content-length") ?? 0) > max) throw tooLarge(max);
  if (!res.body) {
    const data = Buffer.from(await res.arrayBuffer());
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

/** Downloads a .json / .lottie file into `dir` and returns its path. Only http(s), capped size and time. */
export async function downloadFile(url: string, dir: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) links can be downloaded.");
  if (parsed.username || parsed.password) throw new Error("Links with a user name or password are not accepted.");
  const res = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${parsed.host}.`);
  const data = await readCapped(res, MAX_DOWNLOAD);
  mkdirSync(dir, { recursive: true });
  const base = basename(parsed.pathname).replace(/[^A-Za-z0-9._-]/g, "_") || "animation";
  const ext = /\.(json|lottie)$/i.test(base) ? "" : data[0] === 0x50 && data[1] === 0x4b ? ".lottie" : ".json";
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

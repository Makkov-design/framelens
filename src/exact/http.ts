import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

const MAX_DOWNLOAD = 30 * 1024 * 1024;

export const isHttpUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Downloads a .json / .lottie file into `dir` and returns its path. Only http(s), capped size and time. */
export async function downloadFile(url: string, dir: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) links can be downloaded.");
  if (parsed.username || parsed.password) throw new Error("Links with a user name or password are not accepted.");
  const res = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${parsed.host}.`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_DOWNLOAD) throw new Error(`File is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB.`);
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
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

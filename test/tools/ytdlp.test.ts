import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareYtDlp, YTDLP_PIN, ytDlpPinnedPath } from "../../src/tools/ytdlp.js";

const body = "pretend-yt-dlp-binary";
const hash = createHash("sha256").update(body).digest("hex");
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "framelens-pin-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeFetch(sums: string, calls: string[] = [], binary = body): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("SHA2-256SUMS")) return new Response(sums);
    if (String(url).endsWith("/missing.exe")) return new Response("nope", { status: 404 });
    return new Response(binary);
  }) as unknown as typeof fetch;
}

const base = { platform: "win32" as const, arch: "x64", baseUrl: "https://example.test/rel", expectedSha256: hash };

describe("pinned yt-dlp", () => {
  it("records a version and a hash for every supported platform", () => {
    expect(YTDLP_PIN.version).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    for (const asset of Object.values(YTDLP_PIN.assets)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads, verifies against the code and the release sums, and installs under the version folder", async () => {
    const calls: string[] = [];
    const result = await prepareYtDlp({ ...base, env: { FRAMELENS_HOME: home }, fetchFn: fakeFetch(`${hash}  yt-dlp.exe\n`, calls) });
    expect(result.downloaded).toBe(true);
    expect(result.path).toBe(ytDlpPinnedPath(home, "win32", "x64"));
    expect(readFileSync(result.path, "utf8")).toBe(body);
    expect(calls).toEqual(["https://example.test/rel/yt-dlp.exe", "https://example.test/rel/SHA2-256SUMS"]);
  });

  it("does nothing when a verified copy is already there", async () => {
    const env = { FRAMELENS_HOME: home };
    await prepareYtDlp({ ...base, env, fetchFn: fakeFetch(`${hash}  yt-dlp.exe`) });
    const calls: string[] = [];
    const again = await prepareYtDlp({ ...base, env, fetchFn: fakeFetch("", calls) });
    expect(again.downloaded).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rejects and discards a download whose hash differs from the pin", async () => {
    const error = await prepareYtDlp({ ...base, env: { FRAMELENS_HOME: home }, fetchFn: fakeFetch(`${hash}  yt-dlp.exe`, [], "tampered") }).catch((e) => e);
    expect(error.code).toBe("checksum");
    expect(existsSync(ytDlpPinnedPath(home, "win32", "x64")!)).toBe(false);
  });

  it("rejects when the release's own sums disagree", async () => {
    const other = "0".repeat(64);
    const error = await prepareYtDlp({ ...base, env: { FRAMELENS_HOME: home }, fetchFn: fakeFetch(`${other}  yt-dlp.exe`) }).catch((e) => e);
    expect(error.code).toBe("checksum");
    expect(existsSync(ytDlpPinnedPath(home, "win32", "x64")!)).toBe(false);
  });

  it("reports HTTP failures and unsupported platforms", async () => {
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(prepareYtDlp({ ...base, env: { FRAMELENS_HOME: home }, fetchFn: failing })).rejects.toMatchObject({ code: "download_failed" });
    await expect(prepareYtDlp({ env: { FRAMELENS_HOME: home }, platform: "freebsd", arch: "x64" })).rejects.toMatchObject({ code: "unsupported_platform" });
  });
});

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAGE_SCRIPT } from "../../src/browser/web.js";
import { hostSlug, readingFileName, recordingFileName, stamp } from "../../extension/src/names.js";
import { findInfo, readWebmDurationMs, withWebmDuration } from "../../extension/src/webm.js";
import { tempDir } from "../media/fixtures.js";

const dir = tempDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("the extension's manifest and build", () => {
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

  it("is Manifest V3 with only the permissions its two buttons need, no host access and no content scripts", () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "downloads", "offscreen", "scripting", "tabCapture"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toMatch(/^script-src 'self';/);
  });

  const built = existsSync("extension/dist/manifest.json");
  it.skipIf(!built)("ships Frame Lens's own page reader unchanged, its version, and no code that loads or sends anything", () => {
    const reader = readFileSync("extension/dist/reader.js", "utf8");
    expect(reader).toContain(PAGE_SCRIPT);
    expect(JSON.parse(readFileSync("extension/dist/manifest.json", "utf8")).version).toBe(pkg.version);
    for (const name of readdirSync("extension/dist").filter((n) => n.endsWith(".js"))) {
      const code = readFileSync(join("extension/dist", name), "utf8");
      expect(code, name).not.toMatch(/\beval\(|new Function\(|importScripts\(|XMLHttpRequest|WebSocket\(|sendBeacon|https?:\/\/(?!example\.test)/);
      // fetch only for the recorder's own blob: file in the live check helper, never in the extension.
      expect(code, name).not.toMatch(/\bfetch\(/);
    }
    for (const page of ["popup.html", "offscreen.html"]) expect(readFileSync(join("extension/dist", page), "utf8")).not.toMatch(/<script(?![^>]*\bsrc="[a-z]+\.js")/);
  });
});

describe("file names", () => {
  it("saves into Downloads/FrameLens with the host and the local time", () => {
    const d = new Date(2026, 10, 9, 4, 5, 6);
    expect(stamp(d)).toBe("20261109-040506");
    expect(readingFileName("https://www.instagram.com/reel/abc", d)).toBe("FrameLens/page-instagram.com-20261109-040506.framelens.json");
    expect(recordingFileName("https://x.com/a/status/1", d)).toBe("FrameLens/recording-x.com-20261109-040506.webm");
    expect(hostSlug("about:blank")).toBe("page");
    expect(hostSlug("http://[::1]:8080/")).toBe("1");
  });
});

/** A WebM header the way Chrome's MediaRecorder writes it: Segment of unknown size, Info without Duration. */
function recorderWebm(withDuration = false): Uint8Array<ArrayBuffer> {
  const info = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x4d, 0x80, 0x84, 0x43, 0x68, 0x72, 0x6d]; // TimecodeScale 1e6, MuxingApp "Chrm"
  if (withDuration) info.push(0x44, 0x89, 0x84, 0x45, 0x1c, 0x40, 0x00); // Duration 2500 (float32)
  return new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x77, // EBML header with DocType-ish child
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Segment, unknown size
    0x15, 0x49, 0xa9, 0x66, 0x80 | info.length, ...info,
    0x16, 0x54, 0xae, 0x6b, 0x82, 0xae, 0x80, // Tracks (empty TrackEntry)
    0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00, // Cluster, Timecode 0
  ]);
}

describe("WebM duration", () => {
  it("writes the recording's duration into the Segment Info and keeps everything after it", async () => {
    const original = recorderWebm();
    expect(readWebmDurationMs(original)).toBeUndefined();
    const fixed = new Uint8Array(await (await withWebmDuration(new Blob([original], { type: "video/webm" }), 2512.5)).arrayBuffer());
    expect(readWebmDurationMs(fixed)).toBeCloseTo(2512.5, 6);
    expect(Buffer.from(fixed.subarray(fixed.length - 21))).toEqual(Buffer.from(original.subarray(original.length - 21)));
    expect(findInfo(fixed)?.hasDuration).toBe(true);
  });

  it("leaves a file alone that already has a duration, is not WebM, or when the duration is unknown", async () => {
    const has = new Blob([recorderWebm(true)]);
    expect(await withWebmDuration(has, 1000)).toBe(has);
    expect(readWebmDurationMs(recorderWebm(true))).toBeCloseTo(2500, 3);
    const other = new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])]);
    expect(await withWebmDuration(other, 1000)).toBe(other);
    const plain = new Blob([recorderWebm()]);
    expect(await withWebmDuration(plain, 0)).toBe(plain);
  });
});


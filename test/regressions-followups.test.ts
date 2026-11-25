// Follow-ups from the audit receipts on PR #46 (L2, N3, N4, X5): each test fails without its fix.
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specFromPage, type PageReading } from "../src/browser/web.js";
import { evidenceText, unlabelledNumbers } from "../src/style/spec.js";
import { shareableLink } from "../src/text.js";
import { Workspace } from "../src/workspace/workspace.js";

describe("N3: shareable links hide a token in the path", () => {
  it("drops path parameters and the segment after a token-like name", () => {
    expect(shareableLink("https://cdn.example.com/token/abcDEF123secret/v.mp4")).toBe("https://cdn.example.com/token/…/v.mp4");
    expect(shareableLink("https://cdn.example.com/a/v.mp4;jsessionid=ABC123DEF")).toBe("https://cdn.example.com/a/v.mp4");
    expect(shareableLink("https://cdn.example.com/sig/x1;y=2/v.mp4")).toBe("https://cdn.example.com/sig/…/v.mp4");
  });

  it("hides a segment that looks like a token, and keeps slugs, ids and file names", () => {
    expect(shareableLink("https://x.example/files/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl/clip.mp4")).toBe("https://x.example/files/…/clip.mp4");
    expect(shareableLink("https://x.example/v/1a2b3c4d5e6f7a8b9c0d/play")).toBe("https://x.example/v/…/play");
    for (const link of [
      "https://example.com/blog/how-to-animate-a-landing-page-in-2024",
      "https://vimeo.com/123456789",
      "https://cdn.example.com/b/0f8e2a9c4d1b7e6a5f3c2b1a0d9e8f7c.mp4",
      "https://www.tiktok.com/@someone/video/7312345678901234567",
    ]) {
      expect(shareableLink(link)).toBe(link);
    }
    expect(shareableLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("N4: hard links inside a planted workspace", () => {
  it("are neither written through nor read", () => {
    const root = mkdtempSync(join(tmpdir(), "fl-n4-"));
    try {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "mine");
      const wsRoot = join(root, ".framelens");
      mkdirSync(join(wsRoot, "yt-abc"), { recursive: true });
      // A workspace that came with a project (from an archive) can hold a hard link to a file elsewhere.
      linkSync(outside, join(wsRoot, "yt-abc", "probe.json"));
      const ws = new Workspace(wsRoot, "yt-abc");
      expect(() => ws.writeJson("probe.json", { planted: false })).toThrow(/through a hard link/);
      expect(() => ws.readJson("probe.json")).toThrow(/through a hard link/);
      expect(readFileSync(outside, "utf8")).toBe("mine");
      // A file of its own is fine.
      ws.writeText("ok.txt", "fine");
      expect(readFileSync(ws.path("ok.txt"), "utf8")).toBe("fine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("X5: a web page's spec labels what was not read from the page", () => {
  const page = (easing: string): PageReading => ({
    url: "https://example.test/",
    title: "Example",
    viewport: { width: 1440, height: 900 },
    scrollHeight: 900,
    animations: [
      { kind: "css-transition", name: "opacity", target: "h1", delay: 0, duration: 500, iterations: 1, easing, keyframes: [], properties: ["opacity"], scrollY: 0 },
    ],
    colors: [{ hex: "#E0402F", area: 3 }, { hex: "#FFFFFF", area: 1 }],
    fonts: [],
  } as unknown as PageReading);

  it("keeps measured for the page's times and colours, and labels frame counts and the speed peak by how they were made", () => {
    const spec = specFromPage(page("cubic-bezier(0.16, 1, 0.3, 1)"), "test");
    const move = spec.events[0]!;
    expect(move.evidence).toEqual({ start: "measured", end: "measured", iterations: "measured", frames: "inferred", peak: "derived", peakAt: "derived" });
    // The peak comes from the page's own curve, not a placeholder.
    expect(move.peak).toBeGreaterThan(1);
    expect(move.peakAt).toBeLessThan(0.2);
    // Lightness and chroma are the colour's own (OKLab), not zeros.
    expect(spec.palette[0]).toMatchObject({ hex: "#E0402F", share: 0.75, evidence: "measured" });
    // #E0402F is oklch(0.605 0.199 30): checked against the OKLab reference conversion.
    expect(spec.palette[0]!.lightness).toBeCloseTo(0.605, 2);
    expect(spec.palette[0]!.chroma).toBeGreaterThan(0.15);
    expect(spec.palette[1]!.lightness).toBeCloseTo(1, 2);
    expect(unlabelledNumbers(spec)).toEqual([]);
    expect(evidenceText(move.evidence)).toBe("start, end, iterations measured; frames inferred; peak, peakAt derived");
  });

  it("calls the family's usual peak inferred when the curve is not a cubic-bezier", () => {
    const move = specFromPage(page("steps(4, end)"), "test").events[0]!;
    expect(move.evidence).toMatchObject({ peak: "inferred", peakAt: "inferred", start: "measured" });
  });
});

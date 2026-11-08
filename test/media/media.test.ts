import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBoundaries, parseSceneScores } from "../../src/media/boundaries.js";
import { extractFrames, parseShowinfo, planFrames } from "../../src/media/frames.js";
import { parseProbe, probeMedia, type ProbeInfo } from "../../src/media/probe.js";
import { buildSheets, filterValue, fitLabel } from "../../src/media/sheets.js";
import { brightness, cutsVideo, frameByNumber, mediaTools, rampVideo, tempDir } from "./fixtures.js";

const tools = mediaTools();
const probe10: ProbeInfo = { duration: 10, fps: 30, nominalFps: 30, vfr: false, hdr: false, hasVideo: true, hasAudio: true };

describe("parsers", () => {
  it("reads a probe, VFR and HDR", () => {
    const info = parseProbe(
      JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "hevc", width: 1080, height: 1920, avg_frame_rate: "2997/100", r_frame_rate: "60/1", color_transfer: "arib-std-b67" },
          { codec_type: "audio", codec_name: "aac" },
        ],
        format: { duration: "12.5" },
      }),
    );
    expect(info).toMatchObject({ duration: 12.5, width: 1080, height: 1920, fps: 29.97, nominalFps: 60, vfr: true, hdr: true, hasAudio: true });
  });

  it("reads showinfo times and scene scores", () => {
    expect(parseShowinfo("[Parsed_showinfo_2 @ 0x1] n:   0 pts:      0 pts_time:0.04\nnoise\n[Parsed_showinfo_2 @ 0x1] n:   1 pts:   512 pts_time:0.08")).toEqual([0.04, 0.08]);
    expect(parseSceneScores("frame:0    pts:0       pts_time:0\nlavfi.scene_score=0.000000\nframe:1    pts:1  pts_time:0.25\nlavfi.scene_score=0.734\n")).toEqual([
      { t: 0, score: 0 },
      { t: 0.25, score: 0.734 },
    ]);
  });

  it("quotes filter values and fits labels to two lines", () => {
    expect(filterValue("C:\\a b\\it's.txt")).toBe("'C\\:/a b/it'\\''s.txt'");
    expect(fitLabel("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", 20).split("\n")).toHaveLength(2);
  });
});

describe("planFrames", () => {
  it("counts frames per mode and rejects ambiguous or oversized requests", () => {
    expect(planFrames({ every: 1 }, probe10)).toEqual({ start: 0, end: 10, count: 10 });
    expect(planFrames({ start: 2, end: 4, fps: 10 }, probe10).count).toBe(20);
    expect(planFrames({ start: 2, end: 3, everyFrame: true }, probe10).count).toBe(30);
    expect(planFrames({ at: [1, 5] }, probe10).count).toBe(2);
    expect(() => planFrames({ every: 1, fps: 2 }, probe10)).toThrow(/exactly one/);
    expect(() => planFrames({ at: [11] }, probe10)).toThrow(/outside/);
    expect(() => planFrames({ everyFrame: true }, { ...probe10, duration: 60 })).toThrow(/more than/);
    expect(() => planFrames({ start: 5, end: 5, every: 1 }, probe10)).toThrow(/Empty range/);
  });
});

describe.skipIf(!tools)("with ffmpeg", () => {
  let dir: string;
  let video: string;

  beforeAll(() => {
    dir = tempDir();
    video = cutsVideo(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("probes the fixture", async () => {
    const info = await probeMedia(video, tools!);
    expect(info.duration).toBeCloseTo(6, 0);
    expect(info).toMatchObject({ width: 320, height: 180, fps: 25, vfr: false, hasAudio: true, hdr: false });
  });

  it("extracts every frame with real times and samples by interval", async () => {
    const info = await probeMedia(video, tools!);
    const dense = await extractFrames(video, join(dir, "dense"), { start: 1.9, end: 2.1, everyFrame: true, width: 160 }, info, tools!);
    expect(dense.length).toBeGreaterThanOrEqual(4);
    expect(dense.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < dense.length; i++) expect(dense[i]!.t - dense[i - 1]!.t).toBeCloseTo(0.04, 2);
    expect(dense.every((f) => existsSync(f.file))).toBe(true);

    const sparse = await extractFrames(video, join(dir, "sparse"), { every: 1, width: 160 }, info, tools!);
    expect(sparse.map((f) => Math.round(f.t))).toEqual([0, 1, 2, 3, 4, 5]);

    const at = await extractFrames(video, join(dir, "at"), { at: [3.5] }, info, tools!);
    expect(at).toHaveLength(1);
    expect(existsSync(at[0]!.file)).toBe(true);
  });

  it("samples the first frame at or after each grid point and reports its real time", async () => {
    const ramp = rampVideo(dir);
    const info = await probeMedia(ramp, tools!);
    const frames = await extractFrames(ramp, join(dir, "ramp"), { every: 0.5, width: 64 }, info, tools!);
    expect(frames.map((f) => f.t)).toEqual([0, 0.52, 1, 1.52]);
    // Brightness grows 4 per frame: each sample must look like the frame its time names (0.52 s = frame 13),
    // not like a later frame of the interval.
    const reference = (n: number) => brightness(frameByNumber(ramp, n, join(dir, `ref-${n}.png`)));
    const levels = frames.map((f) => brightness(f.file));
    expect(Math.abs(levels[0]! - reference(0))).toBeLessThanOrEqual(2);
    expect(Math.abs(levels[1]! - reference(13))).toBeLessThanOrEqual(2);
    expect(Math.abs(levels[2]! - reference(25))).toBeLessThanOrEqual(2);

    const tenth = await extractFrames(ramp, join(dir, "ramp10"), { start: 0.2, end: 0.6, fps: 10, width: 64 }, info, tools!);
    expect(tenth.map((f) => f.t)).toEqual([0.2, 0.32, 0.4, 0.52]);
  });

  it("builds labelled sheets", async () => {
    const info = await probeMedia(video, tools!);
    const frames = await extractFrames(video, join(dir, "for-sheets"), { every: 0.5, width: 160 }, info, tools!);
    const sheets = await buildSheets(frames, join(dir, "sheets"), "overview", { columns: 4, rows: 2, label: (f) => `${f.t.toFixed(2)} s · привет` }, tools!);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.cells).toHaveLength(8);
    expect(sheets[1]!.cells).toHaveLength(4);
    expect(sheets.every((s) => existsSync(s.file))).toBe(true);
    const single = await buildSheets(frames.slice(0, 1), join(dir, "sheets"), "one", { columns: 4, rows: 2 }, tools!);
    expect(existsSync(single[0]!.file)).toBe(true);
  });

  it("finds the two cuts and nothing else", async () => {
    const result = await findBoundaries(video, tools!, { rate: 10, threshold: 0.3 });
    expect(result.candidates.map((c) => Math.round(c.t * 10) / 10)).toEqual([2, 4]);
    expect(result.dynamics).toBeGreaterThan(0);
  });
});

// Regressions from the release review of 2.1.0, before it was tagged. Each failed before its fix.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanReading, mergeReadings, specFromPage } from "../src/browser/web.js";
import { HELP, runCommand } from "../src/cli.js";
import { runExact } from "../src/exact/run.js";
import { constantShift, matchCuts, verdict } from "../src/compare/compare.js";
import { Engine, localFileResolver } from "../src/engine.js";
import { silentLogger } from "../src/logger.js";
import { ONE_MODE, planFrames } from "../src/media/frames.js";
import type { ProbeInfo } from "../src/media/probe.js";
import { newestInboxFile, newestInboxItem } from "../src/sources/inbox.js";
import { buildSpec, unlabelledNumbers, type MotionSpec } from "../src/style/spec.js";
import { VERSION } from "../src/version.js";
import { toolShapes } from "./fixtures/tool-shapes.js";
import { cutsVideo, mediaTools, rampVideo, tempDir } from "./media/fixtures.js";

const tools = mediaTools();
const probe10: ProbeInfo = { duration: 10, fps: 30, nominalFps: 30, vfr: false, hdr: false, hasVideo: true, hasAudio: true };

describe("frames: sampling modes", () => {
  it("names `around` in the one-mode error and refuses `at` with `every` instead of dropping `every`", () => {
    expect(ONE_MODE).toContain("`around`");
    expect(() => planFrames({ every: 1, fps: 2 }, probe10)).toThrow(ONE_MODE);
    // 2.1.0 took the moments and ignored `every` without a word.
    expect(() => planFrames({ at: [1, 2], every: 1 }, probe10)).toThrow(ONE_MODE);
    expect(() => planFrames({ at: [1], everyFrame: true }, probe10)).toThrow(ONE_MODE);
    expect(planFrames({ at: [1, 2] }, probe10).count).toBe(2);
  });
});

describe("evidence labels in motion-spec.json", () => {
  it("defines the rule: a label on the object that holds the number, one label or one per field", () => {
    expect(unlabelledNumbers({ range: { start: 0, end: 4 } })).toEqual([]);
    expect(unlabelledNumbers({ audio: { tempo_bpm: 120, sfx: [] } })).toEqual(["audio.tempo_bpm"]);
    expect(unlabelledNumbers({ audio: { tempo_bpm: 120, integrated_lufs: -14, evidence: { tempo_bpm: "derived" } } })).toEqual(["audio.integrated_lufs"]);
    expect(unlabelledNumbers({ shots: [{ start: 0, end: 1, evidence: "measured" }, { start: 1, end: 2 }] })).toEqual(["shots[1].start", "shots[1].end"]);
    // A label covers the arrays its object holds, never the objects nested in it.
    expect(unlabelledNumbers({ palette: [{ share: 0.5, oklab: [0.5, 0, 0], evidence: "measured" }] })).toEqual([]);
    expect(unlabelledNumbers({ transitions: [{ at: 1, hold: { start: 1, end: 1.1 }, evidence: "derived" }] })).toEqual(["transitions[0].hold.start", "transitions[0].hold.end"]);
    // A label that is not one of the three words is no label.
    expect(unlabelledNumbers({ timebase: { fps: 30, evidence: "guessed" } })).toEqual(["timebase.fps"]);
    // A track's own label covers its nested window, samples and curves.
    expect(unlabelledNumbers({ tracks: [{ start: 1, window: { start: 0, end: 2 }, samples: [{ t: 0, x: 1 }], evidence: "derived" }] })).toEqual([]);
    expect(unlabelledNumbers({ tracks: [{ start: 1 }] })).toEqual(["tracks[0].start"]);
  });

  it("labels the shots split at a gradual transition derived, and a dip's hold", () => {
    const spec = buildSpec({
      record: { id: "file-x", kind: "file", input: "x.mp4", mediaPath: "x.mp4", fetchedAt: "" },
      probe: { ...probe10, width: 320, height: 180 },
      range: { start: 0, end: 10 },
      changes: [{ t: 2, kind: "cut", score: 0.9 }],
      shots: [
        { id: "s1", start: 0, end: 2, frames: 60, palette: [] },
        { id: "s2", start: 2, end: 6, frames: 120, palette: [] },
        { id: "s3", start: 6, end: 10, frames: 120, palette: [] },
      ],
      overall: [],
      events: [],
      transitions: [{ kind: "dip", via: "black", start: 5.5, end: 6.5, frames: 30, at: 6, hold: { start: 5.95, end: 6.05 } }],
      version: "test",
    });
    expect(spec.shots.map((s) => s.evidence)).toEqual(["measured", "derived", "derived"]);
    expect(spec.transitions!.find((x) => x.kind === "dip")!.hold).toEqual({ start: 5.95, end: 6.05, evidence: "derived" });
    expect(unlabelledNumbers(spec)).toEqual([]);
  });

  it("holds for specs read from a web page, a Lottie and Rive files", async () => {
    // 2.1.0 left timebase, shots and rhythm of these specs (and a page's keyframes and scroll positions) unlabelled.
    const reading = cleanReading({
      url: "https://example.test/",
      title: "Page",
      viewport: { width: 1440, height: 900 },
      scrollHeight: 3000,
      animations: [
        { kind: "css-animation", name: "rise", target: "h1", delay: 100, duration: 650, iterations: 1, easing: "linear", keyframes: [{ offset: 0, easing: "ease", opacity: "0" }, { offset: 1, opacity: "1" }], properties: ["opacity"], scrollY: 0, ended: true },
        { kind: "gsap", name: "x", target: "div", delay: 500, duration: 1200, iterations: "infinite", easing: "expo.out", keyframes: [{ x: "200" }], properties: ["x"], scrollY: 900, scrollTriggered: true },
      ],
      fonts: [{ selector: "h1", family: "Inter", weight: "800", size: "72px", lineHeight: "76px", letterSpacing: "0", transform: "none", sample: "Hi" }],
      colors: [{ hex: "#101418", area: 900 }],
      gsap: true,
    });
    const web = specFromPage(mergeReadings([reading]), "test");
    expect(unlabelledNumbers(web)).toEqual([]);
    expect(web.timebase.evidence).toEqual({ fps: "inferred", duration: "derived", width: "measured", height: "measured" });

    const dir = mkdtempSync(join(tmpdir(), "fl-walk-"));
    try {
      const lottie = {
        v: "5.7.0", nm: "Demo", fr: 30, ip: 0, op: 60, w: 400, h: 300,
        fonts: { list: [{ fName: "Inter-Bold", fFamily: "Inter", fStyle: "Bold" }] },
        markers: [{ cm: "intro", tm: 0, dr: 30 }, { cm: "outro", tm: 30, dr: 30 }],
        layers: [
          { ty: 4, nm: "Box", ind: 1, ip: 0, op: 60, st: 0, sr: 1, ks: { p: { a: 1, k: [{ t: 0, s: [50, 150, 0], o: { x: [0.2], y: [0.8] }, i: { x: [0.3], y: [1] } }, { t: 30, s: [350, 150, 0] }] } }, shapes: [{ ty: "gr", it: [{ ty: "rc", s: { a: 0, k: [100, 100] } }, { ty: "fl", c: { a: 0, k: [1, 0.2, 0.2, 1] } }] }] },
          { ty: 5, nm: "Title", ind: 2, ip: 0, op: 60, ks: {}, t: { d: { k: [{ t: 0, s: { s: 48, f: "Inter-Bold", t: "Hello", fc: [1, 1, 1] } }] } } },
        ],
      };
      const file = join(dir, "demo.json");
      writeFileSync(file, JSON.stringify(lottie));
      const sources = [file, join("test", "fixtures", "rive", "cubic_value_test.riv"), join("test", "fixtures", "rive", "light_switch.riv")];
      for (const source of sources) {
        const r = await runExact({ source, root: join(dir, "ws"), version: "test" });
        const spec = JSON.parse(readFileSync(r.files.spec!, "utf8")) as MotionSpec;
        if (!source.includes("light_switch")) expect(spec.events.length, source).toBeGreaterThan(0); // its moves sit in a state machine
        expect(spec.shots.length, source).toBeGreaterThan(0);
        expect(unlabelledNumbers(spec), source).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compare: a render shifted as a whole", () => {
  const fps = 25;
  const reference = [1.2, 2.4, 3.6, 4.8, 6, 7.2, 8.4, 9.6, 10.8, 12, 13.2];

  it("reports a constant 0.20 s offset as one shift, not 11 missing and 11 extra cuts", () => {
    const render = reference.map((t) => Math.round((t - 0.2) * 1000) / 1000);
    const cuts = matchCuts(reference, render, fps);
    expect(cuts.shift).toEqual({ frames: -5, seconds: -0.2, cuts: 11 });
    expect(cuts.missing).toEqual([]);
    expect(cuts.extra).toEqual([]);
    const notes = verdict({ durations: { reference: 14, render: 13.8, differenceSeconds: -0.2 }, cuts, palette: { distance: 0, reference: [], render: [] }, similarity: { mean: 0.9, worst: [] } }, fps);
    expect(notes[0]).toMatch(/^The render is 5 frames early \(-0\.20 s\): 11 of 11 cuts line up/);
    expect(notes.join(" ")).not.toMatch(/Missing cuts|Extra cuts|Cuts off/);
  });

  it("still names a single cut that is off besides the shift, and finds no shift where there is none", () => {
    const render = reference.map((t, i) => Math.round((t + 0.2 + (i === 3 ? 0.08 : 0)) * 1000) / 1000);
    const cuts = matchCuts(reference, render, fps);
    expect(cuts.shift?.frames).toBe(5);
    const notes = verdict({ durations: { reference: 14, render: 14, differenceSeconds: 0 }, cuts, palette: { distance: 0, reference: [], render: [] }, similarity: { mean: 0.9, worst: [] } }, fps);
    expect(notes[0]).toMatch(/5 frames late/);
    expect(notes.join(" ")).toMatch(/Cuts off by a frame or more besides the shift: 4\.80 s \(\+2\)/);
    // One frame of jitter is no shift, and cuts that do not line up at any offset are missing and extra.
    expect(constantShift(reference, reference.map((t, i) => t + (i % 2 ? 1 / fps : 0)), fps)).toBeUndefined();
    expect(matchCuts([1, 5], [3, 8], fps).shift).toBeUndefined();
  });
});

describe("cli", () => {
  it("answers --help instead of 'Unknown command', and prints to stdout", async () => {
    const printed: string[] = [];
    for (const flag of ["--help", "-h", "help"]) expect(await runCommand([flag], { print: (t) => printed.push(t) })).toEqual({ handled: true });
    expect(printed[0]).toBe(HELP);
    for (const command of ["init", "doctor [--prepare]", "login <site>", "logout", "--version"]) expect(HELP).toContain(command);
    await runCommand(["--version"], { print: (t) => printed.push(t) });
    expect(printed.at(-1)).toBe(`${VERSION}\n`);
    await expect(runCommand(["serve"])).rejects.toThrow(/Unknown command "serve". Run "framelens --help"/);
    // No command is the server: nothing may reach stdout, which then carries the MCP protocol.
    const before = printed.length;
    expect(await runCommand([], { print: (t) => printed.push(t) })).toEqual({ handled: false });
    expect(printed.length).toBe(before);
  });

  it("init prints what it did and the next steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "framelens-cli-"));
    try {
      const printed: string[] = [];
      await runCommand(["init"], { print: (t) => printed.push(t), cwd: dir });
      expect(printed.join("")).toMatch(/added \.mcp\.json and \.claude\/skills\/framelens\/SKILL\.md[\s\S]*Next steps/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("third-party notices", () => {
  it("names every package whose code is bundled into dist, and ships with the npm package", async () => {
    // 2.1.0 bundled @google/genai (Apache-2.0) and others without their notices.
    const { build } = await import("esbuild");
    const result = await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "node", format: "esm", target: "node20", write: false, metafile: true, outfile: "out.mjs", logLevel: "silent" });
    const bundled = new Set<string>();
    for (const [input, info] of Object.entries(Object.values(result.metafile.outputs)[0]!.inputs)) {
      const at = input.lastIndexOf("node_modules/");
      if (at < 0 || !info.bytesInOutput) continue;
      const [scope, name] = input.slice(at + "node_modules/".length).split("/");
      bundled.add(scope!.startsWith("@") ? `${scope}/${name}` : scope!);
    }
    const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
    expect(bundled.has("@google/genai")).toBe(true);
    expect([...bundled].filter((name) => !notices.includes(`### ${name} `))).toEqual([]);
    expect(notices).toMatch(/### @google\/genai [\d.]+\n\nApache-2\.0[\s\S]*Copyright 2025 Google LLC/);
    expect(notices).toContain("## Apache License 2.0");
    expect(JSON.parse(readFileSync("package.json", "utf8")).files).toContain("THIRD_PARTY_NOTICES.md");
  }, 60_000);
});

describe("inbox and tool parameters", () => {
  it("says what the inbox can hold", () => {
    const env = { FRAMELENS_DOWNLOADS: join(tmpdir(), "framelens-no-such-downloads") };
    expect(() => newestInboxItem(env)).toThrow(/inbox holds a video, GIF, page reading or recording/);
    expect(() => newestInboxFile(env)).toThrow(/There is no video, GIF or recording in the inbox/);
  });

  it("describes every parameter of every local tool", () => {
    // 2.1.0 left audio.start, boundaries.start/end and frames.columns/rows without a description.
    const missing = Object.entries(toolShapes()).flatMap(([tool, shape]) =>
      Object.entries(shape).filter(([, schema]) => !(schema as { description?: string }).description).map(([name]) => `${tool}.${name}`),
    );
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!tools)("release review of 2.1.0 on real clips", () => {
  let dir: string;
  let engine: Engine;
  let cuts: string;
  const clip = (name: string, args: string[]) => {
    const file = join(dir, `${name}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args, file], { windowsHide: true, timeout: 60_000 });
    return file;
  };
  /** Writes a transcript into the source's workspace, as `transcript` would cache it. */
  const withWords = async (file: string, words: { t: number; end: number; text: string }[]) => {
    const { ws } = await engine.source(file);
    ws.writeJson("transcript.json", { source: "captions", language: "en", words, segments: [{ start: words[0]!.t, end: words.at(-1)!.end, text: words.map((w) => w.text).join(" ") }] });
  };

  beforeAll(() => {
    dir = tempDir();
    engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    cuts = cutsVideo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("frames around: an occurrence that does not exist says how many there are", async () => {
    await withWords(cuts, [
      { t: 0.5, end: 0.8, text: "really" },
      { t: 1.2, end: 1.5, text: "good" },
      { t: 2.6, end: 2.9, text: "really" },
      { t: 3.06, end: 3.36, text: "really" },
    ]);
    // 2.1.0: "really" is not in the transcript.
    await expect(engine.frames(cuts, { around: "really", occurrence: 5 })).rejects.toThrow('"really" appears 3 times in the transcript; occurrence 5 does not exist. Pass an occurrence from 1 to 3.');
    await expect(engine.frames(cuts, { around: "never said" })).rejects.toThrow(/is not in the transcript/);
    await expect(engine.frames(cuts, { around: "really", at: [1] })).rejects.toThrow(/`at` and `around` cannot be combined/);
    // 3.36 + 1.5 is 4.859999999999999 in floating point: ranges are reported to the millisecond.
    const result = await engine.frames(cuts, { around: "really", occurrence: 3, words: false });
    expect(result.range).toEqual({ start: 1.56, end: 4.86 });
    expect(JSON.parse(readFileSync(result.index, "utf8")).range).toEqual({ start: 1.56, end: 4.86 });
  }, 60_000);

  it("transcript without speech says what can give one, and does not send the agent to doctor", async () => {
    const silent = rampVideo(dir);
    await expect(engine.transcript(silent, { required: true })).rejects.toThrow(/no sound, so there is no speech to transcribe/);
    const tone = clip("tone", ["-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=1", "-f", "lavfi", "-i", "sine=frequency=300:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
    const error = await engine.transcript(tone, { required: true }).catch((e: Error) => e.message);
    expect(error).toMatch(/no captions/);
    expect(error).toMatch(/captions: a link to the same video/);
    expect(error).toMatch(/Gemini transcript with the user's own GEMINI_API_KEY/);
    expect(error).toMatch(/Whisper/);
    expect(error).not.toMatch(/doctor/);
  }, 60_000);

  it("every number of a real spec (style, audio, words) carries an evidence label", async () => {
    // A dissolve, a cut, a beeping tone and words: 2.1.0 left timebase, words, beats, shots, rhythm and the audio
    // numbers (tempo_bpm, integrated_lufs, cut_on_beat_ratio) without a label.
    const file = clip("evidence", [
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=3",
      "-f", "lavfi", "-i", "smptehdbars=s=320x180:r=25:d=3",
      "-f", "lavfi", "-i", "color=c=0x2FE07A:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:beep_factor=4:duration=7.4",
      "-filter_complex", "[0]format=yuv420p,setsar=1[a];[1]format=yuv420p,setsar=1[b];[2]format=yuv420p,setsar=1[c];[a][b]xfade=transition=fade:duration=0.6:offset=2.4[ab];[ab][c]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ]);
    await withWords(file, [{ t: 0.4, end: 0.9, text: "look" }, { t: 5.6, end: 6.1, text: "here" }]);
    await engine.style(file, { version: "test" });
    const { files } = await engine.audio(file);
    const spec = JSON.parse(readFileSync(files.spec!, "utf8")) as MotionSpec;
    expect(spec.anchors.cuts.length).toBeGreaterThan(0);
    expect(spec.anchors.words.length).toBe(2);
    expect(spec.audio.integrated_lufs).toBeDefined();
    expect(unlabelledNumbers(spec)).toEqual([]);
    expect(spec.timebase.evidence).toBe("measured");
    expect(spec.rhythm.evidence).toBe("derived");
    expect(spec.audio.evidence?.integrated_lufs).toBe("measured");
    for (const key of ["tempo_bpm", "cut_on_beat_ratio"] as const) if (spec.audio[key] !== undefined) expect(spec.audio.evidence?.[key]).toBe("derived");
    for (const beat of spec.anchors.beats) expect(beat.evidence).toBe("derived");
  }, 120_000);

  it("compare: a render 5 frames early is one shift, the text and the sheet name the same moments, a wrong path names `render`", async () => {
    const cards = ["0xE0402F", "0x2F6FE0", "0x2FE07A", "0xE0C02F", "0x8F2FE0"];
    const inputs = cards.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=25:d=1.2`]);
    const concat = `${cards.map((_, i) => `[${i}:v]`).join("")}concat=n=${cards.length}:v=1:a=0[v]`;
    const reference = clip("reference", [...inputs, "-filter_complex", concat, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25"]);
    // The same film starting 0.20 s (5 frames) in: every cut comes 5 frames early.
    const render = clip("render-early", ["-ss", "0.2", "-i", reference, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25"]);
    const { comparison, sheet, files } = await engine.compare(reference, render, "test");
    expect(comparison.cuts.shift?.frames).toBe(-5);
    expect(comparison.verdict[0]).toMatch(/^The render is 5 frames early/);
    expect(comparison.cuts.missing).toEqual([]);
    expect(comparison.cuts.extra).toEqual([]);
    // 2.1.0 listed 5 moments in the text and showed 6 on the sheet, at slightly different times.
    const named = comparison.similarity.worst.map((w) => `${w.t.toFixed(2)} s`);
    const onSheet = sheet!.cells.filter((c) => c.label.startsWith("reference")).map((c) => c.label.replace("reference · ", ""));
    expect(onSheet).toEqual(named);
    const report = readFileSync(files.report!, "utf8");
    expect(report).toContain(`Side by side at the ${named.length} least similar moments`);
    for (const t of named) expect(report).toContain(t);
    await expect(engine.compare(reference, join(dir, "no-such-render.mp4"), "test")).rejects.toThrow(/^`render`: /);
  }, 180_000);
});

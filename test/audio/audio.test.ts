import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeAudio, parseLoudnessLog } from "../../src/audio/analyze.js";
import { estimateTempo, fft, onBeatRatio, pickPeaks, spectralFlux } from "../../src/audio/dsp.js";
import { Engine, localFileResolver } from "../../src/engine.js";
import { silentLogger } from "../../src/logger.js";
import { mediaTools, tempDir } from "../media/fixtures.js";

const tools = mediaTools();

/** Clicks at a steady tempo as raw samples. */
function clicks(bpm: number, seconds: number, rate = 11025): Float32Array {
  const out = new Float32Array(seconds * rate);
  const period = 60 / bpm;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const since = t % period;
    out[i] = Math.exp(-200 * since) * Math.sin(2 * Math.PI * 1000 * t);
  }
  return out;
}

describe("dsp", () => {
  it("computes an FFT", () => {
    const n = 16;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 3 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mags = Array.from(re, (r, k) => Math.round(Math.hypot(r, im[k]!)));
    expect(mags[3]).toBe(8);
    expect(mags[13]).toBe(8);
    expect(mags.filter((m) => m > 0.5)).toHaveLength(2);
  });

  it("finds onsets and the tempo of a click track", () => {
    const { hopSeconds, flux } = spectralFlux(clicks(120, 10), 11025);
    const onsets = pickPeaks(flux, hopSeconds);
    expect(onsets.length).toBeGreaterThanOrEqual(18);
    expect(onsets.length).toBeLessThanOrEqual(21);
    const tempo = estimateTempo(flux, hopSeconds)!;
    expect(tempo.bpm).toBeGreaterThan(117);
    expect(tempo.bpm).toBeLessThan(123);
    expect(onBeatRatio(onsets.map((o) => o.t), tempo.beats, 0.05)).toBeGreaterThan(0.85);
  });

  it("measures how many events land on a beat", () => {
    expect(onBeatRatio([1, 1.52, 2.2], [1, 1.5, 2, 2.5], 0.05)).toBe(0.67);
    expect(onBeatRatio([], [1])).toBe(0);
  });

  it("reads ebur128 and silencedetect logs", () => {
    const log = [
      "[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M: -inf S: -inf",
      "[Parsed_ebur128_0 @ 0x1] t: 0.4  TARGET:-23 LUFS    M: -18.2 S: -20.0     I: -19.0 LUFS       LRA:   0.0 LU",
      "[silencedetect @ 0x2] silence_start: 3.5",
      "[silencedetect @ 0x2] silence_end: 4.25 | silence_duration: 0.75",
      "[Parsed_ebur128_0 @ 0x1] Summary:",
      "  Integrated loudness:",
      "    I:         -16.4 LUFS",
    ].join("\n");
    expect(parseLoudnessLog(log, 10)).toEqual({
      integratedLufs: -16.4,
      loudness: [{ t: 10.4, lufs: -18.2 }],
      silences: [{ start: 13.5, end: 14.25 }],
    });
  });
});

describe.skipIf(!tools)("audio on a real file", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = tempDir();
    file = join(dir, "beat.mp4");
    // 8 s of clicks at 100 BPM, then 1.5 s of silence; with a still picture so it is a video file.
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "aevalsrc='exp(-200*mod(t,0.6))*sin(2*PI*900*t)*lt(t,8)':s=44100:d=9.5",
      "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=9.5",
      "-c:a", "aac", "-b:a", "128k", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", file,
    ], { windowsHide: true });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the tempo, the silence and loudness", async () => {
    const analysis = await analyzeAudio(file, tools!, { start: 0, end: 9.5 });
    expect(analysis.tempo!.bpm).toBeGreaterThan(97);
    expect(analysis.tempo!.bpm).toBeLessThan(103);
    // The last click is at 7.8 s and decays within a few milliseconds; the file ends at 9.5 s.
    expect(analysis.silences.some((s) => s.start > 7.7 && s.start < 8.7)).toBe(true);
    expect(analysis.integratedLufs).toBeLessThan(0);
    expect(analysis.onsets.length).toBeGreaterThanOrEqual(12);
  });

  it("writes the analysis and a spectrogram through the engine", async () => {
    const engine = new Engine({ tools: tools!, resolve: localFileResolver, root: join(dir, ".framelens"), logger: silentLogger });
    const { files } = await engine.audio(file);
    expect(existsSync(files.audio!)).toBe(true);
    expect(existsSync(files.spectrogram!)).toBe(true);
  });
});

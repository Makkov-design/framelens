import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaTools } from "../media/exec.js";
import { estimateTempo, pickPeaks, refineOnset, spectralFlux } from "./dsp.js";

export interface AudioAnalysis {
  range: { start: number; end: number };
  /** Integrated loudness of the range, LUFS (streaming platforms aim for about -14). */
  integratedLufs?: number;
  /** Momentary loudness every 0.1 s, LUFS. */
  loudness: { t: number; lufs: number }[];
  silences: { start: number; end: number }[];
  /** Sharp attacks: drum hits, impacts, clicks, cuts in the music. */
  onsets: { t: number; strength: number }[];
  tempo?: { bpm: number; confidence: number };
  beats: number[];
}

const SAMPLE_RATE = 11025;

/** Mono PCM of a range as floats. */
export async function readPcm(source: string, tools: MediaTools, range: { start: number; end: number }): Promise<Float32Array> {
  const out = join(tmpdir(), `framelens-pcm-${process.pid}-${Date.now()}.f32`);
  try {
    await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error", "-y",
      "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source,
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", out,
    ], { timeoutMs: 10 * 60_000 });
    const buf = readFileSync(out);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } finally {
    rmSync(out, { force: true });
  }
}

/** ebur128 momentary loudness and silencedetect, read from ffmpeg's log. */
export function parseLoudnessLog(stderr: string, offset: number): Pick<AudioAnalysis, "integratedLufs" | "loudness" | "silences"> {
  const loudness: { t: number; lufs: number }[] = [];
  const silences: { start: number; end: number }[] = [];
  let silenceStart: number | undefined;
  let integratedLufs: number | undefined;
  let inSummary = false;
  for (const line of stderr.split("\n")) {
    const m = /\bt:\s*([\d.]+(?:[eE][-+]?\d+)?)\s+TARGET:.*?M:\s*(-?[\d.]+(?:[eE][-+]?\d+)?|-inf)/.exec(line);
    if (m && m[2] !== "-inf") loudness.push({ t: Math.round((Number(m[1]) + offset) * 1000) / 1000, lufs: Number(m[2]) });
    if (/Summary:/.test(line)) inSummary = true;
    const integrated = /^\s*I:\s*(-?[\d.]+(?:[eE][-+]?\d+)?) LUFS/.exec(line);
    if (inSummary && integrated) integratedLufs = Number(integrated[1]);
    const ss = /silence_start:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (ss) silenceStart = Math.max(0, Number(ss[1])) + offset;
    const se = /silence_end:\s*([\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (se && silenceStart !== undefined) {
      silences.push({ start: Math.round(silenceStart * 1000) / 1000, end: Math.round((Number(se[1]) + offset) * 1000) / 1000 });
      silenceStart = undefined;
    }
  }
  // Keep the curve light: one point every 0.1 s is what ebur128 prints; thin long ranges to about 2000 points.
  const step = Math.max(1, Math.ceil(loudness.length / 2000));
  return { ...(integratedLufs !== undefined && { integratedLufs }), loudness: loudness.filter((_, i) => i % step === 0), silences };
}

export async function analyzeAudio(source: string, tools: MediaTools, range: { start: number; end: number }): Promise<AudioAnalysis> {
  const { stderr } = await tools.exec(tools.ffmpeg, [
    "-hide_banner", "-nostdin",
    "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source,
    "-vn", "-af", "ebur128=peak=none,silencedetect=noise=-45dB:d=0.35", "-f", "null", "-",
  ], { timeoutMs: 10 * 60_000 });
  const levels = parseLoudnessLog(stderr, range.start);
  const pcm = await readPcm(source, tools, range);
  const { hopSeconds, flux } = spectralFlux(pcm, SAMPLE_RATE);
  const peaks = pickPeaks(flux, hopSeconds);
  const attacks = peaks.map((o) => refineOnset(pcm, SAMPLE_RATE, o.t));
  const onsets = peaks.map((o, i) => ({ t: Math.round((attacks[i]! + range.start) * 1000) / 1000, strength: o.strength }));
  const tempo = estimateTempo(flux, hopSeconds);
  // The beat grid comes from the same flux frames, so it carries the same lead; shift it by the typical one.
  const leads = peaks.map((o, i) => attacks[i]! - o.t).sort((a, b) => a - b);
  const lead = leads.length ? leads[Math.floor(leads.length / 2)]! : 0;
  return {
    range,
    ...levels,
    onsets,
    ...(tempo && { tempo: { bpm: tempo.bpm, confidence: tempo.confidence } }),
    beats: tempo ? tempo.beats.map((b) => Math.round((b + lead + range.start) * 1000) / 1000) : [],
  };
}

/** A spectrogram picture, so the agent can see sound design: risers, whooshes, hits, music beds, silences. */
export async function spectrogram(source: string, out: string, tools: MediaTools, range: { start: number; end: number }): Promise<string> {
  await tools.exec(tools.ffmpeg, [
    "-hide_banner", "-nostdin", "-v", "error", "-y",
    "-ss", String(range.start), "-t", String(range.end - range.start), "-i", source,
    "-lavfi", `showspectrumpic=s=1280x360:legend=1:scale=log:fscale=log:color=intensity`, "-frames:v", "1", out,
  ], { timeoutMs: 5 * 60_000 });
  return out;
}

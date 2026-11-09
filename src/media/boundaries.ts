import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaTools } from "./exec.js";
import { filterValue } from "./sheets.js";

export interface ChangeSample {
  t: number;
  /** ffmpeg's scene-change score, 0–1, against the previous sample. */
  score: number;
}

export interface Boundaries {
  rate: number;
  threshold: number;
  /** Samples above the threshold: places where the picture changes abruptly. Not editorial cut labels. */
  candidates: ChangeSample[];
  /** Mean change score of all samples: near 0 for a talking head, high for fast motion graphics. */
  dynamics: number;
  /** Candidates per minute. */
  changesPerMinute: number;
}

/** Parses ffmpeg's `metadata=print` output into time and scene score pairs. */
export function parseSceneScores(text: string): ChangeSample[] {
  const samples: ChangeSample[] = [];
  let t: number | undefined;
  for (const line of text.split("\n")) {
    const time = /pts_time:\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (time) t = Number(time[1]);
    const score = /lavfi\.scene_score=([\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
    if (score && t !== undefined) {
      samples.push({ t, score: Number(score[1]) });
      t = undefined;
    }
  }
  return samples;
}

/** Samples the picture at `rate` per second and scores how much each sample differs from the previous one. */
export async function findBoundaries(
  source: string,
  tools: MediaTools,
  options: { start?: number; end?: number; rate?: number; threshold?: number } = {},
): Promise<Boundaries> {
  const rate = options.rate ?? 4;
  const threshold = options.threshold ?? 0.3;
  const start = Math.max(0, options.start ?? 0);
  const out = join(tmpdir(), `framelens-scene-${process.pid}-${Date.now()}.txt`);
  try {
    await tools.exec(tools.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error",
      ...(start > 0 ? ["-ss", String(start)] : []),
      ...(options.end !== undefined ? ["-t", String(options.end - start)] : []),
      "-i", source, "-an",
      // The first frame at or after each sample point, with its real time (the fps filter would keep the last one).
      // RGB so the score sees colour: two shots of equal brightness but different hue still cut.
      "-vf",
      `select='eq(n,0)+gt(floor(t*${rate}+0.0005),floor(prev_t*${rate}+0.0005))',scale=160:-2,format=rgb24,` +
        `select='gte(scene,0)',metadata=print:file=${filterValue(out)}`,
      "-fps_mode", "passthrough",
      "-f", "null", "-",
    ]);
    const samples = parseSceneScores(readFileSync(out, "utf8")).map((s) => ({ t: Math.round((s.t + start) * 1000) / 1000, score: s.score }));
    const candidates = samples.filter((s) => s.score >= threshold);
    const span = samples.length ? samples.length / rate : 0;
    return {
      rate,
      threshold,
      candidates,
      dynamics: samples.length ? Math.round((samples.reduce((sum, s) => sum + s.score, 0) / samples.length) * 1000) / 1000 : 0,
      changesPerMinute: span ? Math.round((candidates.length / span) * 60 * 10) / 10 : 0,
    };
  } finally {
    rmSync(out, { force: true });
  }
}

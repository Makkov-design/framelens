import type { MediaTools } from "./exec.js";

export interface ProbeInfo {
  duration: number;
  width?: number;
  height?: number;
  /** Average frame rate (frames / duration). */
  fps?: number;
  /** The stream's nominal rate; differs from `fps` in variable-frame-rate files. */
  nominalFps?: number;
  /** Variable frame rate: frame times must be read from timestamps, never computed from the rate. */
  vfr: boolean;
  /** HDR transfer (HLG or PQ): colours must be tone-mapped before measuring a palette. */
  hdr: boolean;
  videoCodec?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec?: string;
  /** Still images and single-frame files. */
  frameCount?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_transfer?: string;
  nb_frames?: string;
  duration?: string;
}

function rate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !Number.isFinite(num)) return undefined;
  const result = den ? num / den : num;
  return Number.isFinite(result) && result > 0 ? Math.round(result * 1000) / 1000 : undefined;
}

/** Reads duration, size, frame rate, VFR, HDR and audio presence with ffprobe. */
export async function probeMedia(path: string, tools: MediaTools): Promise<ProbeInfo> {
  const { stdout } = await tools.exec(
    tools.ffprobe,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    { timeoutMs: 60_000 },
  );
  return parseProbe(stdout);
}

export function parseProbe(json: string): ProbeInfo {
  const data = JSON.parse(json) as { streams?: FfprobeStream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration ?? 0) || 0;
  const fps = rate(video?.avg_frame_rate);
  const nominalFps = rate(video?.r_frame_rate);
  const transfer = video?.color_transfer ?? "";
  const frameCount = video?.nb_frames ? Number(video.nb_frames) || undefined : undefined;
  return {
    duration,
    ...(video?.width && { width: video.width }),
    ...(video?.height && { height: video.height }),
    ...(fps && { fps }),
    ...(nominalFps && { nominalFps }),
    // A difference of more than 1% between the nominal and the average rate means frames are not evenly spaced.
    vfr: Boolean(fps && nominalFps && Math.abs(fps - nominalFps) / nominalFps > 0.01),
    hdr: /arib-std-b67|smpte2084/i.test(transfer),
    ...(video?.codec_name && { videoCodec: video.codec_name }),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    ...(audio?.codec_name && { audioCodec: audio.codec_name }),
    ...(frameCount && { frameCount }),
  };
}

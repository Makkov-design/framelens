// Types for synth.mjs, so the TypeScript tests can use it.
export function random(seed?: number): () => number;
export function busyBackground(width: number, height: number, seed?: number): Float32Array;
export function renderFrame(
  width: number,
  height: number,
  options: { cx: number; cy: number; size: number; scale?: number; opacity?: number; background: number | Float32Array; level?: number; noise?: number; rand?: () => number },
): Uint8Array;
export function bezierAt(b: [number, number, number, number], u: number): number;
export function springAt(stiffness: number, damping: number, tau: number): number;
export function clipFrames(options: {
  width?: number;
  height?: number;
  total: number;
  progress: (frame: number) => number;
  from?: [number, number];
  to?: [number, number];
  size?: number;
  busy?: boolean;
  noise?: number;
  seed?: number;
  opacity?: (frame: number, progress: number) => number;
  scale?: (frame: number, progress: number) => number;
}): Generator<Uint8Array>;
export function encode(file: string, frames: Iterable<Uint8Array>, options: { width?: number; height?: number; fps: number; ffmpeg?: string; crf?: number; timeoutMs?: number }): Promise<string>;

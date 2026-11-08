import type { EasingFamily } from "../style/motion.js";

export type Bezier = [number, number, number, number];

const n = (x: number) => String(Math.round(x * 10000) / 10000);

export function bezierCss(b: Bezier): string {
  return `cubic-bezier(${b.map(n).join(", ")})`;
}

/** Nearest family from the slopes at both ends of the curve. */
export function bezierFamily(b: Bezier): EasingFamily {
  const [x1, y1, x2, y2] = b;
  if (Math.abs(x1 - y1) < 0.02 && Math.abs(x2 - y2) < 0.02) return "linear";
  const startSlope = x1 > 1e-6 ? y1 / x1 : Infinity;
  const endSlope = 1 - x2 > 1e-6 ? (1 - y2) / (1 - x2) : Infinity;
  const slowStart = startSlope < 0.6;
  const slowEnd = endSlope < 0.6;
  if (slowStart && slowEnd) return "ease-in-out";
  if (slowEnd) return "ease-out";
  if (slowStart) return "ease-in";
  return "unclear";
}

/** Where the curve is fastest, 0 (start) to 1 (end), and its peak speed relative to a straight line. */
export function bezierPeak(b: Bezier): { peak: number; peakAt: number } {
  const [x1, y1, x2, y2] = b;
  const at = (t: number, a: number, c: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * c + t ** 3;
  const d = (t: number, a: number, c: number) => 3 * (1 - t) ** 2 * a + 6 * (1 - t) * t * (c - a) + 3 * t ** 2 * (1 - c);
  let best = { peak: 0, peakAt: 0 };
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    const dx = d(t, x1, x2);
    if (dx < 1e-6) continue;
    const speed = d(t, y1, y2) / dx;
    if (speed > best.peak) best = { peak: speed, peakAt: at(t, x1, x2) };
  }
  return { peak: Math.round(best.peak * 1000) / 1000, peakAt: Math.round(best.peakAt * 1000) / 1000 };
}

/** sRGB ↔ OKLab and a small k-means, so palettes group colours the way people see them. */

export interface Swatch {
  hex: string;
  /** Share of the sampled pixels, 0–1. */
  share: number;
  /** OKLab lightness 0–1. */
  lightness: number;
  /** OKLab chroma; below ~0.03 the colour reads as grey. */
  chroma: number;
}

type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [r / 255, g / 255, b / 255].map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const dist2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/**
 * Dominant colours of packed RGB pixels. Deterministic: seeds are the most frequent colour, then the pixel
 * farthest from all seeds so far (k-means++ without randomness). Near-identical clusters are merged.
 */
export function palette(rgb: Uint8Array | Buffer, k = 6): Swatch[] {
  const pixels: Lab[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) pixels.push(rgbToOklab(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!));
  if (!pixels.length) return [];

  // Seed with the most common quantised colour, then spread out.
  const buckets = new Map<string, number>();
  for (const p of pixels) {
    const key = p.map((v) => Math.round(v * 20)).join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const top = [...buckets.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const centers: Lab[] = [pixels.find((p) => p.map((v) => Math.round(v * 20)).join(",") === top)!];
  while (centers.length < Math.min(k, pixels.length)) {
    let best = pixels[0]!;
    let bestD = -1;
    for (const p of pixels) {
      const d = Math.min(...centers.map((c) => dist2(p, c)));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    if (bestD < 1e-4) break;
    centers.push(best);
  }

  const assign = new Array<number>(pixels.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    pixels.forEach((p, i) => {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, j) => {
        const d = dist2(p, c);
        if (d < bd) {
          bd = d;
          bi = j;
        }
      });
      assign[i] = bi;
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    pixels.forEach((p, i) => {
      const s = sums[assign[i]!]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]! += 1;
    });
    sums.forEach((s, j) => {
      if (s[3]) centers[j] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
  }

  const counts = centers.map((_, j) => assign.filter((a) => a === j).length);
  // Merge clusters a viewer could not tell apart (ΔE OK below ~0.04).
  const merged: { c: Lab; n: number }[] = [];
  centers.forEach((c, j) => {
    if (!counts[j]) return;
    const near = merged.find((m) => Math.sqrt(dist2(m.c, c)) < 0.04);
    if (near) {
      const n = near.n + counts[j]!;
      near.c = near.c.map((v, i) => (v * near.n + c[i]! * counts[j]!) / n) as Lab;
      near.n = n;
    } else {
      merged.push({ c, n: counts[j]! });
    }
  });
  return merged
    .sort((x, y) => y.n - x.n)
    .map(({ c, n }) => ({
      hex: oklabToHex(c),
      share: Math.round((n / pixels.length) * 1000) / 1000,
      lightness: Math.round(c[0] * 1000) / 1000,
      chroma: Math.round(Math.hypot(c[1], c[2]) * 1000) / 1000,
    }));
}

/** Combines per-shot palettes, weighted by how long each shot is on screen. */
export function mergePalettes(parts: { swatches: Swatch[]; weight: number }[], k = 8): Swatch[] {
  const total = parts.reduce((s, p) => s + p.weight, 0) || 1;
  const merged: { c: Lab; w: number }[] = [];
  for (const part of parts) {
    for (const sw of part.swatches) {
      const hex = sw.hex.slice(1);
      const lab = rgbToOklab(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
      const w = (sw.share * part.weight) / total;
      const near = merged.find((m) => Math.sqrt(dist2(m.c, lab)) < 0.05);
      if (near) {
        const sum = near.w + w;
        near.c = near.c.map((v, i) => (v * near.w + lab[i]! * w) / sum) as Lab;
        near.w = sum;
      } else merged.push({ c: lab, w });
    }
  }
  return merged
    .sort((x, y) => y.w - x.w)
    .slice(0, k)
    .map(({ c, w }) => ({
      hex: oklabToHex(c),
      share: Math.round(w * 1000) / 1000,
      lightness: Math.round(c[0] * 1000) / 1000,
      chroma: Math.round(Math.hypot(c[1], c[2]) * 1000) / 1000,
    }));
}

/** Small signal-processing helpers: enough to find onsets and tempo without a native dependency. */

/** In-place radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/**
 * Spectral flux: how much new energy appears in each frame, summed over frequency bins (log-compressed magnitudes,
 * only increases count). Peaks are onsets: drum hits, cuts in the music, sound effects.
 */
export function spectralFlux(samples: Float32Array, sampleRate: number, frameSize = 1024, hop = 256): { hopSeconds: number; flux: Float64Array } {
  const frames = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
  const flux = new Float64Array(frames);
  const window = new Float64Array(frameSize).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1)));
  let previous = new Float64Array(frameSize / 2);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    for (let i = 0; i < frameSize; i++) {
      re[i] = samples[offset + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mags = new Float64Array(frameSize / 2);
    let sum = 0;
    for (let k = 1; k < frameSize / 2; k++) {
      mags[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const diff = mags[k]! - previous[k]!;
      if (diff > 0) sum += diff;
    }
    flux[f] = sum;
    previous = mags;
  }
  return { hopSeconds: hop / sampleRate, flux };
}

/** Local maxima above an adaptive threshold (moving median + offset), at least `minGap` seconds apart. */
export function pickPeaks(signal: Float64Array, hopSeconds: number, options: { minGap?: number; window?: number; delta?: number } = {}): { t: number; strength: number }[] {
  const minGapFrames = Math.max(1, Math.round((options.minGap ?? 0.08) / hopSeconds));
  const half = Math.max(1, Math.round((options.window ?? 0.5) / hopSeconds / 2));
  const max = signal.reduce((m, v) => Math.max(m, v), 0) || 1;
  const delta = (options.delta ?? 0.07) * max;
  const peaks: { t: number; strength: number }[] = [];
  let lastIndex = -Infinity;
  for (let i = 1; i < signal.length - 1; i++) {
    const v = signal[i]!;
    if (v < signal[i - 1]! || v < signal[i + 1]!) continue;
    const local = Array.from(signal.subarray(Math.max(0, i - half), Math.min(signal.length, i + half + 1))).sort((a, b) => a - b);
    const median = local[Math.floor(local.length / 2)]!;
    if (v < median + delta) continue;
    if (i - lastIndex < minGapFrames) {
      if (peaks.length && v > peaks[peaks.length - 1]!.strength * max) {
        peaks[peaks.length - 1] = { t: i * hopSeconds, strength: v / max };
        lastIndex = i;
      }
      continue;
    }
    peaks.push({ t: i * hopSeconds, strength: v / max });
    lastIndex = i;
  }
  return peaks.map((p) => ({ t: Math.round(p.t * 1000) / 1000, strength: Math.round(p.strength * 1000) / 1000 }));
}

/**
 * Tempo by autocorrelation of the onset strength over 60–200 BPM, preferring the 80–160 range people tap to.
 * Returns the period, a confidence 0–1, and the beat phase that lines up best with the onsets.
 */
export function estimateTempo(flux: Float64Array, hopSeconds: number): { bpm: number; confidence: number; beats: number[] } | undefined {
  const n = flux.length;
  if (n * hopSeconds < 4) return undefined;
  const mean = flux.reduce((s, v) => s + v, 0) / n;
  const x = Float64Array.from(flux, (v) => Math.max(0, v - mean));
  const energy = x.reduce((s, v) => s + v * v, 0) || 1;
  let best = { lag: 0, score: -Infinity, raw: 0 };
  const minLag = Math.round(60 / 200 / hopSeconds);
  const maxLag = Math.round(60 / 60 / hopSeconds);
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += x[i]! * x[i + lag]!;
    const raw = sum / energy;
    const bpm = 60 / (lag * hopSeconds);
    // A gentle preference for the range listeners usually perceive as the beat.
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (raw * weight > best.score) best = { lag, score: raw * weight, raw };
  }
  if (!best.lag || best.raw <= 0) return undefined;
  // The best lag is a whole number of hops; a parabola through its neighbours finds the true period between them,
  // otherwise a 0.5-hop error drifts the beat grid by a whole beat within half a minute.
  const ac = (lag: number) => {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += x[i]! * x[i + lag]!;
    return sum;
  };
  const [a, b, c] = [ac(best.lag - 1), ac(best.lag), ac(best.lag + 1)];
  const denom = a - 2 * b + c;
  const period = best.lag + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0);
  // Phase: the offset whose beat grid collects the most onset strength.
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let sum = 0;
    for (let i = phase; Math.round(i) < n; i += period) sum += x[Math.round(i)]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let i = bestPhase; Math.round(i) < n; i += period) beats.push(Math.round(i * hopSeconds * 1000) / 1000);
  return { bpm: Math.round((60 / (period * hopSeconds)) * 10) / 10, confidence: Math.round(Math.min(1, best.raw) * 100) / 100, beats };
}

/** Share of `events` that land within `tolerance` seconds of a beat. */
export function onBeatRatio(events: number[], beats: number[], tolerance = 0.06): number {
  if (!events.length || !beats.length) return 0;
  const hits = events.filter((t) => beats.some((b) => Math.abs(b - t) <= tolerance)).length;
  return Math.round((hits / events.length) * 100) / 100;
}

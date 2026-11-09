import { curveAt, curveLabel } from "./curve.js";
import type { TrackedMove, TrackedProperty } from "./run.js";

const UNITS: Record<string, string> = { x: "px", y: "px", scale: "×", opacity: "" };
const s3 = (n: number) => n.toFixed(3);
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;

/** Measured progress of a property (0 at rest before, 1 at rest after) at each sample, and the fitted curve's. */
function progressSeries(track: TrackedMove, p: TrackedProperty) {
  const key = p.property;
  const span = p.to - p.from || 1;
  return track.samples
    .filter((s) => (key === "opacity" ? s.opacity !== null : !s.lost))
    .map((s) => ({ t: s.t, measured: (((s[key] as number | null) ?? 0) - p.from) / span, fitted: curveAt(p.curve, (s.t - p.start) / Math.max(1e-6, p.end - p.start)) }));
}

/** A small text plot: `o` measured samples, `·` the fitted curve, `O` where they meet. */
export function asciiCurve(track: TrackedMove, p: TrackedProperty, width = 48, height = 10): string {
  const series = progressSeries(track, p);
  if (!series.length) return "";
  const t0 = series[0]!.t;
  const t1 = series.at(-1)!.t;
  const lo = Math.min(0, ...series.map((s) => Math.min(s.measured, s.fitted)));
  const hi = Math.max(1, ...series.map((s) => Math.max(s.measured, s.fitted)));
  const grid = Array.from({ length: height }, () => new Array<string>(width).fill(" "));
  const row = (v: number) => height - 1 - Math.round(((v - lo) / (hi - lo || 1)) * (height - 1));
  const col = (t: number) => Math.round(((t - t0) / (t1 - t0 || 1)) * (width - 1));
  for (let c = 0; c < width; c++) {
    const t = t0 + ((t1 - t0) * c) / (width - 1);
    const r = row(curveAt(p.curve, (t - p.start) / Math.max(1e-6, p.end - p.start)));
    if (r >= 0 && r < height) grid[r]![c] = "·";
  }
  for (const s of series) {
    const r = row(s.measured);
    const c = col(s.t);
    if (r >= 0 && r < height && c >= 0 && c < width) grid[r]![c] = grid[r]![c] === "·" ? "O" : "o";
  }
  const label = (r: number) => (r === 0 ? hi.toFixed(1).padStart(4) : r === height - 1 ? lo.toFixed(1).padStart(4) : "    ");
  return [...grid.map((line, r) => `${label(r)} |${line.join("")}`), `     +${"-".repeat(width)}`, `      ${t0.toFixed(2)} s${" ".repeat(Math.max(1, width - 14))}${t1.toFixed(2)} s`].join("\n");
}

/** One SVG panel per fitted property: measured samples as dots, the fitted curve as a line. */
export function trackSvg(track: TrackedMove): string {
  const W = 360;
  const H = 150;
  const pad = 28;
  const panels = track.properties.map((p, i) => {
    const series = progressSeries(track, p);
    const t0 = series[0]?.t ?? 0;
    const t1 = series.at(-1)?.t ?? 1;
    const lo = Math.min(0, ...series.map((s) => Math.min(s.measured, s.fitted)));
    const hi = Math.max(1, ...series.map((s) => Math.max(s.measured, s.fitted)));
    const X = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
    const Y = (v: number) => i * H + H - pad + -((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const line = Array.from({ length: 121 }, (_, k) => {
      const t = t0 + ((t1 - t0) * k) / 120;
      return `${X(t).toFixed(1)},${Y(curveAt(p.curve, (t - p.start) / Math.max(1e-6, p.end - p.start))).toFixed(1)}`;
    }).join(" ");
    const dots = series.map((s) => `<circle cx="${X(s.t).toFixed(1)}" cy="${Y(s.measured).toFixed(1)}" r="2" fill="#E0402F"/>`).join("");
    const title = `${p.property}: ${curveLabel(p.curve).replace(/[<>&"]/g, "")} · error ${pct(p.rmse)}`;
    return `<g>
  <text x="${pad}" y="${i * H + 16}" font-family="system-ui, sans-serif" font-size="11" fill="#222">${title}</text>
  <line x1="${pad}" y1="${Y(0).toFixed(1)}" x2="${W - pad}" y2="${Y(0).toFixed(1)}" stroke="#ccc"/>
  <line x1="${pad}" y1="${Y(1).toFixed(1)}" x2="${W - pad}" y2="${Y(1).toFixed(1)}" stroke="#ccc" stroke-dasharray="3 3"/>
  <polyline points="${line}" fill="none" stroke="#2F6FE0" stroke-width="1.5"/>
  ${dots}
  <text x="${pad}" y="${i * H + H - 8}" font-family="system-ui, sans-serif" font-size="10" fill="#666">${t0.toFixed(2)} s</text>
  <text x="${W - pad}" y="${i * H + H - 8}" font-family="system-ui, sans-serif" font-size="10" fill="#666" text-anchor="end">${t1.toFixed(2)} s</text>
</g>`;
  });
  const height = Math.max(1, track.properties.length) * H;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">
<rect width="100%" height="100%" fill="#fff"/>
${panels.join("\n") || `<text x="20" y="40" font-family="system-ui, sans-serif" font-size="12">No property moved in this window.</text>`}
</svg>
`;
}

/** The measured block of TRACK.md: every tracked move with its fitted curves and a text plot of each. */
export function trackMarkdown(tracks: TrackedMove[], svgName: (t: TrackedMove) => string): { measured: string; skeleton: string } {
  const sections = tracks.map((t) => {
    const rows = t.properties.map(
      (p) =>
        `| ${p.property}${p.property === t.primary ? " (primary)" : ""} | ${s3(p.from)} → ${s3(p.to)} ${UNITS[p.property]} | ${s3(p.start)}–${s3(p.end)} s | ${p.frames} (${s3(p.seconds)} s) | ${s3(p.delay)} s | \`${curveLabel(p.curve)}\` | ${pct(p.rmse)} (max ${pct(p.maxError)}) | ${p.quality}${p.quality === "unreliable" ? " (not exported)" : ""} |`,
    );
    const plots = t.properties.map((p) => `**${p.property}** (${p.reason}):\n\n\`\`\`text\n${asciiCurve(t, p)}\n\`\`\``);
    return [
      `### ${t.id}: ${s3(t.start)}–${s3(t.end)} s${t.move ? ` (style move ${t.move})` : ""}`,
      "",
      `Window ${s3(t.window.start)}–${s3(t.window.end)} s at ${t.fps} fps. Element ${t.element.auto ? "found automatically" : "given"}: box ${t.element.box.w}×${t.element.box.h} px at (${t.element.box.x}, ${t.element.box.y}) at ${s3(t.element.at)} s. The move lasts ${t.frames} frames (${s3(t.seconds)} s) and starts ${s3(t.delay)} s into the window.`,
      "",
      ...(rows.length
        ? ["| Property | Change | Time | Frames | Delay | Curve | Fit error | Quality |", "|---|---|---|---|---|---|---|---|", ...rows]
        : ["No property moved from one resting value to another in this window."]),
      ...(t.unfitted.length ? ["", ...t.unfitted.map((u) => `- ${u.property}: ${u.reason}.`)] : []),
      ...(t.notes?.length ? ["", ...t.notes.map((n) => `- ${n}`)] : []),
      "",
      ...plots,
      "",
      `Curves as a picture: \`${svgName(t)}\`.`,
    ].join("\n");
  });
  const measured = ["## Tracked moves", "", ...sections].join("\n\n");
  const skeleton = `# Tracked moves

Each move below was followed frame by frame (template matching with subpixel refinement) and its timing fitted:
positions and times are measured, the curves are derived from them with the stated fit error (a fraction of the
travel). \`o\` marks a measured frame, \`·\` the fitted curve. Quality: \`exact\` within 1 % of the travel (or the
sample noise), \`approximate\` within 3 %, \`unreliable\` above that, cut by the window, or too short (5 frames or
fewer) to tell curves apart. Exports use exact and approximate curves instead of easing families; unreliable ones
are reported here only.

{{measured}}

## Notes

What each tracked element is, and which moves matter for the recreation.
`;
  return { measured, skeleton };
}

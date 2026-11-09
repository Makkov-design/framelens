import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transcript } from "../speech/transcript.js";
import type { MotionSpec } from "../style/spec.js";
import { oneLine, write } from "./exporters.js";
import { safeHex } from "../text.js";

const START = "<!-- framelens:measured:start -->";
const END = "<!-- framelens:measured:end -->";

const s2 = (t: number) => t.toFixed(2);
const span = (a: number, b: number) => `${s2(a)}–${s2(b)}`;

function readText(dir: string | undefined, name: string): string | undefined {
  if (!dir) return undefined;
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").trim();
  return text || undefined;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "reference";
}

/** Heading levels move down by one and the first H1 is dropped, so a workspace file can sit under a section. */
function nest(markdown: string): string {
  return markdown
    .replace(/^# .*\n+/, "")
    .replace(/^(#{1,5}) /gm, "$1# ");
}

/** What the agent or user wrote outside our generated measured block. */
function outsideMeasured(markdown: string): string {
  const a = markdown.indexOf(START);
  const b = markdown.indexOf(END);
  return a >= 0 && b > a ? markdown.slice(0, a) + markdown.slice(b + END.length) : markdown;
}

const PLACEHOLDER = /\(to write after looking at the sheets\)|^_What happens and why:_\s*$|^Keep facts \(what is on screen/m;

function isTemplateOnly(text: string): boolean {
  const stripped = text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && !PLACEHOLDER.test(l))
    .join("\n");
  return stripped.trim().length < 40;
}

/** Interpretation the agent wrote under each shot of our TIMELINE.md, keyed by shot id. */
function shotNotes(timeline: string | undefined): Map<string, string> {
  const notes = new Map<string, string>();
  if (!timeline) return notes;
  const parts = timeline.split(/^### /m).slice(1);
  for (const part of parts) {
    const head = part.split("\n")[0] ?? "";
    const id = /·\s*(\S+)\s*\(/.exec(head)?.[1];
    if (!id) continue;
    const marker = part.indexOf("_What happens and why:_");
    const after = marker >= 0 ? part.slice(marker + "_What happens and why:_".length) : "";
    const text = after.trim();
    if (text) notes.set(id, text);
  }
  return notes;
}

function phaseName(index: number, count: number, length: number, median: number): string {
  if (index === 0) return "Opening";
  if (index === count - 1 && count > 1) return "Close";
  if (median > 0 && length < median * 0.6) return "Quick cut";
  if (median > 0 && length > median * 1.5) return "Held shot";
  return "Build";
}

export function hypitAnalysis(spec: MotionSpec, workspace?: string): string {
  const title = oneLine(spec.source.title ?? spec.source.input);
  const fps = spec.timebase.fps;
  const swatches = spec.palette.map((p) => `| \`${safeHex(p.hex)}\` | ${(p.share * 100).toFixed(1)}% | ${p.evidence} |`);
  const kinds = new Map<string, number>();
  for (const e of spec.events) kinds.set(e.easing, (kinds.get(e.easing) ?? 0) + 1);
  const unclear = spec.events.filter((e) => e.easing === "unclear");

  const ownAnalysis = readText(workspace, "ANALYSIS.md");
  const analysisNotes = ownAnalysis && !isTemplateOnly(outsideMeasured(ownAnalysis)) ? nest(outsideMeasured(ownAnalysis)).trim() : undefined;
  const style = readText(workspace, "STYLE.md");
  const styleBody = style && !isTemplateOnly(style) ? nest(style).trim() : undefined;

  return `# Analysis: ${title}

Prepared by ${spec.generatedBy} for Hypit. Facts are measured or read from the source; interpretation is marked as such and comes only from notes written in the Frame Lens workspace.
Source: ${oneLine(spec.source.url ?? spec.source.input, 2000)}, source time ${span(spec.range.start, spec.range.end)} s.

## Measured facts

- Picture: ${spec.timebase.width ?? "?"}×${spec.timebase.height ?? "?"}${fps ? ` at ${fps} fps${spec.timebase.vfr ? " (variable frame rate)" : ""}` : ""}, ${s2(spec.range.end - spec.range.start)} s analysed of ${s2(spec.timebase.duration)} s.
- Rhythm: ${spec.rhythm.cuts} cuts (${spec.rhythm.cutsPerMinute} per minute); shots average ${spec.rhythm.meanShotSeconds} s, median ${spec.rhythm.medianShotSeconds} s; ${spec.rhythm.movesPerMinute} measured moves per minute.
- Sound: ${spec.audio.tempo_bpm ? `${spec.audio.tempo_bpm} BPM` : "no steady tempo measured"}${spec.audio.cut_on_beat_ratio !== undefined ? `, ${Math.round(spec.audio.cut_on_beat_ratio * 100)}% of cuts land on a beat` : ""}${spec.audio.integrated_lufs !== undefined ? `, ${spec.audio.integrated_lufs} LUFS` : ""}${spec.audio.hits?.length ? `, ${spec.audio.hits.length} strong hits` : ""}.
- Moves: ${spec.events.length}${kinds.size ? ` (${[...kinds.entries()].map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}. Easing families come from how fast the whole picture changes, so they are starting curves, not fitted ones.
- Words: ${spec.anchors.words.length} timed words in range.

| Colour | Share of screen time | Evidence |
|---|---|---|
${swatches.join("\n") || "| — | — | — |"}

## Interpretation

${analysisNotes ?? "No interpretation has been written yet in the Frame Lens workspace (ANALYSIS.md is still the template). Everything above is measurement; read the frames and the TIMELINE before deciding what the piece is trying to do."}

${spec.typography.length ? `## Typography\n\n${spec.typography.map((t) => `- ${oneLine(t.role, 120)}: ${t.family_guess ? oneLine(t.family_guess, 120) : "family unknown"}${t.weight ? ` ${Number(t.weight)}` : ""}${t.case ? `, ${oneLine(t.case, 20)}` : ""} (${t.evidence})`).join("\n")}\n` : ""}${spec.systems.length ? `## Systems\n\n${spec.systems.map((y) => `- ${y.id} (${y.role}) from ${s2(y.start)} s to ${s2(y.end)} s`).join("\n")}\n` : ""}${styleBody ? `## Style notes from the workspace\n\n${styleBody}\n\n` : ""}## What to keep, what to redesign

Keep the structure: the cut times and shot lengths in TIMELINE.md, the order of colours, and the timing and easing family of each move. Redesign the content: wording, imagery, typography and exact curves are the new work's own. This is a reference for style transfer, not a copy.

## Open questions

${unclear.length ? unclear.map((e) => `- ${span(e.start, e.end)} s: easing family unclear (${e.frames} frames); reopen with every-frame frames.`).join("\n") : "- None measured as unclear."}
${spec.palette.length === 0 ? "- No palette was measured.\n" : ""}`;
}

export function hypitTimeline(spec: MotionSpec, workspace?: string): string {
  const title = oneLine(spec.source.title ?? spec.source.input);
  const ownTimeline = readText(workspace, "TIMELINE.md");
  const notes = shotNotes(ownTimeline);
  const median = spec.rhythm.medianShotSeconds;
  const sections = spec.shots.map((shot, i) => {
    const moves = spec.events.filter((e) => e.start >= shot.start && e.start < shot.end);
    const words = spec.anchors.words.filter((w) => w.t >= shot.start && w.t < shot.end);
    const beats = spec.anchors.beats.filter((b) => b.t >= shot.start && b.t < shot.end);
    const hits = (spec.audio.hits ?? []).filter((h) => h.t >= shot.start && h.t < shot.end);
    const cut = i > 0 ? spec.anchors.cuts.find((c) => Math.abs(c.t - shot.start) < 0.05) : undefined;
    const lines = [
      `- Shot ${shot.id}: in ${s2(shot.start)} s, out ${s2(shot.end)} s, length ${s2(shot.end - shot.start)} s (${shot.frames} frames).`,
      `- Colours: ${shot.palette.map((p) => `\`${safeHex(p)}\``).join(" ") || "none measured"}.`,
      ...(cut ? [`- Entered by a cut at ${s2(cut.t)} s (score ${cut.score}, ${cut.evidence}).`] : []),
      ...moves.map((m) => `- Move at ${s2(m.start)} s to ${s2(m.end)} s (${m.frames} frames, ${m.easing}${m.curve ? `, tracked curve ${oneLine(m.curve, 400)}` : m.suggestion ? `, starting curve ${oneLine(m.suggestion, 120)}` : ""}, fastest at ${Math.round(m.peakAt * 100)}% of the move; ${m.evidence}).`),
      ...(words.length ? [`- Words: ${words.slice(0, 40).map((w) => `“${oneLine(w.text, 60)}” ${s2(w.t)}–${s2(w.end)}`).join(", ")}${words.length > 40 ? `, … ${words.length - 40} more` : ""}.`] : []),
      ...(beats.length ? [`- Beats at ${beats.map((b) => s2(b.t)).join(", ")} s.`] : []),
      ...(hits.length ? [`- Strong audio hits at ${hits.map((h) => `${s2(h.t)} s (${h.strength.toFixed(2)})`).join(", ")}.`] : []),
    ];
    const note = notes.get(shot.id);
    return `## ${span(shot.start, shot.end)} · ${phaseName(i, spec.shots.length, shot.end - shot.start, median)} (${shot.id})

**Measured**

${lines.join("\n")}

**Interpretation**

${note ?? "Not written yet in the workspace TIMELINE.md. Connect what moves here to the words or actions it serves, and say what it does for the viewer."}`;
  });
  return `# Timeline: ${title}

Sections are named by source time in seconds and a phase. Phase names are derived from a shot's position and length (opening, close, quick cut under 0.6 of the median shot, held shot over 1.5 times it, otherwise build); they are not an interpretation. Under each shot, measured facts come first and interpretation is kept apart.

${sections.join("\n\n") || "No shots were measured."}
`;
}

/** Hypit's transcript shape for word times: { words: [{ word, start, end }] }. */
export function hypitTranscript(workspace: string | undefined): { words: { word: string; start: number; end: number }[] } | undefined {
  const text = readText(workspace, "transcript.json");
  if (!text) return undefined;
  const parsed = JSON.parse(text) as Partial<Transcript>;
  const words = (parsed.words ?? []).map((w) => ({ word: w.text, start: w.t, end: w.end }));
  return { words };
}

export function exportHypit(spec: MotionSpec, root: string, options: { workspace?: string } = {}): string[] {
  const slug = slugify(spec.source.title ?? spec.source.input);
  const dir = `references/${slug}`;
  const transcript = hypitTranscript(options.workspace);
  const files: Record<string, string> = {
    [`${dir}/ANALYSIS.md`]: hypitAnalysis(spec, options.workspace),
    [`${dir}/TIMELINE.md`]: hypitTimeline(spec, options.workspace),
    "HANDOFF.md": `# Handoff to Hypit

Frame Lens measured this reference; Hypit's agent can build on it instead of re-analysing from scratch. Hypit is a separate tool (github.com/hypit-ai/hypit); Frame Lens writes files in the structure its reference-video guide describes and does not run or ship any Hypit code.

## What is here

- \`${dir}/ANALYSIS.md\`: the whole-piece account. Measured facts first, then interpretation (only what was written in the Frame Lens workspace).
- \`${dir}/TIMELINE.md\`: one section per shot, named by source time in seconds and a phase, with measured timings and interpretation apart.
${transcript ? `- \`${dir}/transcript.json\`: ${transcript.words.length} words as \`{ words: [{ word, start, end }] }\`, times in seconds of the source.\n` : "- No transcript.json: the workspace had none. Run Frame Lens `transcript` first, or use `hypit transcribe` on the video.\n"}
## How to use it

1. Copy the \`references\` folder into your Hypit video project, next to the reference's media.
2. Put the reference video itself at \`${dir}/source.mp4\` (a local file, or fetched with \`hypit download\` when it is a link). Times in these files are source times, so they must match that file.
3. Install the Hypit skill once (\`npx skills add hypit-ai/hypit -g\`), open the project in your coding agent and call \`/hypit\`. Tell it the reference is \`${dir}\` and that ANALYSIS.md and TIMELINE.md are already written, so it should verify them against the video instead of starting over.
4. State your own subject, wording and imagery. Keep the structure (cuts, shot lengths, colour order, move timing); redesign the content. This is style transfer, not a copy of the reference.

## What was not verified

The files follow the layout in Hypit's \`reference-video.md\` guide but Frame Lens has not run Hypit on them. The easing curves are measured families to start from; refine them against the video with every-frame inspection.
`,
  };
  if (transcript) files[`${dir}/transcript.json`] = `${JSON.stringify(transcript, null, 2)}\n`;
  return write(root, files);
}

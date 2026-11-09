import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { InvalidInputError } from "./errors.js";
import { oneLine } from "./text.js";
import type { Logger } from "./logger.js";
import { findBoundaries, type Boundaries } from "./media/boundaries.js";
import type { MediaTools } from "./media/exec.js";
import { extractFrames, type FrameRequest } from "./media/frames.js";
import { probeMedia, type ProbeInfo } from "./media/probe.js";
import { buildSheets, type Sheet } from "./media/sheets.js";
import { buildPlan, type Goal, type Plan } from "./router/plan.js";
import { findPhrase, readCaptions, toMarkdown, wordsAt, type Transcript } from "./speech/transcript.js";
import { analyzeAudio, spectrogram, type AudioAnalysis } from "./audio/analyze.js";
import { readPage, type PageResult } from "./browser/read.js";
import { cleanReading, specFromPage, type PageReading } from "./browser/web.js";
import { inboxContents, inboxNote, newestInboxItem, newestInboxReading } from "./sources/inbox.js";
import { matchCuts, paletteDistance, similarity, verdict, type Comparison } from "./compare/compare.js";
import { exportSpec, type ExportTarget } from "./export/exporters.js";
import { onBeatRatio } from "./audio/dsp.js";
import { classifyChanges, energySpikeCuts, frameAt, motionEvents, motionProfile } from "./style/motion.js";
import { mergePalettes, palette } from "./style/palette.js";
import { detectTransitions, visibleMoves } from "./style/transitions.js";
import {
  ANALYSIS_SKELETON,
  buildSpec,
  framePixels,
  paletteTimes,
  shotsFromCuts,
  styleMarkdown,
  timelineMarkdown,
  writeWithMeasuredBlock,
  type MotionSpec,
  type Shot,
} from "./style/spec.js";
import { Workspace, type SourceRecord } from "./workspace/workspace.js";
import { linkTracks } from "./track/link.js";
import { trackMarkdown, trackSvg } from "./track/report.js";
import { trackWindow, type TrackedMove } from "./track/run.js";
import type { Box } from "./track/tracker.js";

/** A box given in fractions of the frame (every value ≤ 1) in source pixels. */
function toSourceBox(b: Box, probe: ProbeInfo): Box {
  const fraction = [b.x, b.y, b.w, b.h].every((v) => v >= 0 && v <= 1);
  const sx = fraction ? (probe.width ?? 1) : 1;
  const sy = fraction ? (probe.height ?? 1) : 1;
  return { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy };
}

/** Intersection over union of two boxes. */
function boxOverlap(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shared = ix * iy;
  return shared / (a.w * a.h + b.w * b.h - shared || 1);
}

/** The style pass reads every frame; longer references are analyzed in parts. */
export const MAX_STYLE_SECONDS = 180;
/** Audio analysis decodes the whole range into memory. */
export const MAX_AUDIO_SECONDS = 600;

/** Turns user input (link, path, ID) into a local media file inside a workspace folder. */
export type SourceResolver = (input: string, options: { workspaceRoot: string; signal?: AbortSignal }) => Promise<SourceRecord>;

/** A transcript from a remote engine (Gemini) when the source has no captions. */
export type TranscriptFallback = (record: SourceRecord, language?: string) => Promise<Transcript | undefined>;

export interface Source {
  ws: Workspace;
  record: SourceRecord;
  probe: ProbeInfo;
}

export interface FramesInput extends FrameRequest {
  /** A phrase from the transcript: frames are taken around the moment it is spoken. */
  around?: string;
  occurrence?: number;
  padding?: number;
  columns?: number;
  rows?: number;
  /** Words spoken at each frame under the picture (needs a transcript; skipped when there is none). */
  words?: boolean;
}

export interface FramesResult {
  source: Source;
  range: { start: number; end: number };
  frameCount: number;
  framesDir: string;
  sheets: Sheet[];
  index: string;
}

/** Until the full sources layer is wired in: local files only. */
export const localFileResolver: SourceResolver = async (input, { workspaceRoot }) => {
  const path = resolve(input);
  if (!existsSync(path)) {
    throw new InvalidInputError(`"${input}" is not a file on this computer. Links need the sources layer (framelens doctor shows what is missing).`);
  }
  const stat = statSync(path);
  const id = `file-${createHash("sha1").update(`${path}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 10)}`;
  const ws = new Workspace(workspaceRoot, id);
  const record: SourceRecord = { id, kind: "file", input, title: basename(path), mediaPath: path, fetchedAt: new Date().toISOString() };
  ws.writeJson("source.json", record);
  return record;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A page reading is a few hundred KB; anything far larger is not one. */
const MAX_READING_BYTES = 20 * 1024 * 1024;

/**
 * A page reading saved by the browser extension (or a web.json): checked to be one, then cleaned like a live
 * reading, because the page it came from wrote every string in it.
 */
export function readSavedReading(file: string): { reading: PageReading; capturedAt?: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new InvalidInputError(`${file} is not JSON. Pass a .framelens.json file the Frame Lens browser extension saved.`);
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const marked = typeof r.framelens === "string" && r.framelens.startsWith("framelens.page-reading/");
  const shaped = Array.isArray(r.animations) && typeof r.url === "string" && r.viewport !== null && typeof r.viewport === "object";
  if (!marked && !shaped) throw new InvalidInputError(`${file} is not a page reading. Pass a .framelens.json file the Frame Lens browser extension saved, or a web.json.`);
  const capturedAt = typeof r.capturedAt === "string" ? Date.parse(r.capturedAt) : NaN;
  return { reading: cleanReading(raw), ...(Number.isFinite(capturedAt) && capturedAt <= Date.now() + 60_000 && { capturedAt }) };
}

export class Engine {
  constructor(
    private readonly options: {
      tools: MediaTools;
      resolve: SourceResolver;
      root: string;
      logger: Logger;
      transcriptFallback?: TranscriptFallback;
      /** Settings for `inbox` (FRAMELENS_INBOX, FRAMELENS_DOWNLOADS); the process environment by default. */
      env?: Record<string, string | undefined>;
    },
  ) {}

  /** The absolute folder that holds every source's workspace. */
  get root(): string {
    return resolve(this.options.root);
  }

  /** Resolves and probes a source; the probe is kept in the workspace. */
  async source(input: string): Promise<Source> {
    const record = await this.options.resolve(input, { workspaceRoot: this.options.root });
    const ws = new Workspace(this.options.root, record.id);
    let probe = ws.readJson<ProbeInfo>("probe.json");
    if (!probe) {
      probe = await probeMedia(record.mediaPath, this.options.tools);
      ws.writeJson("probe.json", probe);
      this.progress(ws, `probed: ${probe.duration.toFixed(1)} s, ${probe.width ?? "?"}×${probe.height ?? "?"}, ${probe.fps ?? "?"} fps${probe.vfr ? " (VFR)" : ""}`);
    }
    return { ws, record, probe };
  }

  /** The cached transcript, or one built from captions or the fallback engine. */
  async transcript(input: string | Source, options: { language?: string; required?: boolean } = {}): Promise<{ source: Source; transcript?: Transcript }> {
    const source = typeof input === "string" ? await this.source(input) : input;
    const cached = source.ws.readJson<Transcript>("transcript.json");
    if (cached) return { source, transcript: cached };

    const captions = [...(source.record.captions ?? [])].sort(
      (a, b) =>
        Number(a.auto) - Number(b.auto) ||
        Number(b.language.startsWith(options.language ?? "\0")) - Number(a.language.startsWith(options.language ?? "\0")),
    );
    let transcript: Transcript | undefined;
    for (const caption of captions) {
      const parsed = readCaptions(caption.path);
      if (!parsed.segments.length) continue;
      transcript = { language: caption.language, source: caption.auto ? "auto-captions" : "captions", ...parsed };
      break;
    }
    if (!transcript && this.options.transcriptFallback) transcript = await this.options.transcriptFallback(source.record, options.language);
    if (!transcript) {
      if (options.required) {
        throw new InvalidInputError(
          "This source has no captions, and no speech-to-text engine is available. Add a Gemini key (GEMINI_API_KEY) " +
            "for YouTube links, or run framelens doctor to see local options.",
        );
      }
      return { source };
    }
    source.ws.writeJson("transcript.json", transcript);
    source.ws.writeText("transcript.md", toMarkdown(transcript, source.record.title));
    this.progress(source.ws, `transcript: ${transcript.source}, ${transcript.segments.length} segments, ${transcript.words.length} timed words`);
    return { source, transcript };
  }

  async boundaries(input: string, options: { start?: number; end?: number; rate?: number; threshold?: number } = {}): Promise<{ source: Source; boundaries: Boundaries; file: string }> {
    const source = await this.source(input);
    const rate = options.rate ?? 4;
    const threshold = options.threshold ?? 0.3;
    const name = `boundaries-r${rate}-t${threshold}-${r3(options.start ?? 0)}-${r3(options.end ?? source.probe.duration)}.json`;
    let boundaries = source.ws.readJson<Boundaries>(name);
    if (!boundaries) {
      boundaries = await findBoundaries(source.record.mediaPath, this.options.tools, { ...options, rate, threshold });
      source.ws.writeJson(name, boundaries);
      this.progress(source.ws, `boundaries: ${boundaries.candidates.length} changes at ${rate}/s (threshold ${threshold}), dynamics ${boundaries.dynamics}`);
    }
    return { source, boundaries, file: source.ws.path(name) };
  }

  async frames(input: string, request: FramesInput): Promise<FramesResult> {
    const source = await this.source(input);
    if (!source.probe.hasVideo) throw new InvalidInputError("This source has no picture, only sound: use `audio` or `transcript`.");
    const wantsWords = request.words !== false;
    const { transcript } = request.around || wantsWords ? await this.transcript(source, { required: Boolean(request.around) }) : {};

    let frameRequest: FrameRequest = { ...request };
    if (request.around) {
      const found = findPhrase(transcript!, request.around, request.occurrence ?? 1);
      if (!found) throw new InvalidInputError(`"${request.around}" is not in the transcript. Check the wording in transcript.md.`);
      const padding = request.padding ?? 1.5;
      frameRequest = { ...frameRequest, start: Math.max(0, found.start - padding), end: Math.min(source.probe.duration, found.end + padding) };
      if (frameRequest.every === undefined && frameRequest.fps === undefined && !frameRequest.everyFrame) frameRequest.fps = 4;
    }
    if (!frameRequest.at?.length && frameRequest.every === undefined && frameRequest.fps === undefined && !frameRequest.everyFrame) {
      throw new InvalidInputError("Say how to sample: `at`, `every`, `fps`, `every_frame` or `around`.");
    }

    const columns = Math.min(Math.max(request.columns ?? 4, 1), 8);
    const rows = Math.min(Math.max(request.rows ?? 4, 1), 8);
    const width = frameRequest.width ?? (columns >= 6 ? 240 : 320);
    const mode = frameRequest.at?.length ? "at" : frameRequest.everyFrame ? "all" : frameRequest.fps !== undefined ? `fps${frameRequest.fps}` : `every${frameRequest.every}`;
    const range = frameRequest.at?.length
      ? { start: Math.min(...frameRequest.at), end: Math.max(...frameRequest.at) }
      : { start: frameRequest.start ?? 0, end: frameRequest.end ?? source.probe.duration };
    const name = `${mode}-${range.start.toFixed(2)}-${range.end.toFixed(2)}-w${width}`.replace(/[^A-Za-z0-9._-]/g, "_");

    const framesDir = source.ws.ensure("frames", name);
    const frames = await extractFrames(source.record.mediaPath, framesDir, { ...frameRequest, width }, source.probe, this.options.tools);
    const fps = source.probe.fps;
    const label = (f: { t: number }) => {
      const frameNo = fps ? ` · f${Math.round(f.t * fps)}` : "";
      const words = transcript ? wordsAt(transcript, f.t) : "";
      return `${f.t.toFixed(3)} s${frameNo}${words ? ` · ${words}` : ""}`;
    };
    const sheets = await buildSheets(frames, source.ws.ensure("sheets"), name, { columns, rows, label }, this.options.tools);
    const index = source.ws.writeJson(`sheets/${name}.json`, {
      range,
      request: { ...frameRequest, width },
      sheets: sheets.map((s) => ({ file: source.ws.display(s.file), cells: s.cells })),
    });
    this.progress(source.ws, `frames: ${frames.length} (${mode}) ${range.start.toFixed(2)}–${range.end.toFixed(2)} s → ${sheets.length} sheet(s) ${name}`);
    return { source, range, frameCount: frames.length, framesDir, sheets, index };
  }

  async plan(input: string, options: { goal?: Goal; request?: string; phrase?: string }): Promise<{ source: Source; plan: Plan }> {
    const source = await this.source(input);
    const { transcript } = await this.transcript(source);
    const { boundaries } = source.probe.hasVideo ? await this.boundaries(input, { rate: 2, threshold: 0.3 }) : { boundaries: undefined };
    // Moves found by an earlier `style` run: the plan points `track` at them.
    const moves = source.ws.readJson<MotionSpec>("motion-spec.json")?.events.map((e) => ({ start: e.start, end: e.end, frames: e.frames, tracked: Boolean(e.track) }));
    const plan = buildPlan({
      probe: source.probe,
      ...(moves && { moves }),
      hasSpeech: Boolean(transcript?.segments.length),
      ...(boundaries && { boundaries }),
      ...(options.goal && { goal: options.goal }),
      ...(options.request && { request: options.request }),
      ...(options.phrase && { phrase: options.phrase }),
    });
    source.ws.writeJson("plan.json", plan);
    this.progress(source.ws, `plan: goal ${plan.goal}${plan.goalInferred ? " (inferred)" : ""}, video type ${plan.videoType}, ${plan.steps.length} steps`);
    return { source, plan };
  }

  /**
   * Replicate-style analysis: cuts, shots with palettes, per-frame motion energy and the moves in it with their
   * easing family. Writes motion-spec.json, STYLE.md, TIMELINE.md and ANALYSIS.md (only the measured blocks are
   * refreshed on later runs; the agent's own writing is kept).
   */
  async style(input: string, options: { start?: number; end?: number; version: string }): Promise<{ source: Source; spec: MotionSpec; files: Record<string, string> }> {
    const source = await this.source(input);
    const { probe, record, ws } = source;
    if (!probe.hasVideo) throw new InvalidInputError("This source has no picture to analyze for style.");
    const start = Math.max(0, options.start ?? 0);
    let end = Math.min(probe.duration, options.end ?? probe.duration);
    const notes: string[] = [];
    if (end - start > MAX_STYLE_SECONDS && options.end === undefined) {
      end = start + MAX_STYLE_SECONDS;
      notes.push(`Analyzed the first ${MAX_STYLE_SECONDS} s; pass start/end for other parts.`);
    }
    const range = { start, end };
    const { transcript } = await this.transcript(source);
    const { boundaries } = await this.boundaries(input, { start, end, rate: 10, threshold: 0.3 });
    const fps = probe.fps ?? probe.nominalFps ?? 30;
    const { energy, frames, skipped } = await motionProfile(record.mediaPath, this.options.tools, range, {
      hdr: probe.hdr,
      expectedFrames: Math.ceil((end - start) * fps * 1.05) + 30,
    });
    if (skipped) notes.push("This range is too long to keep every frame in memory: transitions were not looked for and shot colours come from a few frames each; analyze it in parts (start/end) for those.");
    ws.writeJson(`energy-${start.toFixed(2)}-${end.toFixed(2)}.json`, energy);
    // The frames tell a flash (the picture comes back) from a 2–3 frame shot between two cuts.
    const classified = classifyChanges(boundaries.candidates, energy, fps, 1 / boundaries.rate, frames);
    // Isolated per-frame spikes catch the cuts the sampled score missed (similar-looking shots).
    // A classified change sits on its peak frame: only a spike on that same frame is the same change (a 2-frame shot
    // puts two real cuts two frames apart).
    const extra = energySpikeCuts(energy, 6, frames)
      .filter((s) => !classified.some((c) => Math.abs(c.t - s.t) < 0.5 / fps))
      .map((s) => ({ ...s, kind: "cut" as const }));
    const changes = [...classified, ...extra].sort((a, b) => a.t - b.t);
    const cutTimes = changes.filter((c) => c.kind === "cut").map((c) => c.t);

    // Dissolves, fades and wipes change the whole picture over several frames: transitions, not moves. Moves are
    // found again without their frames, and the shots split at them.
    const transitions = detectTransitions(frames, fps, { cuts: cutTimes, windows: motionEvents(energy, cutTimes, fps) });
    const events = visibleMoves(motionEvents(energy, cutTimes, fps, { exclude: transitions }), frames);
    // A fade in from the first frame or out to the last one belongs to its shot: it starts no new one.
    const firstFrame = frames.times[0] ?? start;
    const lastFrame = frames.times.at(-1) ?? end;
    const edges = [...cutTimes, ...transitions.map((x) => x.at).filter((t) => t > firstFrame + 0.5 / fps && t < lastFrame - 0.5 / fps)].sort((a, b) => a - b);

    const tmp = ws.ensure("frames", "palette");
    const shots: Shot[] = [];
    for (const [i, s] of shotsFromCuts(edges, range, fps).entries()) {
      // Colours over the shot's own frames, not one frame from its middle (which may be halfway through a dissolve):
      // the decoded frames (tone-mapped for HDR in the same pass), or a few seeks when the range was too long to keep them.
      const parts: Uint8Array[] = [];
      if (frames.times.length) for (const t of paletteTimes(s, transitions, fps, 24)) parts.push(frameAt(frames, t));
      else {
        for (const t of paletteTimes(s, transitions, fps)) {
          const pixels = await framePixels(record.mediaPath, t, probe, this.options.tools, tmp);
          if (pixels.length) parts.push(pixels);
        }
      }
      // A one-frame shot has no frame at or after its middle; its only frame is at the start.
      if (!parts.some((p) => p.length)) parts.push(await framePixels(record.mediaPath, s.start, probe, this.options.tools, tmp));
      shots.push({ id: `s${i + 1}`, start: s.start, end: s.end, frames: Math.round((s.end - s.start) * fps), palette: palette(Buffer.concat(parts), 5) });
    }
    const overall = mergePalettes(shots.map((s) => ({ swatches: s.palette, weight: s.end - s.start })));

    const spec = buildSpec({ record, probe, range, changes, shots, overall, events, transitions, version: options.version, ...(transcript && { transcript }) });
    // Tracked moves outlive a new style pass: they are measured on their own windows.
    const tracks = ws.readJson<TrackedMove[]>("tracks.json");
    if (tracks?.length) linkTracks(spec, tracks);
    const files: Record<string, string> = {
      spec: ws.writeJson("motion-spec.json", spec),
      style: writeWithMeasuredBlock(ws, "STYLE.md", styleMarkdown(spec).measured, styleMarkdown(spec).skeleton),
      timeline: writeWithMeasuredBlock(ws, "TIMELINE.md", timelineMarkdown(spec, transcript).measured, timelineMarkdown(spec, transcript).skeleton),
    };
    const analysis = ws.path("ANALYSIS.md");
    files.analysis = existsSync(analysis) ? analysis : ws.writeText("ANALYSIS.md", ANALYSIS_SKELETON(record.title ?? record.input));
    this.progress(ws, `style: ${shots.length} shots, ${transitions.length} gradual transitions, ${spec.events.length} moves, ${overall.length} palette colours (${start.toFixed(2)}–${end.toFixed(2)} s)${notes.length ? `; ${notes.join(" ")}` : ""}`);
    return { source, spec, files };
  }

  /**
   * Follows one element through a window frame by frame and fits the exact timing curve of each property that moves
   * (x, y, scale, opacity). The window defaults to a move found by `style`. Adds the result to tracks.json and
   * motion-spec.json (where the style move it refines gets the curve), and writes TRACK.md and an SVG of the curves.
   */
  async track(
    input: string,
    options: { start?: number; end?: number; move?: number; box?: Box; at?: number } = {},
  ): Promise<{ source: Source; track: TrackedMove; files: Record<string, string>; note?: string }> {
    const source = await this.source(input);
    const { probe, record, ws } = source;
    if (!probe.hasVideo) throw new InvalidInputError("This source has no picture to track.");
    const spec = ws.readJson<MotionSpec>("motion-spec.json");
    let start = options.start;
    let end = options.end;
    let move = options.move;
    let note: string | undefined;
    if (start === undefined || end === undefined) {
      const events = spec?.events ?? [];
      if (move !== undefined && !events[move - 1]) throw new InvalidInputError(`There is no style move ${move}; motion-spec.json lists ${events.length}.`);
      // Without a window: the given style move, else the first one that starts inside the given range, else the first.
      const index = move !== undefined ? move - 1 : events.findIndex((e) => e.start >= (start ?? 0) - 0.05);
      const event = events[index];
      if (!event) {
        throw new InvalidInputError(
          spec ? "No style move to track in this range: pass start and end around the move." : "Pass start and end around the move, or run `style` first so `track` can use the moves it found.",
        );
      }
      move = index + 1;
      // Some rest on both sides: the fit finds where the move really starts and ends.
      start = start ?? Math.max(0, event.start - 0.3);
      end = end ?? Math.min(probe.duration, event.end + 0.4);
      note = `Window from style move ${move} (${event.start.toFixed(3)}–${event.end.toFixed(3)} s).`;
    }
    const tracks = ws.readJson<TrackedMove[]>("tracks.json") ?? [];
    // A track is the same as an earlier one when it asks for the same window and the same element: another box in
    // the same window is another element (a stagger), and keeps its own track.
    const wanted = options.box && toSourceBox(options.box, probe);
    const same = (t: TrackedMove) => {
      const asked = t.requested ?? t.window;
      if (Math.abs(asked.start - start!) >= 0.01 || Math.abs(asked.end - end!) >= 0.01) return false;
      if (!wanted) return t.element.auto;
      return !t.element.auto && boxOverlap(t.element.box, wanted) > 0.5;
    };
    const previous = tracks.find(same);
    const id = previous?.id ?? `t${tracks.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0) + 1}`;
    const track = await trackWindow(record.mediaPath, probe, this.options.tools, {
      start,
      end,
      id,
      ...(options.box && { box: options.box }),
      ...(options.at !== undefined && { at: options.at }),
      ...(move !== undefined && { move }),
    });
    const all = [...tracks.filter((t) => t.id !== id), track].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const files: Record<string, string> = { tracks: ws.writeJson("tracks.json", all) };
    if (spec) files.spec = ws.writeJson("motion-spec.json", linkTracks(spec, all));
    const svgName = (t: TrackedMove) => `track-${t.id}.svg`;
    files.svg = ws.writeText(svgName(track), trackSvg(track));
    const md = trackMarkdown(all, svgName);
    files.report = writeWithMeasuredBlock(ws, "TRACK.md", md.measured, md.skeleton);
    this.progress(ws, `track ${id}: ${track.properties.map((p) => `${p.property} ${p.curve.kind}`).join(", ") || "nothing moved"} (${start.toFixed(2)}–${end.toFixed(2)} s)`);
    return { source, track, files, ...(note && { note }) };
  }

  /**
   * Sound: loudness, silences, onsets, tempo and beat grid, how many cuts land on a beat, and a spectrogram picture.
   * When motion-spec.json exists, its beat anchors and audio block are filled in.
   */
  async audio(input: string, options: { start?: number; end?: number } = {}): Promise<{ source: Source; analysis: AudioAnalysis; cutOnBeat?: number; files: Record<string, string> }> {
    const source = await this.source(input);
    const { probe, record, ws } = source;
    if (!probe.hasAudio) throw new InvalidInputError("This source has no sound.");
    const start = Math.max(0, options.start ?? 0);
    const end = Math.min(probe.duration, options.end ?? Math.min(probe.duration, start + MAX_AUDIO_SECONDS));
    const range = { start, end };
    const analysis = await analyzeAudio(record.mediaPath, this.options.tools, range);
    const name = `audio-${start.toFixed(2)}-${end.toFixed(2)}`;
    const files: Record<string, string> = {
      audio: ws.writeJson(`${name}.json`, analysis),
      spectrogram: await spectrogram(record.mediaPath, ws.path(`${name}-spectrogram.png`), this.options.tools, range),
    };

    let cutOnBeat: number | undefined;
    const spec = ws.readJson<MotionSpec>("motion-spec.json");
    if (spec) {
      const cuts = spec.anchors.cuts.map((c) => c.t).filter((t) => t >= start && t <= end);
      // No cuts is not "0% on the beat": leave the ratio out.
      cutOnBeat = analysis.beats.length && cuts.length ? onBeatRatio(cuts, analysis.beats) : undefined;
      spec.anchors.beats = analysis.beats.map((t, i) => ({ id: `b${i + 1}`, t }));
      spec.audio = {
        ...spec.audio,
        ...(analysis.tempo && { tempo_bpm: analysis.tempo.bpm }),
        ...(cutOnBeat !== undefined && { cut_on_beat_ratio: cutOnBeat }),
        ...(analysis.integratedLufs !== undefined && { integrated_lufs: analysis.integratedLufs }),
        hits: analysis.onsets.filter((o) => o.strength >= 0.5).map((o) => ({ t: o.t, strength: o.strength, evidence: "measured" })),
      };
      files.spec = ws.writeJson("motion-spec.json", spec);
    }
    this.progress(ws, `audio: ${analysis.tempo ? `${analysis.tempo.bpm} BPM (confidence ${analysis.tempo.confidence})` : "no steady tempo"}, ${analysis.onsets.length} onsets, ${analysis.silences.length} silences${cutOnBeat !== undefined ? `, ${Math.round(cutOnBeat * 100)}% of cuts on a beat` : ""}`);
    return { source, analysis, ...(cutOnBeat !== undefined && { cutOnBeat }), files };
  }

  /** Writes a starter project for a renderer from the source's motion-spec.json (running `style` first if needed). */
  async export(input: string, target: ExportTarget, version: string, env: Record<string, string | undefined> = this.options.env ?? process.env): Promise<{ ws: Workspace; title: string; dir: string; files: string[]; inboxNote?: string }> {
    // `inbox`: the newest video or page reading. When only one of the two was already worked on (`web inbox`, or
    // `style inbox`), that one, since it is what the user just looked at; otherwise the newer of the two.
    let wanted = input;
    let note: string | undefined;
    if (input.trim().toLowerCase() === "inbox") {
      const { media, reading } = inboxContents(env);
      const worked = [reading && this.webWorkspace(reading.path) ? reading : undefined, media && this.hasMediaWorkspace(media.path) ? media : undefined].filter((x) => x !== undefined);
      const item = worked.length === 1 ? worked[0]! : newestInboxItem(env);
      wanted = item.path;
      const other = item.kind === "reading" ? media : reading;
      if (other) note = `The inbox also has a ${other.kind === "reading" ? "page reading" : "video"}, ${other.path}; this export is from ${item.path}. Pass a path to export the other.`;
      if (item.kind === "reading" && !this.webWorkspace(item.path)) await this.web(item.path, version, env);
    }
    // A web page read with `web` has its spec in its own workspace; anything else is a video source.
    const web = this.webWorkspace(wanted);
    let ws: Workspace;
    let spec: MotionSpec | undefined;
    if (web) {
      ws = web;
      spec = web.readJson<MotionSpec>("motion-spec.json");
    } else {
      const source = await this.source(wanted);
      ws = source.ws;
      spec = ws.readJson<MotionSpec>("motion-spec.json") ?? (await this.style(wanted, { version })).spec;
    }
    const dir = ws.ensure("export", target);
    const files = exportSpec(spec!, target, dir, { workspace: ws.dir });
    this.progress(ws, `export: ${target} starter with ${spec!.shots.length} scenes → ${ws.display(dir)}`);
    return { ws, title: spec!.source.title ?? input, dir, files, ...(note && { inboxNote: note }) };
  }

  /** Whether a local video already has a workspace here (a tool ran on it). */
  private hasMediaWorkspace(mediaPath: string): boolean {
    if (!existsSync(this.options.root)) return false;
    const wanted = resolve(mediaPath);
    for (const name of readdirSync(this.options.root)) {
      if (!name.startsWith("file-")) continue;
      try {
        const record = new Workspace(this.options.root, name).readJson<{ mediaPath?: string }>("source.json");
        if (record?.mediaPath && resolve(record.mediaPath) === wanted) return true;
      } catch {
        // An unreadable record is no workspace for this file.
      }
    }
    return false;
  }

  /** The workspace of a page read with `web`, or a Lottie, Figma or Rive source read with `exact`, if any. */
  private webWorkspace(input: string): Workspace | undefined {
    const wanted = input.trim();
    if (!wanted || !existsSync(this.options.root)) return undefined;
    const web = /^https?:\/\//i;
    const same = (v: unknown) => typeof v === "string" && v !== "" && (v === wanted || (!web.test(v) && !web.test(wanted) && resolve(v) === resolve(wanted)));
    // Several readings of one page (live, and saved by the extension at different times): the newest reading wins.
    // The live reading's folder is named after the address, so it counts even without its source.json.
    const live = web.test(wanted) ? `web-${createHash("sha1").update(wanted).digest("hex").slice(0, 10)}` : undefined;
    let best: { ws: Workspace; at: number } | undefined;
    for (const name of readdirSync(this.options.root)) {
      if (!/^(web|lottie|figma|rive)-/.test(name)) continue;
      const ws = new Workspace(this.options.root, name);
      let record: { input?: string; url?: string; mediaPath?: string; readFrom?: string; readAt?: string; fetchedAt?: string } | undefined;
      try {
        record = ws.readJson("source.json");
      } catch {
        record = undefined;
      }
      const matches = name === live || (record && [record.input, record.url, record.mediaPath, record.readFrom].some(same));
      if (!matches || !existsSync(ws.path("motion-spec.json"))) continue;
      record ??= {};
      const at = Date.parse(record.readAt ?? record.fetchedAt ?? "") || statSync(ws.path("motion-spec.json")).mtimeMs;
      if (!best || at > best.at) best = { ws, at };
    }
    return best?.ws;
  }

  /**
   * Checks a render against the reference: duration, cuts (matched within 3 frames), palette distance and picture
   * similarity over time, with a side-by-side sheet of the least similar moments. Writes COMPARE.md.
   */
  async compare(reference: string, render: string, version: string): Promise<{ source: Source; comparison: Comparison; files: Record<string, string>; sheet?: Sheet }> {
    const ref = await this.style(reference, { version });
    const out = await this.style(render, { version });
    const fps = ref.source.probe.fps ?? 30;
    const samples = await similarity(ref.source.record.mediaPath, out.source.record.mediaPath, this.options.tools);
    const worst = [...samples].sort((a, b) => a.ssim - b.ssim).slice(0, 6).sort((a, b) => a.t - b.t);
    const partial = {
      durations: {
        reference: ref.source.probe.duration,
        render: out.source.probe.duration,
        differenceSeconds: Math.round((out.source.probe.duration - ref.source.probe.duration) * 1000) / 1000,
      },
      cuts: matchCuts(ref.spec.anchors.cuts.map((c) => c.t), out.spec.anchors.cuts.map((c) => c.t), fps),
      palette: {
        distance: paletteDistance(ref.spec.palette, out.spec.palette),
        reference: ref.spec.palette.map((p) => p.hex),
        render: out.spec.palette.map((p) => p.hex),
      },
      similarity: {
        mean: samples.length ? Math.round((samples.reduce((s, x) => s + x.ssim, 0) / samples.length) * 1000) / 1000 : 0,
        worst,
      },
    };
    const comparison: Comparison = { ...partial, verdict: verdict(partial, fps) };

    const ws = ref.source.ws;
    let sheet: Sheet | undefined;
    const times = worst.map((w) => w.t).filter((t) => t <= Math.min(ref.source.probe.duration, out.source.probe.duration));
    if (times.length) {
      const dir = ws.ensure("frames", "compare");
      const a = await extractFrames(ref.source.record.mediaPath, join(dir, "reference"), { at: times, width: 480 }, ref.source.probe, this.options.tools);
      const b = await extractFrames(out.source.record.mediaPath, join(dir, "render"), { at: times, width: 480 }, out.source.probe, this.options.tools);
      const pairs = a.flatMap((f, i) => [{ ...f, side: "reference" }, { ...b[i]!, side: "render" }]);
      [sheet] = await buildSheets(pairs, ws.ensure("sheets"), "compare", { columns: 2, rows: Math.min(8, times.length), label: (f) => `${(f as { side?: string }).side} · ${f.t.toFixed(3)} s` }, this.options.tools);
    }
    const md = [
      `# Compare: ${oneLine(ref.source.record.title ?? reference)} vs ${oneLine(out.source.record.title ?? render)}`,
      "",
      ...comparison.verdict.map((v) => `- ${v}`),
      "",
      `Duration: reference ${comparison.durations.reference.toFixed(3)} s, render ${comparison.durations.render.toFixed(3)} s.`,
      `Cuts: ${comparison.cuts.matched.length - comparison.cuts.missing.length} of ${comparison.cuts.matched.length} matched within 3 frames.`,
      `Palette distance (OKLab, 0 = same): ${comparison.palette.distance}.`,
      `Mean picture similarity (SSIM): ${comparison.similarity.mean}.`,
      sheet ? `\nSide by side at the least similar moments: ${ws.display(sheet.file)}` : "",
    ].join("\n");
    const files: Record<string, string> = { report: ws.writeText("COMPARE.md", `${md}\n`), json: ws.writeJson("compare.json", comparison) };
    this.progress(ws, `compare: with ${oneLine(render)}: ${comparison.verdict.join(" ")}`);
    return { source: ref.source, comparison, files, ...(sheet && { sheet }) };
  }

  /**
   * A live web page: reads its animations exactly (durations, delays, curves, keyframes) from the browser, plus fonts
   * and colours, films the opening motion frame by frame, and writes the same motion-spec.json as a video.
   */
  async web(input: string, version: string, env: Record<string, string | undefined> = this.options.env ?? process.env): Promise<{ ws: Workspace; spec: MotionSpec; result: PageResult; files: Record<string, string>; savedReading?: string; inboxNote?: string }> {
    const url = input.trim();
    let id: string;
    let result: PageResult;
    let savedReading: string | undefined;
    let readAt = Date.now();
    let ws: Workspace;
    if (/^https?:\/\//i.test(url)) {
      id = `web-${createHash("sha1").update(url).digest("hex").slice(0, 10)}`;
      ws = new Workspace(this.options.root, id);
      result = await readPage(url, ws.ensure("frames", "web"), this.options.tools);
    } else {
      // A reading the browser extension saved in the user's own browser (pages behind their login), or a web.json.
      savedReading = url.toLowerCase() === "inbox" ? newestInboxReading(env) : resolve(url.replace(/^["']|["']$/g, ""));
      const stat = existsSync(savedReading) ? statSync(savedReading) : undefined;
      if (!stat?.isFile()) throw new InvalidInputError(`"${oneLine(input, 300)}" is neither a web page address nor a page reading file. Pass an http(s) address, the path of a .framelens.json the browser extension saved, or "inbox".`);
      if (stat.size > MAX_READING_BYTES) throw new InvalidInputError(`${savedReading} is larger than a page reading can be (${MAX_READING_BYTES / 1024 / 1024} MB).`);
      const saved = readSavedReading(savedReading);
      result = { reading: saved.reading, views: [] };
      readAt = saved.capturedAt ?? stat.mtimeMs;
      id = `web-${createHash("sha1").update(`${savedReading}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 10)}`;
      ws = new Workspace(this.options.root, id);
    }
    const spec = specFromPage(result.reading, version);
    ws.writeJson("source.json", {
      id,
      kind: "url",
      input: savedReading ?? url,
      url: result.reading.url,
      title: result.reading.title,
      mediaPath: "",
      fetchedAt: new Date().toISOString(),
      // When the page itself was read: the newest reading of a page is the one export uses.
      readAt: new Date(readAt).toISOString(),
      ...(savedReading && { readFrom: savedReading }),
    });
    const { measured, skeleton } = styleMarkdown(spec);
    const files: Record<string, string> = {
      reading: ws.writeJson("web.json", result.reading),
      spec: ws.writeJson("motion-spec.json", spec),
      style: writeWithMeasuredBlock(ws, "STYLE.md", measured, skeleton),
    };
    this.progress(
      ws,
      `web: ${result.reading.animations.length} animations${result.reading.gsap ? " (GSAP found)" : ""}, ${result.reading.fonts.length} text styles, ` +
        (savedReading ? `read from ${savedReading}` : `${result.views.length} views`),
    );
    const note = url.toLowerCase() === "inbox" ? inboxNote(env, "reading") : undefined;
    return { ws, spec, result, files, ...(savedReading && { savedReading }), ...(note && { inboxNote: note }) };
  }

  /** Appends a line to PROGRESS.md so a later session can see what was already done. */
  private progress(ws: Workspace, line: string): void {
    const file = ws.path("PROGRESS.md");
    if (!existsSync(file)) ws.writeText("PROGRESS.md", "# Progress\n\nTool runs, oldest first. Add your own notes and open questions below them.\n\n");
    appendFileSync(file, `- ${new Date().toISOString().slice(0, 19)}Z ${line}\n`);
    this.options.logger.debug(line, { workspace: ws.id });
  }
}

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { InvalidInputError } from "./errors.js";
import type { Logger } from "./logger.js";
import { findBoundaries, type Boundaries } from "./media/boundaries.js";
import type { MediaTools } from "./media/exec.js";
import { extractFrames, type FrameRequest } from "./media/frames.js";
import { probeMedia, type ProbeInfo } from "./media/probe.js";
import { buildSheets, type Sheet } from "./media/sheets.js";
import { buildPlan, type Goal, type Plan } from "./router/plan.js";
import { findPhrase, readCaptions, toMarkdown, wordsAt, type Transcript } from "./speech/transcript.js";
import { Workspace, type SourceRecord } from "./workspace/workspace.js";

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

export class Engine {
  constructor(
    private readonly options: {
      tools: MediaTools;
      resolve: SourceResolver;
      root: string;
      logger: Logger;
      transcriptFallback?: TranscriptFallback;
    },
  ) {}

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
    const plan = buildPlan({
      probe: source.probe,
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

  /** Appends a line to PROGRESS.md so a later session can see what was already done. */
  private progress(ws: Workspace, line: string): void {
    const file = ws.path("PROGRESS.md");
    if (!existsSync(file)) ws.writeText("PROGRESS.md", "# Progress\n\nTool runs, oldest first. Add your own notes and open questions below them.\n\n");
    appendFileSync(file, `- ${new Date().toISOString().slice(0, 19)}Z ${line}\n`);
    this.options.logger.debug(line, { workspace: ws.id });
  }
}

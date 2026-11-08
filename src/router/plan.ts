import type { Boundaries } from "../media/boundaries.js";
import type { ProbeInfo } from "../media/probe.js";

export const GOALS = ["listen", "learn", "find", "style", "sound", "production"] as const;
export type Goal = (typeof GOALS)[number];

export type VideoType = "talking-head" | "screen" | "motion-graphics" | "music-video" | "live-action" | "still";

export interface PlanStep {
  tool: "transcript" | "frames" | "boundaries" | "style" | "audio";
  args: Record<string, unknown>;
  why: string;
}

export interface Plan {
  goal: Goal;
  /** True when the goal was guessed from the request or the video type. */
  goalInferred: boolean;
  videoType: VideoType;
  reasons: string[];
  steps: PlanStep[];
  estimate: { frames: number; sheets: number; imageTokens: number };
  notes: string[];
}

/** Keywords per goal, English and Russian, checked in this order. */
const GOAL_WORDS: [Goal, RegExp][] = [
  ["style", /стил|референс|анимац|моушн|motion|style|replicat|recreate|повтор|переход|transition|easing|art direction/i],
  ["sound", /звук|саунд|sound|music|музык|sfx|бит|beat/i],
  ["production", /как снят|снято|сгенерир|ии-|camera|shot|снимал|lighting|свет/i],
  // \b does not see Cyrillic letters, so Russian words end at whitespace instead.
  ["find", /^(где|когда)\s|в какой момент|найди|\bfind\b|^where\b|^when\b|which moment/i],
  ["learn", /гайд|туториал|инструкц|урок|tutorial|guide|how to|step|шаг|настро/i],
  ["listen", /конспект|подкаст|summary|summari|transcri|расшифр|о чём|about|перескаж|lecture|лекци|интервью|interview/i],
];

export function inferGoal(request: string | undefined): Goal | undefined {
  if (!request) return undefined;
  return GOAL_WORDS.find(([, re]) => re.test(request))?.[0];
}

/** Classifies the video from how often and how much its picture changes, and whether it has speech. */
export function classify(probe: ProbeInfo, boundaries: Boundaries | undefined, hasSpeech: boolean): { type: VideoType; reasons: string[] } {
  if (!probe.hasVideo || probe.duration === 0 || (probe.frameCount !== undefined && probe.frameCount <= 1)) {
    return { type: "still", reasons: ["no moving picture"] };
  }
  const cpm = boundaries?.changesPerMinute ?? 0;
  const dyn = boundaries?.dynamics ?? 0;
  const reasons = [`${cpm} picture changes per minute`, `mean change ${dyn}`, hasSpeech ? "has speech" : "no captions or speech found"];
  if (!hasSpeech && probe.hasAudio && cpm >= 10) return { type: "music-video", reasons };
  if (cpm >= 15 || dyn >= 0.08) return { type: "motion-graphics", reasons };
  if (cpm < 1.5 && dyn < 0.02) return { type: "talking-head", reasons };
  if (cpm < 12 && dyn < 0.05) return { type: "screen", reasons };
  return { type: "live-action", reasons };
}

const DEFAULT_GOAL: Record<VideoType, Goal> = {
  "talking-head": "listen",
  screen: "learn",
  "motion-graphics": "style",
  "music-video": "sound",
  "live-action": "listen",
  still: "style",
};

/** Image tokens of a contact sheet of `cells` frames at 320×180 in 4 columns, by Anthropic's ⌈w/28⌉×⌈h/28⌉ rule. */
export function sheetTokens(cells: number, columns = 4, cellWidth = 320, cellHeight = 180 + 56): number {
  const cols = Math.min(columns, cells);
  const rows = Math.ceil(cells / columns);
  return Math.ceil((cols * cellWidth) / 28) * Math.ceil((rows * cellHeight) / 28);
}

/** Windows of the video where the picture changes most, to look at closely. */
export function busiestWindows(boundaries: Boundaries | undefined, duration: number, width = 8, count = 3): { start: number; end: number }[] {
  if (!boundaries?.candidates.length) return [{ start: 0, end: Math.min(duration, width) }];
  const windows = boundaries.candidates.map((c) => {
    const start = Math.max(0, Math.min(c.t - 1, duration - width));
    const end = Math.min(duration, start + width);
    return { start, end, score: boundaries.candidates.filter((d) => d.t >= start && d.t < end).length };
  });
  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: { start: number; end: number }[] = [];
  for (const w of windows) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => w.start < c.end && w.end > c.start)) continue;
    chosen.push({ start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 });
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export function buildPlan(input: {
  goal?: Goal;
  request?: string;
  probe: ProbeInfo;
  boundaries?: Boundaries;
  hasSpeech: boolean;
  phrase?: string;
}): Plan {
  const { probe, boundaries, hasSpeech } = input;
  const { type, reasons } = classify(probe, boundaries, hasSpeech);
  const explicit = input.goal ?? inferGoal(input.request);
  const goal = explicit ?? DEFAULT_GOAL[type];
  const d = probe.duration;
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  let frames = 0;
  let sheets = 0;
  let imageTokens = 0;
  const addSheets = (n: number) => {
    frames += n;
    sheets += Math.ceil(n / 16);
    imageTokens += Math.floor(n / 16) * sheetTokens(16) + (n % 16 ? sheetTokens(n % 16) : 0);
  };
  const overviewEvery = Math.max(1, Math.round((d / 24) * 10) / 10);

  if (goal !== "style" || hasSpeech) {
    steps.push({ tool: "transcript", args: {}, why: hasSpeech ? "word-timed speech is the backbone of the reading" : "check whether there is speech at all" });
  }

  switch (goal) {
    case "listen":
      steps.push({ tool: "frames", args: { every: overviewEvery, columns: 4, rows: 6 }, why: "one overview sheet: who is speaking, slides, setting" });
      addSheets(Math.min(24, Math.ceil(d / overviewEvery)));
      notes.push("The transcript carries the content; frames are only context.");
      break;
    case "learn":
      steps.push({ tool: "boundaries", args: { rate: 2, threshold: 0.25 }, why: "find every screen change" });
      steps.push({ tool: "frames", args: { at: "each boundary + 0.5 s", columns: 4, rows: 4, labels: "words" }, why: "one frame per screen state, with the words spoken there" });
      addSheets(Math.min(160, Math.round(((boundaries?.changesPerMinute ?? 4) * d) / 60) + 1));
      notes.push("Read commands and code from the frames, steps from the words; open a frame at full width when text is small.");
      break;
    case "find":
      steps.push({ tool: "frames", args: { around: input.phrase ?? "<phrase>", fps: 2, columns: 4, rows: 3 }, why: "frames around the place the phrase is spoken" });
      addSheets(12);
      break;
    case "style": {
      steps.push({ tool: "boundaries", args: { rate: 10, threshold: 0.3 }, why: "every cut and abrupt change, to a tenth of a second" });
      const overview = Math.min(120, Math.ceil(d / 0.5));
      steps.push({ tool: "frames", args: { every: Math.max(0.5, Math.round((d / 120) * 10) / 10), columns: 4, rows: 4 }, why: "loupe ×1: the whole piece, its systems and rhythm" });
      addSheets(overview);
      for (const w of busiestWindows(boundaries, d)) {
        steps.push({ tool: "frames", args: { start: w.start, end: w.end, fps: 10, columns: 4, rows: 4 }, why: "loupe ×10: the busiest passage" });
        addSheets(Math.ceil((w.end - w.start) * 10));
      }
      const events = (boundaries?.candidates ?? []).slice(0, 12);
      for (const e of events) {
        steps.push({ tool: "frames", args: { start: Math.max(0, e.t - 0.5), end: Math.min(d, e.t + 0.5), every_frame: true, columns: 6, rows: 4 }, why: `loupe ×60: every frame around the change at ${e.t} s` });
        addSheets(Math.ceil(probe.fps ?? 30));
      }
      steps.push({ tool: "style", args: {}, why: "palette, shots, systems, STYLE.md and motion-spec.json (2.1)" });
      if ((boundaries?.candidates.length ?? 0) > events.length) notes.push(`${boundaries!.candidates.length - events.length} more changes: inspect them the same way if they matter.`);
      break;
    }
    case "sound":
      steps.push({ tool: "audio", args: {}, why: "loudness, hits, tempo and beat grid, spectrogram (2.2)" });
      steps.push({ tool: "boundaries", args: { rate: 10, threshold: 0.3 }, why: "cuts, to compare with the beat" });
      break;
    case "production":
      steps.push({ tool: "boundaries", args: { rate: 4, threshold: 0.3 }, why: "split into shots" });
      steps.push({ tool: "frames", args: { at: "middle of each shot", columns: 4, rows: 4 }, why: "one key frame per shot for camera, light and source" });
      addSheets(Math.min(160, (boundaries?.candidates.length ?? 8) + 1));
      break;
  }

  return { goal, goalInferred: !input.goal, videoType: type, reasons, steps, estimate: { frames, sheets, imageTokens }, notes };
}

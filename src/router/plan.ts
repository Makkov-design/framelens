import type { Boundaries } from "../media/boundaries.js";
import type { ProbeInfo } from "../media/probe.js";

export const GOALS = ["listen", "learn", "find", "style", "sound", "production"] as const;
export type Goal = (typeof GOALS)[number];

export type VideoType = "talking-head" | "screen" | "motion-graphics" | "music-video" | "live-action" | "still";

export interface PlanStep {
  tool: "transcript" | "frames" | "boundaries" | "style" | "audio" | "track";
  /** Arguments the tool accepts as they are (besides `source`). */
  args: Record<string, unknown>;
  why: string;
  /**
   * What to add to `args` before running the step, when it depends on an earlier step's result (the times of the
   * changes `boundaries` finds) or on something only the agent can see (the box around an element).
   */
  then?: string;
}

/** Most moments one `frames` call takes (`at` holds at most 200). */
export const MAX_AT = 200;

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

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Windows of the video where the picture changes most (by the summed strength of its changes), to look at closely.
 * They never overlap, and windows that touch are joined into one.
 */
export function busiestWindows(boundaries: Boundaries | undefined, duration: number, width = 8, count = 3): { start: number; end: number }[] {
  if (!boundaries?.candidates.length) return [{ start: 0, end: r2(Math.min(duration, width)) }];
  const windows = boundaries.candidates.map((c) => {
    const start = Math.max(0, Math.min(c.t - 1, duration - width));
    const end = Math.min(duration, start + width);
    return { start, end, score: boundaries.candidates.filter((d) => d.t >= start && d.t < end).reduce((s, d) => s + d.score, 0) };
  });
  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: { start: number; end: number }[] = [];
  for (const w of windows) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => w.start < c.end && w.end > c.start)) continue;
    chosen.push({ start: r2(w.start), end: r2(w.end) });
  }
  return joinWindows(chosen, 0);
}

/** Joins windows that overlap or lie within `gap` seconds of each other. */
export function joinWindows<T extends { start: number; end: number }>(windows: T[], gap: number, merge?: (a: T, b: T) => T): T[] {
  const out: T[] = [];
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && w.start <= last.end + gap + 1e-9) {
      const joined = merge ? merge(last, w) : last;
      out[out.length - 1] = { ...joined, start: last.start, end: Math.max(last.end, w.end) };
    } else out.push({ ...w });
  }
  return out;
}

/** How many ×10 passages and every-frame windows a video of this length gets, and how long a passage is. */
export function loupeBudget(duration: number): { passages: number; passageSeconds: number; dense: number } {
  return {
    // One to three ×10 passages, each about 12 % of the video (2–8 s): 24 % of a 33 s piece, 20 % of a 2 min one.
    passages: duration <= 20 ? 1 : duration <= 90 ? 2 : 3,
    passageSeconds: Math.min(8, Math.max(2, Math.round(duration * 0.12))),
    // One every-frame window per 8 s, at least 2, at most 8.
    dense: Math.min(8, Math.max(2, Math.round(duration / 8))),
  };
}

/** Longest every-frame window: a longer stretch of change is split into windows of this length. */
export const MAX_DENSE_SECONDS = 2;

/**
 * Every-frame windows around the strongest changes: one second around each, windows that overlap or touch joined,
 * longer stretches split into windows of at most `MAX_DENSE_SECONDS`, the `count` strongest kept in time order.
 */
export function denseWindows(list: { t: number; score: number }[], duration: number, count: number): { start: number; end: number; peak: number; changes: number }[] {
  const around = list.map((c) => ({ start: Math.max(0, c.t - 0.5), end: Math.min(duration, c.t + 0.5), peak: c.t, score: c.score, changes: 1 }));
  const joined = joinWindows(around, 0.1, (a, b) => ({ ...a, peak: b.score > a.score ? b.peak : a.peak, score: Math.max(a.score, b.score), changes: a.changes + b.changes }));
  // A long burst of changes is split into windows of at most `MAX_DENSE_SECONDS`, each scored by its own strongest
  // change, so a busy stretch can use several windows of the budget instead of one.
  const pieces = joined.flatMap((w) => {
    const n = Math.ceil((w.end - w.start) / MAX_DENSE_SECONDS - 1e-9);
    if (n <= 1) return [w];
    const length = (w.end - w.start) / n;
    return Array.from({ length: n }, (_, i) => {
      const start = w.start + i * length;
      const end = i === n - 1 ? w.end : start + length;
      const inside = list.filter((c) => c.t >= start && c.t < end + (i === n - 1 ? 1e-9 : 0));
      const best = inside.reduce<{ t: number; score: number } | undefined>((b, c) => (!b || c.score > b.score ? c : b), undefined);
      return { ...w, start, end, peak: best?.t ?? (start + end) / 2, score: best?.score ?? 0 };
    });
  });
  return pieces
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, count)
    .sort((a, b) => a.start - b.start)
    // How many changes the (possibly shortened) window still holds.
    .map((w) => ({ start: r2(w.start), end: r2(w.end), peak: w.peak, changes: list.filter((c) => c.t >= w.start && c.t <= w.end).length }));
}

/** Most `track` steps a plan lists; the rest are named in a note. */
export const MAX_TRACK_STEPS = 6;

/**
 * Footage where `element: "auto"` (the biggest moving region) is usually the element itself: graphics, UI and screen
 * recordings. In camera footage the biggest moving region is often the camera move or a person, so a box is asked for;
 * a music video may be either, so the agent, who has seen its frames, decides.
 */
const AUTO_ELEMENT_TYPES: ReadonlySet<VideoType> = new Set(["motion-graphics", "screen", "still"]);

const BOX_THEN =
  "add `element`: a box {x, y, w, h} around the thing that moves, read from a frame of this move (source pixels, or fractions of the frame); " +
  "`auto` (the biggest moving region) suits graphics and UI, but in camera footage it often follows the camera or a person instead";

const WHOLE_PICTURE_THEN =
  "add `element`: a box {x, y, w, h} around the part to follow, with `at` (the time of the frame you read it from); " +
  "`style` measured that the whole picture changes in this move (a camera or character move), so `auto` has no element to pick";

/** A move from `style`, with whether `auto` can pick its element (`element`, from the share of the picture it changes). */
export interface PlanMove {
  start: number;
  end: number;
  frames: number;
  tracked?: boolean;
  /** Share of the picture the move changes (0–1); absent in specs from before 2.1.0's release fixes. */
  area?: number;
  /** `box` when the whole picture moves there; absent in older specs. */
  element?: "auto" | "box";
}

/** After `style`: one `track` step per move that matters (the longest untracked ones), or one per move number. */
function addTrackSteps(steps: PlanStep[], notes: string[], moves: PlanMove[] | undefined, type: VideoType): void {
  const auto = AUTO_ELEMENT_TYPES.has(type);
  // `element: "auto"` only where the move allows it (or says nothing) and the footage suits it; a whole-picture move
  // always asks for a box.
  const step = (move: number, why: string, whole = false): PlanStep =>
    whole
      ? { tool: "track", args: { move }, why, then: WHOLE_PICTURE_THEN }
      : auto
        ? { tool: "track", args: { move, element: "auto" }, why }
        : { tool: "track", args: { move }, why, then: BOX_THEN };
  if (!moves) {
    steps.push(step(1, "after style: the exact curve (cubic-bezier or spring) of each move that matters; repeat with move 2, 3, …"));
    return;
  }
  if (!moves.length) {
    notes.push("style found no moves to track; pass start and end to `track` around a move you can see.");
    return;
  }
  // A spec from an older run may list the same move twice: track it once.
  const seen = new Set<string>();
  const open = moves
    .map((m, i) => ({ ...m, number: i + 1 }))
    .filter((m) => {
      const key = `${Math.round(m.start * 1000)}|${Math.round(m.end * 1000)}|${m.frames}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !m.tracked;
    });
  // Moves of one element against a still background first (they fit), then the longest.
  const whole = (m: PlanMove) => m.element === "box";
  const chosen = [...open]
    .sort((a, b) => Number(whole(a)) - Number(whole(b)) || b.frames - a.frames || a.start - b.start)
    .slice(0, MAX_TRACK_STEPS)
    .sort((a, b) => a.start - b.start);
  for (const m of chosen) {
    const why = `exact curve of the move at ${m.start.toFixed(2)}–${m.end.toFixed(2)} s (${m.frames} frames)`;
    if (whole(m)) steps.push(step(m.number, `${why}; the whole picture changes here${m.area !== undefined ? ` (${Math.round(m.area * 100)}% of it)` : ""}`, true));
    else steps.push(step(m.number, `${why}${auto ? "; pass a box when several things move" : ""}`));
  }
  if (open.length > chosen.length) notes.push(`${open.length - chosen.length} more moves can be tracked the same way (track with move: n).`);
}

/** Seconds after a screen change at which its new state is read (the change itself may still be animating). */
const SETTLE_SECONDS = 0.5;

/**
 * One moment per screen state for the learn goal: the opening state and each change plus `SETTLE_SECONDS`, within the
 * video. At most `MAX_AT`; with more changes the strongest are kept.
 */
export function learnMoments(boundaries: Boundaries, duration: number): { at: number[]; dropped: number } {
  const kept = [...boundaries.candidates].sort((a, b) => b.score - a.score || a.t - b.t).slice(0, MAX_AT - 1);
  const at = [...new Set([0, ...kept.map((c) => c.t)].map((t) => r2(Math.min(duration, t + SETTLE_SECONDS))))].sort((a, b) => a - b);
  return { at, dropped: boundaries.candidates.length - kept.length };
}

/** Shots between the changes `boundaries` found, from the start to the end of the video. */
export function shotsFromBoundaries(boundaries: Boundaries, duration: number): { start: number; end: number }[] {
  const edges = [0, ...boundaries.candidates.map((c) => c.t).filter((t) => t > 0 && t < duration).sort((a, b) => a - b), duration];
  return edges.slice(1).map((end, i) => ({ start: edges[i]!, end })).filter((s) => s.end > s.start);
}

/** The middle of each shot, one key frame each. At most `MAX_AT`; with more shots the longest are kept. */
export function shotMiddles(shots: { start: number; end: number }[]): { at: number[]; dropped: number } {
  const kept = [...shots].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start).slice(0, MAX_AT);
  const at = [...new Set(kept.map((s) => r2((s.start + s.end) / 2)))].sort((a, b) => a - b);
  return { at, dropped: shots.length - kept.length };
}

export function buildPlan(input: {
  goal?: Goal;
  request?: string;
  probe: ProbeInfo;
  boundaries?: Boundaries;
  hasSpeech: boolean;
  phrase?: string;
  /** Moves from an earlier `style` run, to point `track` at. */
  moves?: PlanMove[];
  /**
   * Results already in the workspace, so a step that needs them gets real numbers instead of a `then`: `boundaries`
   * over the whole video at a rate and threshold, and the shots of an earlier `style` run.
   */
  known?: {
    boundaries?: (rate: number, threshold: number) => Boundaries | undefined;
    shots?: { start: number; end: number }[];
  };
}): Plan {
  const { probe, boundaries, hasSpeech } = input;
  const { type, reasons } = classify(probe, boundaries, hasSpeech);
  const explicit = input.goal ?? inferGoal(input.request);
  const notes: string[] = [];
  let goal = explicit ?? DEFAULT_GOAL[type];
  // Without a picture every frames, boundaries and style step would fail: plan for the sound instead.
  if (!probe.hasVideo && goal !== "listen" && goal !== "sound") {
    if (explicit) notes.push(`This source has no picture, so the ${explicit} goal is planned as ${hasSpeech ? "listen" : "sound"}.`);
    goal = hasSpeech ? "listen" : "sound";
  }
  // Without sound there is no speech and no audio to read: the picture is all there is.
  if (!probe.hasAudio && probe.hasVideo) {
    if (goal === "sound") {
      notes.push("This source has no sound, so the sound goal is planned as style.");
      goal = "style";
    } else notes.push("This source has no sound: there is no transcript or audio to read, only the picture.");
  }
  const still = type === "still" && probe.hasVideo;
  const d = probe.duration;
  const steps: PlanStep[] = [];
  let frames = 0;
  let sheets = 0;
  let imageTokens = 0;
  // Cells as `frames` draws them: 320 px wide (240 from six columns), the picture's own shape, a 56 px label strip.
  const aspect = probe.width && probe.height ? probe.height / probe.width : 9 / 16;
  const addSheets = (n: number, columns = 4, rows = 4) => {
    if (n <= 0) return;
    const per = columns * rows;
    const width = columns >= 6 ? 240 : 320;
    const height = Math.round(width * aspect) + 56;
    frames += n;
    sheets += Math.ceil(n / per);
    imageTokens += Math.floor(n / per) * sheetTokens(per, columns, width, height) + (n % per ? sheetTokens(n % per, columns, width, height) : 0);
  };
  const overviewEvery = Math.max(1, Math.round((d / 24) * 10) / 10);

  if (probe.hasAudio && (goal !== "style" || hasSpeech)) {
    steps.push({ tool: "transcript", args: {}, why: hasSpeech ? "word-timed speech is the backbone of the reading" : "check whether there is speech at all" });
  }
  const overview = (why: string) => {
    steps.push({ tool: "frames", args: { every: overviewEvery, columns: 4, rows: 6 }, why });
    addSheets(Math.min(24, Math.ceil(d / overviewEvery)), 4, 6);
  };

  switch (goal) {
    case "listen":
      if (!probe.hasVideo) break;
      overview("one overview sheet: who is speaking, slides, setting");
      if (probe.hasAudio) notes.push("The transcript carries the content; frames are only context.");
      break;
    case "learn": {
      const changes = input.known?.boundaries?.(2, 0.25);
      const words = probe.hasAudio ? ", with the words spoken there" : "";
      if (changes) {
        // The changes are already in the workspace: the moments can be listed.
        const { at, dropped } = learnMoments(changes, d);
        steps.push({ tool: "frames", args: { at, columns: 4, rows: 4 }, why: `one frame per screen state (the opening and ${SETTLE_SECONDS} s after each of the ${changes.candidates.length} changes boundaries found)${words}` });
        addSheets(at.length);
        if (dropped) notes.push(`${dropped} weaker screen changes are left out (frames takes ${MAX_AT} moments at a time): run frames again for them if they matter.`);
      } else {
        steps.push({ tool: "boundaries", args: { rate: 2, threshold: 0.25 }, why: "find every screen change" });
        steps.push({
          tool: "frames",
          args: { columns: 4, rows: 4 },
          why: `one frame per screen state${words}`,
          then: `add \`at\`: 0.5, then each change time from the boundaries result plus ${SETTLE_SECONDS} s (at most ${MAX_AT}); or call \`plan\` again after boundaries, and this step comes back with the times filled in`,
        });
        addSheets(Math.min(MAX_AT, Math.round(((boundaries?.changesPerMinute ?? 4) * d) / 60) + 1));
      }
      notes.push("Read commands and code from the frames, steps from the words; open a frame at full width when text is small.");
      break;
    }
    case "find":
      if (!probe.hasAudio && probe.hasVideo) {
        // No sound, no words to find the moment by: look through the whole piece instead.
        overview("an overview sheet to find the moment by eye (there are no words to search)");
        break;
      }
      steps.push(
        input.phrase
          ? { tool: "frames", args: { around: input.phrase, fps: 2, columns: 4, rows: 3 }, why: "frames around the place the phrase is spoken" }
          : {
              tool: "frames",
              args: { columns: 4, rows: 3 },
              why: "frames around the place the phrase is spoken",
              then: "add `around`: the words to look for, as they are said (find them in transcript.md), and `fps: 2`; or pass `phrase` to `plan`",
            },
      );
      addSheets(12, 4, 3);
      break;
    case "style": {
      if (still) {
        // One picture: nothing moves, so there are no cuts to find or ranges to sample.
        steps.push({ tool: "frames", args: { at: [0], columns: 1, rows: 1 }, why: "the picture itself" });
        addSheets(1);
        steps.push({ tool: "style", args: {}, why: "palette, STYLE.md and motion-spec.json" });
        break;
      }
      steps.push({ tool: "boundaries", args: { rate: 10, threshold: 0.3 }, why: "every cut and abrupt change, to a tenth of a second" });
      const every = Math.max(0.5, Math.round((d / 120) * 10) / 10);
      steps.push({ tool: "frames", args: { every, columns: 4, rows: 4 }, why: "loupe ×1: the whole piece, its systems and rhythm" });
      addSheets(Math.min(120, Math.ceil(d / every)));
      // The loupe is bounded by the video's length: one to three ×10 passages of about 12 % each, a handful of every-frame windows
      // around the strongest changes, none of them overlapping.
      const budget = loupeBudget(d);
      for (const w of busiestWindows(boundaries, d, Math.min(d, budget.passageSeconds), budget.passages)) {
        steps.push({ tool: "frames", args: { start: w.start, end: w.end, fps: 10, columns: 4, rows: 4 }, why: "loupe ×10: one of the busiest passages" });
        addSheets(Math.ceil((w.end - w.start) * 10));
      }
      const candidates = boundaries?.candidates ?? [];
      const dense = denseWindows(candidates, d, budget.dense);
      const fps = probe.fps ?? probe.nominalFps ?? 30;
      for (const w of dense) {
        const around = w.changes > 1 ? `${w.changes} changes around ${w.peak} s` : `the change at ${w.peak} s`;
        steps.push({ tool: "frames", args: { start: w.start, end: w.end, every_frame: true, columns: 6, rows: 4 }, why: `loupe ×60: every frame of ${around}` });
        addSheets(Math.ceil((w.end - w.start) * fps), 6, 4);
      }
      steps.push({ tool: "style", args: {}, why: "palette, shots, transitions, moves, STYLE.md and motion-spec.json" });
      addTrackSteps(steps, notes, input.moves, type);
      const covered = candidates.filter((c) => dense.some((w) => c.t >= w.start && c.t <= w.end)).length;
      if (candidates.length > covered) notes.push(`${candidates.length - covered} more changes: inspect them the same way (every_frame around them) if they matter.`);
      break;
    }
    case "sound":
      steps.push({ tool: "audio", args: {}, why: "loudness, hits, tempo and beat grid, spectrogram (2.2)" });
      if (probe.hasVideo && !still) steps.push({ tool: "boundaries", args: { rate: 10, threshold: 0.3 }, why: "cuts, to compare with the beat" });
      break;
    case "production": {
      // Shots from an earlier `style` run, else from boundaries already run with this step's settings.
      const known = input.known?.boundaries?.(4, 0.3);
      const shots = input.known?.shots?.length ? input.known.shots : known && shotsFromBoundaries(known, d);
      if (shots) {
        const { at, dropped } = shotMiddles(shots);
        const from = input.known?.shots?.length ? "style" : "boundaries";
        steps.push({ tool: "frames", args: { at, columns: 4, rows: 4 }, why: `one key frame per shot (the middle of each of the ${shots.length} shots ${from} found) for camera, light and source` });
        addSheets(at.length);
        if (dropped) notes.push(`${dropped} shorter shots are left out (frames takes ${MAX_AT} moments at a time): run frames again for them if they matter.`);
      } else {
        steps.push({ tool: "boundaries", args: { rate: 4, threshold: 0.3 }, why: "split into shots" });
        steps.push({
          tool: "frames",
          args: { columns: 4, rows: 4 },
          why: "one key frame per shot for camera, light and source",
          then: `add \`at\`: the middle of each shot, halfway between 0, each change time from the boundaries result and the end (at most ${MAX_AT}); or call \`plan\` again after boundaries, and this step comes back with the times filled in`,
        });
        addSheets(Math.min(MAX_AT, (boundaries?.candidates.length ?? 8) + 1));
      }
      break;
    }
  }

  return { goal, goalInferred: !input.goal, videoType: type, reasons, steps, estimate: { frames, sheets, imageTokens }, notes };
}

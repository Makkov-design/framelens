import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaTools } from "./exec.js";
import type { ExtractedFrame } from "./frames.js";

export interface SheetOptions {
  columns: number;
  rows: number;
  /** Text under each cell, e.g. its time and the words spoken at that moment. */
  label?: (frame: ExtractedFrame) => string;
  /** Cell width in pixels; by default the frames keep their own width. */
  width?: number;
}

export interface Sheet {
  file: string;
  cells: { t: number; label: string }[];
}

/** A font drawtext can use for Latin and Cyrillic labels, or undefined to let fontconfig pick. */
export function findFont(platform = process.platform): string | undefined {
  const candidates =
    platform === "win32"
      ? ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
      : platform === "darwin"
        ? ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]
        : ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"];
  return candidates.find((path) => existsSync(path));
}

/**
 * Escapes a path for an ffmpeg filter option. A filtergraph is unescaped twice, first as the graph (where `[ ] , ;`
 * split filters) and then as one filter's options (where `:` splits options), so each level gets its own
 * backslashes. Single quotes do not survive both levels: an apostrophe in a folder name broke the old form.
 */
export function filterValue(value: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? value.replaceAll("\\", "/") : value;
  return path.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
}

let drawtextSupport: Promise<boolean> | undefined;

/** Whether this ffmpeg build has drawtext (needs libfreetype); sheets fall back to unlabelled cells. */
export function hasDrawtext(tools: MediaTools): Promise<boolean> {
  drawtextSupport ??= tools
    .exec(tools.ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 30_000 })
    .then(({ stdout }) => /\sdrawtext\s/.test(stdout))
    .catch(() => false);
  return drawtextSupport;
}

/** Keeps a label to two short lines. */
export function fitLabel(text: string, perLine = 46): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [""];
  for (const word of words) {
    const current = lines[lines.length - 1]!;
    if ((current + " " + word).trim().length <= perLine) lines[lines.length - 1] = (current + " " + word).trim();
    else if (lines.length < 2) lines.push(word.slice(0, perLine));
    else {
      lines[1] = `${lines[1]!.slice(0, perLine - 1)}…`;
      break;
    }
  }
  return lines.join("\n");
}

/**
 * Arranges frames into contact sheets, `columns × rows` per sheet, each cell with its label underneath so the
 * picture itself stays unobstructed.
 */
export async function buildSheets(
  frames: ExtractedFrame[],
  outDir: string,
  baseName: string,
  options: SheetOptions,
  tools: MediaTools,
): Promise<Sheet[]> {
  mkdirSync(outDir, { recursive: true });
  const perSheet = Math.max(1, options.columns * options.rows);
  const labels = await hasDrawtext(tools);
  const font = findFont();
  const sheets: Sheet[] = [];
  const tmp = join(outDir, `.labels-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    for (let page = 0; page * perSheet < frames.length; page++) {
      const chunk = frames.slice(page * perSheet, (page + 1) * perSheet);
      const cells = chunk.map((frame) => ({ t: frame.t, label: fitLabel(options.label?.(frame) ?? `${frame.t.toFixed(3)} s`) }));
      const file = join(outDir, `${baseName}-${String(page + 1).padStart(2, "0")}.jpg`);
      const inputs = chunk.flatMap((frame) => ["-i", frame.file]);
      const chains = chunk.map((_frame, i) => {
        const parts = [`[${i}:v]scale=${options.width ?? "iw"}:-2`, "pad=iw:ih+56:0:0:color=0x111111"];
        if (labels) {
          const textFile = join(tmp, `${page}-${i}.txt`);
          writeFileSync(textFile, cells[i]!.label, "utf8");
          parts.push(
            `drawtext=textfile=${filterValue(textFile)}${font ? `:fontfile=${filterValue(font)}` : ""}` +
              ":fontsize=17:fontcolor=white:line_spacing=4:x=8:y=h-50",
          );
        }
        return `${parts.join(",")}[c${i}]`;
      });
      const columns = Math.min(options.columns, chunk.length);
      let graph: string;
      if (chunk.length === 1) {
        graph = `${chains[0]!.replace(/\[c0\]$/, "")}`;
      } else {
        // All frames of a request share one width, so cell positions follow from the first cell's size.
        const layout = chunk.map((_f, i) => `${i % columns === 0 ? "0" : Array.from({ length: i % columns }, () => "w0").join("+")}_${
          Math.floor(i / columns) === 0 ? "0" : Array.from({ length: Math.floor(i / columns) }, () => "h0").join("+")
        }`);
        graph = `${chains.join(";")};${chunk.map((_f, i) => `[c${i}]`).join("")}xstack=inputs=${chunk.length}:layout=${layout.join("|")}:fill=0x111111`;
      }
      await tools.exec(tools.ffmpeg, [
        "-hide_banner", "-nostdin", "-v", "error", "-y",
        ...inputs, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", file,
      ]);
      sheets.push({ file, cells });
    }
    return sheets;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

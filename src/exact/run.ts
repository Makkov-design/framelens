import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exportSpec, type ExportTarget } from "../export/exporters.js";
import { Workspace } from "../workspace/workspace.js";
import { fetchFigma, FigmaTokenError, FIGMA_TOKEN_HELP, parseFigma } from "./figma.js";
import { downloadFile, isHttpUrl, type FetchLike } from "./http.js";
import { loadLottieFile, parseLottie } from "./lottie.js";
import { MAX_RIVE_BYTES, parseRive, riveMarkdown, type RiveAnalysis } from "./rive.js";
import { writeExact, type ExactSpec } from "./spec.js";
import type { ExactAnalysis } from "./types.js";
import { oneLine } from "../text.js";

export { FigmaTokenError, FIGMA_TOKEN_HELP };

export interface ExactOptions {
  /** Path or http(s) URL of a Lottie (.json / .lottie) or Rive (.riv) file, or a Figma link. */
  source?: string;
  /** Figma JSON (REST nodes response, or the Figma MCP output) instead of a link. */
  figmaJson?: unknown;
  root: string;
  version: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  exportTarget?: ExportTarget;
}

export interface ExactResult {
  ws: Workspace;
  analysis: ExactAnalysis;
  spec: ExactSpec;
  files: Record<string, string>;
  exported?: { dir: string; files: string[] };
  /** For a .riv source: artboards, animations and state machines behind the analysis. */
  rive?: RiveAnalysis;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const isFigmaUrl = (s: string) => /^https?:\/\/([a-z0-9-]+\.)?figma\.com\//i.test(s);
/**
 * Rive links: a direct .riv file anywhere is read; a rive.app page (editor, community, share) is not a file, and Frame
 * Lens never scrapes pages or signs in, so it says how to get the .riv instead.
 */
const RIV_EXT = /\.riv$/i;

export function riveLink(url: string): boolean {
  const u = new URL(url);
  const isRiv = RIV_EXT.test(u.pathname);
  if (/(^|\.)rive\.app$/i.test(u.hostname) && !isRiv) {
    throw new Error(
      "This rive.app link is a page, not a .riv file. Frame Lens reads .riv files only and does not open Rive pages or sign in: " +
        "download the .riv (in the editor: Export → Download; on a community page: its download button), then pass its path or a direct link to the .riv file.",
    );
  }
  return isRiv;
}

function startsWithRive(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.toString("latin1") === "RIVE";
  } finally {
    closeSync(fd);
  }
}

const looksLottie = (j: unknown): boolean => !!j && typeof j === "object" && Array.isArray((j as { layers?: unknown }).layers) && typeof (j as { fr?: unknown }).fr === "number";

/** Reads exact animation data (Lottie, Rive or Figma), writes motion-spec.json + STYLE.md (+ RIVE.md), optionally a starter project. */
export async function runExact(o: ExactOptions): Promise<ExactResult> {
  const env = o.env ?? process.env;
  let analysis: ExactAnalysis;
  let ws: Workspace;
  let rive: RiveAnalysis | undefined;

  if (o.figmaJson !== undefined) {
    const json = typeof o.figmaJson === "string" ? JSON.parse(o.figmaJson) : o.figmaJson;
    ws = new Workspace(o.root, `figma-${sha(JSON.stringify(json))}`);
    analysis = parseFigma(json, { input: "figma_json" });
  } else if (o.source && isFigmaUrl(o.source)) {
    const { json, fileKey } = await fetchFigma(o.source, env.FIGMA_TOKEN?.trim(), o.fetchImpl);
    ws = new Workspace(o.root, `figma-${sha(`${fileKey}|${o.source}`)}`);
    analysis = parseFigma(json, { input: o.source, url: o.source });
  } else if (o.source) {
    let path: string;
    let url: string | undefined;
    let key: string;
    if (isHttpUrl(o.source)) {
      url = o.source;
      key = sha(url);
      ws = new Workspace(o.root, `${riveLink(url) ? "rive" : "lottie"}-${key}`);
      path = await downloadFile(url, ws.path("source"), o.fetchImpl);
    } else {
      path = resolve(o.source);
      if (!existsSync(path)) throw new Error(`"${o.source}" is not a file on this computer.`);
      const st = statSync(path);
      key = sha(`${path}|${st.size}|${st.mtimeMs}`);
      ws = new Workspace(o.root, `${RIV_EXT.test(path) ? "rive" : "lottie"}-${key}`);
    }
    if (statSync(path).isFile() && startsWithRive(path)) {
      if (!ws.id.startsWith("rive-")) {
        // An extensionless link that turned out to be Rive: move the download under a rive workspace.
        const old = ws;
        ws = new Workspace(o.root, `rive-${key}`);
        if (url) {
          const dest = join(ws.ensure("source"), basename(path));
          renameSync(path, dest);
          for (const dir of [dirname(path), old.dir]) {
            try {
              if (!readdirSync(dir).length) rmdirSync(dir);
            } catch {
              // Not empty or already gone: leave it.
            }
          }
          path = dest;
        }
      }
      if (statSync(path).size > MAX_RIVE_BYTES) throw new Error(`This .riv file is larger than ${MAX_RIVE_BYTES / 1024 / 1024} MB.`);
      rive = parseRive(readFileSync(path), { input: o.source, ...(url && { url }), title: basename(path).replace(RIV_EXT, "") });
      analysis = rive.analysis;
    } else {
      if (ws.id.startsWith("rive-")) throw new Error(`"${oneLine(o.source, 200)}" is not a Rive file: a .riv file starts with the letters RIVE.`);
      const loaded = loadLottieFile(path);
      if (looksLottie(loaded.json)) {
        analysis = parseLottie(loaded.json, { input: o.source, ...(url && { url }), ...(loaded.fontsFromZip.length && { fontFiles: loaded.fontsFromZip }) });
      } else {
        // A saved Figma response: re-home it under a figma workspace.
        ws = new Workspace(o.root, `figma-${sha(readFileSync(path, "utf8"))}`);
        analysis = parseFigma(loaded.json, { input: o.source });
      }
    }
  } else {
    throw new Error("Pass `source` (a Lottie or Rive file or link, or a Figma link) or `figma_json`.");
  }

  analysis = cleanAnalysis(analysis);
  const { spec, files } = writeExact(ws, analysis, o.version);
  if (rive) {
    rive = { ...rive, analysis };
    (files as Record<string, string>).rive = ws.writeText("RIVE.md", riveMarkdown(rive));
  }
  let exported: ExactResult["exported"];
  if (o.exportTarget) {
    const dir = ws.ensure("export", o.exportTarget);
    exported = { dir, files: exportSpec(spec, o.exportTarget, dir, { workspace: ws.dir }) };
  }
  return { ws, analysis, spec, files, ...(exported && { exported }), ...(rive && { rive }) };
}

/**
 * Names in a Lottie or Figma file (layers, nodes, fonts, texts) are the author's free text and land in STYLE.md, the
 * tool's summary and starter files: one short line each.
 */
export function cleanAnalysis(a: ExactAnalysis): ExactAnalysis {
  const t = (v: unknown, max = 160) => oneLine(v, max);
  return {
    ...a,
    title: t(a.title, 200),
    shots: a.shots.map((s) => ({ ...s, name: t(s.name) })),
    moves: a.moves.map((m) => ({ ...m, target: t(m.target, 240), property: t(m.property, 60), type: t(m.type, 60), curve: t(m.curve, 120), from: m.from.map((v) => (typeof v === "string" ? t(v, 60) : v)), to: m.to.map((v) => (typeof v === "string" ? t(v, 60) : v)), ...(m.trigger !== undefined && { trigger: t(m.trigger, 60) }) })),
    texts: a.texts.map((x) => ({ ...x, text: t(x.text, 200), where: t(x.where, 240), ...(x.family !== undefined && { family: t(x.family, 120) }), ...(x.case !== undefined && { case: t(x.case, 20) }) })),
    fonts: a.fonts.map((f) => t(f, 120)),
    unknowns: a.unknowns.map((u) => t(u, 240)),
  };
}

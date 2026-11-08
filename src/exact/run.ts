import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { exportSpec, type ExportTarget } from "../export/exporters.js";
import { Workspace } from "../workspace/workspace.js";
import { fetchFigma, FigmaTokenError, FIGMA_TOKEN_HELP, parseFigma } from "./figma.js";
import { downloadFile, isHttpUrl, type FetchLike } from "./http.js";
import { loadLottieFile, parseLottie } from "./lottie.js";
import { writeExact, type ExactSpec } from "./spec.js";
import type { ExactAnalysis } from "./types.js";
import { oneLine } from "../text.js";

export { FigmaTokenError, FIGMA_TOKEN_HELP };

export interface ExactOptions {
  /** Path or http(s) URL of a Lottie (.json / .lottie) or a Figma link. */
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
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const isFigmaUrl = (s: string) => /^https?:\/\/([a-z0-9-]+\.)?figma\.com\//i.test(s);
const looksLottie = (j: unknown): boolean => !!j && typeof j === "object" && Array.isArray((j as { layers?: unknown }).layers) && typeof (j as { fr?: unknown }).fr === "number";

/** Reads exact animation data (Lottie or Figma), writes motion-spec.json + STYLE.md, optionally a starter project. */
export async function runExact(o: ExactOptions): Promise<ExactResult> {
  const env = o.env ?? process.env;
  let analysis: ExactAnalysis;
  let ws: Workspace;

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
    if (isHttpUrl(o.source)) {
      url = o.source;
      ws = new Workspace(o.root, `lottie-${sha(url)}`);
      path = await downloadFile(url, ws.path("source"), o.fetchImpl);
    } else {
      path = resolve(o.source);
      if (!existsSync(path)) throw new Error(`"${o.source}" is not a file on this computer.`);
      const st = statSync(path);
      ws = new Workspace(o.root, `lottie-${sha(`${path}|${st.size}|${st.mtimeMs}`)}`);
    }
    const loaded = loadLottieFile(path);
    if (looksLottie(loaded.json)) {
      analysis = parseLottie(loaded.json, { input: o.source, ...(url && { url }), ...(loaded.fontsFromZip.length && { fontFiles: loaded.fontsFromZip }) });
    } else {
      // A saved Figma response: re-home it under a figma workspace.
      ws = new Workspace(o.root, `figma-${sha(readFileSync(path, "utf8"))}`);
      analysis = parseFigma(loaded.json, { input: o.source });
    }
  } else {
    throw new Error("Pass `source` (a Lottie file or link, or a Figma link) or `figma_json`.");
  }

  analysis = cleanAnalysis(analysis);
  const { spec, files } = writeExact(ws, analysis, o.version);
  let exported: ExactResult["exported"];
  if (o.exportTarget) {
    const dir = ws.ensure("export", o.exportTarget);
    exported = { dir, files: exportSpec(spec, o.exportTarget, dir, { workspace: ws.dir }) };
  }
  return { ws, analysis, spec, files, ...(exported && { exported }) };
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

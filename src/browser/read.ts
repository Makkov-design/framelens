import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "../media/exec.js";
import { buildSheets, type Sheet } from "../media/sheets.js";
import { evaluate, findBrowser, launchBrowser, navigate, screenshot } from "./cdp.js";
import { mergeReadings, PAGE_SCRIPT, type PageReading } from "./web.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PageResult {
  reading: PageReading;
  /** Screenshots down the page. */
  views: string[];
  /** The opening animations frame by frame (all page animations paused and stepped together). */
  sheet?: Sheet;
}

/**
 * Opens a page in a throwaway headless profile, reads its animations at the top and while scrolling, takes views
 * down the page, then pauses every animation and steps it in time to film the opening motion frame by frame.
 */
export async function readPage(url: string, outDir: string, tools: MediaTools, options: { maxScroll?: number; stepSeconds?: number } = {}): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) throw new InvalidInputError(`"${url}" is not a web page address (http or https).`);
  const executable = findBrowser();
  if (!executable) throw new InvalidInputError("Reading web pages needs Chrome or Edge on this computer (or FRAMELENS_BROWSER pointing to one).");
  const profile = mkdtempSync(join(tmpdir(), "framelens-page-"));
  const session = await launchBrowser({ executable, profile, headless: true, width: 1440, height: 900, maxLifetimeMs: 3 * 60_000 });
  try {
    await session.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, session.sessionId);
    await navigate(session, url);
    await wait(1200);
    const readings: PageReading[] = [await evaluate<PageReading>(session, PAGE_SCRIPT)];
    const first = readings[0]!;
    const maxScroll = Math.min(first.scrollHeight - first.viewport.height, options.maxScroll ?? 12_000);
    const views: string[] = [];
    const take = async (name: string) => {
      const file = join(outDir, `${name}.png`);
      writeFileSync(file, await screenshot(session));
      views.push(file);
    };
    await take("view-0000");
    // Half a screen at a time, always ending exactly at the bottom so the last section is read too.
    const stops: number[] = [];
    for (let y = 450; y < maxScroll; y += 450) stops.push(y);
    if (maxScroll > 0) stops.push(maxScroll);
    for (const [i, y] of stops.entries()) {
      await evaluate(session, `window.scrollTo(0, ${y})`);
      await wait(350);
      readings.push(await evaluate<PageReading>(session, PAGE_SCRIPT));
      if (i % 4 === 3 || i === stops.length - 1) await take(`view-${String(y).padStart(5, "0")}`);
    }
    await evaluate(session, "window.scrollTo(0, 0)");
    await wait(300);

    // Film the opening: pause every animation, step them together, screenshot each step.
    const step = options.stepSeconds ?? 1 / 20;
    const longest = await evaluate<number>(
      session,
      `Math.min(4000, Math.max(0, ...document.getAnimations().map((a) => { const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}; return Number.isFinite(t.endTime) ? t.endTime : 0; })))`,
    );
    const frames: { t: number; file: string }[] = [];
    if (longest > 0) {
      for (let t = 0; t <= longest / 1000 + 1e-9 && frames.length < 48; t += step) {
        await evaluate(session, `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${Math.round(t * 1000)}; })`);
        await wait(40);
        const file = join(outDir, `motion-${t.toFixed(3).padStart(8, "0")}.png`);
        writeFileSync(file, await screenshot(session));
        frames.push({ t: Math.round(t * 1000) / 1000, file });
      }
    }
    const sheet = frames.length
      ? (await buildSheets(frames, outDir, "opening", { columns: 4, rows: Math.min(6, Math.ceil(frames.length / 4)), width: 480, label: (f) => `${f.t.toFixed(2)} s` }, tools))[0]
      : undefined;
    return { reading: mergeReadings(readings), views, ...(sheet && { sheet }) };
  } finally {
    await session.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

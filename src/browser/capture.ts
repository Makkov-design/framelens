import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";
import type { MediaTools } from "../media/exec.js";
import { evaluate, findBrowser, launchBrowser, navigate, profileDir } from "./cdp.js";

/** Login pages for `framelens login <site>`. */
export const LOGIN_PAGES: Record<string, string> = {
  instagram: "https://www.instagram.com/accounts/login/",
  facebook: "https://www.facebook.com/login/",
  x: "https://x.com/i/flow/login",
  twitter: "https://x.com/i/flow/login",
  threads: "https://www.threads.net/login",
  linkedin: "https://www.linkedin.com/login",
  vimeo: "https://vimeo.com/log_in",
  tiktok: "https://www.tiktok.com/login",
};

export interface MediaCandidate {
  url: string;
  mimeType: string;
  length: number;
}

/**
 * Picks the media the page played: the largest video stream and, when the platform serves sound separately (DASH),
 * the largest audio stream. Byte-range parameters are dropped so the whole file is fetched, not one segment.
 */
export function chooseMedia(candidates: MediaCandidate[]): { video?: MediaCandidate; audio?: MediaCandidate } {
  const whole = candidates.map((c) => ({ ...c, url: c.url.replace(/[?&](bytestart|byteend)=\d+/g, "").replace(/\?&/, "?") }));
  const unique = [...new Map(whole.map((c) => [c.url, c])).values()];
  const video = unique.filter((c) => c.mimeType.startsWith("video/") && !/\.m3u8/i.test(c.url)).sort((a, b) => b.length - a.length)[0];
  const audio = unique.filter((c) => c.mimeType.startsWith("audio/")).sort((a, b) => b.length - a.length)[0];
  return { ...(video && { video }), ...(audio && { audio }) };
}

/** Downloads a URL to a file (following redirects), stopping at `maxBytes`. */
export function download(url: string, file: string, maxBytes: number, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    // Plain http only for a page on this computer (tests, local previews); everything remote goes over https.
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    if (!local && !url.startsWith("https://")) {
      reject(new Error("Only https media links are downloaded."));
      return;
    }
    const get = local ? httpGet : httpsGet;
    const req = get(url, { headers: { "user-agent": "Mozilla/5.0 (framelens)" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        download(new URL(res.headers.location, url).toString(), file, maxBytes, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`The media server answered ${res.statusCode}.`));
        return;
      }
      let size = 0;
      const out = createWriteStream(file);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("The video is larger than FRAMELENS_MAX_DOWNLOAD_MB."));
          out.destroy();
        }
      });
      res.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("The media download timed out.")));
  });
}

/** Opens a visible browser with the Frame Lens profile on the site's login page and waits until the user closes it. */
export async function login(site: string, write: (line: string) => void): Promise<void> {
  const page = LOGIN_PAGES[site.toLowerCase()];
  if (!page) throw new InvalidInputError(`Unknown site "${site}". Choose one of: ${Object.keys(LOGIN_PAGES).join(", ")}.`);
  const executable = findBrowser();
  if (!executable) throw new InvalidInputError("framelens login needs Chrome or Edge on this computer.");
  const profile = profileDir();
  write(
    `A browser window opens with a separate Frame Lens profile (${profile}).\n` +
      "Log in there yourself, ideally with a second account, then close the window. Your login stays only on this computer;\n" +
      "`framelens logout` deletes it.\n",
  );
  const session = await launchBrowser({ executable, profile, headless: false, width: 1200, height: 900, maxLifetimeMs: 30 * 60_000 });
  try {
    await navigate(session, page, 60_000).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        try {
          await session.cdp.send("Browser.getVersion", {}, undefined, 2_000);
        } catch {
          clearInterval(timer);
          resolve();
        }
      }, 1_000);
    });
  } finally {
    await session.close();
  }
  write("Saved. Links that need this login now open through the Frame Lens profile.\n");
}

export function logout(): boolean {
  const profile = profileDir();
  if (!existsSync(profile)) return false;
  rmSync(profile, { recursive: true, force: true });
  return true;
}

export function hasLoginProfile(): boolean {
  return existsSync(join(profileDir(), "Default"));
}

/**
 * Plays a post in the Frame Lens profile (where the user logged in) and saves the media the page itself loaded:
 * the same file the user would watch, fetched once, at their request. Separate sound is merged with ffmpeg.
 */
export async function captureVideo(url: string, outDir: string, tools: MediaTools, maxBytes: number): Promise<string> {
  const executable = findBrowser();
  if (!executable) throw new InvalidInputError("Capturing needs Chrome or Edge on this computer.");
  mkdirSync(outDir, { recursive: true });
  const session = await launchBrowser({ executable, profile: profileDir(), headless: true, width: 1280, height: 900, maxLifetimeMs: 2 * 60_000 });
  const candidates: MediaCandidate[] = [];
  try {
    await session.cdp.send("Network.enable", {}, session.sessionId);
    session.cdp.on("Network.responseReceived", (params, sid) => {
      if (sid !== session.sessionId) return;
      const response = params.response as { url: string; mimeType: string; headers: Record<string, string> };
      const isMedia = /^(video|audio)\//.test(response.mimeType) || /\.(mp4|m4s|m4a|webm)(\?|$)/i.test(response.url);
      if (!isMedia || response.url.startsWith("blob:")) return;
      const length = Number(response.headers["content-length"] ?? response.headers["Content-Length"] ?? 0);
      const mimeType = response.mimeType.startsWith("audio/") || /audio/i.test(response.url) ? "audio/mp4" : response.mimeType.startsWith("video/") ? response.mimeType : "video/mp4";
      candidates.push({ url: response.url, mimeType, length });
    });
    await navigate(session, url, 45_000);
    await new Promise((r) => setTimeout(r, 2_500));
    await evaluate(session, `(() => { const v = document.querySelector("video"); if (v) { v.muted = true; v.play().catch(() => {}); } return Boolean(v); })()`).catch(() => false);
    await new Promise((r) => setTimeout(r, 6_000));
  } finally {
    await session.close();
  }

  const { video, audio } = chooseMedia(candidates);
  if (!video) {
    throw new InvalidInputError(
      "The page did not load a video file Frame Lens can save (it may need a login in the Frame Lens profile: run `framelens login <site>`). " +
        "Otherwise save the video with the platform's own download button or a screen recording, and give the file.",
    );
  }
  const videoFile = join(outDir, "captured-video.mp4");
  await download(video.url, videoFile, maxBytes);
  const out = join(outDir, "source.mp4");
  if (audio) {
    const audioFile = join(outDir, "captured-audio.m4a");
    await download(audio.url, audioFile, maxBytes);
    await tools.exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", videoFile, "-i", audioFile, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", out]);
    rmSync(audioFile, { force: true });
  } else {
    await tools.exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", videoFile, "-c", "copy", out]);
  }
  rmSync(videoFile, { force: true });
  if (!statSync(out).size) throw new InvalidInputError("The captured video is empty.");
  return out;
}

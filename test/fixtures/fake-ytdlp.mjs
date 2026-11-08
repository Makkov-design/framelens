// A stand-in for yt-dlp used by the tests. FAKE_YTDLP_MODE picks the behaviour; FAKE_YTDLP_LOG collects the arguments.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_YTDLP_MODE ?? "ok";
if (process.env.FAKE_YTDLP_LOG) appendFileSync(process.env.FAKE_YTDLP_LOG, `${JSON.stringify(args)}\n`);

if (args.includes("--version") || args.includes("-version")) {
  console.log(args.includes("-version") ? "ffmpeg version 0.0-fake Copyright" : "0.0.0-fake");
  process.exit(0);
}

const fail = (text) => {
  console.error(text);
  process.exit(1);
};
if (mode === "login") fail("ERROR: [Instagram] Cx1: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser or --cookies");
if (mode === "bot") fail("ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies");
if (mode === "private") fail("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video");
if (mode === "geo") fail("ERROR: [youtube] abc: The uploader has not made this video available in your country");
if (mode === "unsupported") fail("ERROR: Unsupported URL: https://example.com/page");
if (mode === "limited") fail("ERROR: unable to download video data: HTTP Error 429: Too Many Requests");

if (args.includes("--dump-single-json")) {
  const size = mode === "huge" ? 5 * 1024 * 1024 * 1024 : 1000;
  console.log(
    JSON.stringify({
      title: "Fake video",
      webpage_url: "https://example.com/watch/1",
      language: "en",
      subtitles: mode === "manual-subs" ? { en: [{}] } : {},
      automatic_captions: { "en-orig": [{}], en: [{}], de: [{}], fr: [{}] },
      requested_formats: [{ filesize: size }, { filesize: 10 }],
    }),
  );
  process.exit(0);
}

const template = args[args.indexOf("-o") + 1];
const base = template.replace("%(ext)s", "");
mkdirSync(dirname(template), { recursive: true });
if (mode !== "nofile") writeFileSync(`${base}mp4`, "fake-video");
const langs = args.includes("--sub-langs") ? args[args.indexOf("--sub-langs") + 1].split(",") : [];
for (const lang of langs) writeFileSync(`${base}${lang}.json3`, "{}");
process.exit(0);

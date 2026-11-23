// A stand-in for yt-dlp used by the tests. FAKE_YTDLP_MODE picks the behaviour; FAKE_YTDLP_LOG collects the arguments.
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_YTDLP_MODE ?? "ok";
if (process.env.FAKE_YTDLP_LOG) appendFileSync(process.env.FAKE_YTDLP_LOG, `${JSON.stringify(args)}\n`);
// FAKE_YTDLP_PIDS: each run appends its process id, so a test can check it was stopped.
if (process.env.FAKE_YTDLP_PIDS) appendFileSync(process.env.FAKE_YTDLP_PIDS, `${process.pid}\n`);

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
      // "stream": an HLS stream of unknown size, as live and some VOD playlists are: no filesize at all.
      ...(mode === "stream" ? { protocol: "m3u8_native" } : { requested_formats: [{ filesize: size }, { filesize: 10 }] }),
    }),
  );
  process.exit(0);
}

const template = args[args.indexOf("-o") + 1];
const base = template.replace("%(ext)s", "");
mkdirSync(dirname(template), { recursive: true });
// FAKE_YTDLP_DELAY_MS: a download that takes a while, with its partial file on disk meanwhile (concurrency, cancel).
const delay = Number(process.env.FAKE_YTDLP_DELAY_MS ?? 0);
if (delay) {
  writeFileSync(`${base}mp4.part`, "partial");
  await new Promise((done) => setTimeout(done, delay));
}
// "stream": keeps appending fragments (1 MB every 50 ms) until it is stopped, like a long HLS download.
// "stream-temp-id": the same, under a format id the site chose to contain ".temp." (a DASH Representation@id).
if (mode === "stream" || mode === "stream-temp-id") {
  const chunk = Buffer.alloc(1024 * 1024);
  const part = mode === "stream" ? `${base}mp4.part` : `${base}fv.temp.1.mp4.part`;
  for (let i = 0; i < 600; i++) {
    appendFileSync(part, chunk);
    await new Promise((done) => setTimeout(done, 50));
  }
}
// "merge": separate video and audio (2 + 1 MB), then the merger's temporary output (3 MB) next to them for a while,
// then, as yt-dlp's FFmpegMergerPP does, the output renamed to its final name while the inputs are still there, and
// only then the inputs removed. Each state is held long enough for the size watch to see it.
if (mode === "merge") {
  writeFileSync(`${base}f1.mp4`, Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(`${base}f2.m4a`, Buffer.alloc(1024 * 1024));
  writeFileSync(`${base}temp.mp4`, Buffer.alloc(3 * 1024 * 1024));
  await new Promise((done) => setTimeout(done, 1000));
  renameSync(`${base}temp.mp4`, `${base}mp4`);
  await new Promise((done) => setTimeout(done, 1000));
  rmSync(`${base}f1.mp4`);
  rmSync(`${base}f2.m4a`);
  process.exit(0);
}
if (mode === "fail-download") fail("ERROR: unable to download video data: HTTP Error 500: Internal Server Error");
if (mode !== "nofile") writeFileSync(`${base}mp4`, "fake-video");
const langs = args.includes("--sub-langs") ? args[args.indexOf("--sub-langs") + 1].split(",") : [];
for (const lang of langs) writeFileSync(`${base}${lang}.json3`, "{}");
process.exit(0);

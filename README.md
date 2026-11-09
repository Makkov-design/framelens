# Frame Lens

**Eyes and ears for AI agents.** Give your agent any video or animation (a YouTube link, a TikTok, a screen recording,
a GIF, a file) and a goal in plain words. Frame Lens picks the right way to look at it and returns **measurements,
not retellings**: word-timed transcripts, frames with their real timestamps, cuts to the frame, palettes, the duration
and easing of every move, tempo and beats, and a machine-readable motion spec that starts a project in HyperFrames,
Remotion or CSS.

It is an [MCP](https://modelcontextprotocol.io) server for Claude Code, Claude Desktop, Cursor, Codex and any other MCP
client. The core is free, runs on your computer and needs no API key.

[![npm](https://img.shields.io/npm/v/framelens)](https://www.npmjs.com/package/framelens)
[![CI](https://github.com/Makkov-design/framelens/actions/workflows/ci.yml/badge.svg)](https://github.com/Makkov-design/framelens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What you can ask

| You want | Say something like | Frame Lens does |
|---|---|---|
| **Listen**: a podcast, lecture, interview | "Summarize this 3-hour podcast and find where they talk about pricing" | Word-timed transcript, one overview sheet; no wasted frames |
| **Learn**: a tutorial into steps | "Turn this tutorial into a step-by-step guide" | Finds every screen change, frames with the words spoken there, text read from the screen |
| **Find** a moment | "Where does he set up DNS?" | Frames around the phrase in the transcript |
| **Style**: replicate the motion | "Use this as a reference for my product promo" | Cuts to the frame, shots, OKLab palette, every move with its duration and easing family, `STYLE.md` and `motion-spec.json`, then a starter project and a check of your render |
| **Sound** design | "What is the sound design here?" | Loudness, silences, hits, tempo and beat grid, how many cuts land on the beat, a spectrogram picture |
| **Production** | "How was this shot?" | Shots with key frames for camera, light and source |
| **A website's motion** | "Make my landing animate like this site" | The page's real animation curves, durations, fonts and colours, then a CSS or Motion starter |
| **A Lottie or Figma prototype** | "Rebuild this Lottie in Remotion" | Exact keyframes and curves from the file, then a starter in any target |

Start with `plan`: it classifies the video (talking head, screen, motion graphics, music video, live action), reads
the goal from the request and lists the steps with an estimate of how many image tokens they cost.

## Tools

**Local, measured** (needs ffmpeg, and yt-dlp for links; when either is missing, Frame Lens downloads a pinned,
checksum-verified build on first use and says so):

| Tool | What it does |
|---|---|
| `probe` | Fetches the source if needed; duration, size, frame rate (variable or not), HDR, audio, captions, workspace folder |
| `plan` | Goal-based plan: which passes, how dense, which ranges, image-token estimate |
| `transcript` | Word-timed transcript from captions (Gemini as a fallback for YouTube) |
| `frames` | Frames and contact sheets with time, frame number and spoken words under each picture. `at`, `every`, `fps`, `every_frame` (real timestamps, for transitions), or `around` a phrase |
| `boundaries` | Where the picture changes abruptly, scored, plus how dynamic the video is |
| `style` | Cuts told apart from fast motion and flashes, shots with palettes, moves with their easing family; writes `motion-spec.json`, `STYLE.md`, `TIMELINE.md`, `ANALYSIS.md` |
| `audio` | Loudness (LUFS), silences, onsets, tempo and beats, cuts on the beat, spectrogram |
| `export` | Starter project from the motion spec for `hyperframes`, `remotion`, `css`, `after-effects` (ExtendScript), `lottie`, or a `hypit` handoff: structure, timing, colours and eases carried over, content left to you |
| `compare` | Your render against the reference: duration, cuts matched within 3 frames, palette distance, picture similarity, worst moments side by side |
| `web` | A live page's animations read exactly from the browser (CSS, Web Animations, Motion, GSAP): target, delay, duration, curve, keyframes, scroll-triggered ones too, plus real fonts and colours (needs Chrome or Edge and Node 22+). Also takes a reading the [browser extension](#browser-extension) saved: `inbox` or its path |
| `exact` | Lottie / dotLottie and Rive (`.riv`: artboards, timelines, curves, state machines in `RIVE.md`) keyframes and curves, and Figma prototype transitions (`FIGMA_TOKEN`, or the Figma MCP's motion context), read from the source's own data |

**Gemini** (YouTube links, needs `GEMINI_API_KEY`, works in cloud sessions without ffmpeg):
`summarize_youtube_video`, `ask_about_youtube_video`, `extract_key_moments`, `get_video_transcript`,
`list_supported_models`.

Everything a local tool produces is written to a workspace folder (`.framelens/<id>/` in the current directory), so
results stay small, can be reopened by path, and a later session can continue from `PROGRESS.md`. When the server is
started in a system folder (Claude Desktop on Windows starts it in `C:\WINDOWS\system32`, on macOS in `/`) or in a
folder it cannot write to, the workspace moves to `~/.framelens/`; `FRAMELENS_WORKSPACE` overrides both. Every path
in a tool result is absolute, and `framelens doctor` says which folder is in use and why.

## How it looks at a video: the loupe

Ten frames per second over a ten-minute video is 6,000 frames and about 450,000 image tokens. Frame Lens never does
that. It works like a loupe:

1. **×1 overview**: a sheet of the whole piece, its rhythm and recurring elements.
2. **×10 passage**: 10 frames per second over the 5–20 seconds that matter.
3. **×60 transition**: every native frame ±0.5 s around each move, because a typical transition lasts 6–12 frames
   and sheets a second apart miss 1–3-frame timing.

Frame times are the real times of the frames shown: sampling keeps the first frame at or after each point (ffmpeg's
`fps` filter would keep the last one, up to half an interval late), and `every_frame` reads timestamps from the
stream, so variable-frame-rate screen recordings stay exact.

Every number in `motion-spec.json` says how it was obtained: `measured` (from pixels, audio or the source's data),
`derived` (fitted from measurements, such as an easing family) or `inferred` (a model's judgement, such as a font
guess).

**How accurate?** On ground-truth videos (known cuts, moves of 8–30 frames with known easing, at 24, 30 and 60 fps)
Frame Lens finds every cut on its exact frame, every move, and the right easing family for each, with a mean move
start error of about one frame: see [docs/ACCURACY.md](docs/ACCURACY.md) and run `node scripts/benchmark.mjs`
yourself. Web pages, Lottie and Figma need no estimate: their curves are read from the source.

## Install

You need **Node.js 20+**. The local tools use **ffmpeg**, and links use **yt-dlp**: an ffmpeg you installed yourself
(Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`; Linux: your package manager) is used first, and
when one of them is missing Frame Lens sets it up by itself (see [Automatic setup](#automatic-setup)). Check what you
have:

```bash
npx -y framelens@2.0.0 doctor
```

`doctor --prepare` downloads the pinned, checksum-verified yt-dlp, and ffmpeg when it is missing, right away.

### Automatic setup

When a local tool needs ffmpeg/ffprobe or yt-dlp and cannot find it, Frame Lens downloads a pinned build into
`~/.framelens/tools/`, checks its SHA-256 against the hash recorded in the code, continues, and adds a line to the
tool result saying what it did. Nothing that fails the check is kept. `FRAMELENS_AUTO_INSTALL=0` turns this off.

| Tool | Version | Windows x64 | macOS arm64 and x64, Linux x64 (glibc) |
|---|---|---|---|
| ffmpeg, ffprobe | FFmpeg 9.0.2 | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) essentials build ([GitHub release](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)) | [Martin Riedl's build server](https://ffmpeg.martin-riedl.de/) |
| yt-dlp | 2026.10.21 | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21) | same, also checked against the release's SHA2-256SUMS |

Gyan Doshi's Windows builds are the ones ffmpeg.org's download page links; Martin Riedl's build server has published
release builds with a SHA-256 for each file since 2022 and keeps the old ones, so a pinned address keeps working.
Other platforms (Alpine and other musl systems, Linux on ARM, Windows on ARM) install ffmpeg from their own packages.

### Browser extension

For pages and posts behind your own login, the Frame Lens extension for Chrome and Edge works in your browser:
**Read this page's motion** saves what the `web` tool would read (animations, curves, fonts, colours, a scroll pass),
and **Record this tab** saves a WebM of what you watch. Both land in `Downloads/FrameLens`, where the `inbox` source
finds them: `web` with `inbox` for a reading, any video tool with `inbox` for a recording. It needs no network access
and no host permissions. Install it with Load unpacked: [extension/README.md](extension/README.md).

### Claude Code, every project on your computer

```bash
claude mcp add framelens --scope user -- npx -y framelens@2.0.0
```

On Windows, put `cmd /c` before `npx`. Add `--env GEMINI_API_KEY=<key>` to enable the Gemini tools. Or install the
plugin, which also brings the skill:

```text
/plugin install framelens --marketplace Makkov-design/framelens
```

### One project, including Claude Code cloud sessions

Run in the project's root folder (or ask Claude Code to run it and commit the result):

```bash
npx -y framelens@2.0.0 init
```

It adds `.mcp.json` with the server and `.claude/skills/framelens/SKILL.md`, and replaces an old `ytlens` entry. In
cloud sessions, which have no ffmpeg by default, the Gemini tools do the work: add `GEMINI_API_KEY` to the cloud
environment's variables and start a new session.

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "framelens": {
      "command": "npx",
      "args": ["-y", "framelens@2.0.0"],
      "env": { "GEMINI_API_KEY": "<optional, for the Gemini tools>" }
    }
  }
}
```

Pin the version so a new release never runs without you choosing it. Without npm the same works from GitHub:
`npx -y github:Makkov-design/framelens#v2.0.0`.

## Sources

| Source | How |
|---|---|
| YouTube, TikTok, Loom, Twitch, Google Drive, Dropbox, direct media links and hundreds of other sites | Public links through the pinned yt-dlp |
| Local files: mp4, mov (ProRes), webm, mkv, GIF, APNG | A path |
| Your phone or a platform's own download button | Put the file in the inbox folder (`FRAMELENS_INBOX`) and use the source `inbox` |
| Sites that ask you to log in (Instagram, Facebook, X, Threads, Vimeo) | Your own access only, in this order: save the video with the platform's own download button or a screen recording and give the file; opt in to your browser's cookies with `FRAMELENS_COOKIES_FROM_BROWSER=firefox` or `FRAMELENS_COOKIES_FILE=<cookies.txt>` (Chrome and Edge on Windows encrypt cookies so they cannot be used); or run `npx framelens login instagram` once: a browser window with a separate Frame Lens profile opens, you log in yourself (a second account is wiser), and links that need the login are then played there and saved. `framelens logout` deletes that profile |
| A video or a page you see while logged in | The [browser extension](#browser-extension): record the tab, or read the page's motion, then `inbox` |
| Public links yt-dlp has no extractor for, with your own [cobalt](https://github.com/imputnet/cobalt) server | Opt in with `FRAMELENS_COBALT_URL` (below) |
| A live website | `web` with its address |
| Lottie, dotLottie, Rive `.riv`, Figma | `exact` with the file, link or Figma URL (a direct `.riv` link; rive.app pages are not read) |

Frame Lens never bypasses logins, CAPTCHAs or bot checks, never uses online downloader sites or scraping services,
and downloads one video at a time at your request. Platforms' terms may forbid automated downloading, and a platform
can restrict an account it sees doing it: analyze videos you are allowed to watch and use, for reference.

**Self-hosted cobalt (opt-in).** This is meant for a [cobalt](https://github.com/imputnet/cobalt) instance you run
yourself: set `FRAMELENS_COBALT_URL` to its API address (and `FRAMELENS_COBALT_KEY` to an API key if it asks for
one). A link then goes to it only when yt-dlp has no extractor for it ("Unsupported URL"), or fails for a reason that
is clearly not access control. A failure that mentions a login or sign-in, an age check, a bot check or challenge, a
block, a rate limit, a private, members-only or paid post, or HTTP 401, 403 or 429, is never sent to cobalt: those
stay with you (the extension, your own cookies or `framelens login`). The media comes through your instance only,
and a redirect to this computer or the local network is refused. Nothing changes when it is unset. Frame Lens cannot
tell someone else's public instance from yours; it only refuses the official cobalt.tools hosts by name, which are not
for other projects.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FRAMELENS_WORKSPACE` | `./.framelens`, or `~/.framelens` from a system or read-only folder | Where workspaces go (a relative path is taken from the home folder) |
| `FRAMELENS_INBOX` | — | Folder for the source `inbox`: the newest video or page reading there or in Downloads/FrameLens |
| `FRAMELENS_DOWNLOADS` | `~/Downloads` | The browser's download folder, where the extension saves into `FrameLens/` |
| `FRAMELENS_AUTO_INSTALL` | on | `0` stops Frame Lens from downloading a missing ffmpeg or yt-dlp |
| `FRAMELENS_COBALT_URL`, `FRAMELENS_COBALT_KEY` | — | Your own cobalt instance for public links yt-dlp has no extractor for, and its API key |
| `FRAMELENS_FFMPEG`, `FRAMELENS_FFPROBE`, `FRAMELENS_YTDLP` | found automatically | Paths to the tools |
| `FRAMELENS_MAX_DOWNLOAD_MB` | `2048` | Largest download |
| `FRAMELENS_COOKIES_FROM_BROWSER`, `FRAMELENS_COOKIES_FILE` | — | Opt-in cookies for sites that need your login |
| `FRAMELENS_BROWSER`, `FRAMELENS_BROWSER_PROFILE` | found automatically, `~/.framelens/browser-profile` | Chrome or Edge for `web` and `login`, and where the login profile lives |
| `FIGMA_TOKEN` | — | A read-only Figma personal access token for `exact` on Figma links |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | — | Enables the Gemini tools |
| `GEMINI_MODEL_NAME` | `gemini-flash-lite-latest` | Flash-Lite has the largest free daily quota |
| `FRAMELENS_FALLBACK_MODELS` | `gemini-flash-latest` | Tried when the main model's daily quota is used up; empty turns this off |
| `FRAMELENS_TIMEOUT_MS`, `FRAMELENS_MAX_RETRIES`, `FRAMELENS_CACHE_TTL_MINUTES`, `FRAMELENS_LOG_LEVEL` | `300000`, `3`, `60`, `info` | Gemini call limits, cache and logging |

Settings named `YTLENS_*` from the earlier name still work.

## Gemini notes

Free-tier limits count per Google Cloud project (more keys in one project do not help) and reset at midnight Pacific
time; on Flash they are small (about 20 requests a day), which is why Flash-Lite is the default. Quota errors name the
exact limit. One request holds about 40 minutes of video; analyze longer videos in parts with `start` / `end`. A
Google One / AI Pro subscription does not raise API limits; enabling billing on the key does.

## Security

- External programs run without a shell, with timeouts, and are killed with their process tree on abort.
- The pinned yt-dlp and ffmpeg are verified against their SHA-256 before they are used.
- Cookies are opt-in and never logged; the Gemini key is removed from every error and log line.
- Video content is untrusted: every result is labelled as third-party content so the agent treats it as information,
  never as commands.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
npm ci
npm test            # unit, media (real ffmpeg fixtures) and in-memory MCP tests
npm run typecheck
npm run bundle      # writes dist/framelens.mjs; commit it with the source change
```

Design and module layout: [docs/DESIGN.md](docs/DESIGN.md). Inside this repository, `npx framelens` resolves to the
checkout itself; point an MCP client at `dist/framelens.mjs` while developing.

## License

[MIT](LICENSE)

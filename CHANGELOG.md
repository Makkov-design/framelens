# Changelog

## [Unreleased]

- **Browser extension** for Chrome and Edge (`extension/`, Manifest V3, Load unpacked): "Read this page's motion"
  runs the `web` tool's own page reader in the user's browser, so pages behind their login can be read, and "Record
  this tab" saves a WebM of what they watch (with its duration written in; frame times stay the real, variable
  ones). Files go to `Downloads/FrameLens`; `web` takes `inbox` or the saved `.framelens.json` and writes the same
  `motion-spec.json` and `STYLE.md` as for a live page, and video tools take `inbox` for a recording. `inbox` is the
  newest item of either kind for every tool, `export inbox` included. A download the browser interrupts is reported,
  not called saved. No network access, no host permissions. `npm run build:extension` builds `extension/dist` and a
  zip.
- **Automatic setup**: a missing ffmpeg/ffprobe or yt-dlp is downloaded on first use (FFmpeg 9.0.2 from gyan.dev for
  Windows x64 and from ffmpeg.martin-riedl.de for macOS and Linux x64; yt-dlp 2026.10.21), checked against SHA-256
  hashes in the code, and the tool call that needed it says so. A pinned binary is trusted only after its hash
  matches; two servers installing at once each use their own temporary files and never delete a good binary; what
  a killed install left behind is removed; downloads have a size cap, a time limit and a stall limit.
  `FRAMELENS_AUTO_INSTALL=0` turns it off; `doctor --prepare` does the same on demand.
- **Self-hosted cobalt, opt-in**: with `FRAMELENS_COBALT_URL` (and `FRAMELENS_COBALT_KEY`), a link goes to the
  user's own cobalt instance only when yt-dlp has no extractor for it or fails for a reason that is clearly not
  access control; logins, age and bot checks, blocks, rate limits, private posts and HTTP 401/403/429 never go there.
  Every redirect of the media download is checked (no local or private hosts, https off the instance) and the file
  must be video or audio. Only the official cobalt.tools hosts are refused by name; it is meant for your own
  instance.
- **Workspace fallback**: when the server starts in a system folder (Claude Desktop on Windows uses
  `C:\WINDOWS\system32`; also through junctions, short names, `\\?\` paths and admin shares) or a folder it cannot
  write to, workspaces go to `~/.framelens/`; `FRAMELENS_WORKSPACE` overrides both (a relative one is taken from the
  home folder). Tool results show absolute paths, and `doctor` says which folder is used and why.
- `exact` reads Rive files (`.riv`, a path or a direct link; extensionless links by the `RIVE` fingerprint; rive.app
  pages are refused with how to get the file, never scraped). A dependency-free reader of the runtime format: header,
  table of contents (unknown properties of newer exports are skipped by it), artboards, nodes, fills and strokes,
  linear animations timed as the runtime plays them (work area, speed, backwards for negative speed), keyframes (double, colour, bool, id) with their exact cubic,
  cubic-value and elastic curves, and state machines (inputs, layers, states, transitions with blend times and
  conditions). Writes the usual `motion-spec.json` and `STYLE.md` plus `RIVE.md`; `export` works from it like from a
  Lottie spec. Hard limits on file size, object count and string length; names are treated as untrusted text.
- `STYLE.md` from `exact` (Lottie and Figma too) escapes names and text from the file as Markdown, so they cannot add
  links, HTML or table columns.

## 2.0.0 — 2026-11-09

**ytlens is now Frame Lens** (`framelens`): eyes and ears for AI agents for any video or animation. It measures
instead of retelling, runs locally for free, and picks how to look at a video from the user's goal. The Gemini tools
of 1.x keep working unchanged; settings named `YTLENS_*` are still read, and `framelens init` replaces an old
`ytlens` entry in `.mcp.json`.

New local tools (ffmpeg; links through a pinned, checksum-verified yt-dlp):
- `probe`, `plan`: fetch and probe any source, classify the video and plan the analysis for a goal (listen, learn,
  find, style, sound, production) with an image-token estimate.
- `transcript`: word-timed transcripts from captions (json3, VTT with inline word times), Gemini as a fallback.
- `frames`: frames with their real timestamps (the first frame at or after each sample point, every frame for
  transitions, VFR-safe) in contact sheets with time, frame number and the words spoken under each picture; `around`
  a phrase.
- `boundaries`: picture-change candidates and how dynamic a video is.
- `style`: cuts told apart from fast motion and flashes, shots with OKLab palettes, moves with their duration in
  frames and easing family; `motion-spec.json`, `STYLE.md`, `TIMELINE.md`, `ANALYSIS.md`.
- `audio`: loudness, silences, onsets, tempo and beat grid, cuts on the beat, spectrogram.
- `export`: starter projects for HyperFrames, Remotion, CSS, After Effects (ExtendScript), Lottie, and a handoff for
  Hypit; `compare`: a render against the reference (cuts, colour, picture similarity, worst moments).
- `web`: a live page's animations read exactly (CSS, Web Animations, Motion, GSAP), with real fonts and colours.
- `exact`: Lottie and dotLottie keyframes and curves, Figma prototype transitions.
- `framelens doctor [--prepare]`, `framelens login <site>` / `logout` (a separate browser profile for sites that
  need the user's own login), the `inbox` source and opt-in cookies.
- Accuracy is measured on ground-truth videos: [docs/ACCURACY.md](docs/ACCURACY.md).

Fixes found by independent audits before the release:
- `frames` `at` names each frame by the time of the frame shown, not the moment asked for, and a moment inside the
  last frame (up to the duration) returns that frame instead of an ffmpeg error.
- Variable frame rate is detected in Matroska/WebM files, which store no frame count.
- Folder names with an apostrophe (and `, ; [ ]`) no longer break contact-sheet labels and measurements.
- `style` times a cut on its own frame at 60 fps and above, and reads the palette of a one-frame video.
- `audio` onsets and the beat grid sit on the attack; before they were about 80 ms early.
- `plan` no longer proposes picture steps for audio files; `frames` on an audio file says there is no picture.
- Exports: the HyperFrames index loads GSAP and uses a bundled Inter weight; CSS preview scenes show only during
  their own slot; a multi-line source title can no longer turn into code in the Remotion or After Effects starters.
- Every tool result that shows a title from a site carries the third-party notice.
- Gemini: a per-minute input-token limit is waited out once before giving up; a 429 without quota details is
  retried with backoff; a deadline during a retry wait reports what was being waited out; a missing fallback model
  no longer hides the used-up daily quota; an empty `FRAMELENS_FALLBACK_MODELS` turns fallbacks off; a numeric quota
  limit of `0` is recognised.

## 1.2.0 — 2026-11-09

- Default model is now `gemini-flash-lite-latest`: on the free tier it allows about 500 requests a day, against 20
  for Flash.
- When the daily quota of a model is used up, or the model does not exist, ytlens moves on to the models in
  `YTLENS_FALLBACK_MODELS` (default `gemini-flash-latest`).
- Quota errors name the limit that was hit (daily, per-minute, or a request too large for the per-minute token
  budget), its model and when it resets. Retrying only happens where it can help: a used-up daily quota or an
  oversized request is no longer retried, and per-minute limits wait the delay Google asks for.
- Error details are no longer cut off before the name of the quota.
- `detail: "low"` is documented as saving tokens only on Gemini 2.5 models.

## 1.1.1 — 2026-11-05

- Starts without a Gemini key instead of exiting. Every tool then answers with the steps to add one, for a computer
  and for a Claude cloud session, so the agent can pass them on; before, the tools were just missing from the session.

## 1.1.0 — 2026-10-26

- `ytlens init`: adds ytlens to any project in one command (`.mcp.json` entry plus the skill), so Claude Code cloud
  sessions pick it up from the repository. Existing servers in `.mcp.json` are kept.
- `ytlens --version`.

## 1.0.0 — 2026-10-26

First release.

- Tools: `summarize_youtube_video`, `ask_about_youtube_video`, `extract_key_moments` (structured, with deep links),
  `get_video_transcript` (speech with speaker labels plus on-screen text), `list_supported_models`.
- Analyze part of a video with `start` / `end`; `detail: "low"` for long videos; `response_language`.
- Strict YouTube URL validation, in-memory result cache, per-call deadline with retries on rate limits and server errors.
- Prompt-injection hardening and API key redaction in every error and log line.
- Claude Code plugin with a bundled skill.
- Single self-contained bundle that runs straight from GitHub.

# Changelog

## Unreleased

### Added

- Name check: automatic captions spell product and proper names by ear ("Rare UI" for RareUI, "Val" for Vaul).
  When the words come from automatic captions, `plan` for `listen` and `learn` picks the likely names (capitalised
  words, words after cue words such as "called", "by" or "use", web addresses, said or written), adds a `frames` step
  640 px wide a second after each is said, and writes `NAMES.md` (caption spelling, on-screen spelling for the agent to
  fill in, time, evidence `seen` or `said`). `NAMES.md` is written once, so a later `plan` keeps what the agent wrote.

## 2.1.0 — 2026-11-09

Frame Lens now measures the exact curve of a move, reads Rive files, tells cuts from fades, dissolves and wipes,
reads pages and records tabs from a browser extension, and sets up ffmpeg and yt-dlp by itself. Every part went
through an independent audit, fixes and a re-check; see the sections below. Website:
https://makkov-design.github.io/framelens/

### Added

- `track`: follows one element through a window at the full frame rate (found automatically as the biggest moving
  region, or from a box) with subpixel template matching, and fits the exact timing of each property that moves
  (x, y, scale, opacity): a `cubic-bezier`, a damped spring (stiffness, damping, mass; also duration and bounce),
  linear or steps, with the fit error, duration in frames and seconds, and the delay. Writes `TRACK.md` with a plot
  per property, an SVG of the curves and `tracks.json`, and adds the move to `motion-spec.json` (positions and times
  `measured`, the curve `derived`). `plan` with the style goal suggests `track` for the moves `style` found.
- `export` uses a tracked curve wherever one exists: CSS `cubic-bezier()` / `linear()` for springs / `steps()`,
  Remotion `Easing.bezier` or `spring({config})`, exact GSAP eases in HyperFrames, After Effects keyframe speed and
  influence (a key per frame for springs, held keys for steps), and Lottie handles.
- Each fitted curve carries its error and a quality grade (`exact` ≤ 1 %, `approximate` ≤ 3 %, else `unreliable`);
  a move cut by the window widens the window (or is reported as cut), and moves of 5 frames or fewer are marked
  unreliable. Only exact and approximate curves reach `export`.
- The accuracy benchmark adds rendered moves with known beziers and springs in several directions, scale, opacity,
  on a busy background and with the element found automatically: see [docs/ACCURACY.md](docs/ACCURACY.md).
- `exact` reads Rive files (`.riv`, a path or a direct link; extensionless links by the `RIVE` fingerprint; rive.app
  pages are refused with how to get the file, never scraped). A dependency-free reader of the runtime format: header,
  table of contents (unknown properties of newer exports are skipped by it), artboards, nodes, fills and strokes,
  linear animations timed as the runtime plays them (work area, speed, backwards for negative speed), keyframes (double, colour, bool, id) with their exact cubic,
  cubic-value and elastic curves, and state machines (inputs, layers, states, transitions with blend times and
  conditions). Writes the usual `motion-spec.json` and `STYLE.md` plus `RIVE.md`; `export` works from it like from a
  Lottie spec. Hard limits on file size, object count and string length; names are treated as untrusted text.
- `style` reports transitions: cuts (`measured`) and dissolves, fades in and out, dips through black or white and wipes
  (`derived`), each with start, end, duration in frames, the shot boundary, the colour or direction and the blend's
  easing, in `transitions` of `motion-spec.json`, `STYLE.md` and `TIMELINE.md`. Shots split at a dissolve's halfway
  frame and a fade's black or white frame; a fade from the first frame or to the last splits nothing, nor does a flash
  after which the picture comes back; cuts stay exact. Dissolves are frames that blend two different pictures (not one
  picture relit, recoloured, white-balanced or panning); fades are also found by the picture approaching flat black or
  white, so they are caught on footage that keeps moving; wipes are looked for in every run of changing frames, and a
  flat panel sliding in stays a move. On the Big Buck Bunny trailer the title cards are shots of their own again
  (dissolves at 3.48–4.44 s and 6.24–7.12 s, five dips to black at 18.88–22.88 s, a flash to white at 26.72 s), and
  the opening title's fade from white and the end card's fade to white are found. A push is not recognised (reported
  as a move). The benchmark adds 60 rendered transitions: see [docs/ACCURACY.md](docs/ACCURACY.md).
- **Browser extension** for Chrome and Edge (`extension/`, Manifest V3, Load unpacked): "Read this page's motion"
  runs the `web` tool's own page reader in the user's browser, so pages behind their login can be read, and "Record
  this tab" saves a WebM of what they watch (with its duration written in; frame times stay the real, variable
  ones). Files go to `Downloads/FrameLens`; `web` takes `inbox` or the saved `.framelens.json` and writes the same
  `motion-spec.json` and `STYLE.md` as for a live page, and video tools take `inbox` for a recording. Each tool
  takes the newest inbox item it can use (video tools a video, `web` a page reading, `export` either, preferring the
  one already worked on) and the result names the other one. A download the browser interrupts is reported, not
  called saved. No network access, no host permissions. `npm run build:extension` builds `extension/dist` and a
  zip.
- **Automatic setup**: a missing ffmpeg/ffprobe or yt-dlp is downloaded on first use (FFmpeg 9.0.2 from gyan.dev for
  Windows x64 and from ffmpeg.martin-riedl.de for macOS and Linux x64; yt-dlp 2026.10.21), checked against SHA-256
  hashes in the code, and the tool call that needed it says so. A pinned binary is trusted only after its hash
  matches; two servers installing at once each use their own temporary files and never delete a good binary; what
  a killed install left behind is removed; downloads have a size cap, a time limit and a stall limit.
  `FRAMELENS_AUTO_INSTALL=0` turns it off; `doctor --prepare` does the same on demand.
- **Self-hosted cobalt, opt-in**: with `FRAMELENS_COBALT_URL` (and `FRAMELENS_COBALT_KEY`), a link goes to the
  user's own cobalt instance only when yt-dlp has no extractor for it or fails with wording that does not look like
  access control; logins, age and bot checks, challenges, blocks, rate limits, passwords, DRM, private or paid posts
  and HTTP 401/403/429/451 never go there. Every hop of the media download is checked (no local or private hosts,
  IPv4 inside IPv6 included; https off the instance), the connection goes to the checked address, and the file must
  be video or audio. Only the official cobalt.tools hosts are refused by name; it is meant for your own instance.
- **Workspace fallback**: when the server starts in a system folder (Claude Desktop on Windows uses
  `C:\WINDOWS\system32`; also through junctions, short names, `\\?\` paths and admin shares) or a folder it cannot
  write to, workspaces go to `~/.framelens/`; `FRAMELENS_WORKSPACE` overrides both (a relative one is taken from the
  home folder). Tool results show absolute paths, and `doctor` says which folder is used and why.
- Listed for the official MCP Registry as `io.github.Makkov-design/framelens` (`server.json`, `mcpName` in
  `package.json`, and a manual "Publish to MCP Registry" workflow); `glama.json`; a PNG icon for the Claude Code
  plugin. Contributing guide, code of conduct, issue forms (including "Wrong measurement") and a pull request
  template.
- `framelens --help` lists the commands (it used to answer "Unknown command").
- `THIRD_PARTY_NOTICES.md`, shipped in the npm package: the licences of the code bundled into `dist/framelens.mjs`
  (the MCP TypeScript SDK, Zod, Google's Gen AI SDK under Apache-2.0, and what they bring in).

### Changed

- `export` animates only what Frame Lens read from the reference: titles move where `style` found a move (easing
  family derived) or `track` fitted a curve, dissolves are cross-fades and fades and dips go through black or white,
  each with its own colour and easing (CSS keyframes, HyperFrames tweens, Remotion opacity, After Effects and Lottie
  opacity keys; a wipe is a clip-path edge where the target has one; in After Effects each title sits above its own
  shot, so a dissolve covers the outgoing title too). Shots without a move hold still instead of getting an invented
  0.2 s entrance; REFERENCE.md says what is derived and lists what is a default. A spec whose `transitions` is not a
  list, or lies outside the range, is cleaned instead of crashing the export.
- Shot palettes and backgrounds come from the shot's own frames over its whole length (outside its transitions), not
  from one frame at its middle: a title card that dissolves into the film is white, not the blend. The frames come
  from the same decoding pass as the per-frame change, through a pipe (tone-mapped for HDR, so HDR shots need no
  extra seeks); a range too long to keep them gets the per-frame change only, with a note to analyze it in parts.
- `plan` for the style goal stays proportionate: one to three ×10 passages of about 12 % of the video each (2–8 s;
  24 % of the 33 s trailer in all), every-frame windows around the strongest changes (one per 8 s of video, 2–8 of
  them) joined when they overlap or touch and split into windows of at most 2 s, and the estimate counts frames and
  tokens per sheet layout. On the 33 s trailer: 272 frames and 22,417 image tokens, down from 606 frames and 63,043.
- The login profile (`framelens login`, 2.0) now decides on yt-dlp's own words, not Frame Lens's help text, with the
  same classifier as cobalt: "rate-limit reached or login required" and other bot checks, rate limits and blocks are
  never played through the user's login.
- `framelens init` pins `framelens@<version>` from npm instead of `github:Makkov-design/framelens#v<version>`, a
  16 MB download that needed the tag to exist; running from GitHub stays documented. Its next steps start with
  asking the agent about any video, link, file, site, Lottie or Rive, and end with the Gemini key, as optional.
- Without a Gemini key, only the Gemini YouTube tools say how to add one, once, and that the local tools need none.
  The message said "To use framelens, add a Gemini API key", twice.
- `plan` lists only steps the tools accept as they are. Learn and production get their moments when the boundaries or
  shots are already in the workspace, and otherwise a `then` that says what to add from the `boundaries` result
  (before: `at: "each boundary + 0.5 s"` and a `labels` parameter that does not exist). A source without sound gets
  no `transcript` step. `track` steps offer `element: "auto"` for graphics and UI footage and ask for a box in camera
  footage, where the biggest moving region is often the camera, and for any move where `style` measured the whole
  picture changing (those come after moves of one element).
- Every number in a video's `motion-spec.json` carries an evidence label on the object that holds it: `timebase` and
  words measured, beats derived, shots measured (derived when an end is a gradual transition), `rhythm` derived, a
  dip's `hold` derived, and `audio` one label per field (tempo and cuts on the beat derived, loudness measured). The
  rule is in docs/DESIGN.md, and a test walks a real spec for numbers without one. Specs from `web` and `exact`
  follow it too: the source's own values are `measured` (a page's keyframes and scroll positions included), counts
  and rates `derived`, and a page's 60 fps, Frame Lens's own choice, `inferred`.
- `compare` finds a render shifted as a whole and says so first ("the render is 5 frames early") instead of calling
  every cut missing and every cut extra, and its text and side-by-side sheet name the same least similar moments.
- `doctor` and the other commands print to stdout (only the server keeps stdout for MCP); `doctor` lists
  `FRAMELENS_HOME` among the overrides, with each override's value.

### Fixed

- `style` no longer lists the same move twice (two bursts of motion that grew over the same slow frames), and moves
  leave out transition frames and still frames whose change is only grain. Exporters and `plan` drop duplicates from
  older specs.
- ffmpeg numbers in scientific notation are read whole: signalstats prints tiny averages as `6.94444e-05`, which
  2.0 read as 6.94, so a still frame with a few changed pixels became a false cut (six on Frame Lens's own demo) and
  moves on flat graphics looked stronger. Fixed in every ffmpeg log Frame Lens parses (energy, scene scores, frame
  times, SSIM, loudness, silences).
- A 2–3 frame shot between two cuts is no longer taken for a flash: a flash returns to the picture it left, a short
  shot does not, and `style` now compares those frames. Montage cuts are found (the benchmark adds a montage of 2- and
  3-frame shots with flashes in it). A cut inside part of the frame only is still judged on the whole frame (a limit,
  in ACCURACY.md).
- `STYLE.md` from `exact` (Lottie and Figma too) escapes names and text from the file as Markdown, so they cannot add
  links, HTML or table columns.
- `frames`: `around` with an occurrence past the last says how many there are ("appears 3 times; occurrence 5 does not
  exist") instead of "not in the transcript"; `at` together with `every`, `fps`, `every_frame` or `around` is an
  error instead of an option silently dropped, and the error names `around`; ranges are given to the millisecond
  (4.86, not 4.859999999999999).
- `transcript` on a source without captions says what can give a transcript (captions on a site that has them, the
  Gemini transcript of a YouTube link with the user's key, a speech-to-text such as Whisper that the user runs)
  instead of sending the agent to `doctor`, which lists none; on a source without sound it says there is none.
- Errors: a `compare` source that cannot be opened names its argument (`reference` or `render`); a relative path
  that is not found says it is taken from the server's working folder (System32 under Claude Desktop) and asks for
  an absolute one; the empty-inbox message says what the inbox holds (a video, GIF, page reading or recording); a
  link that cannot be fetched leaves no empty `yt-<id>` folder behind.
- Every local tool parameter has a description (`audio.start`, `boundaries.start` and `end`, `frames.columns` and
  `rows` had none).
- `web` records page-load motion from the first frame: a recorder added before the page's own scripts keeps every CSS
  animation, CSS transition and Web Animation as it starts, so motion that is over before the page is read (a 650 ms
  entrance, a transition toggled on load) is in the reading, marked as over, and in the opening film. The result says
  what can still be missed (GSAP tweens finished before the reading, motion drawn by scripts) and, for a reading from
  the extension, that ended animations are not in it. A page without headings or text says so instead of "Fonts: .".
- `export` writes every tracked move of a shot, not only the first: each further one gets its own element at the
  tracked element's place (CSS, Remotion, HyperFrames, After Effects, Lottie) with its own curve, spring included, and
  Hypit's TIMELINE.md lists them. On Frame Lens's own demo the spring at 12.8 s now reaches every target. A move
  tracked twice (an automatic pick, then a box) is exported once, as its best-graded and newest track; REFERENCE.md
  names the one left out.
- `track` with `move: n` keeps its window inside the move's shot and never widens it past a cut (the trailer's move 1
  was read across the cuts at 13.20 and 13.88 s). `style` measures how much of the picture each move changes (`area`);
  when the whole picture moves (a camera or character move) `track` says so and asks for a box instead of "Nothing
  moves", the automatic pick never returns the whole frame or half of it, and a window given by hand that crosses a
  cut says which. `style` numbers its moves for `track move: n` (STYLE.md too) and its next step names `track`.
- `exact` on a video or GIF (MP4, MOV, WebM, MKV, AVI, GIF, FLV, MPEG, found by their first bytes) says it is one and
  points to `plan` or `style`, instead of a JSON parser error; its description lists all six export targets; colours
  within 0.01 in OKLab (#FFFFFF, #FEFFFF, #FEFEFE) are one palette entry.
- `audio` returns its spectrogram as a JPEG preview (about 65 KB for the 33 s trailer instead of a 548 KB PNG); the
  full PNG stays on disk.

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

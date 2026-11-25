# Frame Lens — design (v2)

Frame Lens (`framelens` in code, npm, CLI and URLs) gives AI agents eyes and ears for any video or animation.
It takes a reference from any source, picks the analysis that fits the user's goal, and writes measured,
reusable results to disk. This file is the shared brief for everyone working on v2. The product plan with
research and reasoning lives in the plan page; this file is what the code must follow.

## Principles

1. **Measure, don't retell.** Every number carries an evidence label: `measured` (read from pixels, audio or the
   source's own data), `derived` (fitted from measurements), `inferred` (a model's judgement).
2. **Any goal.** Goals: `listen`, `learn`, `find`, `style` (replicate motion style), `sound`, `production`.
   The router picks passes and density from the goal and the video type.
3. **Any source.** YouTube and other links (yt-dlp), direct media URLs, local files, GIF/APNG/WebP, image
   sequences; later Lottie, live web pages and Figma, whose exact animation data is read instead of measured.
4. **Local and free first.** The npm core has no runtime dependencies (one esbuild bundle). ffmpeg/ffprobe,
   yt-dlp, whisper and the HyperFrames CLI are optional external tools found and checked by `framelens doctor`.
   A missing ffmpeg or yt-dlp is fetched automatically (pinned version, SHA-256 in the code, the agent is told;
   `FRAMELENS_AUTO_INSTALL=0` turns it off). Gemini stays as an optional engine for cloud sessions and semantic
   descriptions.
5. **Results live on disk.** Each source gets a workspace folder; tools return a short summary plus paths, so a
   tool result stays far below the 25K-token MCP limit. The agent opens the sheets it needs.
6. **The loupe.** Overview first (storyboard-like sampling), then 10 fps on chosen ranges, then every native frame
   ±0.5 s around events. Never dense sampling of a whole long video.
7. **Honest access.** Only content the user can see, fetched the way the user can: file, public link, the user's
   own cookies (opt-in), the user's own browser profile, the browser extension in the user's own browser (they
   record what they watch), or the user's own self-hosted cobalt instance (opt-in, and only for links that yt-dlp
   has no extractor for or fails on for reasons whose wording does not look like access control). Never bot-check or
   CAPTCHA evasion, client impersonation of our own, public online downloader sites, paid scrapers or account pools.
   One word check on the error text (`sources/access.ts`) decides both: a failure that may be access control
   (login, age, bot check, challenge, block, rate limit, password, DRM, private or paid post, HTTP 401/403/429/451)
   never goes to cobalt, and a bot check, challenge, rate limit or block is never answered with the login profile.
   It is wide on purpose and cannot know every site's wording.
8. **Understanding, not production.** We do not generate footage, voices or variants. We export specs and starter
   projects to renderers (HyperFrames, Remotion, CSS/Motion, later Lottie, After Effects, Hypit).

## Layout of `src/`

| Path | Owns |
|---|---|
| `index.ts` | CLI: no args = MCP server on stdio; `init`, `doctor [--prepare]`, `--version`; later `login <site>`, `logout` |
| `config.ts` | Env config. `FRAMELENS_*` names, legacy `YTLENS_*` still read |
| `server.ts` | MCP tool registration and result formatting only; logic lives in modules below |
| `analyzer.ts`, `cache.ts`, `prompts.ts` | Gemini engine (existing tools keep working) |
| `sources/` | Turning any input into a local media file plus `source.json`: resolve, yt-dlp, direct URL, local file, inbox folder, cookies |
| `tools/` | Finding and running external binaries (ffmpeg, ffprobe, yt-dlp, whisper), version checks, pinned downloads |
| `media/` | ffprobe probe (VFR, HDR, audio), frame extraction, contact sheets with time and word labels, visual-change candidates, dynamics index |
| `speech/` | Transcript with word times: captions first, local whisper if present, Gemini as fallback; `names.ts` picks likely names in automatic captions for the name check (`NAMES.md`) |
| `workspace/` | Workspace folder layout, `manifest.json`, cached pass results, `PROGRESS.md` |
| `runtime/` | The per-call context (`call.ts`): the client's cancel signal and MCP progress, carried to the code that runs programs |
| `router/` | Video type classification and the goal-based plan |
| `style/` (2.1) | Shots, cuts, transitions (`transitions.ts`: dissolves, fades, dips, wipes from every frame at 64×36), palette, typography notes, `STYLE.md`, `motion-spec.json`, `ANALYSIS.md`, `TIMELINE.md` |
| `track/` (2.1) | Element tracking (normalised cross-correlation, then Lucas–Kanade subpixel refinement with gain and offset, drift checked against the first template) and curve fitting (cubic-bezier, spring, linear, steps by least squares with Nelder–Mead), `TRACK.md`, `tracks.json` |
| `audio/` (2.2) | Loudness, silences, onsets, tempo and beat grid, cut-on-beat, spectrogram image, SFX labels |
| `exact/` (2.4) | Lottie, live web pages (WAAPI/GSAP), Figma; Rive `.riv` (`rive.ts` reads the runtime binary format, keys copied from Rive's MIT defs in `rive-defs.ts`) |
| `export/`, `compare/` (2.3) | Starter projects per renderer; render-vs-reference comparison |

Every external process goes through `tools/` (one place for timeouts, Windows quoting, `windowsHide`, killing the
tree on abort). stdout is reserved for MCP: logs go to stderr through `logger.ts`.

**Cancellation, progress, shutdown.** Each tool call (the local tools, `web`, `exact`, and the Gemini tools, whose
request to Gemini is aborted with the call) runs inside a call context (`runtime/call.ts`, an AsyncLocalStorage) that holds
the client's `extra.signal` and, when the client sent a progress token, a reporter. The code that starts programs
(`tools/run.ts`, `media/exec.ts`, the ffmpeg pipes in `track/decode.ts` and `style/motion.ts`) reads the signal from
there, so the engine's methods need no signal parameter. Those programs are spawned by `tools/children.ts`: no
shell, their own process group on POSIX (killing the group stops what they started, such as yt-dlp's ffmpeg; on
Windows taskkill walks the tree), and registered until they end. The browser is the one child spawned elsewhere
(`browser/cdp.ts`, its own group as well): it is killed when its call is cancelled, at the end of its lifetime and on
exit. A cancelled call kills its children. The server kills all of them on exit, SIGINT, SIGTERM, SIGHUP and a broken
stdout; when the client closes stdin, the requests it already sent are answered first (`runtime/stdio.ts` counts
them), then the server exits — unless the client itself is gone, in which case nobody would read the answers and the
server exits at once, killing the children. While draining it checks every second that the process that started it
is still there, and every 5 s writes an MCP `ping` to the client: a write that fails (EPIPE) means the client's end
of stdout is closed. The ping is what works under launchers that outlive the client (`npx` runs the server under
`sh -c` or `cmd /c`, and `npm exec`; `test/runtime/shutdown.test.ts` goes through such a launcher on POSIX and
Windows); before stdin closes nothing of this runs, so a call in progress is never stopped by it. A script client
that pipes its requests, closes stdin and reads stdout by hand therefore sees
`{"jsonrpc":"2.0","id":"framelens-alive-N","method":"ping"}` lines between the answers during a call longer than
5 s: a valid JSON-RPC request (MCP allows `ping` from either side) that it may ignore or answer, and that nothing
waits for. A SIGKILL of the server cannot be caught: its children, each in its own process group,
then run until they end. `run` settles when the program exits even if a descendant that left the group keeps the
pipes open, and never signals a pid after the child is reaped.

Shared work never runs under one call's signal: the first-use install of ffmpeg or yt-dlp and the one drawtext check
run outside any call (`outsideCall`) on their own limits, and each caller waits with its own signal (`untilAborted`).
The install's download lines go to every call waiting for it that reports progress (a call that joins late first
hears the latest line), and an install note that no waiting call could show goes to the next call that uses the
tool. A cancelled call's reporter goes silent once the call has answered. Tool versions are not cached from a
cancelled call. Nothing is written to a workspace under a cancelled call (`Workspace.writeJson` and
`writeText` check), so a later call never trusts a result cut short. Progress notifications carry each finished
step (the lines written to `PROGRESS.md`, setup and download log lines) and a heartbeat every 15 s, so a client that
resets its timeout on progress waits for a long `style` or download. A program that hits its time limit is reported
with that limit, not as a failed command.

**One download per workspace.** `resolveSource` (and the login-profile capture in `index.ts`) keep the downloads in
flight by workspace folder (`singleFlight`): a second call on
the same new link waits for the first (and gets its record or its error) instead of starting a second yt-dlp that
deletes the first one's files. A waiter whose download was cancelled by the other caller tries again itself.
`source.json` is written only after the media is complete, so a cancelled download leaves nothing a later call takes
for a finished one.

## Workspace

`<cwd>/.framelens/<id>/` unless `FRAMELENS_WORKSPACE` is set; `~/.framelens/<id>/` when the working folder is a
system folder (Windows folder, Program Files, a drive root, `/`, `/usr`, `/System`, …) or cannot be written to.
Tool output always shows absolute paths. `<id>`: `yt-<videoId>`, `file-<sha1 of path+size+mtime, 10 hex>`,
`url-<sha1 of url, 10 hex>`.

```
source.json        input, kind, title, canonical url, fetchedAt, tool versions
media/source.<ext> the fetched or linked media (local files are referenced, not copied)
probe.json         duration, fps (avg and real), vfr, size, hdr, audio streams
transcript.json    { language, source: captions|whisper|gemini, words: [{ t, end, text }], segments: [...] }
transcript.md      readable transcript with [m:ss] marks
frames/            single frames named by source time, e.g. 000012.480.jpg
sheets/            contact sheets + sheets/<name>.json index (cell → time, frame number, words)
plan.json          the router's plan for the current goal
NAMES.md           likely names in automatic captions for the agent to check on screen (created once, never through a link)
ANALYSIS.md        whole-piece reading (2.1): purpose, hook, structure, systems, why it works
TIMELINE.md        time-located sections (2.1)
STYLE.md           art direction (2.1)
motion-spec.json   machine spec (2.1, see below)
PROGRESS.md        what is done, open questions, next step — so another session can resume
```

`NAMES.md` is the one file the agent edits that `plan` points it to, so it is handled like the rest of a workspace
that may have come with a project: it is created only when the name is free (`Workspace.writeTextOnce`, exclusive
create, so never through a link), and a later `plan` names it again only when it is a plain file of the workspace's
own (`Workspace.fileState`: not a link, not a hard link to a file elsewhere). Frame Lens never reads it back. Its
caption names are third-party text: escaped with `mdText` in the file and in the plan step, under the third-party
notice in the result.

## MCP tools (v2)

All new tools take `source` (URL, path or YouTube ID) and return a short text summary plus `structuredContent`.

| Tool | Phase | Does |
|---|---|---|
| `probe` | 2.0 | Resolve and fetch the source, probe it, report kind, duration, fps, captions, dynamics, workspace path |
| `plan` | 2.0 | Picture changes over the whole source up to 10 min; a longer one is read in 12 windows of 30 s spread over it, and the plan says so. Goal (or free-text request) + probe → passes, densities, ranges, token estimate. Style goal: 1–3 ×10 passages of about 12 % of the video each (2–8 s, by summed change strength, never overlapping), every-frame windows around the strongest changes (one per 8 s, 2–8, overlapping or touching windows joined, longer stretches split into windows of ≤ 2 s); the estimate counts frames and image tokens per sheet layout |
| `transcript` | 2.0 | Word-timed transcript; returns the text (bounded) and file paths |
| `frames` | 2.0 | Frames or contact sheets for a range: `at`, `every` (s), `fps`, `every_frame`, `around` (phrase), `columns`, `rows`, `cell`, word labels. Returns sheet paths; inlines at most a few sheets |
| `boundaries` | 2.0 | Visual-change candidates with scores (not editorial cut labels) |
| `style` | 2.1 | One decoding pass (per-frame change at 160 px, and every frame at 64×36 streamed through a pipe into one buffer, tone-mapped for HDR; a range whose frames pass 768 MB gets the change only, with a note): cuts, gradual transitions, shots split at them, palette per shot over its own frames (not the blend frames), moves without the transition frames; writes STYLE.md, motion-spec.json, ANALYSIS/TIMELINE skeletons. Transitions: runs of frames whose changes correlate (cosine ≥ 0.3), trimmed of plain motion at the ends, accepted when the frames are blends of the two pictures (median residual ≤ 0.3, share of the new picture rising), most of the picture changes, and the new picture is not the old one relit, recoloured or white-balanced (its colours map one to one: correlation ratio ≥ 0.75; or its edges stay in place: gradient correlation ≥ 0.7), moved a few pixels, or panning (each frame a shifted copy of the one before); a flat black or white end makes it a fade, a fade out and a fade in through the same colour with ≤ 0.5 s between them a dip, unless the picture after is the one before (a flash inside one shot). Fades are also found from each flat run by walking while every frame is further from the colour (mean distance plus contrast), which motion inside the shot does not hide; a fade from the first or to the last frame splits no shot. Wipes are checked in every run of changing frames, up to where the share of pixels that left the first picture stops growing, and in the move windows (each pixel one picture or the other, a straight travelling edge, a new picture with detail: a flat panel sliding in stays a move). Shot boundary: a dissolve's or wipe's halfway frame (the new picture at half), a fade's black or white frame (the hold's darkest or brightest). A move whose picture never leaves its first frame by 1/250 is noise and is dropped. Two isolated spikes 2–3 frames apart are a flash only when the picture after them is the one before them (else two cuts around a short shot). ffmpeg numbers are parsed with exponents (signalstats prints `6.9e-05`) |
| `track` | 2.1 | One element through a window (≤ 15 s, decoded once as grey frames over a pipe, ≤ 64 MB; widened up to twice when the move runs past it); `auto` candidates are paired with the frame whose edges sit on the box and verified by tracking; a faint (faded) element keeps its place instead of being searched for; per-property fit with start, end, delay, error and quality (exports take exact and approximate curves only). Model choice: steps when they fit at least twice as well as any smooth curve; a spring when the value swings back across its target, or overshoots and the spring fits better; linear when within 25 % of the bezier's error; otherwise the bezier. Tracks go to `tracks.json` and `motion-spec.json` (`tracks`, and `track`/`curve` on the style move they refine) |
| `audio` | 2.2 | Sound analysis and spectrogram |
| `export`, `compare` | 2.3 | Starter projects; render-vs-reference report. Exports animate only what was read from the reference: a title moves where `style` found a move (easing family derived) or `track` fitted a curve; dissolves are opacity cross-fades (the incoming scene starts with the dissolve, painted above; in After Effects each title sits right above its own background), fades and dips a black or white veil each (in and out apart, with their own colour and easing), wipes a clip-path edge (an opacity cross-fade in After Effects and Lottie); everything else is still. `safeSpec` drops transitions that are not a list and clamps their times into the range. REFERENCE.md says what is derived and lists the defaults |
| Gemini tools | kept | `summarize_youtube_video`, `ask_about_youtube_video`, `extract_key_moments`, `get_video_transcript`, `list_supported_models` |

## motion-spec.json v1

```jsonc
{
  "spec": "framelens.motion/1",
  "source": { "kind": "youtube", "url": "…", "title": "…" },
  "range": { "start": 0, "end": 45.2 },  // the span that was asked for: input, so the one block without a label
  "timebase": { "fps": 30, "vfr": false, "duration": 45.2, "width": 1080, "height": 1920, "evidence": "measured" },
  "anchors": {                       // time sources an exporter can re-flow to new words or music
    "words": [{ "id": "w12", "t": 3.21, "end": 3.48, "text": "faster", "evidence": "measured" }],
    "beats": [{ "id": "b8", "t": 3.2, "downbeat": true, "evidence": "derived" }],
    "cuts":  [{ "id": "c3", "t": 3.2, "frame": 96, "score": 0.71, "evidence": "measured" }]
  },
  "palette": [{ "hex": "#0E0F1A", "role": "background", "share": 0.62, "evidence": "measured" }],
  "typography": [{ "role": "caption", "family_guess": "Inter Tight", "weight": 800, "case": "upper", "evidence": "inferred" }],
  "shots": [                         // measured when both ends are cuts or range ends, derived when one is a gradual transition's
    { "id": "s4", "start": 3.2, "end": 4.6, "frames": 42, "palette": ["#0E0F1A", "#F2F2F2"], "anchor": "c3", "evidence": "derived" }
  ],
  "transitions": [                   // how each shot gives way to the next (2.1)
    { "id": "x1", "kind": "cut", "start": 3.2, "end": 3.2, "frames": 0, "at": 3.2, "from": "s3", "to": "s4", "evidence": "measured" },
    { "id": "x2", "kind": "dissolve", "start": 4.2, "end": 5.0, "frames": 24, "at": 4.6, "easing": "linear", "fit": 0.03, "from": "s4", "to": "s5", "evidence": "derived" },
    { "id": "x3", "kind": "dip", "via": "black", "start": 8.6, "end": 9.16, "frames": 14, "at": 8.88, "hold": { "start": 8.88, "end": 8.92, "evidence": "derived" }, "evidence": "derived" }
  ],                                 // kinds: cut, dissolve, fade-in, fade-out, dip (via black|white), wipe (direction)
  "systems": [{                        // things that live across several shots: captions, boards, sound beds (written by the agent)
    "id": "caption", "role": "Caption", "start": 0, "end": 45.2, "evidence": "inferred",
    "states": [{ "t": 3.21, "anchor": "w12", "change": "word highlight", "evidence": "measured" }]
  }],
  "events": [{
    "t": 3.2, "frame": 96, "anchor": "b8", "target": "s4/title", "kind": "enter",
    "type": "slide-up + fade", "frames": 9, "easing": "cubic-bezier(.2,.8,.2,1)", "evidence": "derived"
  }],
  "rhythm": { "cuts": 11, "cutsPerMinute": 14.6, "transitions": 10, "meanShotSeconds": 2.26, "medianShotSeconds": 1.6, "movesPerMinute": 9.3, "evidence": "derived" },
  "audio": {
    "tempo_bpm": 120, "cut_on_beat_ratio": 0.82, "integrated_lufs": -14.2,
    "evidence": { "tempo_bpm": "derived", "cut_on_beat_ratio": "derived", "integrated_lufs": "measured" },  // one label per number where they differ
    "hits": [{ "t": 3.21, "strength": 0.9, "evidence": "measured" }],
    "sfx": [{ "t": 3.21, "label": "whoosh", "evidence": "inferred" }]
  }
}
```

**The evidence rule.** Every number is a field of an object that carries `evidence`, or an element of an array such
an object holds. `evidence` is one label for all the object's numbers, or an object with a label per numeric field
where they differ (`audio`). A label covers only its own object, never the objects nested in it (a dip's `hold`
carries its own), with one exception: a track in `tracks` labels the whole record, its window, element, samples and
curves (TRACK.md says the positions are measured and the curves derived). `range` is input and has no label.
`unlabelledNumbers` in `src/style/spec.ts` checks a spec against the rule; a test runs `style` and `audio` on a real
clip and walks the result. The labels on `timebase`, `words`, `beats`, `shots`, `rhythm`, `audio` and `hold` came in
2.1.0; specs written earlier lack them, and so, for now, do the `timebase`, `shots` and `rhythm` of specs read from
web pages (`browser/web.ts`) and from Lottie, Rive and Figma (`exact/spec.ts`).

Roles use production vocabulary: A-roll, B-roll, Caption, Typography, MG, UI, SFX, Music, VO.

## Sources: social platforms

Tiers, tried in order with a clear message when one fails: 0 file or inbox folder (`FRAMELENS_INBOX`, newest
file) · 1 public link via pinned yt-dlp (gallery-dl optional fallback) · 2 opt-in cookies (Firefox profile or a
cookies.txt path; Chrome/Edge on Windows cannot work) · 3 a dedicated Frame Lens browser profile (2.4) · 3+ the
browser extension (`extension/`, 2.1): the user records the tab or reads the page in their own browser, files go to
`Downloads/FrameLens` and the `inbox` finds them (each tool takes the newest item it can use: video tools a video,
`web` a page reading, `export` either, and the result names the other). Links yt-dlp has no extractor for may go to
the user's own cobalt instance (`FRAMELENS_COBALT_URL`); a failure that may be access control never does (allow-list
in `sources/cobalt.ts`, wording in `sources/access.ts`). One video per request, with pauses between requests.

Redirects are followed by hand wherever a download takes an address from third-party data: `checkHop` and
`pinnedGet` in `sources/cobalt.ts`, shared by cobalt and `exact` links (`exact/http.ts`). The trusted origin (the
user's cobalt instance, or the host of the link given to `exact`) may be local; no hop may add a user name or
password; every hop to another host must be https and resolve only to public addresses, and is connected to at the
address that was checked.
The same check walks a link's redirects before yt-dlp follows them (`checkLinkRedirects` in `sources/resolve.ts`; one
plain GET to the link's own host, no new service) and covers every hop of the login-profile capture's media download
(`browser/capture.ts`). `web` sends every request of its browser through `browser/proxy.ts` (below), and also holds each document request over
CDP (`Fetch.requestPaused`, `browser/read.ts`) to say clearly when a page redirects to a refused address.

`exact` decodes gzip, deflate and br through `stream.pipeline` (never `pipe`, which left the socket open and let the
time limit's abort surface as an unhandled error) and refuses other encodings. yt-dlp's `--max-filesize` covers only a
size known up front, so `sources/ytdlp.ts` also measures the `source.*` files every 250 ms (not the postprocessor's
`source.temp.<ext>`, nor the finished `source.<ext>` while the merge's inputs are still beside it) and stops the
download past the limit. Whatever a stopped, cancelled or failed download wrote is removed in `fetchWithYtDlp`.

### `web` request proxy (2.3.1)

Checking subresources target by target over CDP failed (it killed dedicated workers and missed sandboxed frames and
prefetches), so every request of `web`'s browser goes through one choke point:

- `browser/proxy.ts` is an HTTP proxy inside the Frame Lens process, on 127.0.0.1 and a random port, started for one
  reading and closed with its browser; if it cannot start, or Chrome cannot be given its credentials, the page is not
  opened. Chrome is started with `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>` (so
  loopback goes through it too), `--disable-quic`, WebRTC limited to proxied traffic
  (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), secure DNS off, and no proxy variables in its
  environment.
- Each request names a host: an absolute-form request for http (the URL's host is checked and connected to; a
  different Host header is replaced by it), `CONNECT host:port` for https and WebSockets. The proxy resolves the host
  once per reading with `hostAddresses` and refuses it (403) when any address fails `isPrivateAddress`; otherwise it
  connects to the address it checked, so a second DNS answer cannot swap it. TLS and its server name stay between the
  browser and the site.
- Exempt: only the user's own input when it is literally `localhost` (or `*.localhost`) or a loopback or private IP,
  that exact host on any port. A public name that resolves to a private address is never exempt.
- Only the browser it started may use it: a per-run random user name and password as Basic proxy credentials, or a 407
  and nothing forwarded. Chrome reports a challenge only for a request it intercepts, so the browser target intercepts
  every request at the request stage and lets it go at once (no measurable cost: about 2.0 s for a page with 40 images
  either way); `Fetch.authRequired` gets the credentials only for a challenge from source `Proxy` at the proxy's own
  address, and anything else is cancelled. Proxy-Authorization and the other hop-by-hop headers are never forwarded,
  and a site's own 407 is turned into a 502 so the browser never offers the credentials to a site.
- Limits: 15 s to connect, 2 minutes idle, 256 connections at once.
- No new service and no new outside request: the proxy carries only what the page asked for, as the browser would.

## Engineering rules

- TypeScript strict, ESM, Node ≥ 20, zero runtime dependencies; bundle with `npm run bundle` and commit
  `dist/framelens.mjs` together with the source change.
- Match the existing style: small modules, short comments that explain why, plain names.
- Tests with vitest. Run them with `--maxWorkers=2` (the dev machine is shared). Media tests generate their
  fixtures with ffmpeg (`testsrc2`, `sine`, color cards with known cut frames) into a temp dir and are skipped
  when ffmpeg is missing; CI installs ffmpeg. No network in unit tests.
- One heavy command at a time per session; wrap long-running commands in timeouts.
- Branch `feat/<phase>-<area>`, pull request into `main`, CI green before merge. Commit messages end with the
  co-author line used in this repository.
- Every milestone gets an independent audit (quality, security, tests, a live run) before the next starts.
- Repository maintenance may read public pages that the shipped server never contacts. `scripts/check-listings.mjs`
  (run weekly by `listings-check.yml`, never by the package) reads npm, the MCP Registry and five catalogue pages
  (Glama, LobeHub, MCP Market, claudemarketplaces.com, mcprush) to see whether they show the current version.
  Reason: catalogues copy a release on their own schedule and offer no way to push one, so a stale or misnamed
  listing is otherwise found by accident. It sends plain GETs with a user agent that names this repository, no
  cookies or keys, and treats a refusal as "not readable" (principle 7). None of these services is a dependency of
  `dist/framelens.mjs`.

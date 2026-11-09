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
   Gemini stays as an optional engine for cloud sessions and semantic descriptions.
5. **Results live on disk.** Each source gets a workspace folder; tools return a short summary plus paths, so a
   tool result stays far below the 25K-token MCP limit. The agent opens the sheets it needs.
6. **The loupe.** Overview first (storyboard-like sampling), then 10 fps on chosen ranges, then every native frame
   ±0.5 s around events. Never dense sampling of a whole long video.
7. **Honest access.** Only content the user can see, fetched the way the user can: file, public link, the user's
   own cookies (opt-in), or later the user's own browser profile. Never bot-check or CAPTCHA evasion, client
   impersonation of our own, online downloader sites, paid scrapers or account pools.
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
| `speech/` | Transcript with word times: captions first, local whisper if present, Gemini as fallback |
| `workspace/` | Workspace folder layout, `manifest.json`, cached pass results, `PROGRESS.md` |
| `router/` | Video type classification and the goal-based plan |
| `style/` (2.1) | Shots, cuts, palette, typography notes, `STYLE.md`, `motion-spec.json`, `ANALYSIS.md`, `TIMELINE.md` |
| `audio/` (2.2) | Loudness, silences, onsets, tempo and beat grid, cut-on-beat, spectrogram image, SFX labels |
| `exact/` (2.4) | Lottie, live web pages (WAAPI/GSAP), Figma; Rive `.riv` (`rive.ts` reads the runtime binary format, keys copied from Rive's MIT defs in `rive-defs.ts`) |
| `export/`, `compare/` (2.3) | Starter projects per renderer; render-vs-reference comparison |

Every external process goes through `tools/` (one place for timeouts, Windows quoting, `windowsHide`, killing the
tree on abort). stdout is reserved for MCP: logs go to stderr through `logger.ts`.

## Workspace

`<cwd>/.framelens/<id>/` unless `FRAMELENS_WORKSPACE` is set. `<id>`: `yt-<videoId>`, `file-<sha1 of path+size+mtime, 10 hex>`,
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
ANALYSIS.md        whole-piece reading (2.1): purpose, hook, structure, systems, why it works
TIMELINE.md        time-located sections (2.1)
STYLE.md           art direction (2.1)
motion-spec.json   machine spec (2.1, see below)
PROGRESS.md        what is done, open questions, next step — so another session can resume
```

## MCP tools (v2)

All new tools take `source` (URL, path or YouTube ID) and return a short text summary plus `structuredContent`.

| Tool | Phase | Does |
|---|---|---|
| `probe` | 2.0 | Resolve and fetch the source, probe it, report kind, duration, fps, captions, dynamics, workspace path |
| `plan` | 2.0 | Goal (or free-text request) + probe → passes, densities, ranges, token estimate |
| `transcript` | 2.0 | Word-timed transcript; returns the text (bounded) and file paths |
| `frames` | 2.0 | Frames or contact sheets for a range: `at`, `every` (s), `fps`, `every_frame`, `around` (phrase), `columns`, `rows`, `cell`, word labels. Returns sheet paths; inlines at most a few sheets |
| `boundaries` | 2.0 | Visual-change candidates with scores (not editorial cut labels) |
| `style` | 2.1 | Cuts, shots, palette, systems; writes STYLE.md, motion-spec.json, ANALYSIS/TIMELINE skeletons |
| `audio` | 2.2 | Sound analysis and spectrogram |
| `export`, `compare` | 2.3 | Starter projects; render-vs-reference report |
| Gemini tools | kept | `summarize_youtube_video`, `ask_about_youtube_video`, `extract_key_moments`, `get_video_transcript`, `list_supported_models` |

## motion-spec.json v1

```jsonc
{
  "spec": "framelens.motion/1",
  "source": { "kind": "youtube", "url": "…", "title": "…" },
  "timebase": { "fps": 30, "vfr": false, "duration": 45.2, "width": 1080, "height": 1920 },
  "anchors": {                       // time sources an exporter can re-flow to new words or music
    "words": [{ "id": "w12", "t": 3.21, "end": 3.48, "text": "faster" }],
    "beats": [{ "id": "b8", "t": 3.2, "downbeat": true }],
    "cuts":  [{ "id": "c3", "t": 3.2, "frame": 96, "evidence": "measured" }]
  },
  "palette": [{ "hex": "#0E0F1A", "role": "background", "share": 0.62, "evidence": "measured" }],
  "typography": [{ "role": "caption", "family_guess": "Inter Tight", "weight": 800, "case": "upper", "evidence": "inferred" }],
  "shots": [{ "id": "s4", "start": 3.2, "end": 4.6, "frames": 42, "anchor": "c3", "role": "B-roll" }],
  "systems": [{                        // things that live across several shots: captions, boards, sound beds
    "id": "caption", "role": "Caption", "start": 0, "end": 45.2,
    "states": [{ "t": 3.21, "anchor": "w12", "change": "word highlight", "evidence": "measured" }]
  }],
  "events": [{
    "t": 3.2, "frame": 96, "anchor": "b8", "target": "s4/title", "kind": "enter",
    "type": "slide-up + fade", "frames": 9, "easing": "cubic-bezier(.2,.8,.2,1)", "evidence": "derived"
  }],
  "audio": { "tempo_bpm": 120, "cut_on_beat_ratio": 0.82, "sfx": [{ "t": 3.21, "label": "whoosh", "evidence": "inferred" }] }
}
```

Roles use production vocabulary: A-roll, B-roll, Caption, Typography, MG, UI, SFX, Music, VO.

## Sources: social platforms

Tiers, tried in order with a clear message when one fails: 0 file or inbox folder (`FRAMELENS_INBOX`, newest
file) · 1 public link via pinned yt-dlp (gallery-dl optional fallback) · 2 opt-in cookies (Firefox profile or a
cookies.txt path; Chrome/Edge on Windows cannot work) · 3 a dedicated Frame Lens browser profile (2.4) · 3+ a
browser extension (2.5). One video per request, with pauses between requests.

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

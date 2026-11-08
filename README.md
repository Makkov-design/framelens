# ytlens

**Let your AI assistant actually watch YouTube.** ytlens is an [MCP](https://modelcontextprotocol.io) server that
sends a YouTube video to Google Gemini, which looks at the frames *and* listens to the audio. Answers cover slides,
code on screen, UI walkthroughs, charts and demos, not just the captions.

Works with Claude Code (local and cloud sessions), Claude Desktop, Cursor and any other MCP client.

[![npm](https://img.shields.io/npm/v/ytlens)](https://www.npmjs.com/package/ytlens)
[![CI](https://github.com/Makkov-design/ytlens/actions/workflows/ci.yml/badge.svg)](https://github.com/Makkov-design/ytlens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Tools

| Tool | What it does |
|---|---|
| `summarize_youtube_video` | Short, medium or long summary with timestamps |
| `ask_about_youtube_video` | Answers a question with timestamped evidence; without a question, a detailed description |
| `extract_key_moments` | Key moments as structured data: seconds, `H:MM:SS` timestamp, title, description, deep link |
| `get_video_transcript` | Timestamped transcript with speaker labels, plus on-screen text (slides, titles, code); works without captions |
| `list_supported_models` | Gemini models your key can use; marks the one in use |

Options shared by the video tools:

| Option | Meaning |
|---|---|
| `youtube_url` | Any YouTube video link (`watch`, `youtu.be`, `shorts`, `live`, `embed`, mobile, music) or the 11-character video ID |
| `start`, `end` | Analyze only part of the video: seconds (`90`), `MM:SS` or `H:MM:SS` |
| `detail` | `low` sends frames at low resolution; it saves tokens only on Gemini 2.5 models |
| `response_language` | Answer language, e.g. `Russian` (the transcript keeps the spoken language) |

## You need

- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (the free tier works)
- Node.js 20 or newer

Only public and unlisted videos can be analyzed. The free tier allows about 8 hours of YouTube video per day, and
free-tier data may be used by Google to improve its products.

The server is a single self-contained file with no dependencies, published on
[npm](https://www.npmjs.com/package/ytlens), so `npx` starts it in seconds.

## Setup

### Add ytlens to any project (works in Claude Code cloud sessions too)

Run this in the project's root folder, or just ask Claude Code to run it and commit the result:

```bash
npx -y ytlens@1.1.0 init
```

It adds two files to the project:

- `.mcp.json` with the ytlens server (other servers already in the file are kept);
- `.claude/skills/ytlens/SKILL.md`, the skill that teaches Claude how to use the tools.

Commit both. Then make your Gemini key available:

- **Cloud sessions (claude.ai/code):** open the environment settings, add `GEMINI_API_KEY=<your key>` to the
  environment variables, and keep network access on **Trusted** (it already allows GitHub and `*.googleapis.com`).
  Without a plugin, cloud sessions only load what is in the repository, which is why the files go into the project.
  If you added ytlens as a plugin in claude.ai, cloud sessions load it from your account and only the key is needed.
  Start a new session after adding the key: running sessions keep the old variables.
- **On your computer:** set `GEMINI_API_KEY` as an environment variable for your user (on Windows:
  `setx GEMINI_API_KEY "<your key>"`, then restart Claude Code).

Everyone who works in the repository gets ytlens; each person needs their own key.

No key yet? The server still starts, and every tool answers with these steps, so the agent can tell you what to do.

### Claude Code on your computer, in every project (plugin)

The plugin bundles the server and the skill:

```text
/plugin install ytlens --marketplace Makkov-design/ytlens
```

Set `GEMINI_API_KEY` as an environment variable for your user (on Windows: `setx GEMINI_API_KEY "<your key>"`, then
restart Claude Code). Optionally set `GEMINI_MODEL_NAME`.

Or add only the server, without the plugin:

```bash
claude mcp add ytlens --scope user --env GEMINI_API_KEY=<your key> -- npx -y ytlens@1.1.0
```

On Windows, put `cmd /c` before `npx` in the command.

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "ytlens": {
      "command": "npx",
      "args": ["-y", "ytlens@1.1.0"],
      "env": { "GEMINI_API_KEY": "<your key>" }
    }
  }
}
```

Always pin the version (`ytlens@1.1.0`), so a new release never runs on your machine without you choosing it.
Without npm, the same works straight from GitHub: `npx -y github:Makkov-design/ytlens#v1.1.0`.

### Docker

```bash
docker build -t ytlens https://github.com/Makkov-design/ytlens.git#v1.1.0
docker run -i --rm -e GEMINI_API_KEY=<your key> ytlens
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | required | Gemini API key |
| `GEMINI_MODEL_NAME` | `gemini-flash-lite-latest` | Model used for analysis; `list_supported_models` shows the choices. Flash-Lite has the largest free daily quota |
| `YTLENS_FALLBACK_MODELS` | `gemini-flash-latest` | Comma-separated models tried when the main model's daily quota is used up or the model is unavailable |
| `YTLENS_TIMEOUT_MS` | `300000` | Time limit for one tool call, retries included |
| `YTLENS_MAX_RETRIES` | `3` | Retries on per-minute rate limits, timeouts and server errors. A used-up daily quota is never retried |
| `YTLENS_CACHE_TTL_MINUTES` | `60` | How long identical requests are answered from memory; `0` turns the cache off |
| `YTLENS_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs go to stderr and never contain questions or answers |

## Tips for long videos

- Gemini samples about one frame per second, roughly 100 tokens per second of video. The free tier allows about
  250,000 input tokens per minute, so one request can hold about 40 minutes: analyze longer videos in parts with
  `start` / `end`.
- Free-tier limits are counted per Google Cloud project and reset at midnight Pacific time. When the daily quota of
  the main model is used up, ytlens switches to the fallback model and says so; the error names the exact limit.
- Transcripts are limited by the model's output size; request videos longer than about 30 minutes in parts.

## Security

- Only YouTube video URLs are accepted; anything else is rejected before a request is made.
- The API key travels only in request headers to Google and is removed from every error message and log line.
- Video content is untrusted. Gemini is told never to follow instructions found in a video, and every result is
  labelled as third-party content so the calling assistant treats it as information, not commands.
- Nothing is written to disk; the cache lives in memory only.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
npm ci
npm test            # unit and in-memory MCP integration tests
npm run typecheck
npm run bundle      # writes dist/ytlens.mjs; commit it together with the source change
GEMINI_API_KEY=... npm run smoke                                  # live check of every tool on a short public video
GEMINI_API_KEY=... npm run smoke -- <url> --long <url-over-1h>    # also checks clip timestamps past one hour
```

Inside this repository, `npx ytlens` resolves to the checkout itself rather than the published package, so an
MCP client configured with `npx ytlens` cannot start it here; point it at `dist/ytlens.mjs` while developing.

Code layout: `src/youtube.ts` (URLs and timestamps), `src/prompts.ts` (prompts and response schemas),
`src/analyzer.ts` (Gemini client and error mapping), `src/cache.ts`, `src/server.ts` (MCP tools), `src/index.ts`
(entry). The Claude Code plugin lives in `.claude-plugin/` and `skills/`.

## License

[MIT](LICENSE)

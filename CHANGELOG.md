# Changelog

## Unreleased

- `frames` `at` names each frame by the time of the frame shown, not the moment asked for, and a moment inside the
  last frame (up to the duration) returns that frame instead of an ffmpeg error.
- Variable frame rate is detected in Matroska/WebM files, which store no frame count.
- Folder names with an apostrophe (and `, ; [ ]`) no longer break contact-sheet labels and measurements.
- `style` times a cut on its own frame at 60 fps and above (it could be up to three frames late), and reads the
  palette of a one-frame video.
- `audio` onsets and the beat grid sit on the attack; before they were about 80 ms early. No cuts no longer
  reads as "0% of cuts on a beat".
- `plan` no longer proposes picture steps for audio files, and plans a still image as one frame; `frames` on an
  audio file says there is no picture.
- Exports: the HyperFrames index loads GSAP (without it no animation ran) and uses a bundled Inter weight; CSS
  preview scenes show only during their own slot; a multi-line source title can no longer turn into code in the
  Remotion starter.
- Every tool result that shows a title from a site carries the third-party notice.

- A per-minute input-token limit is waited out once before giving up: it is often used up by earlier requests,
  not by this one. The message no longer claims the request is too large when that is not known.
- A 429 without quota details (Google short of capacity) is retried with backoff again, as before 1.2.0.
- When the deadline would cut a retry wait short, the error says what was being waited out (rate limit, server
  error) instead of a timeout that suggests raising `FRAMELENS_TIMEOUT_MS`; such waits are no longer started.
- A missing fallback model no longer hides the used-up daily quota of the main model.
- An empty `FRAMELENS_FALLBACK_MODELS` turns fallback models off; before, it silently meant the default.
- A numeric quota limit of `0` is recognised like the usual string.

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

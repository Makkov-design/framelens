# Launch posts

English, factual, numbers only from [docs/ACCURACY.md](../ACCURACY.md) and the site. Post them yourself from your
own accounts; read each community's rules on the day (self-promotion rules change), and stay around to answer
comments for the first two hours.

Links used below:

- Site: https://makkov-design.github.io/framelens/
- Repository: https://github.com/Makkov-design/framelens
- Accuracy: https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md

---

## Show HN

**Where:** https://news.ycombinator.com/submit. Best on a weekday, 8 to 10 am US Eastern. Do not ask anyone for
upvotes.

**Title** (69 characters):

```text
Show HN: Frame Lens – an MCP server that measures video for AI agents
```

**URL:** `https://github.com/Makkov-design/framelens`

**First comment** (post it right after submitting):

```text
Hi HN. I'm a designer, and I kept asking coding agents to rebuild animations from reference videos. They
would read the captions or describe a few screenshots and say "a quick, smooth slide". That is not something you
can rebuild.

Frame Lens is a local MCP server that measures instead: real frame times, cuts, palettes, beats and word-timed
transcripts from any video, and the exact timing curve of a move. The agent says what it needs ("use this as a
reference for my promo", "summarize this podcast"), and a plan step picks how densely to look: one overview sheet
for a podcast, every frame around each move for a promo.

How it works: ffmpeg/ffprobe on your machine, a pinned yt-dlp for links, results written to a workspace folder so
tool results stay small. The `track` tool follows one element at the full frame rate with subpixel template
matching and fits a cubic-bezier or a damped spring to each property (x, y, scale, opacity), with the fit error.
Websites, Lottie, Rive and Figma prototypes are read exactly from their data instead. It exports what it found to
CSS, Remotion, HyperFrames, After Effects and Lottie, and `compare` checks your render against the reference.

Every number carries a label: measured, derived or inferred.

Accuracy, on synthetic clips with known answers (24, 30 and 60 fps): 33/33 cuts on the exact frame, 36/36 easing
families right, mean error on where a move starts 1.00 frame. `track` on 54 rendered beziers and springs (clean,
noisy, busy background) chose the right model every time, with a mean shape error of 0.1 % of the travel or less.
Those renders are a sharp square without motion blur; real footage reports its own fit error. Benchmark:
https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md

Free, MIT, no runtime dependencies (one bundled file). `npx -y framelens init` adds it to a project; it works in
Claude Code, Codex, Cursor and any MCP client. It does not generate video, and it never works around logins or bot
checks: a login-walled post is fetched only with your own cookies or browser, opt-in.

I'd love reports of measurements that are wrong, with the source and the value you expected.
```

---

## Reddit

Post as a text post with the link inside, from an account with some history in the subreddit. Pick the flair the
subreddit asks for (r/ClaudeAI: the project or "Built with Claude" flair if offered; r/mcp: "showcase" or similar).
Do not cross-post the same text within minutes: space them a few hours apart.

### r/ClaudeAI

**Title:**

```text
I built a free MCP server that lets Claude measure videos and animations instead of guessing from captions
```

**Body:**

```text
When I give Claude Code a reference video and ask it to rebuild the animation, it usually reads the captions or a
few frames and describes the motion in words. Frame Lens gives it measurements instead.

What it does:
- `plan` takes your request ("turn this tutorial into a guide", "use this as a reference for my promo") and returns
  the steps: which tools, how densely to look, which part of the video.
- Measures cuts, shots, palettes, beats, loudness and word-timed transcripts with ffmpeg on your machine.
- `track` follows one element frame by frame and fits the exact curve: a cubic-bezier or a spring, with the error.
- Reads websites, Lottie, Rive and Figma prototypes exactly from their data.
- Exports to CSS, Remotion, HyperFrames, After Effects and Lottie, then `compare` diffs your render against the
  reference.

On the benchmark (synthetic clips with known answers): 33/33 cuts on the exact frame, 36/36 easing families right,
1.00 frame mean error on move starts. Details: https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md

Install in Claude Code:
  /plugin marketplace add Makkov-design/framelens
  /plugin install framelens@framelens
or for one project: npx -y framelens init

It is free and MIT, runs locally (Node 20 and ffmpeg; missing ffmpeg/yt-dlp are fetched and hash-checked). The
Gemini tools for YouTube are optional and use your own key. Claude Code helped write and test most of it.

Repo: https://github.com/Makkov-design/framelens
Site with a scrubbable demo: https://makkov-design.github.io/framelens/

Feedback on wrong measurements is the most useful thing you can send me.
```

### r/mcp

**Title:**

```text
Frame Lens: a local MCP server for video and motion (cuts, easing curves, palettes, beats, transcripts), MIT
```

**Body:**

```text
Frame Lens is a stdio MCP server, one bundled file with no runtime dependencies, published on npm as `framelens`.

Design choices that might interest people building servers here:
- Results go to a workspace folder on disk (motion-spec.json, TIMELINE.md, contact sheets); tool results return a
  short summary plus paths, so they stay far below the token limit. The agent opens what it needs.
- A `plan` tool turns the user's goal into the next tool calls and their density, so the agent does not sample a
  three-hour podcast at 10 fps.
- Every number carries an evidence label: measured, derived (fitted) or inferred (a model's judgement).
- Missing ffmpeg/yt-dlp are downloaded on first use, pinned and SHA-256 checked (FRAMELENS_AUTO_INSTALL=0 turns it
  off).

Tools: probe, plan, transcript, frames, boundaries, style, track, audio, web, exact, export, compare, plus optional
Gemini tools for YouTube.

Benchmark on synthetic clips: 33/33 cuts on the exact frame, 36/36 easing families right, 1.00 frame mean start
error; `track` chose the right curve model on 54/54 rendered beziers and springs.
https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md

Any client: {"mcpServers": {"framelens": {"command": "npx", "args": ["-y", "framelens"]}}}
Repo: https://github.com/Makkov-design/framelens
```

### r/motiondesign

Read the sidebar first: this subreddit is strict about self-promotion. Frame it as a question to motion designers,
and skip it if the rules forbid tool posts.

**Title:**

```text
I made a free tool that reads the exact easing curve and timing of a move from any video. Would you use this?
```

**Body:**

```text
I'm a designer who does motion, and I kept hand-measuring references: stepping frames to find where a move starts, guessing
the graph editor curve. So I built a tool that does it from the video.

You give it a clip (a file or a link) and a moment. It follows the element frame by frame and fits the timing
curve: a cubic-bezier you can paste into CSS or After Effects, or a spring (stiffness, damping), with how far the
fit is off. It also finds every cut on the exact frame, the palette of each shot, and the beat grid of the music.
For Lottie, Rive and Figma files it reads the keyframes directly instead of measuring.

Example from the demo: a title move in the Big Buck Bunny trailer at 26.04 s measures as 23 frames on
cubic-bezier(0.7, 0, 0.84, 0), and it writes that move out for After Effects (keyframe speed and influence),
Lottie, CSS and Remotion.

It runs on your own computer, is free and open source, and is driven by an AI agent (Claude Code, Codex, Cursor)
rather than a UI for now.

Site with a demo you can scrub: https://makkov-design.github.io/framelens/

Honest question: which parts of your reference work would this save time on, and what would it need to measure to
be useful in your pipeline?
```

---

## X / Bluesky thread

Each part fits 280 characters (X) and 300 (Bluesky). Attach `docs/assets/og.png` or a screen recording of the
site's scrubbable demo to the first post.

```text
1/ Ask an AI agent to rebuild an animation from a video and it describes it: "a quick, smooth slide".

Frame Lens makes it measure instead: 23 frames, cubic-bezier(0.7, 0, 0.84, 0).

Free, local, MIT. https://makkov-design.github.io/framelens/
```

```text
2/ It's an MCP server for Claude Code, Codex, Cursor or any client. Tell it the goal (summarize a podcast, turn a
tutorial into a guide, copy a promo's motion) and it decides how densely to look: one sheet, or every frame
around each move.
```

```text
3/ What it measures with ffmpeg on your machine: cuts on the exact frame, shots, palettes, beats and loudness,
word-timed transcripts. `track` follows one element and fits the exact cubic-bezier or spring, with the fit error.
```

```text
4/ Websites, Lottie, Rive and Figma prototypes are read exactly from their data, not from pixels.

Then it exports to CSS, Remotion, HyperFrames, After Effects and Lottie, and compares your render with the
reference.
```

```text
5/ Benchmark on clips with known answers: 33/33 cuts on the exact frame, 36/36 easing families right, 1.00 frame
mean error on move starts. Every number says if it was measured, derived or inferred.
https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md
```

```text
6/ npx -y framelens init

Repo: https://github.com/Makkov-design/framelens
Wrong measurements are the most useful bug reports: send the source and the value you expected.
```

---

## LinkedIn

```text
AI agents can now write a whole animation in code, but give one a reference video and it still guesses: it reads
the captions or a few screenshots and describes the motion in words.

I built Frame Lens to close that gap. It's a free, open-source MCP server that gives agents like Claude Code,
Codex and Cursor eyes and ears for any video or animation:

• Cuts on the exact frame, shots, palettes, beats and word-timed transcripts, measured locally with ffmpeg
• The exact timing curve of a move (a cubic-bezier or a spring) with its fit error
• Websites, Lottie, Rive and Figma prototypes read exactly from their data
• Starter projects for CSS, Remotion, HyperFrames, After Effects and Lottie, and a compare step that checks the
  render against the reference

Every number says how it was obtained: measured, derived or inferred. On the benchmark with known answers it found
33 of 33 cuts on the exact frame and named 36 of 36 easing families right.

It runs on your own computer, costs nothing and is MIT licensed.

Site and demo: https://makkov-design.github.io/framelens/
Code: https://github.com/Makkov-design/framelens

#MotionDesign #AIagents #ClaudeCode #OpenSource #MCP
```

---

## Product Hunt

Launch at 12:01 am Pacific on a Tuesday to Thursday. Needs a maker account, a gallery (use `docs/assets/og.png` plus
2 or 3 screenshots of the site demo and a `TRACK.md` plot) and the links below.

- **Name:** Frame Lens
- **Tagline** (47 of 60 characters): `Video your AI agent can measure, frame by frame`
- **Link:** https://makkov-design.github.io/framelens/
- **Topics:** Developer Tools, Artificial Intelligence, Design Tools, Open Source
- **Pricing:** Free (open source)
- **Description** (239 of 260 characters):

```text
A free, local MCP server that gives AI agents eyes and ears for any video or animation: exact cuts, easing curves,
palettes, beats and transcripts. Reads Lottie, Rive, Figma and websites exactly; exports to CSS, Remotion and After
Effects.
```

- **First comment (maker):**

```text
Hi Product Hunt! I'm a designer. Frame Lens started because AI agents kept describing my reference videos
instead of measuring them.

Now Claude Code, Codex or Cursor can call it and get real numbers: the frame a cut lands on, the cubic-bezier or
spring of a move with its fit error, the palette of each shot, the beat grid, word-timed speech. Lottie, Rive,
Figma and live websites are read exactly from their data. It exports to CSS, Remotion, HyperFrames, After Effects
and Lottie, and compares your render with the reference.

On clips with known answers it found 33 of 33 cuts on the exact frame and 36 of 36 easing families. It runs on your
computer, is MIT licensed and free.

Try it: npx -y framelens init. I'd love to hear which reference you test it on first.
```

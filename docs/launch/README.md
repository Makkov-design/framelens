# Launch kit

Everything needed to list and announce Frame Lens. Nothing here is published automatically: each step that needs
the owner's accounts is written out with the exact command or text.

| File | What it is |
|---|---|
| [repo-settings.md](repo-settings.md) | GitHub description, homepage, topics, labels, social preview; `gh` commands to apply them |
| [listings.md](listings.md) | Official MCP Registry, Claude Code plugin, skills.sh, Glama, PulseMCP, mcp.so, Smithery: what each needs and the text to submit |
| [posts.md](posts.md) | Show HN, Reddit (r/ClaudeAI, r/mcp, r/motiondesign), X and Bluesky thread, LinkedIn, Product Hunt |
| [awesome-lists.md](awesome-lists.md) | Awesome lists to submit to, how each accepts entries, and the one-line entry |

## Order

1. Release to npm: push the tag `v<version>` on the merged bump commit; `release.yml` publishes to npm (with
   provenance from the next version on), the MCP Registry and a GitHub release (see CONTRIBUTING.md, Releasing).
2. Apply [repo-settings.md](repo-settings.md) and check the site is live.
3. Check the official MCP Registry entry ([listings.md](listings.md), section 1); `release.yml` publishes it.
   PulseMCP and other aggregators read from it.
4. Glama claim and mcp.so form.
5. Posts: Show HN first (a weekday morning, US Eastern time), Reddit and X/Bluesky the same day, LinkedIn and
   Product Hunt later in the week.
6. Awesome lists: punkpeye/awesome-mcp-servers and LottieFiles/awesome-lottie right away; the lists that ask for
   community traction once the repository has some.

## Facts used in every text

Only numbers from [docs/ACCURACY.md](../ACCURACY.md) and the site. Check them again if the benchmark is re-run.

- 33 of 33 cuts found on the exact frame; 36 of 36 easing families named right; mean error on where a move starts:
  1.00 frame (synthetic clips at 24, 30 and 60 fps).
- `track`: 54 rendered clips with known cubic-beziers and springs (clean, with noise, on a busy background): the
  right model chosen in 54 of 54, mean shape error 0.0 to 0.1 % of the travel (worst 0.4 %), spring stiffness and
  damping within 0.2 % on average.
- Limits stated in the benchmark: a sharp square without motion blur on a static background. Real footage reports
  its own fit error.
- The site demo: the Big Buck Bunny trailer read as 20 shots, 11 cuts and 10 fades and dissolves at 25 fps; a move
  at 26.04 s measured as 15 frames on `cubic-bezier(0.7, 0, 0.84, 0)` (`docs/assets/bbb/reading.js`); a live website read as 328 animations, mostly 500 ms on
  `cubic-bezier(0.16, 1, 0.3, 1)`.
- Free, local, MIT, zero runtime dependencies, Node 20; ffmpeg and yt-dlp are downloaded on first use (pinned,
  SHA-256-checked) when missing. Works in Claude Code, Codex, Cursor and any MCP
  client. Gemini tools are optional and need the user's own key.

## Links

- Site: https://makkov-design.github.io/framelens/
- Repository: https://github.com/Makkov-design/framelens
- npm: https://www.npmjs.com/package/framelens
- Accuracy: https://github.com/Makkov-design/framelens/blob/main/docs/ACCURACY.md

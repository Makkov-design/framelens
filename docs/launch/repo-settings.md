# Repository settings

For https://github.com/Makkov-design/framelens. Run the commands from any terminal where `gh` is signed in as
`Makkov-design` (`gh auth status` shows the active account; `gh auth switch -u Makkov-design` changes it).

## Description (282 of 350 characters)

```text
Eyes and ears for AI agents: a free, local MCP server that measures any video or animation (cuts, exact easing curves, palettes, beats, word-timed transcripts), reads websites, Lottie, Rive and Figma exactly, and exports to HyperFrames, Remotion, CSS, After Effects and Lottie. MIT.
```

## Homepage

```text
https://makkov-design.github.io/framelens/
```

## Topics (20, the maximum)

```text
mcp, mcp-server, model-context-protocol, claude-code, claude-code-plugin, ai-agents, video-analysis,
motion-design, animation, easing, css-animations, ffmpeg, lottie, rive, figma, remotion, hyperframes,
after-effects, transcript, youtube
```

This replaces today's set; `gemini` drops out (the Gemini tools are optional, and the description says what matters).

## Apply by API

Description and homepage:

```bash
gh repo edit Makkov-design/framelens --description "Eyes and ears for AI agents: a free, local MCP server that measures any video or animation (cuts, exact easing curves, palettes, beats, word-timed transcripts), reads websites, Lottie, Rive and Figma exactly, and exports to HyperFrames, Remotion, CSS, After Effects and Lottie. MIT." --homepage "https://makkov-design.github.io/framelens/"
```

Topics (replaces the whole list):

```bash
gh api -X PUT repos/Makkov-design/framelens/topics -f "names[]=mcp" -f "names[]=mcp-server" -f "names[]=model-context-protocol" -f "names[]=claude-code" -f "names[]=claude-code-plugin" -f "names[]=ai-agents" -f "names[]=video-analysis" -f "names[]=motion-design" -f "names[]=animation" -f "names[]=easing" -f "names[]=css-animations" -f "names[]=ffmpeg" -f "names[]=lottie" -f "names[]=rive" -f "names[]=figma" -f "names[]=remotion" -f "names[]=hyperframes" -f "names[]=after-effects" -f "names[]=transcript" -f "names[]=youtube"
```

The `measurement` label used by the "Wrong measurement" issue form (`bug` and `enhancement` exist already):

```bash
gh label create measurement -R Makkov-design/framelens --color FBCA04 --description "A cut, timing, curve, colour or beat that does not match the source"
```

Private vulnerability reporting. It is off today, and both SECURITY.md and CODE_OF_CONDUCT.md send reports through
it:

```bash
gh api -X PUT repos/Makkov-design/framelens/private-vulnerability-reporting
```

GitHub Pages from `main` / `docs` (skip if the site is already live at the homepage address):

```bash
gh api -X POST repos/Makkov-design/framelens/pages -f "source[branch]=main" -f "source[path]=/docs"
```

Check the result:

```bash
gh repo view Makkov-design/framelens --json description,homepageUrl,repositoryTopics
```

## Social preview (no API: by hand, about 1 minute)

1. Open https://github.com/Makkov-design/framelens/settings (Settings tab of the repository).
2. In "General", scroll to "Social preview" and click "Edit" > "Upload an image…".
3. Choose `docs/assets/og.png` from the checkout (1200 × 630 px, 220 KB; GitHub accepts at least 640 × 320 and up to
   1 MB).
4. To check it, paste the repository link into a new X or Slack message draft: the card shows the image (do not
   send it).

## Optional

- Releases: publish the 2.1.0 GitHub release from the tag with the CHANGELOG section as notes; directories and
  aggregators show the latest release.
- Discussions (`gh repo edit Makkov-design/framelens --enable-discussions`): only if you plan to answer them;
  issue forms cover bugs, wrong measurements and feature requests.
- Pin the repository on the `Makkov-design` profile (Profile > Customize your pins).

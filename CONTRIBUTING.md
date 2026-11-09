# Contributing to Frame Lens

Thanks for helping. Bug reports with a link or a file are the most useful thing you can send: a wrong measurement with
its source and the value you expected is worth more than a long description.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through the private
channel in [SECURITY.md](SECURITY.md), never a public issue.

## Before you start

- Read [docs/DESIGN.md](docs/DESIGN.md): its principles decide most review questions.
- For anything larger than a fix, open an issue first so we can agree on the approach.
- Frame Lens measures and reads; it does not generate footage, voices or variants (principle 8). Features in that
  direction will be declined.

## Development setup

You need Node 20 or newer, git and ffmpeg/ffprobe on `PATH` (the media tests make their own fixtures with ffmpeg and
are skipped without it). yt-dlp is only needed to try links by hand.

```bash
git clone https://github.com/Makkov-design/framelens.git
cd framelens
npm ci --ignore-scripts
npm run typecheck
```

Run the server from source through the bundle:

```bash
npm run bundle
node dist/framelens.mjs doctor
```

To try it in Claude Code, point an MCP config at your checkout:
`claude mcp add framelens-dev -- node /path/to/framelens/dist/framelens.mjs`.

## Tests

Tests use vitest. Always limit the workers: the suite renders video with ffmpeg and gets heavy fast.

```bash
npx vitest run --maxWorkers=2 test/track          # one folder or file while you work
npm test -- --maxWorkers=2                         # the whole suite before you push
```

- Every fix comes with a test that fails without it. Regressions go into the `test/regressions*.test.ts` files.
- Unit tests use no network. Media fixtures are generated (`testsrc2`, `sine`, colour cards with known cut frames)
  into a temp folder.
- A change to how something is measured needs a ground-truth check: extend `scripts/benchmark.mjs` and regenerate
  [docs/ACCURACY.md](docs/ACCURACY.md) with `node scripts/benchmark.mjs` (after `npm run bundle`). Never edit the
  numbers in that file by hand.

## The bundle and the extension are committed

The npm package has no runtime dependencies: everything is bundled into one file by esbuild. CI fails when the
committed build is out of date, so after any change under `src/` or `extension/`:

```bash
npm run bundle             # updates dist/framelens.mjs
npm run build:extension    # updates extension/dist (only when extension/ changed)
```

Commit those files together with the source change. `npm run check` runs typecheck, tests and bundle in one go
(pass `-- --maxWorkers=2` to the test step if you run `npm test` separately).

## Evidence labels

Every number Frame Lens reports carries how it was obtained (principle 1):

| Label | Meaning | Example |
|---|---|---|
| `measured` | Read from pixels, audio or the source's own data | a cut at frame 663; a Lottie keyframe |
| `derived` | Fitted or computed from measurements | `cubic-bezier(0.7, 0, 0.84, 0)` fitted to tracked positions |
| `inferred` | A model's judgement | Gemini's summary of a scene |

New output must carry the right label, and a value must never be promoted to a stronger one than its source
supports. If a number cannot be measured reliably, say so and give the error instead of a guess.

## Honest access (principle 7)

Frame Lens only reaches content the user can see, the way the user can: a file, a public link, the user's own
cookies (opt-in), their own browser profile, the browser extension in their own browser, or their own self-hosted
cobalt instance (opt-in). Pull requests that add any of the following will not be merged:

- bot-check or CAPTCHA evasion, or impersonating a client of our own;
- public online downloader sites, paid scrapers or account pools;
- sending a failure that may be access control (login, age, bot check, block, rate limit, DRM, private or paid post,
  HTTP 401/403/429/451) anywhere other than back to the user with what they can do.

The single word check that decides this lives in `src/sources/access.ts`; widen it rather than narrow it.

## Style

- TypeScript strict, ESM, small modules, plain names, short comments that explain why.
- Never write to stdout from the server: it carries the MCP protocol (a test enforces this).
- Tool results stay short and point at files in the workspace; big output goes to disk.
- Text in results, docs and errors: plain English, short sentences, say what the user can do next.

## Pull requests

- Branch from `main`, one topic per pull request, and fill in the template.
- CI must be green: typecheck, tests on Node 22 and 24, the committed bundle and extension build, the server
  starting on Node 20, 22 and 24, and the Docker build.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.
- Do not bump versions; that happens at release time (`package.json`, `src/version.ts`,
  `.claude-plugin/plugin.json` and `server.json` move together, and a test checks it).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

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
are skipped without it). The suite is tested with ffmpeg 8.0, which CI uses. On ffmpeg 6.1 (Ubuntu 24.04's package)
one test fails (`test/style/style.test.ts`, the eased move is not found); 7.x is expected to work but has not been
tested. If your system ffmpeg is older, install a newer build and put it first on `PATH`. yt-dlp is only
needed to try links by hand.

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

Commit those files together with the source change. Dependabot's npm PRs are the exception: see below.

## Dependabot PRs

Dependabot opens PRs that update dependencies: every minor and patch update together in one PR, and every major
update in a PR of its own. Because the bundle is committed, each npm update needs a rebuilt bundle, and the
`dependabot-bundle.yml` workflow does that. What to do as the maintainer:

1. Dependabot opens the PR. Its first CI run fails at "Committed bundle is up to date". That is expected.
2. Within a few minutes a commit by `github-actions[bot]` appears on the PR: "Rebuild dist/framelens.mjs and
   extension/dist for the dependency update".
3. GitHub does not run CI on that commit by itself. On the PR page, click **Approve workflows to run**. If no such
   button appears, open the **Actions** tab, choose **CI**, click **Run workflow**, pick the PR's branch
   (`dependabot/npm_and_yarn/…`) and start it.
4. Merge only when that CI run on the bot's commit is green. For a major update, also read its release notes.

If the PR later gets a merge conflict, or `main` has changed the source since the PR was opened, comment
`@dependabot recreate` on the PR. Dependabot no longer rebases a PR by itself once another account has committed to
it, and the bundle is built from the PR branch as it is, not merged with the newest `main`.

This path had not run end to end when it was added: the first Dependabot npm PR after it merged is its live test.
Check there that the bot's commit appears and that CI can be approved or started on it. `npm run check` runs typecheck, tests and bundle in one go
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
- CI must be green: typecheck, tests on Node 22 and 24 (Ubuntu) and Node 22 (Windows, without the media tests), the
  committed bundle and extension build, the bundle starting and running `probe` on Node 20, 22 and 24, and the Docker
  build.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.
- Do not bump versions; that happens at release time (`package.json`, `src/version.ts`,
  `.claude-plugin/plugin.json` and `server.json` move together, and a test checks it).
- A release is a tag on `main`; see [Releasing](#releasing).

## Releasing

For maintainers. Nothing is published by hand any more:

1. In one PR, bump the version in `package.json`, `src/version.ts`, `.claude-plugin/plugin.json` and both versions
   in `server.json` (`test/regressions.test.ts` fails when they differ), rename `## Unreleased` in `CHANGELOG.md` to
   `## <version> — <date>`, run `npm run bundle` and commit the bundle. Merge it.
2. Tag the merged commit on `main` and push the tag: `git tag v<version> <commit> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks that the commit is on `main` and that the tag, `package.json`,
   `server.json` and the changelog agree, runs typecheck, tests and the bundle, checks the committed bundle is the
   one it built, and publishes to npm through trusted publishing (GitHub OIDC, no token). It then publishes
   `server.json` to the MCP Registry (`publish-mcp-registry.yml`) and creates the GitHub release from that version's
   changelog section. Each step skips what is already done, so a failed run can be re-run.

npm provenance starts with the first version released this way, the one after 2.2.0: 2.2.0 and earlier were
published by hand and carry no provenance statement. The one-time setup (npm trusted publisher, the `npm-release`
environment, the tag ruleset) is in [docs/launch/listings.md](docs/launch/listings.md). `listings-check.yml` checks
every week that npm, the MCP Registry and the catalogues show the same version and opens an issue when one lags.

## CI notes

Things learned the hard way, so the next change does not relearn them:

- A dependency bump always changes the committed bundle, so bot PRs need the rebuild workflow (`dependabot-bundle.yml`).
- Never give a write token to a job that runs freshly bumped packages: build in a read-only job and let the privileged
  job only check and copy the files.
- Check an artifact by its exact shape, not by a path prefix: file types, modes and dot-named entries too. A `.git`
  directory or `.gitattributes` under an allowed folder is enough to change what git commits, or to run code on a later
  `git status`. "We never run it" holds only for today's commands.
- Read a platform rule in the current documentation before writing it down, above all in a security note. A push made
  with `GITHUB_TOKEN` that updates a PR does create CI runs, in an approval-required state; this was first written
  from memory as "creates no run".
- Dependabot branches cut before `dependabot-bundle.yml` merged get no rebuild: comment `@dependabot recreate`.
- Each major update is its own PR and counts toward Dependabot's default limit of 5 open version-update PRs.
- The first headless browser start on a busy runner can take more than 20 s; `CI` raises the deadline to 60 s. No
  retry: a retry would also hide real failures in the other browser tests.
- Ubuntu 24.04's ffmpeg (6.1) fails one test in `test/style/style.test.ts`; CI's runner image has 8.0.
- macOS is not in the unit-test matrix yet: `test/tools/ffmpeg.test.ts` fails there.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

# Pipeline profile

What an agent running a feature or bug-fix pipeline on this repository needs to know. Only facts the repository
already states: the source of truth is [AGENTS.md](../AGENTS.md) (part 2), [DESIGN.md](DESIGN.md) and
`.github/workflows/ci.yml`.

## Commands

| Step | Command |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run typecheck` (server and extension) |
| Tests | `npx vitest run --maxWorkers=2`; a focused folder or file first (`npx vitest run test/track --maxWorkers=2`). Media tests need ffmpeg on PATH; browser tests only with `FRAMELENS_BROWSER_TESTS=1` |
| Bundle | `npm run bundle` writes `dist/framelens.mjs`: commit it, as the last commit of a PR, and again after a rebase |
| Extension | `npm run build:extension` when `extension/` or the page reader changes: commit `extension/dist` |
| Benchmark | `node scripts/benchmark.mjs`; update `docs/ACCURACY.md` when its numbers change |

One heavy command at a time (tests, typecheck, bundle, a browser): several agents often share one machine.

## CI

`.github/workflows/ci.yml`: typecheck, tests, the bundle and extension builds (fails when the committed
`dist/framelens.mjs` or `extension/dist` is stale), the bundle starting on Node 20, 22 and 24, and the Docker image
build.

## Definition of done

- A regression test next to each fix in `test/`, failing before the fix.
- `CHANGELOG.md` entry under `## Unreleased` (`### Added`, `### Changed`, `### Fixed`); no version bump in a fix PR.
- README, `skills/framelens/SKILL.md` and `docs/llms.txt` in step with tool names, parameters and numbers.
- Evidence labels, honest access, untrusted third-party text and no runtime dependencies, as AGENTS.md states.
- A newly pinned binary hash comes from the upstream release's own checksum file; the PR says how it was checked.

## Known environment differences

- Ubuntu's ffmpeg 6.1 fails `test/style/style.test.ts` ("writes a spec with cuts, palette and an eased move"): the
  move near 6.1 s is not classified as motion there. CI's ffmpeg passes it.
- `docker build` in a cloud session needs the proxy's CA inside the image for `apk add`; CI builds the image as is.

## Lessons

- Code that spawns ffmpeg itself (a pipe: `src/track/decode.ts`, `src/style/motion.ts`) must not use
  `tools.ffmpeg` directly: until a tool is located it is the bare name, and a pinned-only install is not on PATH.
  Use `spawnPath(tools, "ffmpeg")` (`src/tools/spawn-path.ts`). A test can only catch this with the process PATH
  emptied too (`test/tools/pinned-only.test.ts`), because a bare spawn otherwise finds the system ffmpeg.
- A paid or remote fallback (Gemini) belongs behind the call that needs its result, not behind a helper several
  tools share for optional data; remember its failures, or every retry spends the user's quota again.
- Warnings a tool writes to `PROGRESS.md` are not seen by the agent: return them in the tool result as well.

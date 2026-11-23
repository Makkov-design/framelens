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
  tools share for optional data.
- A memo of failures must not outlive the failure. Remember only what the same request would hit again (a missing
  key, a blocked video, the day's quota, an unreadable answer); let overload, timeouts and per-minute limits through,
  or one bad minute blocks a tool until a restart the agent cannot do. Key the memo by exactly what the call depends
  on (the Gemini transcript ignores `language`, so the key is the source alone). Test a transient and a permanent kind.
- Warnings a tool writes to `PROGRESS.md` are not seen by the agent: return them in the tool result as well.
- Shared on-disk state needs a lock where it is created: two tool calls on the same new link raced on one workspace.
  The lock is keyed by the workspace folder (`resolveSource`), waiters get the leader's record or error, and a
  waiter whose leader was cancelled retries instead of inheriting the cancellation.
- Every child process goes through `tools/children.ts` (`spawnTracked`): its own process group, registered, and
  killed on cancel and shutdown. A bare `spawn` or `execFile` outlives the call and the server. Code that swallows an
  error to retry (`catch {}` around ffmpeg) must rethrow `CancelledError`.
- A per-call cancel signal must never reach shared or memoized work. The first-use install was shared by all calls
  but ran under the first caller's signal, so one cancelled call failed every other call and a client that cancels on
  timeout restarted the install from zero each time; a memo (`hasDrawtext`) cached `false` from a cancelled call.
  Shared work runs outside any call (`outsideCall`) on its own limits and each caller waits with `untilAborted`;
  workspace writes refuse under a cancelled call. Sweep for `??=`, module-level maps and `.catch(() => …)`.
- Pinned-build lookups take the platform and arch they are asked for, never `process.arch` behind the caller's back:
  tests that fake `linux-x64` failed on arm64 macOS runners because `findTool` looked for the machine's arch.
  Reproduce such a failure on any host by overriding `process.arch` in the test.
- Exit on stdin EOF only after the requests already received are answered: a client that pipes its requests and
  closes stdin is normal (CI's start check is one). `runtime/stdio.ts` counts requests at the transport, so every
  tool is covered, and a cancelled request counts as answered.
- Shutdown is tested against the real server over stdio, built from the current source in the test
  (`test/runtime/shutdown.test.ts`): a piped client that closes stdin gets every answer, and SIGTERM kills a running
  download's process group.
- "The parent died" is not "the client died": launchers such as `npx` put `sh -c` and `npm exec` between client and
  server, and they outlive the client. The reliable sign is the pipe itself: a write to the client fails once its
  end is closed, so a server that must notice a dead client writes something valid (an MCP `ping`) and treats EPIPE
  as gone. Test it through a launcher that stays alive, not only with the client as the direct parent.
- A safety check written for one download route belongs to every route that fetches third-party addresses: the
  cobalt path checked each redirect hop while `exact` link downloads followed any redirect. Reuse the one check
  (`checkHop`, `pinnedGet`) rather than writing a second, and test a hop to a private address over a real socket.
- A limit that a tool enforces only from metadata is no limit when the metadata is missing: yt-dlp's
  `--max-filesize` skips streams of unknown size. Enforce caps on what is actually written or read.
- Chain streams with `stream.pipeline`, never `.pipe()`: `pipe` neither passes errors on nor closes the source when
  the reader stops, so an open socket's later abort became an unhandled `'error'` that ended the server. Test hostile
  answers (endless, broken, stalled, cut) in a process of their own and wait past every time limit
  (`test/runtime/download-guard.test.ts`). A quick fix to a review finding needs the same scrutiny: two of this PR's
  three audit findings came from such fixes.
- A filter that skips files must match the exact name our side writes, never a substring the remote side can put in a
  name: yt-dlp keeps dots in a site-chosen format id, so `.includes(".temp.")` let a manifest switch the size watch off.
- A size cap measures what is on disk: an archive's own size fields can lie (`unzip -Zt` reads them), so measure the
  extracted files before copying them anywhere that matters.

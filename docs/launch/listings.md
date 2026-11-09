# Directory listings

Checked against each directory's own docs on 9 November 2026. Repository files they read are already committed:
`server.json` and `mcpName` in `package.json` (MCP Registry), `glama.json` (Glama), `.claude-plugin/` (Claude Code
plugin, with `icon.png`), `skills/framelens/SKILL.md` (skills.sh).

| Directory | How it lists | What the owner does | Time |
|---|---|---|---|
| Official MCP Registry | `server.json` published under `io.github.Makkov-design/framelens` | Run one workflow after the npm release | 5 min |
| PulseMCP | Submissions paused; it will read the official registry | Nothing; check later | 0 |
| Glama | Indexes GitHub; `glama.json` lets the owner claim the listing | Sign in with GitHub, claim | 10 min |
| mcp.so | Web form | Fill in the form | 5 min |
| Claude Code plugin | This repository is its own marketplace | Nothing (already works); optional official directory | 0 to 15 min |
| skills.sh | Ranked from `npx skills` install telemetry | Nothing; use the command in posts | 0 |
| Smithery | Publishing closed on 31 October 2026 | Nothing | 0 |

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

- Name: `io.github.Makkov-design/framelens`. The case matters: the registry grants GitHub users the namespace
  `io.github.<login>/*` with the login exactly as GitHub spells it (`Makkov-design`), and compares names
  case-sensitively. A lowercase `io.github.makkov-design/...` would be refused.
- The registry checks ownership by reading `mcpName` from the npm package of the same version, so the version in
  `server.json` must already be on npm with that `mcpName`. framelens 2.0.0 on npm has none: the first version that
  can be listed is 2.1.0.
- `server.json` follows schema `2025-12-11`; it was checked with ajv against
  https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json and with the registry's own
  `POST /v0.1/validate` (result `{"valid":true,"issues":[]}`). Description: 98 of 100 characters.
- A test (`test/regressions.test.ts`) fails if `server.json`'s name or versions drift from `package.json`, so the
  release bump has to move `package.json`, `src/version.ts`, `.claude-plugin/plugin.json` and both versions in
  `server.json` together.

### Publish (recommended: GitHub Actions, no download)

After `npm publish` of 2.1.0:

1. Open https://github.com/Makkov-design/framelens/actions/workflows/publish-mcp-registry.yml
2. Click "Run workflow", keep branch `main`, click the green "Run workflow".
3. Wait about a minute. A green tick means it is published. The first step stops with a clear message if npm does not
   have the right version yet.
4. Check: https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Makkov-design/framelens shows the
   entry.

The workflow logs in with GitHub's OIDC token (no secret to create), downloads `mcp-publisher` v1.8.8 and checks its
Sigstore signature before running it, then runs `mcp-publisher validate` and `mcp-publisher publish`.

### Publish by hand (fallback, Windows PowerShell)

Downloads the official CLI from the registry's own GitHub release and checks it against the release's checksum file.

```powershell
gh release download v1.8.8 -R modelcontextprotocol/registry -p "mcp-publisher_windows_amd64.tar.gz" -p "registry_1.8.8_checksums.txt" -D $env:TEMP\mcp-publisher
```

```powershell
cd $env:TEMP\mcp-publisher; (Get-FileHash mcp-publisher_windows_amd64.tar.gz -Algorithm SHA256).Hash.ToLower(); Select-String "mcp-publisher_windows_amd64.tar.gz$" registry_1.8.8_checksums.txt
```

The two hashes must be equal (v1.8.8: `20417546bc6798acee317570c0d4041840069e081baa562dc9414c651eb274fa`). If they
differ, stop. Then unpack and publish from the repository folder:

```powershell
tar xf mcp-publisher_windows_amd64.tar.gz mcp-publisher.exe
```

```powershell
cd "D:\Perosnal projects\Youtube-vision-mcp-upgrade"; & "$env:TEMP\mcp-publisher\mcp-publisher.exe" validate
```

```powershell
& "$env:TEMP\mcp-publisher\mcp-publisher.exe" login github
```

It prints a code and https://github.com/login/device: open the link signed in as `Makkov-design`, enter the code,
approve. Then:

```powershell
& "$env:TEMP\mcp-publisher\mcp-publisher.exe" publish
```

Expected: `✓ Server io.github.Makkov-design/framelens version 2.1.0`. Each later release: bump, `npm publish`, run
the workflow again.

## 2. PulseMCP (pulsemcp.com)

The submit page says new submissions and listing changes are paused, and asks servers to publish to the official
MCP Registry, which PulseMCP will pick up automatically. Nothing to do beyond section 1. If submissions reopen
(https://www.pulsemcp.com/submit), use the mcp.so text below.

## 3. Glama (glama.ai/mcp/servers)

Glama indexes MCP servers on GitHub, builds them and grades license, quality and maintenance. `glama.json` in the
repository root names `Makkov-design` as maintainer, which lets that account claim the listing.

1. Open https://glama.ai/mcp/servers and search "framelens". If it is listed, open it and choose "Claim"; sign in
   with GitHub as `Makkov-design`. If it is not listed yet, click "Add Server" and give
   `https://github.com/Makkov-design/framelens`.
2. In the server's admin page, set the Dockerfile to the repository's `Dockerfile` (it bundles the server and runs
   `node framelens.mjs` over stdio as the unprivileged `node` user). Glama's build then checks that the server
   starts and lists its tools.
3. Edit the listing text with the description below.
4. Once listed, the awesome-mcp-servers entry can carry Glama's score badge (see awesome-lists.md).

Listing text:

> Frame Lens gives AI agents eyes and ears for any video or animation. It measures cuts, shots, easing curves,
> palettes, beats and word-timed transcripts with ffmpeg on your own machine, reads animations exactly from websites,
> Lottie, Rive and Figma, and exports starter projects to HyperFrames, Remotion, CSS, After Effects and Lottie.
> Every number says whether it was measured, derived or inferred. Free, MIT, zero runtime dependencies.

## 4. mcp.so

Form at https://mcp.so/submit: type "MCP Server", Repository URL `https://github.com/Makkov-design/framelens`, Name
`Frame Lens`. Use the free submission; the $39 option only skips their review queue. If the form asks for more:

- Description: the Glama listing text above.
- Tags: video, motion design, animation, transcript, ffmpeg, lottie, claude code.
- Config:

```json
{ "mcpServers": { "framelens": { "command": "npx", "args": ["-y", "framelens"] } } }
```

## 5. Claude Code plugin

`.claude-plugin/marketplace.json` makes this repository its own marketplace; `claude plugin validate ./` passes with
no warnings (the PNG icon was added for the plugin directory check). Users install with:

```text
/plugin marketplace add Makkov-design/framelens
/plugin install framelens@framelens
```

or from a shell: `claude plugin install framelens --marketplace Makkov-design/framelens` (Claude Code 2.1.292 or
later). Changes reach users when `version` in `.claude-plugin/plugin.json` changes, which the release bump does.

Optional: submit to Anthropic's plugin directory through the developer portal (the validator calls it "the plugin
directory"). It runs a safety scan and a policy review; the PNG icon is used as the listing icon the first time the
plugin is submitted and cannot be changed later, so submit only once the icon is final.

## 6. skills.sh

`npx skills add Makkov-design/framelens` finds `skills/framelens/SKILL.md` (the `skills` CLI scans `skills/<name>/`
and also reads `.claude-plugin` manifests; it needs Node 22.20 or later). There is no submission: skills.sh ranks
skills by anonymous install telemetry from the CLI, so the listing appears once people install it. Mention the
command in posts aimed at agent users (it installs the skill only; the MCP server still comes from npm).

## 7. Smithery

Smithery shut down its connection services, accounts, API keys and CLI on 31 October 2026 and remains a public
directory now run with Arcade.dev. There is no publishing path for a local stdio server, so no `smithery.yaml` was
added. Nothing to do.

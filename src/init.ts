import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInputError } from "./errors.js";
import { VERSION } from "./version.js";

/** Where projects fetch the server from: this exact version of the npm package, a small download that needs no tag. */
export const SERVER_SPEC = `framelens@${VERSION}`;

/** The same version straight from GitHub, for people who do not want npm (a larger download of the tagged commit). */
export const GITHUB_SERVER_SPEC = `github:Makkov-design/framelens#v${VERSION}`;

const SKILL_SOURCE = new URL("../skills/framelens/SKILL.md", import.meta.url);

export interface InitResult {
  /** Paths written, relative to the project. */
  files: string[];
}

/**
 * `framelens init`: adds framelens to a project, so Claude Code (local or cloud) picks it up from the repository:
 * the server entry in `.mcp.json` (other servers are kept) and the skill in `.claude/skills/framelens/`.
 * The entry starts `npx` itself, as before: the file is shared with cloud sessions, which run Linux, so it carries no
 * Windows `cmd /c` wrapper.
 */
export function initProject(projectDir: string): InitResult {
  const mcpPath = join(projectDir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      throw new InvalidInputError(`${mcpPath} is not valid JSON. Fix or remove it, then run init again.`);
    }
  }
  // A project set up with ytlens, the earlier name, gets the renamed server instead of a second copy.
  const { ytlens: _legacy, ...servers } = config.mcpServers ?? {};
  config.mcpServers = {
    ...servers,
    framelens: {
      command: "npx",
      args: ["-y", SERVER_SPEC],
      env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);

  const skillDir = join(projectDir, ".claude", "skills", "framelens");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), readFileSync(SKILL_SOURCE, "utf8"));

  return { files: [".mcp.json", ".claude/skills/framelens/SKILL.md"] };
}

export const INIT_NEXT_STEPS = `
Next steps:
  1. Commit .mcp.json and .claude/skills/framelens/ to the repository.
  2. Start a new Claude Code session in the project and ask your agent about any video, link, file, site, Lottie or
     Rive. The local tools need no API key.
  3. Optional, only for the Gemini YouTube tools (summaries and questions about a YouTube link, also in cloud sessions
     without ffmpeg): make GEMINI_API_KEY available where Claude Code runs:
     - cloud sessions (claude.ai/code): add GEMINI_API_KEY=<your key> to the environment's variables;
     - on your computer: set GEMINI_API_KEY as an environment variable.
     Get a key at https://aistudio.google.com/apikey
`;

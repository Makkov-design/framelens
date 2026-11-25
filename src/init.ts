import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInputError } from "./errors.js";
import { oneLine } from "./text.js";
import { VERSION } from "./version.js";

/** Where projects fetch the server from: this exact version of the npm package, a small download that needs no tag. */
export const SERVER_SPEC = `framelens@${VERSION}`;

/** The same version straight from GitHub, for people who do not want npm (a larger download of the tagged commit). */
export const GITHUB_SERVER_SPEC = `github:Makkov-design/framelens#v${VERSION}`;

const SKILL_SOURCE = new URL("../skills/framelens/SKILL.md", import.meta.url);

export interface InitResult {
  /** Paths written, relative to the project. */
  files: string[];
  /** Settings in .mcp.json that look like a literal secret (`server.env.NAME`), never their values. */
  secrets: string[];
}

/**
 * `framelens init`: adds framelens to a project, so Claude Code (local or cloud) picks it up from the repository:
 * the server entry in `.mcp.json` (other servers, and settings added to an existing entry, are kept) and the skill in
 * `.claude/skills/framelens/`.
 * The entry starts `npx` itself, as before: the file is shared with cloud sessions, which run Linux, so it carries no
 * Windows `cmd /c` wrapper.
 */
export function initProject(projectDir: string): InitResult {
  const mcpPath = join(projectDir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  // An existing file keeps its indentation (tabs or a number of spaces), so the change reads as one entry in a diff.
  let indent: string | number = 2;
  if (existsSync(mcpPath)) {
    indent = /^\{\s*\n([ \t]+)\S/.exec(readFileSync(mcpPath, "utf8"))?.[1] ?? 2;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      throw new InvalidInputError(`${mcpPath} is not valid JSON. Fix or remove it, then run init again.`);
    }
    if (!asObject(parsed)) throw new InvalidInputError(`${mcpPath} does not hold a JSON object. Fix or remove it, then run init again.`);
    config = parsed as typeof config;
    if (config.mcpServers !== undefined && !asObject(config.mcpServers)) {
      throw new InvalidInputError(`"mcpServers" in ${mcpPath} is not an object. Fix or remove it, then run init again.`);
    }
  }
  // A project set up with ytlens, the earlier name, gets the renamed server instead of a second copy.
  const { ytlens: legacy, ...servers } = config.mcpServers ?? {};
  // An entry that is already there keeps what the user added (more environment variables, a timeout, ...): only the
  // command and its arguments, which pin the version, are rewritten, and the Gemini key is added when missing.
  const existing = asObject(servers.framelens) ?? asObject(legacy) ?? {};
  config.mcpServers = {
    ...servers,
    framelens: {
      ...existing,
      command: "npx",
      args: ["-y", SERVER_SPEC],
      env: { GEMINI_API_KEY: "${GEMINI_API_KEY}", ...asObject(existing.env) },
    },
  };
  // Written next to it and renamed over it, so an interrupted run never leaves a half-written .mcp.json.
  const temp = `${mcpPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, indent)}\n`);
    renameSync(temp, mcpPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  const skillDir = join(projectDir, ".claude", "skills", "framelens");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), readFileSync(SKILL_SOURCE, "utf8"));

  const files = [".mcp.json", ".claude/skills/framelens/SKILL.md"];
  if (ignoreWorkspace(projectDir)) files.push(".gitignore");
  return { files, secrets: literalSecrets(config.mcpServers) };
}

/**
 * In a git repository, `.framelens/` (downloads, transcripts, the full source links) is added to `.gitignore` unless
 * an entry already ignores it. Returns whether the file was changed.
 */
function ignoreWorkspace(projectDir: string): boolean {
  if (!existsSync(join(projectDir, ".git"))) return false;
  const file = join(projectDir, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).some((line) => /^\/?\.framelens\/?(\*\*?)?\s*$/.test(line.trim()))) return false;
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Frame Lens workspaces (downloads, transcripts, source links)\n.framelens/\n`);
  return true;
}

const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|cookie/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abpr]-|AIza|glpat-|eyJ)[\w.-]{10,}/;

/**
 * Settings in the servers' `env` and `headers` (and their arguments) that hold a value rather than a `${VAR}`
 * reference and look like a secret, by their name or their form. Only where they are is returned, never the value.
 */
export function literalSecrets(servers: Record<string, unknown> | undefined): string[] {
  const found: string[] = [];
  for (const [name, entry] of Object.entries(servers ?? {})) {
    const server = asObject(entry);
    if (!server) continue;
    for (const field of ["env", "headers"]) {
      for (const [key, value] of Object.entries(asObject(server[field]) ?? {})) {
        if (typeof value !== "string" || !value.trim() || /^\$\{[^}]+\}$/.test(value.trim())) continue;
        if (SECRET_NAME.test(key) || SECRET_VALUE.test(value.trim())) found.push(`${oneLine(name, 60)}.${field}.${oneLine(key, 60)}`);
      }
    }
    const args = Array.isArray(server.args) ? server.args : [];
    if (args.some((a) => typeof a === "string" && SECRET_VALUE.test(a.replace(/^--?[\w-]+=/, "")))) found.push(`${oneLine(name, 60)}.args`);
    if (typeof server.url === "string" && secretInUrl(server.url)) found.push(`${oneLine(name, 60)}.url`);
  }
  return found;
}

/** A server address that carries a user name and password, or a secret-like query value (`?api_key=…`). */
function secretInUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return SECRET_VALUE.test(text);
  }
  if (url.password || url.username) return true;
  return [...url.searchParams].some(([key, value]) => value && !/^\$\{[^}]+\}$/.test(value) && (SECRET_NAME.test(key) || SECRET_VALUE.test(value)));
}

/** What to do after `init`. With a literal secret in .mcp.json, step 1 warns instead of saying to commit it. */
export function initNextSteps(result: InitResult): string {
  if (!result.secrets.length) return INIT_NEXT_STEPS;
  return INIT_NEXT_STEPS.replace(
    /  1\. Commit[^\n]*\n/,
    `  1. Do not commit .mcp.json yet: ${result.secrets.join(", ")} look like secrets written into it. Replace each value with a\n` +
      '     reference such as "GITHUB_TOKEN": "${GITHUB_TOKEN}" and set the variable where Claude Code runs, then commit\n' +
      "     .mcp.json and .claude/skills/framelens/.\n",
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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

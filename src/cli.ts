import { login, logout } from "./browser/capture.js";
import { runDoctor } from "./doctor.js";
import { ConfigError, InvalidInputError } from "./errors.js";
import { INIT_NEXT_STEPS, initProject } from "./init.js";
import { VERSION } from "./version.js";

export const HELP = `Frame Lens ${VERSION}: eyes and ears for AI agents (an MCP server).

Usage: framelens [command]

  (no command)        start the MCP server on stdio; MCP clients run this
  init                add Frame Lens to the project in this folder (.mcp.json and the agent skill)
  doctor [--prepare]  show which tools are found and which settings are used; --prepare downloads the
                      pinned yt-dlp (and ffmpeg when it is missing) now
  login <site>        log in yourself, in a separate Frame Lens browser profile, to a site that needs it
                      (instagram, facebook, x, threads, linkedin, vimeo, tiktok)
  logout              delete that browser profile and its logins
  --version, -v       print the version
  --help, -h          print this help

The local tools need no API key. GEMINI_API_KEY (optional) turns on the Gemini YouTube tools.
More: https://github.com/Makkov-design/framelens#readme
`;

/**
 * Runs a command-line command. Commands print to stdout like any CLI; only the server itself (no command) keeps
 * stdout for the MCP protocol. Returns `handled: false` when there is no command, so the caller starts the server.
 */
export async function runCommand(
  args: string[],
  options: { print?: (text: string) => void; cwd?: string } = {},
): Promise<{ handled: boolean; exitCode?: number }> {
  const print = options.print ?? ((text: string) => process.stdout.write(text));
  const cwd = options.cwd ?? process.cwd();
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      return { handled: false };
    case "init": {
      const { files } = initProject(cwd);
      print(`framelens ${VERSION}: added ${files.join(" and ")} to ${cwd}\n${INIT_NEXT_STEPS}`);
      return { handled: true };
    }
    case "doctor":
      return { handled: true, exitCode: await runDoctor({ prepare: rest.includes("--prepare"), cwd, write: (line) => print(`${line}\n`) }) };
    case "login": {
      const site = rest[0];
      if (!site) throw new InvalidInputError("Say which site: framelens login instagram (or facebook, x, threads, linkedin, vimeo, tiktok).");
      await login(site, print);
      return { handled: true };
    }
    case "logout":
      print(logout() ? "The Frame Lens browser profile and its logins were deleted.\n" : "There was no Frame Lens browser profile.\n");
      return { handled: true };
    case "--version":
    case "-v":
      print(`${VERSION}\n`);
      return { handled: true };
    case "--help":
    case "-h":
    case "help":
      print(HELP);
      return { handled: true };
    default:
      throw new ConfigError(`Unknown command "${command}". Run "framelens --help" for the commands, or run without arguments to start the MCP server.`);
  }
}

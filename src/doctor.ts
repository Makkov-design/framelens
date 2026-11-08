import { hasLoginProfile } from "./browser/capture.js";
import { findBrowser } from "./browser/cdp.js";
import { readEnv, findTool, prepareYtDlp, readToolVersion, TOOL_ENV, ToolError, YTDLP_PIN, missingToolMessage, type Env, type ToolName } from "./tools/index.js";

export interface DoctorOptions {
  /** Download the pinned yt-dlp when it is not there yet. */
  prepare?: boolean;
  env?: Env;
  /** Defaults to stderr: stdout belongs to the MCP protocol. */
  write?: (line: string) => void;
  signal?: AbortSignal;
}

const UNLOCKS: Record<ToolName, string> = {
  ffmpeg: "frames, contact sheets, merging downloads",
  ffprobe: "probe: duration, fps, size, audio",
  "yt-dlp": "links: YouTube and other sites, captions",
};

/** Prints what is installed and what each tool unlocks. Returns the process exit code. */
export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  let exitCode = 0;

  if (options.prepare) {
    try {
      const prepared = await prepareYtDlp({ env, signal: options.signal, log: out });
      out(prepared.downloaded ? `yt-dlp ${prepared.version} installed and verified.` : `yt-dlp ${prepared.version} was already installed and verified.`);
    } catch (error) {
      exitCode = 1;
      out(`Could not prepare yt-dlp: ${error instanceof Error ? error.message : String(error)}`);
    }
    out("");
  }

  out("Frame Lens tools");
  for (const name of ["ffmpeg", "ffprobe", "yt-dlp"] as const) {
    try {
      const location = findTool(name, { env });
      if (!location) {
        out(`  [missing] ${name}: unlocks ${UNLOCKS[name]}`);
        out(`            ${missingToolMessage(name)}`);
        continue;
      }
      const version = await readToolVersion(location, options.signal);
      const note = name === "yt-dlp" && location.source !== "pinned" && version !== YTDLP_PIN.version ? ` (pinned release is ${YTDLP_PIN.version}; \`doctor --prepare\` installs it)` : "";
      out(`  [ok]      ${name} ${version ?? "(version unknown)"} via ${location.source}: ${location.path}${note}`);
      out(`            unlocks ${UNLOCKS[name]}`);
    } catch (error) {
      out(`  [problem] ${name}: ${error instanceof ToolError ? error.message : String(error)}`);
    }
  }

  const browser = findBrowser(env as Record<string, string | undefined>);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (browser && nodeMajor >= 22) {
    out(`  [ok]      browser ${browser}`);
    out("            unlocks web: live page animations, fonts and colours; login: sites that need your own login");
  } else {
    out(`  [missing] browser: unlocks web and login (${!browser ? "install Chrome or Edge, or set FRAMELENS_BROWSER" : `needs Node.js 22 or newer, this is ${process.versions.node}`})`);
  }
  out(`  Login profile (framelens login): ${hasLoginProfile() ? "set up" : "not set up"}`);

  out("");
  out("Settings");
  const geminiKey = readEnv(env, "GEMINI_API_KEY") ?? readEnv(env, "GOOGLE_API_KEY");
  out(`  Gemini key: ${geminiKey ? "set" : "not set"} (cloud video descriptions; local analysis works without it)`);
  out(`  Inbox folder (FRAMELENS_INBOX): ${readEnv(env, "FRAMELENS_INBOX") ?? "not set"}`);
  const cookies = readEnv(env, "FRAMELENS_COOKIES_FILE") ? "cookies file" : readEnv(env, "FRAMELENS_COOKIES_FROM_BROWSER") ? "browser profile" : "off";
  out(`  Cookies (opt-in): ${cookies}`);
  out(`  Overrides: ${Object.values(TOOL_ENV).filter((n) => readEnv(env, n)).join(", ") || "none"}`);
  return exitCode;
}

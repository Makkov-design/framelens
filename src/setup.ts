import type { VideoAnalyzer } from "./analyzer.js";
import { DEFAULT_MODEL } from "./config.js";
import { AnalyzerError } from "./errors.js";

/**
 * What the Gemini tools answer without a key. Only those tools say it: the local tools (plan, frames, style,
 * transcript from captions, …) need no key, so the message must not suggest the whole server does.
 */
export const SETUP_STEPS =
  "The Gemini YouTube tools (summarize_youtube_video, ask_about_youtube_video, extract_key_moments, get_video_transcript, " +
  "list_supported_models) need the user's own Gemini API key, free at https://aistudio.google.com/apikey. " +
  "The local Frame Lens tools need no key: for this video, `plan` and the steps it lists work without one. " +
  "To add the key on a computer: set GEMINI_API_KEY in the environment, or in the \"env\" section of the MCP config, then restart the client. " +
  "In a Claude cloud session (claude.ai/code): open the environment's settings, add GEMINI_API_KEY=<your key> under Environment variables, then start a new session.";

/**
 * Stands in for the Gemini analyzer when no key is configured, so the server still starts and the
 * agent can tell the user what to do, instead of the tools silently missing from the session.
 */
export function createSetupAnalyzer(reason: string): VideoAnalyzer {
  const fail = (): never => {
    throw new AnalyzerError("auth", `${reason} ${SETUP_STEPS}`);
  };
  return {
    model: process.env.GEMINI_MODEL_NAME?.trim() || DEFAULT_MODEL,
    analyze: async () => fail(),
    listModels: async () => fail(),
  };
}

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AnalyzerError, MissingKeyError } from "../src/errors.js";
import { createSetupAnalyzer, SETUP_STEPS } from "../src/setup.js";

describe("setup mode without a key", () => {
  it("marks a missing or placeholder key as MissingKeyError", () => {
    expect(() => loadConfig({})).toThrow(MissingKeyError);
    expect(() => loadConfig({ GEMINI_API_KEY: "${GEMINI_API_KEY}" })).toThrow(MissingKeyError);
  });

  it("keeps other config errors fatal", () => {
    let error: unknown;
    try { loadConfig({ GEMINI_API_KEY: "k", FRAMELENS_LOG_LEVEL: "loud" }); } catch (e) { error = e; }
    expect(error).not.toBeInstanceOf(MissingKeyError);
  });

  it("says once, and only for the Gemini tools, how to add a key; the local tools need none", async () => {
    // 2.1.0 joined config's "Create a key at …" to "To use framelens, add a Gemini API key …": two key how-tos, and
    // a message that read as if the whole server needed a key.
    for (const env of [{}, { GEMINI_API_KEY: "${GEMINI_API_KEY}" }]) {
      let reason = "";
      try {
        loadConfig(env);
      } catch (e) {
        reason = (e as Error).message;
      }
      const message = await createSetupAnalyzer(reason).analyze({} as never).then(() => "", (e: Error) => e.message);
      expect(message.match(/aistudio\.google\.com/g)).toHaveLength(1);
      expect(message.match(/set GEMINI_API_KEY/gi)).toHaveLength(1);
      expect(message).not.toMatch(/To use framelens/i);
      expect(message).toMatch(/Gemini YouTube tools/);
      expect(message).toMatch(/local Frame Lens tools need no key/);
    }
  });

  it("answers every call with the reason and the cloud and computer steps", async () => {
    const analyzer = createSetupAnalyzer("GEMINI_API_KEY is not set.");
    const call = analyzer.analyze({} as never);
    await expect(call).rejects.toBeInstanceOf(AnalyzerError);
    await expect(analyzer.analyze({} as never)).rejects.toThrow(/GEMINI_API_KEY is not set\..*cloud session/);
    await expect(analyzer.listModels()).rejects.toThrow(SETUP_STEPS);
  });
});

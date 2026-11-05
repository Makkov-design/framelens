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
    try { loadConfig({ GEMINI_API_KEY: "k", YTLENS_LOG_LEVEL: "loud" }); } catch (e) { error = e; }
    expect(error).not.toBeInstanceOf(MissingKeyError);
  });

  it("answers every call with the reason and the cloud and computer steps", async () => {
    const analyzer = createSetupAnalyzer("GEMINI_API_KEY is not set.");
    const call = analyzer.analyze({} as never);
    await expect(call).rejects.toBeInstanceOf(AnalyzerError);
    await expect(analyzer.analyze({} as never)).rejects.toThrow(/GEMINI_API_KEY is not set\..*cloud session/);
    await expect(analyzer.listModels()).rejects.toThrow(SETUP_STEPS);
  });
});

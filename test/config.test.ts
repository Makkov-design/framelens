import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({ GEMINI_API_KEY: "k" })).toEqual({
      apiKey: "k",
      model: DEFAULT_MODEL,
      fallbackModels: ["gemini-flash-latest"],
      timeoutMs: 300_000,
      maxRetries: 3,
      cacheTtlMs: 60 * 60_000,
      logLevel: "info",
    });
  });

  it("reads every variable", () => {
    expect(
      loadConfig({
        GEMINI_API_KEY: " key ",
        GEMINI_MODEL_NAME: " gemini-x ",
        FRAMELENS_FALLBACK_MODELS: " gemini-y , gemini-x,,gemini-y ",
        FRAMELENS_TIMEOUT_MS: "1000",
        FRAMELENS_MAX_RETRIES: "0",
        FRAMELENS_CACHE_TTL_MINUTES: "0",
        FRAMELENS_LOG_LEVEL: "DEBUG",
      }),
    ).toEqual({
      apiKey: "key",
      model: "gemini-x",
      fallbackModels: ["gemini-y"],
      timeoutMs: 1000,
      maxRetries: 0,
      cacheTtlMs: 0,
      logLevel: "debug",
    });
  });

  it("falls back to GOOGLE_API_KEY", () => {
    expect(loadConfig({ GOOGLE_API_KEY: "g" }).apiKey).toBe("g");
    expect(loadConfig({ GEMINI_API_KEY: "a", GOOGLE_API_KEY: "g" }).apiKey).toBe("a");
  });

  it("still reads settings named for ytlens, the earlier name", () => {
    const config = loadConfig({ GEMINI_API_KEY: "k", YTLENS_TIMEOUT_MS: "2000", FRAMELENS_MAX_RETRIES: "1", YTLENS_MAX_RETRIES: "5" });
    expect(config.timeoutMs).toBe(2000);
    expect(config.maxRetries).toBe(1);
  });

  it("never falls back to the model already in use", () => {
    expect(loadConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL_NAME: "gemini-flash-latest" }).fallbackModels).toEqual([]);
  });

  it("turns fallback models off with an empty value, also under the ytlens name", () => {
    expect(loadConfig({ GEMINI_API_KEY: "k", FRAMELENS_FALLBACK_MODELS: "" }).fallbackModels).toEqual([]);
    expect(loadConfig({ GEMINI_API_KEY: "k", YTLENS_FALLBACK_MODELS: " " }).fallbackModels).toEqual([]);
    expect(loadConfig({ GEMINI_API_KEY: "k", YTLENS_FALLBACK_MODELS: "gemini-z" }).fallbackModels).toEqual(["gemini-z"]);
    expect(loadConfig({ GEMINI_API_KEY: "k", FRAMELENS_FALLBACK_MODELS: "", YTLENS_FALLBACK_MODELS: "gemini-z" }).fallbackModels).toEqual([]);
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL_NAME: "" }).model).toBe(DEFAULT_MODEL);
  });

  it("explains an unexpanded ${VAR} placeholder from the client config", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "${GEMINI_API_KEY}" })).toThrow(/not set in this environment/);
  });

  it("requires an API key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ GEMINI_API_KEY: "  " })).toThrow(/GEMINI_API_KEY/);
  });

  it.each([
    ["FRAMELENS_TIMEOUT_MS", "abc"],
    ["FRAMELENS_TIMEOUT_MS", "0"],
    ["FRAMELENS_MAX_RETRIES", "-1"],
    ["FRAMELENS_MAX_RETRIES", "11"],
    ["FRAMELENS_CACHE_TTL_MINUTES", "1.5"],
    ["FRAMELENS_LOG_LEVEL", "verbose"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => loadConfig({ GEMINI_API_KEY: "k", [name]: value })).toThrow(ConfigError);
  });

  it("never puts the key in an error message", () => {
    try {
      loadConfig({ GEMINI_API_KEY: "secret-key", FRAMELENS_LOG_LEVEL: "nope" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-key");
    }
  });
});

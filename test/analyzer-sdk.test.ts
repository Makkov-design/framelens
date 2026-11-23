// The real @google/genai client against a stubbed fetch: the API version it calls, and the error shapes
// toAnalyzerError depends on (status on the error, Google's JSON body in the message).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiAnalyzer, GEMINI_API_VERSION } from "../src/analyzer.js";
import { permanentFallbackFailure } from "../src/engine.js";
import { loadConfig } from "../src/config.js";
import { AnalyzerError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { parseVideoRef } from "../src/youtube.js";

const KEY = "AIzaSyFAKEKEYFORTESTS0000000000000000";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(reply: () => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return reply();
    }),
  );
  return urls;
}

function analyzer(env: Record<string, string> = {}) {
  const config = loadConfig({ GEMINI_API_KEY: KEY, FRAMELENS_FALLBACK_MODELS: "", FRAMELENS_MAX_RETRIES: "0", ...env });
  return createGeminiAnalyzer(config, silentLogger);
}

async function failure(promise: Promise<unknown>): Promise<AnalyzerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyzerError);
    return error as AnalyzerError;
  }
  throw new Error("expected a failure");
}

const request = { video: parseVideoRef("jNQXAC9IVRw"), prompt: "Summarize.", detail: "default" as const };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the real @google/genai client", () => {
  it("calls v1beta, where the default -latest models exist (v3 defaults to v1)", async () => {
    const urls = stubFetch(() => json(200, { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
    const result = await analyzer().analyze(request);
    expect(result.text).toBe("ok");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/${GEMINI_API_VERSION}/models/gemini-flash-lite-latest:generateContent`);
  });

  it("keeps v1beta when GOOGLE_GENAI_API_VERSION is set in the environment", async () => {
    vi.stubEnv("GOOGLE_GENAI_API_VERSION", "v1");
    const urls = stubFetch(() => json(200, { models: [] }));
    await analyzer().listModels();
    expect(urls[0]).toContain("/v1beta/models");
    expect(urls[0]).not.toContain("/v1/models");
  });

  it("maps an invalid key to auth, without the key in the message", async () => {
    stubFetch(() =>
      json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
    );
    const error = await failure(analyzer().analyze(request));
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(400);
    expect(error.message).toContain("API key not valid");
    expect(error.message).not.toContain(KEY);
  });

  it("reads a daily quota from Google's QuotaFailure details", async () => {
    stubFetch(() =>
      json(429, {
        error: {
          code: 429,
          message: "You exceeded your current quota.",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20", quotaDimensions: { model: "gemini-flash-lite-latest" } }],
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" },
          ],
        },
      }),
    );
    const error = await failure(analyzer().analyze(request));
    expect(error.kind).toBe("quota");
    expect(error.quota).toMatchObject({ scope: "day", limit: "20", model: "gemini-flash-lite-latest", retryDelayMs: 30_000 });
  });

  it("maps 404 to model_not_found and 503 to unavailable", async () => {
    stubFetch(() => json(404, { error: { code: 404, message: "models/x is not found for API version v1beta", status: "NOT_FOUND" } }));
    expect((await failure(analyzer().analyze(request))).kind).toBe("model_not_found");
    stubFetch(() => json(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }));
    expect((await failure(analyzer().analyze(request))).kind).toBe("unavailable");
  });

  it("maps the SDK's MALFORMED_RESPONSE finish reason to bad_response, not an empty answer", async () => {
    stubFetch(() => json(200, { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_RESPONSE" }] }));
    const error = await failure(analyzer().analyze(request));
    expect(error.kind).toBe("bad_response");
    expect(error.message).toMatch(/MALFORMED_RESPONSE/);
    // The transcript memo tries such an answer again on the next call; it remembers only failures that repeat.
    expect(permanentFallbackFailure(error)).toBe(false);
  });

  it("maps a 200 whose body is not JSON to bad_response, not unknown", async () => {
    stubFetch(() => new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "application/json" } }));
    const error = await failure(analyzer().analyze(request));
    expect(error.kind).toBe("bad_response");
    expect(permanentFallbackFailure(error)).toBe(false);
    // A transcript answer that is not the expected JSON stays remembered (the same video gives the same answer).
    expect(permanentFallbackFailure(new AnalyzerError("bad_response", "not the expected JSON"))).toBe(true);
  });
});

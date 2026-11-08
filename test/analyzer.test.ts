import type { GenerateContentParameters, GenerateContentResponse, Model } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { GeminiAnalyzer, type AnalyzeRequest, type GenAiClient } from "../src/analyzer.js";
import { AnalyzerError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { parseVideoRef } from "../src/youtube.js";

const KEY = "AIzaSyTESTKEY123";
const video = parseVideoRef("dQw4w9WgXcQ");

function response(fields: Record<string, unknown>): GenerateContentResponse {
  return fields as unknown as GenerateContentResponse;
}

function setup(generate: (params: GenerateContentParameters) => Promise<GenerateContentResponse>, models: Model[] = []) {
  const generateContent = vi.fn(generate);
  const client: GenAiClient = {
    models: {
      generateContent,
      list: async () =>
        (async function* () {
          yield* models;
        })(),
    },
  };
  const analyzer = new GeminiAnalyzer({ client, model: "gemini-test", timeoutMs: 30_000, logger: silentLogger, secrets: [KEY] });
  return { analyzer, generateContent };
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { name: "ApiError", status });
}

const base: AnalyzeRequest = { video, prompt: "Summarize.", detail: "default" };

describe("GeminiAnalyzer.analyze", () => {
  it("sends the video, prompt and system instruction", async () => {
    const { analyzer, generateContent } = setup(async () =>
      response({ text: "ok", modelVersion: "gemini-test-001", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
    );
    const result = await analyzer.analyze(base);

    expect(result).toEqual({
      text: "ok",
      model: "gemini-test-001",
      truncated: false,
      usage: { promptTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const params = generateContent.mock.calls[0]![0];
    expect(params.model).toBe("gemini-test");
    expect(params.contents).toEqual([
      { role: "user", parts: [{ fileData: { fileUri: video.url } }, { text: "Summarize." }] },
    ]);
    expect(params.config?.systemInstruction).toMatch(/untrusted/);
    // one deadline for the whole call, so retries cannot stretch it
    expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params.config?.mediaResolution).toBeUndefined();
    expect(params.config?.responseMimeType).toBeUndefined();
  });

  it("passes clip offsets, low detail and a JSON schema", async () => {
    const { analyzer, generateContent } = setup(async () => response({ text: "{}" }));
    const schema = { type: "object" };
    await analyzer.analyze({ ...base, clip: { startSeconds: 60, endSeconds: 120 }, detail: "low", responseJsonSchema: schema });

    const params = generateContent.mock.calls[0]![0];
    const parts = (params.contents as { parts: unknown[] }[])[0]!.parts;
    expect(parts[0]).toEqual({ fileData: { fileUri: video.url }, videoMetadata: { startOffset: "60s", endOffset: "120s" } });
    expect(params.config).toMatchObject({
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
  });

  it("sends only the bounds that are set", async () => {
    const { analyzer, generateContent } = setup(async () => response({ text: "x" }));
    await analyzer.analyze({ ...base, clip: { startSeconds: 30 } });
    const parts = (generateContent.mock.calls[0]![0].contents as { parts: unknown[] }[])[0]!.parts;
    expect(parts[0]).toMatchObject({ videoMetadata: { startOffset: "30s" } });
    expect((parts[0] as { videoMetadata: object }).videoMetadata).not.toHaveProperty("endOffset");
  });

  it("flags output that hit the token limit", async () => {
    const { analyzer } = setup(async () => response({ text: "partial", candidates: [{ finishReason: "MAX_TOKENS" }] }));
    expect((await analyzer.analyze(base)).truncated).toBe(true);
  });

  it.each([
    [response({ promptFeedback: { blockReason: "SAFETY" } }), "blocked"],
    [response({ text: "", candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }), "blocked"],
    [response({ text: "", candidates: [{ finishReason: "MAX_TOKENS" }] }), "empty_response"],
    [response({ text: "  " }), "empty_response"],
    [response({}), "empty_response"],
  ])("rejects unusable responses (%#)", async (res, kind) => {
    const { analyzer } = setup(async () => res);
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind });
  });
});

describe("GeminiAnalyzer error mapping", () => {
  it.each<[unknown, string]>([
    [apiError(400, "API key not valid. Please pass a valid API key."), "auth"],
    [apiError(403, "Permission denied"), "auth"],
    [apiError(401, "Unauthenticated"), "auth"],
    [apiError(429, "Resource has been exhausted (e.g. check quota)."), "quota"],
    [apiError(404, "models/gemini-test is not found"), "model_not_found"],
    [apiError(500, "Internal error"), "unavailable"],
    [apiError(503, "The model is overloaded"), "unavailable"],
    [apiError(504, "Deadline exceeded"), "timeout"],
    [apiError(400, "Cannot fetch content from the provided URL. Video is private."), "video_unavailable"],
    [apiError(400, "The input token count exceeds the maximum number of tokens allowed"), "video_unavailable"],
    [apiError(400, "Invalid value at 'generation_config'"), "invalid_request"],
    [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "timeout"],
    [new TypeError("fetch failed"), "unavailable"],
    [new Error("something odd"), "unknown"],
    ["a string", "unknown"],
  ])("maps %s to %s", async (thrown, kind) => {
    const { analyzer } = setup(async () => {
      throw thrown;
    });
    const error = await analyzer.analyze(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalyzerError);
    expect((error as AnalyzerError).kind).toBe(kind);
  });

  it("never leaks the API key", async () => {
    const { analyzer } = setup(async () => {
      throw apiError(400, `API key ${KEY} invalid for https://host/v1?key=${KEY}&alt=json and https://host/v2?alt=json&key=othersecret`);
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("othersecret");
    expect(error.message).toContain("[redacted]");
  });

  it("shows the message from a JSON error body instead of the raw JSON", async () => {
    const body = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } });
    const { analyzer } = setup(async () => {
      throw apiError(429, body);
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.kind).toBe("quota");
    expect(error.message).toMatch(/Details: You exceeded your current quota\.$/);
  });

  it("redacts the key anywhere in the longer details", async () => {
    const { analyzer } = setup(async () => {
      throw apiError(500, `${"x ".repeat(400)}key ${KEY} at the end`);
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.message).toContain("[redacted] at the end");
    expect(error.message).not.toContain(KEY);
  });

  it("keeps details bounded", async () => {
    const { analyzer } = setup(async () => {
      throw apiError(500, "x".repeat(5000));
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.message.length).toBeLessThan(1200);
  });
});

/** A 429 body the way the Gemini API sends it. */
function quota429(quotaId: string, options: { value?: string; metric?: string; retryDelay?: string; model?: string } = {}) {
  return apiError(
    429,
    JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: `You exceeded your current quota. * Quota exceeded for metric: ${options.metric ?? "generate_content_free_tier_requests"}, limit: ${options.value ?? "20"}`,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: `generativelanguage.googleapis.com/${options.metric ?? "generate_content_free_tier_requests"}`,
                quotaId,
                quotaDimensions: { location: "global", model: options.model ?? "gemini-test" },
                quotaValue: options.value ?? "20",
              },
            ],
          },
          ...(options.retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: options.retryDelay }] : []),
        ],
      },
    }),
  );
}

describe("quotas, retries and fallback models", () => {
  function chain(generate: (params: GenerateContentParameters) => Promise<GenerateContentResponse>, fallbackModels: string[] = [], maxRetries = 3) {
    const generateContent = vi.fn(generate);
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client: GenAiClient = { models: { generateContent, list: async () => (async function* () {})() } };
    const analyzer = new GeminiAnalyzer({ client, model: "gemini-test", fallbackModels, maxRetries, timeoutMs: 30_000, logger: silentLogger, wait });
    return { analyzer, generateContent, wait };
  }

  it("names a used-up daily quota, its model and when it resets, without retrying", async () => {
    const { analyzer, generateContent, wait } = chain(async () => {
      throw quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.kind).toBe("quota");
    expect(error.quota).toMatchObject({ scope: "day", limit: "20", model: "gemini-test" });
    expect(error.message).toMatch(/daily Gemini quota for "gemini-test" is used up/);
    expect(error.message).toMatch(/midnight Pacific/);
    expect(error.message).toContain("generate_content_free_tier_requests");
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("moves to the next model when the daily quota is used up", async () => {
    const { analyzer, generateContent } = chain(async (params) => {
      if (params.model === "gemini-test") throw quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
      return response({ text: "from fallback" });
    }, ["gemini-backup"]);
    const result = await analyzer.analyze(base);
    expect(result).toMatchObject({ text: "from fallback", model: "gemini-backup" });
    expect(generateContent.mock.calls.map((c) => c[0].model)).toEqual(["gemini-test", "gemini-backup"]);
  });

  it("moves to the next model when the model does not exist", async () => {
    const { analyzer } = chain(async (params) => {
      if (params.model === "gemini-test") throw apiError(404, "models/gemini-test is not found");
      return response({ text: "ok" });
    }, ["gemini-backup"]);
    expect((await analyzer.analyze(base)).model).toBe("gemini-backup");
  });

  it("treats a limit of 0 as a model missing from the plan", async () => {
    const { analyzer } = chain(async () => {
      throw quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", { value: "0" });
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.quota?.scope).toBe("day");
    expect(error.message).toMatch(/not available on your Gemini plan/);
  });

  it("waits the delay Google asks for on a per-minute limit, then succeeds", async () => {
    let calls = 0;
    const { analyzer, wait } = chain(async () => {
      if (calls++ === 0) throw quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", { retryDelay: "12.5s", value: "5" });
      return response({ text: "ok" });
    });
    expect((await analyzer.analyze(base)).text).toBe("ok");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]![0]).toBe(12_500);
  });

  const tokenLimit = () =>
    quota429("GenerateContentInputTokensPerModelPerMinute-FreeTier", {
      metric: "generate_content_free_tier_input_token_count",
      value: "250000",
      retryDelay: "20s",
    });

  it("waits out a per-minute token limit only once: a request bigger than the limit never fits", async () => {
    const { analyzer, generateContent, wait } = chain(async () => {
      throw tokenLimit();
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.quota).toMatchObject({ scope: "minute", tooLarge: true });
    expect(error.message).toMatch(/30 minutes or less/);
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.map((c) => c[0])).toEqual([20_000]);
  });

  it("succeeds after a per-minute token limit that earlier requests used up", async () => {
    let calls = 0;
    const { analyzer } = chain(async () => {
      if (calls++ === 0) throw tokenLimit();
      return response({ text: "ok" });
    });
    expect((await analyzer.analyze(base)).text).toBe("ok");
  });

  it("retries a 429 without quota details, and one whose body is not JSON", async () => {
    for (const thrown of [apiError(429, "Resource has been exhausted (e.g. check quota)."), apiError(429, "got status: 429 Too Many Requests")]) {
      let calls = 0;
      const { analyzer, wait } = chain(async () => {
        if (calls++ === 0) throw thrown;
        return response({ text: "ok" });
      });
      expect((await analyzer.analyze(base)).text).toBe("ok");
      expect(wait.mock.calls.map((c) => c[0])).toEqual([1000]);
    }
  });

  it("reads a daily quota from a body that is not JSON", async () => {
    const { analyzer, generateContent } = chain(async () => {
      throw apiError(429, "Quota exceeded: requests per day for this model");
    });
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ quota: { scope: "day" } });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("does not wait longer than a minute for a per-minute limit", async () => {
    const { analyzer, generateContent, wait } = chain(async () => {
      throw quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", { retryDelay: "75s", value: "5" });
    });
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind: "quota", quota: { scope: "minute", retryDelayMs: 75_000 } });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("treats a numeric limit of 0 like the string Google usually sends", async () => {
    const { analyzer } = chain(async () => {
      throw apiError(429, quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier").message.replace('"quotaValue":"20"', '"quotaValue":0'));
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.quota).toMatchObject({ scope: "day", limit: "0" });
    expect(error.message).toMatch(/not available on your Gemini plan/);
  });

  it("reports the daily quota, not a missing fallback model, when the fallback does not exist", async () => {
    const { analyzer, generateContent } = chain(async (params) => {
      if (params.model === "gemini-test") throw quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
      throw apiError(404, "models/gemini-typo is not found");
    }, ["gemini-typo"]);
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.quota).toMatchObject({ scope: "day", model: "gemini-test" });
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("with no fallback models, a used-up daily quota fails at once", async () => {
    const { analyzer, generateContent } = chain(async () => {
      throw quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
    }, []);
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ quota: { scope: "day" } });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("passes the same deadline signal to every attempt and every model", async () => {
    let calls = 0;
    const { analyzer, generateContent } = chain(async (params) => {
      if (params.model === "gemini-test") {
        if (calls++ === 0) throw apiError(503, "busy");
        throw quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
      }
      return response({ text: "ok" });
    }, ["gemini-backup"]);
    await expect(analyzer.analyze(base)).resolves.toMatchObject({ model: "gemini-backup" });
    const signals = generateContent.mock.calls.map((c) => c[0].config?.abortSignal);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(new Set(signals).size).toBe(1);
  });

  it("retries server errors with backoff up to the retry limit", async () => {
    const { analyzer, generateContent, wait } = chain(async () => {
      throw apiError(503, "The model is overloaded");
    }, [], 2);
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.kind).toBe("unavailable");
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("never retries a bad key", async () => {
    const { analyzer, generateContent } = chain(async () => {
      throw apiError(403, "Permission denied");
    }, ["gemini-backup"]);
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind: "auth" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("reports why it was waiting when the deadline cuts a wait short", async () => {
    const client: GenAiClient = {
      models: {
        generateContent: async () => {
          throw apiError(503, "busy");
        },
        list: async () => (async function* () {})(),
      },
    };
    const analyzer = new GeminiAnalyzer({
      client,
      model: "gemini-test",
      maxRetries: 3,
      timeoutMs: 30_000,
      logger: silentLogger,
      wait: async () => {
        throw new Error("aborted");
      },
    });
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind: "unavailable", message: expect.stringMatching(/busy/) });
  });

  it("does not start a wait that would outlast the deadline", async () => {
    const generateContent = vi.fn(async (_params: GenerateContentParameters): Promise<GenerateContentResponse> => {
      throw quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", { retryDelay: "45s", value: "5" });
    });
    const wait = vi.fn(async () => {});
    const analyzer = new GeminiAnalyzer({
      client: { models: { generateContent, list: async () => (async function* () {})() } },
      model: "gemini-test",
      maxRetries: 3,
      timeoutMs: 30_000,
      logger: silentLogger,
      wait,
    });
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind: "quota", quota: { scope: "minute" } });
    expect(wait).not.toHaveBeenCalled();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("GeminiAnalyzer.listModels", () => {
  it("lists Gemini models that can understand video", async () => {
    const { analyzer } = setup(async () => response({}), [
      { name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 1000, supportedActions: ["generateContent", "countTokens"] },
      { name: "models/embedding", supportedActions: ["embedContent"] },
      { name: "models/gemini-b", supportedActions: ["generateContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedActions: ["generateContent"] },
      { name: "models/gemini-3-pro-image", supportedActions: ["generateContent"] },
      { name: "models/nano-banana-pro-preview", supportedActions: ["generateContent"] },
      { name: "models/gemma-4-31b-it", supportedActions: ["generateContent"] },
      { supportedActions: ["generateContent"] },
    ]);
    expect(await analyzer.listModels()).toEqual([
      { name: "gemini-a", displayName: "Gemini A", inputTokenLimit: 1000 },
      { name: "gemini-b" },
    ]);
  });
});

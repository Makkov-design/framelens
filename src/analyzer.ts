import {
  GoogleGenAI,
  MediaResolution,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Model,
  type Part,
} from "@google/genai";
import type { Config } from "./config.js";
import { AnalyzerError, type QuotaInfo } from "./errors.js";
import type { Logger } from "./logger.js";
import { SYSTEM_INSTRUCTION } from "./prompts.js";
import type { Clip, VideoRef } from "./youtube.js";

export type Detail = "default" | "low";

export interface AnalyzeRequest {
  video: VideoRef;
  clip?: Clip;
  prompt: string;
  detail: Detail;
  /** When set, the model must answer with JSON matching this JSON Schema. */
  responseJsonSchema?: object;
  /** Throws if the answer is unusable; such answers are never cached. */
  validate?: (result: AnalyzeResult) => void;
}

export interface Usage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AnalyzeResult {
  text: string;
  model: string;
  usage: Usage;
  /** True when the output stopped at the model's token limit. */
  truncated: boolean;
  /** True when the result came from the local cache instead of a new Gemini call. */
  cached?: boolean;
}

export interface ModelInfo {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
}

export interface VideoAnalyzer {
  readonly model: string;
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
  listModels(): Promise<ModelInfo[]>;
}

/** The part of the `@google/genai` client this module uses; lets tests pass a fake. */
export interface GenAiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    list(): Promise<AsyncIterable<Model>>;
  };
}

const BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

/** Gemini variants that generate speech or images, or embed text, rather than understand video. */
const NOT_VIDEO_MODELS = /tts|image|embedding|banana|native-audio|live|robotics|computer-use|customtools/i;

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Longest wait for a per-minute limit before trying again. */
const MAX_RETRY_DELAY_MS = 60_000;

export class GeminiAnalyzer implements VideoAnalyzer {
  readonly model: string;
  private readonly fallbackModels: string[];
  private readonly maxRetries: number;
  private readonly client: GenAiClient;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private readonly logger: Logger;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: {
    client: GenAiClient;
    model: string;
    /** Tried in order when a model's daily quota is used up or the model does not exist. */
    fallbackModels?: string[];
    /** Retries per model on timeouts, server errors and per-minute limits. */
    maxRetries?: number;
    timeoutMs: number;
    logger: Logger;
    /** Strings removed from every error message (the API key). */
    secrets?: string[];
    /** Replaces the real wait between retries (tests). */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.client = options.client;
    this.model = options.model;
    this.fallbackModels = options.fallbackModels ?? [];
    this.maxRetries = options.maxRetries ?? 0;
    this.wait = options.wait ?? sleep;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.secrets = options.secrets ?? [];
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const videoPart: Part = { fileData: { fileUri: request.video.url } };
    if (request.clip) {
      videoPart.videoMetadata = {
        ...(request.clip.startSeconds !== undefined && { startOffset: `${request.clip.startSeconds}s` }),
        ...(request.clip.endSeconds !== undefined && { endOffset: `${request.clip.endSeconds}s` }),
      };
    }

    // One deadline for the whole call, retries and fallback models included.
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const config: GenerateContentConfig = {
      systemInstruction: SYSTEM_INSTRUCTION,
      abortSignal: deadline,
    };
    if (request.detail === "low") config.mediaResolution = MediaResolution.MEDIA_RESOLUTION_LOW;
    if (request.responseJsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = request.responseJsonSchema;
    }

    const { response, model } = await this.generate(
      { contents: [{ role: "user", parts: [videoPart, { text: request.prompt }] }], config },
      deadline,
    );

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AnalyzerError("blocked", `Gemini refused to process this request (${blockReason}).`);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    const text = response.text ?? "";
    if (finishReason && BLOCKING_FINISH_REASONS.has(finishReason)) {
      throw new AnalyzerError("blocked", `Gemini stopped the answer because of its content filters (${finishReason}).`);
    }
    if (!text.trim()) {
      throw new AnalyzerError(
        "empty_response",
        finishReason === "MAX_TOKENS"
          ? "Gemini ran out of output tokens before answering. Analyze a shorter part with `start`/`end`."
          : `Gemini returned an empty answer${finishReason ? ` (${finishReason})` : ""}. Try again or rephrase the request.`,
      );
    }

    const usage = response.usageMetadata;
    return {
      text,
      model: response.modelVersion ?? model,
      truncated: finishReason === "MAX_TOKENS",
      usage: {
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        totalTokens: usage?.totalTokenCount,
      },
    };
  }

  /**
   * Calls Gemini with the configured model, then each fallback model. Per model it retries timeouts,
   * server errors and per-minute limits; a used-up daily quota or a missing model moves on to the next.
   */
  private async generate(
    params: Omit<GenerateContentParameters, "model">,
    deadline: AbortSignal,
  ): Promise<{ response: GenerateContentResponse; model: string }> {
    const models = [this.model, ...this.fallbackModels];
    let lastError: AnalyzerError | undefined;
    for (const [index, model] of models.entries()) {
      for (let attempt = 0; ; attempt++) {
        try {
          return { response: await this.client.models.generateContent({ ...params, model }), model };
        } catch (error) {
          const mapped = this.toAnalyzerError(error, model);
          lastError = mapped;
          const next = models[index + 1];
          if ((mapped.quota?.scope === "day" || mapped.kind === "model_not_found") && next) {
            this.logger.warn(`model ${model} unavailable, trying ${next}`, { reason: mapped.quota?.scope ?? mapped.kind });
            break;
          }
          const delay = this.retryDelay(mapped, attempt);
          if (delay === undefined) throw mapped;
          this.logger.info("retrying gemini call", { model, attempt: attempt + 1, delayMs: delay, kind: mapped.kind });
          try {
            await this.wait(delay, deadline);
          } catch {
            throw this.toAnalyzerError(Object.assign(new Error("deadline"), { name: "TimeoutError" }), model);
          }
        }
      }
    }
    throw lastError ?? new AnalyzerError("unknown", "No Gemini model to call.");
  }

  /** How long to wait before retrying, or undefined when retrying cannot help. */
  private retryDelay(error: AnalyzerError, attempt: number): number | undefined {
    if (attempt >= this.maxRetries) return undefined;
    const backoff = Math.min(1000 * 2 ** attempt, 16_000);
    if (error.kind === "quota") {
      // A daily quota or a request larger than the per-minute token budget fails the same way every time.
      if (error.quota?.scope !== "minute" || error.quota.tooLarge) return undefined;
      const delay = error.quota.retryDelayMs ?? backoff;
      return delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
    }
    if (error.kind === "unavailable" || (error.kind === "timeout" && error.status !== undefined)) return backoff;
    return undefined;
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      for await (const model of await this.client.models.list()) {
        if (!model.name || !model.supportedActions?.includes("generateContent")) continue;
        if (!/^(models\/)?gemini-/.test(model.name) || NOT_VIDEO_MODELS.test(model.name)) continue;
        models.push({
          name: model.name.replace(/^models\//, ""),
          ...(model.displayName && { displayName: model.displayName }),
          ...(model.inputTokenLimit && { inputTokenLimit: model.inputTokenLimit }),
        });
      }
    } catch (error) {
      throw this.toAnalyzerError(error);
    }
    return models;
  }

  /** Maps any SDK or network failure to an actionable message that never contains the key. */
  toAnalyzerError(error: unknown, model: string = this.model): AnalyzerError {
    if (error instanceof AnalyzerError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const detail = this.redact(apiMessage(raw)).replace(/\s+/g, " ").trim().slice(0, 1000);
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    const name = error instanceof Error ? error.name : "";
    this.logger.debug("gemini call failed", { status, name, detail });

    const withDetail = (message: string) => `${message} Details: ${detail}`;

    if (status === undefined) {
      if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(raw)) {
        return new AnalyzerError(
          "timeout",
          `Gemini did not answer within ${Math.round(this.timeoutMs / 1000)} s. Analyze a shorter part with \`start\`/\`end\`, or raise YTLENS_TIMEOUT_MS.`,
        );
      }
      if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(raw)) {
        return new AnalyzerError("unavailable", withDetail("Could not reach the Gemini API (network error)."));
      }
      return new AnalyzerError("unknown", withDetail("Gemini request failed."));
    }

    if (status === 401 || status === 403 || (status === 400 && /api[ _]?key/i.test(raw))) {
      return new AnalyzerError(
        "auth",
        withDetail("Gemini rejected the API key. Check GEMINI_API_KEY and that the key may use the Gemini API."),
        status,
      );
    }
    if (status === 429) {
      const quota = quotaInfo(raw, model);
      return new AnalyzerError("quota", withDetail(quotaMessage(quota, model)), status, quota);
    }
    if (status === 404) {
      return new AnalyzerError(
        "model_not_found",
        withDetail(`Model "${model}" is not available. Run list_supported_models and set GEMINI_MODEL_NAME.`),
        status,
      );
    }
    if (status === 408 || status === 504) {
      return new AnalyzerError("timeout", withDetail("Gemini timed out while processing the video."), status);
    }
    if (status >= 500) {
      return new AnalyzerError("unavailable", withDetail("Gemini is temporarily unavailable. Try again shortly."), status);
    }
    if (/video|youtube|file_?uri|fetch|private|unavailable|token/i.test(raw)) {
      return new AnalyzerError(
        "video_unavailable",
        withDetail(
          "Gemini could not process this video. It may be private, age-restricted, region-locked, removed, or too long; " +
            "try a shorter `start`/`end` range (about 30 minutes or less).",
        ),
        status,
      );
    }
    return new AnalyzerError("invalid_request", withDetail("Gemini rejected the request."), status);
  }

  private redact(text: string): string {
    return this.secrets.reduce(
      (acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc),
      text.replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]"),
    );
  }
}

/** The SDK puts the raw error body into the message; pull out Google's human-readable text when present. */
function apiMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return raw;
  try {
    const body = JSON.parse(raw.slice(start)) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : raw;
  } catch {
    return raw;
  }
}

/** Reads Google's QuotaFailure and RetryInfo details from a 429 body. */
export function quotaInfo(raw: string, model: string): QuotaInfo {
  const info: QuotaInfo = { scope: "unknown", model };
  let details: unknown[] = [];
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(raw.slice(start)) as { error?: { details?: unknown } };
      if (Array.isArray(body.error?.details)) details = body.error.details;
    } catch {
      // Not JSON: the text checks below still apply.
    }
  }
  type Violation = { quotaId?: string; quotaMetric?: string; quotaValue?: string; quotaDimensions?: { model?: string } };
  const violations: Violation[] = [];
  for (const item of details) {
    const d = item as { "@type"?: string; violations?: Violation[]; retryDelay?: string };
    if (d["@type"]?.endsWith("QuotaFailure") && Array.isArray(d.violations)) violations.push(...d.violations);
    if (d["@type"]?.endsWith("RetryInfo") && typeof d.retryDelay === "string") {
      const seconds = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(seconds)) info.retryDelayMs = Math.ceil(seconds * 1000);
    }
  }
  // A daily limit outranks a per-minute one: waiting a minute will not lift it.
  const chosen =
    violations.find((v) => /PerDay/i.test(v.quotaId ?? "")) ??
    violations.find((v) => /PerMinute/i.test(v.quotaId ?? "")) ??
    violations[0];
  if (chosen) {
    info.quotaId = chosen.quotaId;
    info.limit = chosen.quotaValue;
    info.model = chosen.quotaDimensions?.model ?? model;
    if (/PerDay/i.test(chosen.quotaId ?? "")) info.scope = "day";
    else if (/PerMinute/i.test(chosen.quotaId ?? "")) info.scope = "minute";
    if (info.scope === "minute" && /token/i.test(`${chosen.quotaId ?? ""} ${chosen.quotaMetric ?? ""}`)) info.tooLarge = true;
  } else if (/per ?day|daily/i.test(raw)) {
    info.scope = "day";
  } else if (/per ?minute/i.test(raw)) {
    info.scope = "minute";
  }
  // A limit of 0 never resets: the model is not on this tier at all.
  if (info.limit === "0") info.scope = "day";
  return info;
}

function quotaMessage(quota: QuotaInfo, model: string): string {
  const name = quota.model ?? model;
  if (quota.limit === "0") {
    return `The model "${name}" is not available on your Gemini plan (its limit is 0). Set GEMINI_MODEL_NAME to another model; list_supported_models shows the choices.`;
  }
  if (quota.scope === "day") {
    return (
      `The daily Gemini quota for "${name}" is used up. It resets at midnight Pacific time (08:00 UTC in winter, 07:00 UTC in summer). ` +
      "Until then use another model (GEMINI_MODEL_NAME) or a key with billing enabled. Free-tier limits count per Google Cloud project, so more keys in the same project do not help."
    );
  }
  if (quota.tooLarge) {
    return (
      "This request needs more input tokens than the per-minute limit allows, so retrying will not help. " +
      "A video costs about 100 tokens per second; analyze about 30 minutes or less at a time with `start`/`end`."
    );
  }
  if (quota.scope === "minute") return "Too many Gemini requests this minute. Wait a minute and try again.";
  return "Gemini quota or rate limit reached. Wait a minute and try again; if it persists, the daily quota may be used up.";
}

export function createGeminiAnalyzer(config: Config, logger: Logger): GeminiAnalyzer {
  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: config.timeoutMs,
      // GeminiAnalyzer retries itself, because it can tell a daily quota from a per-minute one.
      retryOptions: { attempts: 1 },
    },
  });
  return new GeminiAnalyzer({
    client,
    model: config.model,
    fallbackModels: config.fallbackModels,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    logger,
    secrets: [config.apiKey],
  });
}

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one tool call carries down to the code that runs programs, without threading it through every engine method:
 * the client's cancel signal and a progress reporter. The external programs (`run`, `execTool`, the ffmpeg pipes)
 * read the signal from here, so a cancelled call stops its yt-dlp or ffmpeg instead of leaving it running.
 */
export interface CallContext {
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

const store = new AsyncLocalStorage<CallContext>();

export function withCall<T>(context: CallContext, body: () => Promise<T>): Promise<T> {
  return store.run(context, body);
}

/** The signal of the tool call this code runs in, if any. */
export function callSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

/** Tells the client what the call is doing now (an MCP progress notification when it asked for them). */
export function reportProgress(message: string): void {
  store.getStore()?.progress?.(message);
}

/** The error a cancelled call ends with. */
export class CancelledError extends Error {
  override name = "CancelledError";
  constructor(what = "The tool call") {
    super(`${what} was cancelled.`);
  }
}

/** Throws when the current call was cancelled: a check between long steps. */
export function throwIfCancelled(): void {
  if (callSignal()?.aborted) throw new CancelledError();
}

/** Minimal shape of the MCP SDK's handler `extra` that progress needs (RequestHandlerExtra, SDK 1.x). */
export interface ProgressExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

/** How often a long call says it is still working, so a client that resets its timeout on progress keeps waiting. */
export const HEARTBEAT_MS = 15_000;

/**
 * The context for one MCP tool call: its signal, and progress notifications when the client sent a progress token
 * (each step's line, and a heartbeat with the elapsed time while a step runs). `stop` ends the heartbeat.
 */
export function mcpCallContext(tool: string, extra: ProgressExtra | undefined, heartbeatMs = HEARTBEAT_MS): { context: CallContext; stop: () => void } {
  const token = extra?._meta?.progressToken;
  if (!extra || token === undefined) return { context: extra ? { signal: extra.signal } : {}, stop: () => {} };
  const started = Date.now();
  let count = 0;
  let last = `${tool}: started`;
  const send = (message: string) => {
    count += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: count, message } }).catch(() => undefined);
  };
  const timer = setInterval(() => send(`${last} (still working, ${Math.round((Date.now() - started) / 1000)} s)`), heartbeatMs);
  timer.unref();
  send(last);
  return {
    context: {
      signal: extra.signal,
      progress: (message) => {
        last = `${tool}: ${message}`;
        send(last);
      },
    },
    stop: () => clearInterval(timer),
  };
}

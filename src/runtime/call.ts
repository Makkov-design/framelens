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

/**
 * Runs shared work (an install, a one-time check other calls wait for) outside the current call: no call's signal
 * stops it and no call's progress reporter hears it. Each caller waits for it with its own signal (`untilAborted`).
 */
export function outsideCall<T>(body: () => T): T {
  return store.exit(body);
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

/**
 * Waits for shared work (a download or install other calls also wait for) with one caller's signal: `promise`, or a
 * CancelledError as soon as `signal` aborts. The shared work itself keeps running for the others.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, what = "The wait"): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError(what));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError(what));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One run of `work` per key at a time (a download into one workspace, a browser capture of one link). The first
 * call runs it under its own signal; calls that come while it runs wait for its result or error with their own
 * signal. When the first call is cancelled, a waiter that is not starts the work again itself.
 */
export async function singleFlight<T>(
  flights: Map<string, { promise: Promise<T>; signal?: AbortSignal }>,
  key: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
  what = "The wait",
): Promise<{ value: T; shared: boolean }> {
  for (;;) {
    const pending = flights.get(key);
    if (!pending) break;
    try {
      return { value: await untilAborted(pending.promise, signal, what), shared: true };
    } catch (error) {
      if (signal?.aborted || !pending.signal?.aborted) throw error;
      // The call that ran it was cancelled, this one was not: run it again.
    }
  }
  const promise = work();
  const entry = { promise, ...(signal && { signal }) };
  flights.set(key, entry);
  try {
    return { value: await promise, shared: false };
  } finally {
    if (flights.get(key) === entry) flights.delete(key);
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
  let stopped = false;
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
        // Work started inside the call can outlive it: nothing is sent once its answer is out.
        if (stopped) return;
        last = `${tool}: ${message}`;
        send(last);
      },
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

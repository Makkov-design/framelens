import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidInputError } from "../errors.js";

/** Chrome or Edge on this computer, or `FRAMELENS_BROWSER`. */
export function findBrowser(env: Record<string, string | undefined> = process.env, platform = process.platform): string | undefined {
  const configured = env.FRAMELENS_BROWSER?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const candidates =
    platform === "win32"
      ? [
          `${env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.PROGRAMFILES ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((path) => path && existsSync(path));
}

/** A browser's own everyday profile folder (Chrome, Edge, Chromium, Brave on Windows, macOS and Linux). */
export function isEverydayProfile(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return (
    /\/(google\/chrome( beta| dev| sxs)?|microsoft\/edge( beta| dev| sxs)?|chromium|bravesoftware\/brave-browser)\/user data(\/|$)/.test(p) ||
    /\/library\/application support\/(google\/chrome|microsoft edge|chromium|bravesoftware\/brave-browser)(\/|$)/.test(p) ||
    /\/\.config\/(google-chrome|chromium|microsoft-edge|bravesoftware\/brave-browser)(\/|$)/.test(p)
  );
}

/**
 * Where `framelens login` keeps its own browser profile: never the user's everyday one. `logout` deletes this folder
 * and capture drives it, so a FRAMELENS_BROWSER_PROFILE pointing at the browser's own profile is refused.
 */
export function profileDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FRAMELENS_BROWSER_PROFILE?.trim();
  if (configured && isEverydayProfile(configured)) {
    throw new InvalidInputError("FRAMELENS_BROWSER_PROFILE points at your everyday browser profile. Frame Lens uses a separate folder only; unset it or choose a new empty folder.");
  }
  return configured || join(homedir(), ".framelens", "browser-profile");
}

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

/** A minimal Chrome DevTools Protocol client over the built-in WebSocket (Node 22+). */
export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<Handler>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {}, message.sessionId);
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("The browser connection closed."));
      this.pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketImpl) throw new InvalidInputError("Reading web pages needs Node.js 22 or newer.");
    const socket = new WebSocketImpl(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the browser.")), timeoutMs);
      socket.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      socket.addEventListener("error", () => (clearTimeout(timer), reject(new Error("Could not connect to the browser."))), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  on(method: string, handler: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }

  waitFor(method: string, sessionId: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (off(), reject(new Error(`Timed out waiting for ${method}.`))), timeoutMs);
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch (error) {
          reject(error as Error);
        }
      });
    }).on("error", reject);
  });
}

export interface BrowserSession {
  cdp: Cdp;
  sessionId: string;
  close(): Promise<void>;
}

/** Browsers this process started and has not closed yet, so they can be ended if Frame Lens itself is stopped. */
const running = new Set<ChildProcess>();
let exitHooks = false;

function endAllOnExit(): void {
  if (exitHooks) return;
  exitHooks = true;
  process.once("exit", () => {
    for (const child of running) killTree(child);
  });
  // A client that stops the server sends a signal; Node's default exits without running "exit" handlers, and a
  // headless browser left behind runs until the computer restarts.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      for (const child of running) killTree(child);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** Ends the browser and every process it started (Chrome spawns helpers that outlive a plain kill). */
function killTree(child: ChildProcess): void {
  running.delete(child);
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Starts Chrome or Edge with its own profile and a DevTools port, opens one tab and attaches to it. The browser is
 * always killed on close and after `maxLifetimeMs`, so a hung page cannot leave it running.
 */
export async function launchBrowser(options: {
  executable: string;
  profile: string;
  headless: boolean;
  width?: number;
  height?: number;
  maxLifetimeMs?: number;
}): Promise<BrowserSession> {
  mkdirSync(options.profile, { recursive: true });
  const portFile = join(options.profile, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const width = Math.min(options.width ?? 1440, 1440);
  const height = Math.min(options.height ?? 900, 4000);
  const child = spawn(
    options.executable,
    [
      ...(options.headless ? ["--headless=new", "--mute-audio", "--hide-scrollbars"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${options.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" },
  );
  running.add(child);
  child.once("exit", () => running.delete(child));
  endAllOnExit();
  const lifetime = setTimeout(() => killTree(child), options.maxLifetimeMs ?? 5 * 60_000);
  lifetime.unref();
  const fail = (message: string) => {
    clearTimeout(lifetime);
    killTree(child);
    return new Error(message);
  };

  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (child.exitCode !== null) throw fail("The browser exited at start. If it is already open with this profile, close that window first.");
    if (Date.now() > deadline) throw fail("The browser did not start within 20 s.");
    await new Promise((r) => setTimeout(r, 150));
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const cdp = await Cdp.connect(String(version.webSocketDebuggerUrl));
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return {
      cdp,
      sessionId,
      close: async () => {
        clearTimeout(lifetime);
        try {
          await cdp.send("Browser.close", {}, undefined, 3_000);
        } catch {
          // Killed below either way.
        }
        cdp.close();
        killTree(child);
      },
    };
  } catch (error) {
    throw fail(`Could not control the browser: ${(error as Error).message}`);
  }
}

/** Evaluates an expression in the page and returns its JSON value. */
export async function evaluate<T>(session: BrowserSession, expression: string, timeoutMs = 30_000): Promise<T> {
  const result = await session.cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    // `timeout` stops our own script if the page made it loop (a redefined getAnimations, say); the send timeout
    // covers a page whose own scripts keep the tab busy.
    { expression, returnByValue: true, awaitPromise: true, timeout: Math.max(1_000, timeoutMs - 5_000) },
    session.sessionId,
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value as T;
}

/** Opens a URL and waits for the load event (or `timeoutMs`). */
export async function navigate(session: BrowserSession, url: string, timeoutMs = 30_000): Promise<void> {
  await session.cdp.send("Page.enable", {}, session.sessionId);
  const loaded = session.cdp.waitFor("Page.loadEventFired", session.sessionId, timeoutMs).catch(() => undefined);
  const nav = await session.cdp.send<{ errorText?: string }>("Page.navigate", { url }, session.sessionId);
  if (nav.errorText) throw new InvalidInputError(`Could not open ${url}: ${nav.errorText}.`);
  await loaded;
}

/** A PNG of the viewport. */
export async function screenshot(session: BrowserSession): Promise<Buffer> {
  const { data } = await session.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, session.sessionId);
  return Buffer.from(data, "base64");
}

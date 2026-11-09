import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * A headless Chrome or Edge driven over --remote-debugging-pipe, the only way current Chrome loads an unpacked
 * extension for a test (Extensions.loadUnpacked; branded Chrome ignores --load-extension since version 137, Edge
 * still honours it). Always killed after `maxLifetimeMs`.
 */
export class PipeBrowser {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void>();
  readonly profile: string;

  private constructor(
    private readonly child: ChildProcess,
    profile: string,
  ) {
    this.profile = profile;
    const input = child.stdio[4] as Readable;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf("\0"); end >= 0; end = this.buffer.indexOf("\0")) {
        const message = JSON.parse(this.buffer.slice(0, end)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
        this.buffer = this.buffer.slice(end + 1);
        if (message.id !== undefined) {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(message.error.message));
          else waiter?.resolve(message.result ?? {});
        } else if (message.method) {
          for (const l of this.listeners) l({ method: message.method, params: message.params ?? {}, ...(message.sessionId && { sessionId: message.sessionId }) });
        }
      }
    });
  }

  static launch(executable: string, options: { args?: string[]; downloads?: string; maxLifetimeMs?: number } = {}): PipeBrowser {
    const profile = mkdtempSync(join(tmpdir(), "framelens-ext-test-"));
    // The profile's own download folder: chrome.downloads keeps its file names there (a DevTools download override
    // would rename every file).
    if (options.downloads) {
      mkdirSync(join(profile, "Default"), { recursive: true });
      writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: options.downloads, prompt_for_download: false, directory_upgrade: true } }));
    }
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--mute-audio",
        "--window-size=1440,900",
        ...(options.args ?? []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" },
    );
    const browser = new PipeBrowser(child, profile);
    setTimeout(() => browser.close(), options.maxLifetimeMs ?? 50_000).unref();
    return browser;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`No answer to ${method}`))), timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v as T)), reject: (e) => (clearTimeout(timer), reject(e)) });
      (this.child.stdio[3] as Writable).write(`${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`);
    });
  }

  on(listener: (m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Evaluates an expression in a target session and returns its JSON value. */
  async evaluate<T>(sessionId: string, expression: string, timeoutMs = 30_000): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return r.result.value as T;
  }

  close(): void {
    for (const w of this.pending.values()) w.reject(new Error("browser closed"));
    this.pending.clear();
    if (this.child.pid !== undefined && this.child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      }
    }
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The OS may hold a file a moment longer; it is a temp folder.
    }
  }
}

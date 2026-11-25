// `web` fails closed when Chrome cannot be given the proxy's credentials: the page is not opened, and the proxy and
// browser are closed.
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { RequestProxy } from "../../src/browser/proxy.js";

const started: RequestProxy[] = [];
let browserClosed = false;

vi.mock("../../src/browser/proxy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/browser/proxy.js")>();
  return {
    ...real,
    startProxy: async (...args: Parameters<typeof real.startProxy>) => {
      const proxy = await real.startProxy(...args);
      started.push(proxy);
      return proxy;
    },
  };
});

vi.mock("../../src/browser/cdp.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/browser/cdp.js")>();
  return {
    ...real,
    findBrowser: () => "/fake/chrome",
    launchBrowser: async () => ({
      sessionId: "tab",
      cdp: {
        on: () => () => undefined,
        send: async (method: string) => {
          if (method === "Fetch.enable") throw new Error("Fetch.enable wasn't found");
          return {};
        },
      },
      close: async () => {
        browserClosed = true;
      },
    }),
  };
});

describe("web when the proxy credentials cannot be set up", () => {
  it("refuses the page, and closes the browser and the proxy", async () => {
    const { readPage } = await import("../../src/browser/read.js");
    await expect(readPage("https://example.com/", "/tmp", {} as never, { env: {} })).rejects.toThrow(/Could not set up the request check.*Fetch\.enable wasn't found.*not opened/);
    expect(browserClosed).toBe(true);
    expect(started).toHaveLength(1);
    await expect(new Promise((resolve, reject) => connect(started[0]!.port, "127.0.0.1").on("connect", resolve).on("error", reject))).rejects.toThrow();
  });
});

// `web` fails closed: no proxy, no page. And the browser gets no way around the proxy.
import { describe, expect, it, vi } from "vitest";
import { findBrowser, proxyFlags, withoutProxyEnv } from "../../src/browser/cdp.js";

vi.mock("../../src/browser/proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser/proxy.js")>()),
  startProxy: async () => {
    throw new Error("listen EACCES");
  },
}));

describe("web and its request proxy", () => {
  it("pins every request to the proxy, loopback included, and turns off what goes around it", () => {
    const flags = proxyFlags("http://127.0.0.1:4567");
    expect(flags).toContain("--proxy-server=http://127.0.0.1:4567");
    expect(flags).toContain("--proxy-bypass-list=<-loopback>");
    expect(flags).toContain("--disable-quic");
    expect(flags).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(flags.some((f) => /pac|no-proxy|proxy-auto/i.test(f))).toBe(false);
    const env = withoutProxyEnv({ HTTP_PROXY: "x", https_proxy: "x", ALL_PROXY: "x", NO_PROXY: "x", auto_proxy: "x", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it.skipIf(!findBrowser())("refuses to open the page when the proxy cannot start, instead of reading it unguarded", async () => {
    const { readPage } = await import("../../src/browser/read.js");
    await expect(readPage("https://example.com/", "/tmp", {} as never)).rejects.toThrow(/Could not start the request check.*listen EACCES.*not opened/);
  });
});

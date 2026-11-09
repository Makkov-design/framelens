import { describe, expect, it } from "vitest";
import { capturableLogin } from "../../src/browser/capture.js";

describe("the login tier", () => {
  it("only answers a real login wall on a site the user can log in to", () => {
    expect(capturableLogin("https://www.instagram.com/reel/abc/", "This content requires login")).toBe(true);
    expect(capturableLogin("https://x.com/user/status/1", "login required")).toBe(true);
  });

  it("never answers a bot check, on any site", () => {
    expect(capturableLogin("https://www.youtube.com/watch?v=jNQXAC9IVRw", "Sign in to confirm you're not a bot")).toBe(false);
    expect(capturableLogin("https://www.instagram.com/reel/abc/", "Please complete the CAPTCHA")).toBe(false);
    expect(capturableLogin("https://youtu.be/jNQXAC9IVRw", "login required")).toBe(false);
  });

  it("ignores sites and inputs it has no login page for", () => {
    expect(capturableLogin("https://example.com/video", "login required")).toBe(false);
    expect(capturableLogin("jNQXAC9IVRw", "login required")).toBe(false);
  });
});

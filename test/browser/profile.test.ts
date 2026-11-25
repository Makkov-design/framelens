// The temporary browser profile is removed with retries, and a profile Windows still holds (EBUSY) does not throw out
// of `finally` and lose a finished `web` reading.
import { describe, expect, it } from "vitest";
import { removeProfile } from "../../src/browser/read.js";

describe("removeProfile", () => {
  it("retries the removal and swallows a folder that stays busy", () => {
    const calls: unknown[] = [];
    const busy = ((path: string, options: unknown) => {
      calls.push([path, options]);
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }) as never;
    expect(() => removeProfile("/tmp/framelens-profile-x", busy)).not.toThrow();
    expect(calls).toEqual([["/tmp/framelens-profile-x", { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }]]);
  });
});

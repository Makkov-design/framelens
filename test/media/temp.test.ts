import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { tempPath, uniqueName } from "../../src/media/temp.js";

describe("temp names", () => {
  it("are unguessable: no process id or clock, 96 random bits, never the same twice", () => {
    const names = new Set(Array.from({ length: 1000 }, () => uniqueName(".tmp-")));
    expect(names.size).toBe(1000);
    const one = uniqueName("framelens-scene-", ".txt");
    expect(one).toMatch(/^framelens-scene-[0-9a-f]{24}\.txt$/);
    expect(one).not.toContain(String(process.pid));
    expect(tempPath("framelens-ssim-", ".txt").startsWith(tmpdir())).toBe(true);
  });
});

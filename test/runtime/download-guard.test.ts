// No answer from a download source may end the server process: every download path is run in a process of its own
// against endless, broken, stalled and cut answers, and must settle each call and survive past every time limit.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "../media/fixtures.js";

const dir = tempDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("download paths against a hostile server", () => {
  it("settle every call and never crash the process", async () => {
    const script = join(dir, "guard.mjs");
    await build({
      entryPoints: ["test/fixtures/download-guard.ts"],
      outfile: script,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      banner: { js: 'import { createRequire as __r } from "node:module"; const require = __r(import.meta.url);' },
      logLevel: "error",
    });
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
    expect(run.stderr, "nothing uncaught").not.toMatch(/Uncaught|Error: aborted|ERR_/);
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { alive: boolean; results: { name: string; outcome: string }[] };
    expect(report.alive).toBe(true);
    for (const r of report.results) expect(r.outcome, r.name).toMatch(/^rejected: ./);
    const exact = Object.fromEntries(report.results.filter((r) => r.name.startsWith("exact")).map((r) => [r.name, r.outcome]));
    expect(exact["exact /endless-gzip"]).toMatch(/larger than 30 MB/);
    expect(exact["exact /not-gzip-open"]).toMatch(/could not be decoded \(gzip\): ./);
    expect(exact["exact /stall-gzip"]).toMatch(/did not finish in 1 s/);
    expect(exact["exact /zstd-open"]).toMatch(/^rejected: The link sent the file with an encoding Frame Lens cannot read \(zstd\); only gzip, deflate and br/);
    expect(exact["exact /cut"]).toMatch(/was cut off before the file was complete/);
  }, 90_000);
});

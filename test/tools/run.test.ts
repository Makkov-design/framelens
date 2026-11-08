import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../../src/tools/run.js";
import { ToolError } from "../../src/tools/errors.js";

const dir = mkdtempSync(join(tmpdir(), "framelens-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const node = process.execPath;

describe("run", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await run(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("passes cwd and env", async () => {
    const result = await run(node, ["-e", "console.log(process.cwd() + '|' + process.env.FL_TEST)"], { cwd: dir, env: { FL_TEST: "yes" } });
    expect(result.stdout.trim().endsWith("|yes")).toBe(true);
  });

  it("runs a .mjs script under this Node", async () => {
    const script = join(dir, "hello.mjs");
    writeFileSync(script, "console.log('hi ' + process.argv[2])");
    expect((await run(script, ["there"])).stdout.trim()).toBe("hi there");
  });

  it("keeps the start of stdout and the end of stderr when output is over the cap", async () => {
    const result = await run(node, ["-e", "process.stdout.write('a'.repeat(5000)+'END'); process.stderr.write('x'.repeat(5000)+'TAIL')"], { maxOutputBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("a".repeat(100));
    expect(result.stderr.endsWith("TAIL")).toBe(true);
    expect(result.stderr.length).toBe(100);
  });

  it("reports a missing program as not_found", async () => {
    await expect(run(join(dir, "nope-binary"), [])).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops a process that runs past the timeout", async () => {
    const started = Date.now();
    const error = await run(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops a process on abort, and refuses to start when already aborted", async () => {
    const controller = new AbortController();
    const pending = run(node, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await expect(run(node, ["-e", "1"], { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("kills the whole tree, not only the direct child", async () => {
    const marker = join(dir, "grandchild-ran");
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    await expect(run(node, ["-e", parent], { timeoutMs: 500 })).rejects.toMatchObject({ code: "timeout" });
    await new Promise((r) => setTimeout(r, 2200));
    expect(existsSync(marker)).toBe(false);
  });
});

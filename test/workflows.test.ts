// The Dependabot rebuild workflow copies in only the files on its allow-list. The list must name exactly the bundle
// and the committed extension build: a file the build adds would otherwise make every Dependabot rebuild fail, and a
// stale name would let an unexpected file through.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dependabot-bundle workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/dependabot-bundle.yml", import.meta.url), "utf8");

  it("allows exactly the committed bundle and extension files", () => {
    const block = /^\s*allowed=\(\n([\s\S]*?)^\s*\)$/m.exec(workflow);
    expect(block, "allowed=( ... ) in the commit job").not.toBeNull();
    const allowed = block![1]!.split("\n").map((l) => l.trim()).filter(Boolean).sort();
    const committed = execFileSync("git", ["ls-files", "--", "dist/framelens.mjs", "extension/dist"], { encoding: "utf8" }).trim().split("\n").sort();
    expect(allowed).toEqual(committed);
  });

  it("checks the artifact's size before it extracts anything, and measures what it extracted before copying it in", () => {
    const commit = workflow.slice(workflow.indexOf("  commit:"));
    expect(commit).not.toContain("actions/download-artifact");
    // The measured size of what was extracted is checked before the repository's files are touched.
    const order = ["size_in_bytes", "--max-filesize", "unzip -Z1", "unzip -Zt", "unzip -q", 'du -sk "$src"', "rm -rf extension/dist"].map((s) => commit.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

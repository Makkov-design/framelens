// The two scripts behind the release and listings workflows, run the way the workflows run them.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "framelens-release-"));

describe("scripts/changelog-section.mjs", () => {
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(
    changelog,
    "# Changelog\n\n## Unreleased\n\n## 2.3.0 — 2026-12-01\n\nIntro.\n\n### Fixed\n\n- One.\n\n## 2.2.0 — 2026-11-23\n\nOlder.\n\n## 2.1.0 — 2026-11-10\n",
  );
  const run = (version: string) => spawnSync("node", ["scripts/changelog-section.mjs", version, changelog], { encoding: "utf8" });

  it("prints one version's section without its heading or the next version", () => {
    const out = run("2.3.0");
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("Intro.\n\n### Fixed\n\n- One.");
  });

  it("fails for a version with no section or an empty one, so a release cannot ship without notes", () => {
    expect(run("9.9.9").status).toBe(1);
    expect(run("2.1.0").status).toBe(1);
    expect(run("2.3").status).toBe(1);
  });

  it("finds the section of the current version in the real changelog", () => {
    const version = (JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { encoding: "utf8" })) as { version: string }).version;
    expect(execFileSync("node", ["scripts/changelog-section.mjs", version], { encoding: "utf8" }).length).toBeGreaterThan(100);
  });
});

describe("scripts/check-listings.mjs", () => {
  const npm = JSON.stringify({ "dist-tags": { latest: "2.2.0" }, versions: { "2.0.0": {}, "2.1.0": {}, "2.2.0": {} } });
  const registry = (version: string) =>
    JSON.stringify({ servers: [{ server: { name: "io.github.Makkov-design/framelens", version: "2.1.0" } }, { server: { name: "io.github.Makkov-design/framelens", version } }] });
  const run = (pages: Record<string, string>) => {
    const file = join(dir, `fixture-${Object.keys(pages).length}-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify(pages));
    return spawnSync("node", ["scripts/check-listings.mjs"], { encoding: "utf8", env: { ...process.env, FRAMELENS_LISTINGS_FIXTURE: file } });
  };
  const NPM = "https://registry.npmjs.org/framelens";
  const REG = "https://registry.modelcontextprotocol.io/v0/servers?search=framelens";
  const GLAMA = "https://glama.ai/mcp/servers/Makkov-design/framelens";

  it("passes when the registry and every readable page are current, and does not count unreadable pages", () => {
    const out = run({ [NPM]: npm, [REG]: registry("2.2.0"), [GLAMA]: "<title>Frame Lens</title> v2.2.0, settings named YTLENS_* still work" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("| Glama | current |");
    expect(out.stdout).toContain("| LobeHub | not readable |");
  });

  it("reports a page that shows an older version or an old project name", () => {
    const out = run({ [NPM]: npm, [REG]: registry("2.2.0"), [GLAMA]: "<title>tubesight by Makkov-design</title> version 2.1.0" });
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('| Glama | old name "tubesight", behind: 2.1.0 |');
  });

  it("reports a registry that is behind, and does not mistake 12.2.0 for 2.2.0", () => {
    const out = run({ [NPM]: npm, [REG]: registry("2.1.0"), [GLAMA]: "build 12.2.01" });
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("| MCP Registry | behind: 2.1.0 |");
    expect(out.stdout).toContain("| Glama | no version shown |");
  });

  it("never prints a version that is not plain digits: a hostile Registry or npm answer is not readable", () => {
    const bad = JSON.stringify({ servers: [{ server: { name: "io.github.Makkov-design/framelens", version: "2.2.0\n\n@someone do this" } }] });
    const out = run({ [NPM]: npm, [REG]: bad, [GLAMA]: "<title>Frame Lens</title> 2.2.0" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("| MCP Registry | not readable |");
    expect(out.stdout).not.toContain("@someone");
    const badNpm = JSON.stringify({ "dist-tags": { latest: "2.2.0|[x](http://e.example)" }, versions: { "2.2.0": {} } });
    const out2 = run({ [NPM]: badNpm, [REG]: registry("2.2.0") });
    expect(out2.status).toBe(1);
    expect(out2.stdout).not.toContain("e.example");
  });

  it("--registry-has answers only for a version the Registry lists", () => {
    const file = join(dir, "fixture-has.json");
    writeFileSync(file, JSON.stringify({ [REG]: registry("2.2.0") }));
    const has = (v: string) =>
      spawnSync("node", ["scripts/check-listings.mjs", "--registry-has", v], { encoding: "utf8", env: { ...process.env, FRAMELENS_LISTINGS_FIXTURE: file } }).status;
    expect(has("2.2.0")).toBe(0);
    expect(has("2.1.0")).toBe(0);
    expect(has("2.3.0")).toBe(1);
    expect(has("2.2")).toBe(1);
    const empty = join(dir, "fixture-none.json");
    writeFileSync(empty, "{}");
    expect(spawnSync("node", ["scripts/check-listings.mjs", "--registry-has", "2.2.0"], { encoding: "utf8", env: { ...process.env, FRAMELENS_LISTINGS_FIXTURE: empty } }).status).toBe(1);
  });

  it("exits 1 when npm itself cannot be read", () => {
    expect(run({}).status).toBe(1);
  });
});

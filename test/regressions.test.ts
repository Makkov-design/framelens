import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = join(import.meta.dirname, "..");
const sourceFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));

describe("regressions", () => {
  it("never writes to stdout, which carries the MCP protocol", () => {
    // The command-line commands (`framelens doctor`, `--help`, …) print to stdout like any CLI; they never run inside
    // the server, which starts only when there is no command (checked in regressions-2-1-release.test.ts).
    const commands = new Set(["cli.ts", "doctor.ts"]);
    for (const file of sourceFiles.filter((f) => !commands.has(f.replace(/\\/g, "/")))) {
      const code = readFileSync(join(root, "src", file), "utf8");
      expect(code, file).not.toMatch(/console\.(log|info|debug|warn|error)\(|process\.stdout/);
    }
  });

  it("reports the package version everywhere", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    // A release moves every copy of the version together: the lockfile, the extension build, the README's examples
    // and the CHANGELOG's latest release.
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]!.version).toBe(pkg.version);
    expect(JSON.parse(readFileSync(join(root, "extension", "dist", "manifest.json"), "utf8")).version).toBe(pkg.version);
    expect(readFileSync(join(root, "extension", "dist", "background.js"), "utf8")).toContain(`Frame Lens extension ${"$"}{"${pkg.version}"}`);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const pins = [...readme.matchAll(/framelens@(\d+\.\d+\.\d+)|framelens#v(\d+\.\d+\.\d+)/g)].map((m) => m[1] ?? m[2]);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect(pin, "a version named in README.md").toBe(pkg.version);
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(/^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}$/m.exec(changelog)?.[1], "the latest release in CHANGELOG.md").toBe(pkg.version);
  });

  it("keeps the MCP Registry entry in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; mcpName: string };
    const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
      name: string;
      version: string;
      description: string;
      packages: unknown[];
    };
    // The registry checks that the published npm package's mcpName equals server.json's name.
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([expect.objectContaining({ registryType: "npm", identifier: pkg.name, version: pkg.version })]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("only ever talks to Google through the SDK (no hand-built URLs with the key)", () => {
    for (const file of sourceFiles) {
      expect(readFileSync(join(root, "src", file), "utf8"), file).not.toMatch(/[?&]key=\$\{|fetch\(/);
    }
  });
});

describe("install from GitHub", () => {
  it("has no script that makes npm install dev dependencies and rebuild on `npx github:...`", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: object };
    for (const name of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
      expect(pkg.scripts, name).not.toHaveProperty(name);
    }
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/errors.js";
import { initProject, SERVER_SPEC } from "../src/init.js";
import { VERSION } from "../src/version.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "framelens-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mcpJson = () => JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
const skill = () => readFileSync(join(dir, ".claude", "skills", "framelens", "SKILL.md"), "utf8");

describe("initProject", () => {
  it("pins the server to this version on GitHub", () => {
    expect(SERVER_SPEC).toBe(`github:Makkov-design/framelens#v${VERSION}`);
  });

  it("creates .mcp.json and the skill in an empty project", () => {
    const result = initProject(dir);

    expect(mcpJson()).toEqual({
      mcpServers: {
        framelens: {
          command: "npx",
          args: ["-y", SERVER_SPEC],
          env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
        },
      },
    });
    expect(skill()).toMatch(/^---\nname: framelens\n/);
    expect(result.files).toEqual([".mcp.json", ".claude/skills/framelens/SKILL.md"]);
  });

  it("replaces a ytlens entry from the earlier name instead of adding a second server", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { ytlens: { command: "npx" }, other: { command: "x" } } }));
    initProject(dir);
    expect(Object.keys(mcpJson().mcpServers)).toEqual(["other", "framelens"]);
  });

  it("keeps other servers and settings in an existing .mcp.json", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-server" } }, extra: true }, null, 2),
    );
    initProject(dir);
    const config = mcpJson();
    expect(config.extra).toBe(true);
    expect(config.mcpServers.other).toEqual({ command: "other-server" });
    expect(config.mcpServers.framelens.args).toEqual(["-y", SERVER_SPEC]);
  });

  it("updates an older framelens entry and is safe to run twice", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { framelens: { command: "npx", args: ["-y", "github:Makkov-design/framelens#v0.9.0"] } } }),
    );
    initProject(dir);
    initProject(dir);
    expect(mcpJson().mcpServers.framelens.args).toEqual(["-y", SERVER_SPEC]);
  });

  it("refuses to touch an .mcp.json it cannot parse", () => {
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(() => initProject(dir)).toThrow(InvalidInputError);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{ not json");
  });

  it("overwrites an outdated skill file", () => {
    mkdirSync(join(dir, ".claude", "skills", "framelens"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "framelens", "SKILL.md"), "old");
    initProject(dir);
    expect(skill()).toMatch(/name: framelens/);
  });
});

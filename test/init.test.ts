import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/errors.js";
import { GITHUB_SERVER_SPEC, INIT_NEXT_STEPS, initProject, SERVER_SPEC } from "../src/init.js";
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
  it("pins the server to this version of the npm package, with GitHub kept as a documented fallback", () => {
    // 2.1.0 wrote github:Makkov-design/framelens#v2.1.0: a 16 MB download that needs the tag to exist.
    expect(SERVER_SPEC).toBe(`framelens@${VERSION}`);
    expect(GITHUB_SERVER_SPEC).toBe(`github:Makkov-design/framelens#v${VERSION}`);
    initProject(dir);
    expect(mcpJson().mcpServers.framelens).toMatchObject({ command: "npx", args: ["-y", `framelens@${VERSION}`] });
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(GITHUB_SERVER_SPEC.replace(VERSION, "<version>"));
  });

  it("puts asking the agent first and the Gemini key last, as optional", () => {
    const steps = INIT_NEXT_STEPS.split(/\n\s*\d\.\s/).slice(1);
    expect(steps[1]).toMatch(/ask your agent about any video, link, file, site, Lottie or\s+Rive/);
    expect(steps[1]).toMatch(/local tools need no API key/);
    expect(steps.at(-1)).toMatch(/^Optional, only for the Gemini YouTube tools/);
    expect(steps.slice(0, -1).join(" ")).not.toContain("GEMINI_API_KEY");
    expect(INIT_NEXT_STEPS).not.toMatch(/share a YouTube link/);
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

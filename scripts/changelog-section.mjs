#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md (without its heading), for the release workflow.
// Usage: node scripts/changelog-section.mjs 2.3.0 [path]
import { readFileSync } from "node:fs";

export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length > 0 ? body : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, path = "CHANGELOG.md"] = process.argv.slice(2);
  const section = version ? changelogSection(readFileSync(path, "utf8"), version) : null;
  if (!section) {
    console.error(`CHANGELOG.md has no section "## ${version ?? "<version>"} — <date>" with text in it.`);
    process.exit(1);
  }
  console.log(section);
}

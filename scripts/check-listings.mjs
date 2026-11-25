#!/usr/bin/env node
// Compares the version on npm with the official MCP Registry and the catalogues that copy from it.
// Prints a Markdown report. Exit code 0: everything readable is current; 2: at least one listing is behind or
// still has an old project name in its title; 1: npm itself could not be read.
// A catalogue that cannot be read (bot check, timeout) is reported as "not readable" and never counted as behind.
// `--registry-has <version>` only asks the Registry: exit 0 when it lists that version, 1 otherwise.
// A version read from npm or the Registry is used only when it is plain digits (1.2.3): it goes into the issue text.
// FRAMELENS_LISTINGS_FIXTURE=<file.json> ({ "<url>": "<body>" }) replaces the network, for tests.
import { readFileSync } from "node:fs";

const NAME = "io.github.Makkov-design/framelens";
const OLD_NAMES = ["tubesight", "ytlens"];
const NPM = "https://registry.npmjs.org/framelens";
const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers?search=framelens";
const PAGES = [
  ["Glama", "https://glama.ai/mcp/servers/Makkov-design/framelens"],
  ["LobeHub", "https://lobehub.com/mcp/makkov-design-framelens"],
  ["MCP Market", "https://mcpmarket.com/server/frame-lens"],
  ["claudemarketplaces.com", "https://claudemarketplaces.com/mcp/makkov-design/framelens"],
  ["mcprush", "https://mcprush.com/makkov-design/frame-lens-mcp"],
];

const fixture = process.env.FRAMELENS_LISTINGS_FIXTURE
  ? JSON.parse(readFileSync(process.env.FRAMELENS_LISTINGS_FIXTURE, "utf8"))
  : null;

async function read(url) {
  if (fixture) return url in fixture ? fixture[url] : null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "framelens-listings-check (+https://github.com/Makkov-design/framelens)" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const isVersion = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
const hasVersion = (text, v) => new RegExp(`(^|[^0-9.])${v.replaceAll(".", "\\.")}([^0-9.]|$)`).test(text);

async function registryVersions() {
  const versions = JSON.parse(await read(REGISTRY))
    .servers.map((s) => s.server)
    .filter((s) => s.name === NAME)
    .map((s) => s.version);
  if (versions.length === 0 || !versions.every(isVersion)) throw new Error("not readable");
  return versions.sort(cmp);
}

if (process.argv[2] === "--registry-has") {
  const wanted = process.argv[3];
  let listed = false;
  try {
    listed = isVersion(wanted) && (await registryVersions()).includes(wanted);
  } catch {}
  process.exit(listed ? 0 : 1);
}

const npmBody = await read(NPM);
let latest, older;
try {
  const doc = JSON.parse(npmBody);
  latest = doc["dist-tags"].latest;
  if (!isVersion(latest)) throw new Error("not a version");
  older = Object.keys(doc.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && cmp(v, latest) < 0);
} catch {
  console.log("npm could not be read; nothing was compared.");
  process.exit(1);
}

const rows = [];
let behind = false;

try {
  const top = (await registryVersions()).at(-1);
  const ok = top === latest;
  behind ||= !ok;
  rows.push(["MCP Registry", ok ? "current" : `behind: ${top}`, REGISTRY]);
} catch {
  rows.push(["MCP Registry", "not readable", REGISTRY]);
}

for (const [label, url] of PAGES) {
  const body = await read(url);
  if (body === null) {
    rows.push([label, "not readable", url]);
    continue;
  }
  const notes = [];
  // Only the page title: the README text that catalogues copy mentions the old names itself.
  const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").toLowerCase();
  const oldName = OLD_NAMES.find((n) => title.includes(n));
  if (oldName) notes.push(`old name "${oldName}"`);
  if (!hasVersion(body, latest)) {
    const shown = older.filter((v) => hasVersion(body, v)).sort(cmp).at(-1);
    if (shown) notes.push(`behind: ${shown}`);
  }
  if (notes.length > 0) behind = true;
  const state = notes.length > 0 ? notes.join(", ") : hasVersion(body, latest) ? "current" : "no version shown";
  rows.push([label, state, url]);
}

console.log(`npm \`framelens\` is at **${latest}**.\n`);
console.log("| Listing | State | Page |\n|---|---|---|");
for (const [label, state, url] of rows) console.log(`| ${label} | ${state} | ${url} |`);
console.log(
  "\nA catalogue that copies from npm, GitHub or the MCP Registry can take days to catch up after a release. " +
    '"Not readable" means the page refused an automated request; open it in a browser.',
);
process.exit(behind ? 2 : 0);

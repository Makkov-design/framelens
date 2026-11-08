#!/usr/bin/env node
// Live end-to-end check: starts the built server over stdio, like an MCP client does, and calls every
// tool against a real public video. Needs GEMINI_API_KEY and `npm run bundle` first. Uses Gemini quota.
//
//   node scripts/smoke.mjs [youtube-url] [--long <url-of-a-video-over-1-hour>]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const longIndex = args.indexOf("--long");
const longVideo = longIndex >= 0 ? args.splice(longIndex, 2)[1] : undefined;
const video = args[0] ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo", 19 s

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error("Set GEMINI_API_KEY first.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/framelens.mjs", import.meta.url))],
  env: { ...process.env, FRAMELENS_LOG_LEVEL: "info" },
  stderr: "inherit",
});
const protocolErrors = [];
const client = new Client({ name: "smoke", version: "0" });
client.onerror = (error) => protocolErrors.push(error);
await client.connect(transport);

let failures = 0;
async function step(name, toolArgs, check, { expectError = false } = {}) {
  const started = Date.now();
  // Long videos can take minutes; the SDK's default request timeout is 60 s.
  const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 360_000 });
  const text = result.content?.[0]?.text ?? "";
  const problem = expectError
    ? result.isError ? undefined : "expected an error"
    : result.isError ? text : check?.(result);
  console.log(`\n=== ${name} ${JSON.stringify(toolArgs)} — ${problem ? "FAIL" : "ok"} in ${Date.now() - started} ms`);
  console.log(text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text);
  if (problem) {
    failures++;
    console.log(`!!! ${problem}`);
  }
  return result;
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

await step("list_supported_models", {}, (r) => (/← in use/.test(r.content[0].text) ? undefined : "configured model not found in list"));
await step("summarize_youtube_video", { youtube_url: video, summary_length: "short" });
await step("ask_about_youtube_video", { youtube_url: video, question: "What animals are visible, and what exactly does the person say about them?" });
await step("ask_about_youtube_video", { youtube_url: video, question: "Опиши, что происходит в кадре.", detail: "low" });
await step("extract_key_moments", { youtube_url: video, number_of_moments: 3 }, (r) =>
  r.structuredContent?.moments?.length ? undefined : "no structured moments",
);
await step("get_video_transcript", { youtube_url: video }, (r) =>
  r.structuredContent?.segments?.length ? undefined : "no transcript segments",
);
await step("summarize_youtube_video", { youtube_url: video, summary_length: "short" }, (r) =>
  /· cached/.test(r.content[0].text) ? undefined : "repeat call was not served from cache",
);
await step("summarize_youtube_video", { youtube_url: "https://example.com/video" }, undefined, { expectError: true });

if (longVideo) {
  await step("extract_key_moments", { youtube_url: longVideo, number_of_moments: 6, start: "1:00:00", end: "1:20:00", detail: "low" }, (r) => {
    const moments = r.structuredContent?.moments ?? [];
    if (!moments.length) return "no moments";
    const outside = moments.filter((m) => m.seconds < 3600 || m.seconds > 4800);
    return outside.length ? `moments outside 1:00:00–1:20:00: ${outside.map((m) => m.timestamp).join(", ")}` : undefined;
  });
}

await client.close();
if (protocolErrors.length) {
  failures++;
  console.log(`\n!!! protocol errors (something wrote to stdout?): ${protocolErrors.map(String).join("; ")}`);
}
console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);

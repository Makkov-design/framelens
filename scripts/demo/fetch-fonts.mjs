// Downloads the site's fonts (Panchang 700, General Sans 400 and 600, from Fontshare under the
// ITF Free Font License) into assets/fonts/. The files are not committed; run this once before
// previewing or rendering: node fetch-fonts.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "assets", "fonts");
const fonts = [
  ["panchang@700", "panchang-700.woff2"],
  ["general-sans@400", "general-sans-400.woff2"],
  ["general-sans@600", "general-sans-600.woff2"],
];

await mkdir(out, { recursive: true });
for (const [query, file] of fonts) {
  const css = await (await fetch(`https://api.fontshare.com/v2/css?f%5B%5D=${query}&display=swap`)).text();
  const url = css.match(/url\('([^']+\.woff2)'\)/)?.[1];
  if (!url) throw new Error(`No woff2 for ${query}`);
  const res = await fetch(url.startsWith("//") ? `https:${url}` : url);
  if (!res.ok) throw new Error(`${query}: HTTP ${res.status}`);
  await writeFile(join(out, file), Buffer.from(await res.arrayBuffer()));
  console.log(`${file}  ${res.headers.get("content-length") ?? "?"} bytes`);
}

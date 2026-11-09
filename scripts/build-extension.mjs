// Builds the browser extension into extension/dist (load it unpacked) and extension/framelens-extension-<version>.zip.
// The page reader is not a copy: reader.js is Frame Lens's own PAGE_SCRIPT from src/browser/page-script.ts, and the
// service worker bundles the same cleaning and merging code the `web` tool uses. No code is fetched at run time.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extension");
const dist = join(ext, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "icons"), { recursive: true });

await build({
  entryPoints: { background: join(ext, "src/background.ts"), offscreen: join(ext, "src/offscreen.ts"), popup: join(ext, "src/popup.ts") },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  // Readable on purpose: store reviewers and users can see exactly what runs.
  minify: false,
  legalComments: "none",
  charset: "utf8",
  define: { FRAMELENS_VERSION: JSON.stringify(version) },
  logLevel: "warning",
});

// reader.js: the PAGE_SCRIPT expression itself. executeScript returns a file's last value, the reading.
const reader = await build({ entryPoints: [join(root, "src/browser/page-script.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning" });
const { PAGE_SCRIPT } = await import(`data:text/javascript;base64,${Buffer.from(reader.outputFiles[0].text).toString("base64")}`);
writeFileSync(join(dist, "reader.js"), `// Frame Lens page reader, generated from src/browser/page-script.ts (the same script the web tool runs).\n${PAGE_SCRIPT};\n`);

const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const page of ["popup.html", "offscreen.html"]) copyFileSync(join(ext, "src", page), join(dist, page));

// --- Icons: a lens ring drawn in code, so the repository holds no binary sources -------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / (size / 2);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // Dark rounded tile, a yellow ring and a small blue pupil.
      const tile = Math.max(Math.abs(x - c), Math.abs(y - c)) / (size / 2) < 0.96;
      const ring = r > 0.48 && r < 0.72;
      const pupil = r < 0.24;
      const [R, G, B] = ring ? [0xf2, 0xe9, 0x4e] : pupil ? [0x7a, 0xa7, 0xff] : [0x16, 0x17, 0x1d];
      rows.set([R, G, B, tile ? 255 : 0], o);
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
for (const size of [16, 32, 48, 128]) writeFileSync(join(dist, "icons", `${size}.png`), png(size));

// --- The zip, for sharing the build or uploading it to a store later ---------------------------------------------
function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const locals = [];
const centrals = [];
let offset = 0;
for (const path of files(dist)) {
  const name = Buffer.from(relative(dist, path).replaceAll("\\", "/"));
  const raw = readFileSync(path);
  const data = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);
  const header = (central) => {
    const h = Buffer.alloc(central ? 46 : 30);
    let p = 0;
    h.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, p);
    p += 4;
    if (central) (h.writeUInt16LE(20, p), (p += 2));
    h.writeUInt16LE(20, p);
    h.writeUInt16LE(0x0800, p + 2); // names are UTF-8
    h.writeUInt16LE(8, p + 4);
    h.writeUInt16LE(0, p + 6); // 00:00
    h.writeUInt16LE(0x21, p + 8); // 1980-01-01: the same zip for the same files
    h.writeUInt32LE(crc, p + 10);
    h.writeUInt32LE(data.length, p + 14);
    h.writeUInt32LE(raw.length, p + 18);
    h.writeUInt16LE(name.length, p + 22);
    if (central) h.writeUInt32LE(offset, 42);
    return h;
  };
  centrals.push(header(true), name);
  locals.push(header(false), name, data);
  offset += 30 + name.length + data.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zip = join(ext, `framelens-extension-${version}.zip`);
writeFileSync(zip, Buffer.concat([...locals, directory, end]));
process.stderr.write(`extension ${version}: ${relative(root, dist)} and ${relative(root, zip)}\n`);

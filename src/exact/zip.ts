import { inflateRawSync } from "node:zlib";

/** Largest single file we inflate, so a crafted archive cannot fill memory. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** All files together: many entries just under the single-file cap would otherwise still fill memory. */
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;

/** Reads the files of a ZIP from its central directory (stored and deflate only; enough for .lottie). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no central directory).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt ZIP entry ${name}.`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    // Names are only map keys here; nothing is ever written to disk under an entry's name.
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - total) });
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new Error("This archive unpacks to more than Frame Lens reads (192 MB).");
        throw new Error(`ZIP entry ${name.slice(0, 80)} is corrupt.`);
      }
    } else throw new Error(`ZIP entry ${name.slice(0, 80)} uses unsupported compression ${method}.`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("This archive unpacks to more than Frame Lens reads (192 MB).");
    files.set(name, data);
  }
  return files;
}

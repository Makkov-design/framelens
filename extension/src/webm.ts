/**
 * Chrome's MediaRecorder writes WebM without a duration (it streams and never goes back), so players show no length
 * and tools that read the container header see 0 s. This adds the Duration element to the Segment Info, the way
 * the container would carry it, without touching the frames: their timestamps stay the real, variable ones.
 */

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const SEEK_HEAD = 0x114d9b74;
const CLUSTER = 0x1f43b675;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** An EBML variable-length number: IDs keep their marker bit, sizes drop it; all ones is "unknown size". */
function vint(buf: Uint8Array, pos: number, keepMarker: boolean): Vint | undefined {
  const first = buf[pos];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i]!;
    if (buf[pos + i] !== 0xff) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}

function element(buf: Uint8Array, pos: number): { id: number; dataStart: number; size: number; unknown: boolean } | undefined {
  const id = vint(buf, pos, true);
  if (!id) return undefined;
  const size = vint(buf, pos + id.length, false);
  if (!size) return undefined;
  return { id: id.value, dataStart: pos + id.length + size.length, size: size.value, unknown: size.unknown };
}

function readUint(buf: Uint8Array, start: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i]!;
  return v;
}

/** The size as an 8-byte EBML number, which every reader accepts and never needs to grow. */
function size8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
}

/** Where the Segment Info sits and what it holds, or undefined when the file is not a WebM this can fix safely. */
export function findInfo(head: Uint8Array): { start: number; end: number; dataStart: number; timecodeScale: number; hasDuration: boolean } | undefined {
  const header = element(head, 0);
  if (!header || header.id !== EBML) return undefined;
  const segmentPos = header.dataStart + header.size;
  const segment = element(head, segmentPos);
  // A Segment with a known size would need its size rewritten too; MediaRecorder always writes "unknown".
  if (!segment || segment.id !== SEGMENT || !segment.unknown) return undefined;
  for (let pos = segment.dataStart; pos < head.length; ) {
    const el = element(head, pos);
    if (!el || el.unknown) return undefined;
    // A SeekHead holds byte positions that the insertion would move; leave such files alone.
    if (el.id === SEEK_HEAD || el.id === CLUSTER) return undefined;
    const end = el.dataStart + el.size;
    if (el.id === INFO) {
      if (end > head.length) return undefined;
      let timecodeScale = 1_000_000;
      let hasDuration = false;
      for (let p = el.dataStart; p < end; ) {
        const child = element(head, p);
        if (!child) return undefined;
        if (child.id === TIMECODE_SCALE) timecodeScale = readUint(head, child.dataStart, child.size) || 1_000_000;
        if (child.id === DURATION) hasDuration = true;
        p = child.dataStart + child.size;
      }
      return { start: pos, end, dataStart: el.dataStart, timecodeScale, hasDuration };
    }
    pos = end;
  }
  return undefined;
}

/** The recording with its duration written in; the original Blob when there is nothing to fix or it is unsafe to. */
export async function withWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!(durationMs > 0)) return blob;
  const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const info = findInfo(head);
  if (!info || info.hasDuration) return blob;
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / info.timecodeScale);
  const data = head.subarray(info.dataStart, info.end);
  const infoBytes = new Uint8Array(4 + 8 + data.length + duration.length);
  infoBytes.set([0x15, 0x49, 0xa9, 0x66]);
  infoBytes.set(size8(data.length + duration.length), 4);
  infoBytes.set(data, 12);
  infoBytes.set(duration, 12 + data.length);
  return new Blob([blob.slice(0, info.start), infoBytes, blob.slice(info.end)], { type: blob.type });
}

/** The Duration a WebM carries, in milliseconds (tests). */
export function readWebmDurationMs(head: Uint8Array): number | undefined {
  const header = element(head, 0);
  if (!header) return undefined;
  const segment = element(head, header.dataStart + header.size);
  if (!segment) return undefined;
  for (let pos = segment.dataStart; pos < head.length; ) {
    const el = element(head, pos);
    if (!el) return undefined;
    if (el.id === INFO) {
      let scale = 1_000_000;
      let raw: number | undefined;
      for (let p = el.dataStart; p < el.dataStart + el.size; ) {
        const child = element(head, p);
        if (!child) return undefined;
        if (child.id === TIMECODE_SCALE) scale = readUint(head, child.dataStart, child.size);
        if (child.id === DURATION) {
          const view = new DataView(head.buffer, head.byteOffset + child.dataStart, child.size);
          raw = child.size === 4 ? view.getFloat32(0) : view.getFloat64(0);
        }
        p = child.dataStart + child.size;
      }
      return raw === undefined ? undefined : (raw * scale) / 1_000_000;
    }
    if (el.unknown) return undefined;
    pos = el.dataStart + el.size;
  }
  return undefined;
}

/**
 * Test-only writer for the Rive runtime format, the mirror of src/exact/rive.ts: builds small synthetic .riv files so
 * every field type, table-of-contents skipping and broken or hostile input can be tested without the Rive editor.
 */
export type Field = "uint" | "int" | "bool" | "double" | "color" | "string" | "bytes";
export type Prop = [key: number, field: Field, value: number | string | boolean | Uint8Array];
export type Obj = [type: number, props?: Prop[]];

export interface RivSpec {
  major?: number;
  minor?: number;
  fileId?: number;
  /** Property keys with their table-of-contents field index: 0 uint, 1 string/bytes, 2 double, 3 colour. */
  toc?: [number, 0 | 1 | 2 | 3][];
  objects: Obj[];
}

export function varuint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return [...b];
};
const f32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return [...b];
};

function value(field: Field, v: Prop[2]): number[] {
  switch (field) {
    case "uint":
      return varuint(Number(v));
    case "int": {
      const n = Number(v);
      return varuint(n < 0 ? -2 * n - 1 : 2 * n);
    }
    case "bool":
      return [v ? 1 : 0];
    case "double":
      return f32(Number(v));
    case "color":
      return u32(Number(v));
    case "string": {
      const b = Buffer.from(String(v), "utf8");
      return [...varuint(b.length), ...b];
    }
    case "bytes": {
      const b = v instanceof Uint8Array ? v : Buffer.from(String(v));
      return [...varuint(b.length), ...b];
    }
  }
}

export function header(s: Omit<RivSpec, "objects"> = {}): number[] {
  const toc = s.toc ?? [];
  const out = [...Buffer.from("RIVE"), ...varuint(s.major ?? 7), ...varuint(s.minor ?? 0), ...varuint(s.fileId ?? 42)];
  for (const [k] of toc) out.push(...varuint(k));
  out.push(0);
  for (let i = 0; i < toc.length; i += 4) {
    let bits = 0;
    toc.slice(i, i + 4).forEach(([, f], j) => (bits |= f << (j * 2)));
    out.push(...u32(bits));
  }
  return out;
}

export function object([type, props = []]: Obj): number[] {
  const out = varuint(type);
  for (const [key, field, v] of props) out.push(...varuint(key), ...value(field, v));
  out.push(0);
  return out;
}

export function riv(s: RivSpec): Uint8Array {
  return Uint8Array.from([...header(s), ...s.objects.flatMap(object)]);
}

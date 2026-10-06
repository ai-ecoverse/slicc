export interface ImportedMemory {
  module: string;
  name: string;
  initial: number;
  maximum?: number;
  shared: boolean;
}

export type ForeignResult = 'none' | 'i32' | 'i64' | 'f32' | 'f64' | 'other';

export type ForeignImports = Record<string, Record<string, ForeignResult>>;

const PROVIDED = new Set(['wasi_snapshot_preview1', 'wasix_32v1', 'wasi', 'env']);

const VALTYPE: Record<number, ForeignResult> = { 127: 'i32', 126: 'i64', 125: 'f32', 124: 'f64' };

function reader(bytes: Uint8Array) {
  const r = {
    at: 8,
    u32(): number {
      let result = 0;
      let shift = 0;
      for (;;) {
        const b = bytes[r.at++];
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) return result >>> 0;
        shift += 7;
      }
    },
    name(): string {
      const len = r.u32();
      const s = new TextDecoder().decode(bytes.subarray(r.at, r.at + len));
      r.at += len;
      return s;
    },
    limits() {
      const flags = bytes[r.at++];
      const initial = r.u32();
      const maximum = flags & 1 ? r.u32() : undefined;
      return { initial, maximum, shared: (flags & 2) !== 0 };
    },

    sections(visit: (id: number, end: number) => boolean | undefined): void {
      while (r.at < bytes.length) {
        const id = bytes[r.at++];
        const size = r.u32();
        const end = r.at + size;
        if (visit(id, end)) return;
        r.at = end;
      }
    },

    imports(
      visit: (module: string, field: string, kind: number, type: number) => boolean | undefined
    ): void {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const module = r.name();
        const field = r.name();
        const kind = bytes[r.at++];
        let type = -1;
        if (kind === 0) type = r.u32();
        else if (kind === 1) {
          r.at++;
          r.limits();
        } else if (kind === 2) {
          const at = r.at;
          if (visit(module, field, kind, type)) return;
          r.at = at;
          r.limits();
          continue;
        } else if (kind === 3) r.at += 2;
        else if (kind === 4) {
          r.at++;
          r.u32();
        }
        if (visit(module, field, kind, type)) return;
      }
    },
  };
  return r;
}

export function importedMemory(bytes: Uint8Array): ImportedMemory | undefined {
  const r = reader(bytes);
  let memory: ImportedMemory | undefined;
  r.sections((id) => {
    if (id !== 2) return false;
    r.imports((module, name, kind) => {
      if (kind !== 2) return false;
      memory = { module, name, ...r.limits() };
      return true;
    });
    return true;
  });
  return memory;
}

export function foreignImports(bytes: Uint8Array): ForeignImports {
  const r = reader(bytes);
  const results: ForeignResult[] = [];
  const foreign: ForeignImports = {};
  r.sections((id) => {
    if (id === 1) {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        r.at++;
        const params = r.u32();
        r.at += params;
        const n = r.u32();
        results.push(n === 0 ? 'none' : n === 1 ? (VALTYPE[bytes[r.at]] ?? 'other') : 'other');
        r.at += n;
      }
      return false;
    }
    if (id !== 2) return false;
    r.imports((module, name, kind, type) => {
      if (kind === 0 && !PROVIDED.has(module))
        (foreign[module] ??= {})[name] = results[type] ?? 'other';
      return false;
    });
    return true;
  });
  return foreign;
}

export interface ImportedMemory {
  module: string;
  name: string;
  initial: number;
  maximum?: number;
  shared: boolean;
}

export function importedMemory(bytes: Uint8Array): ImportedMemory | undefined {
  let at = 8;
  const u32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[at++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  const name = (): string => {
    const len = u32();
    const s = new TextDecoder().decode(bytes.subarray(at, at + len));
    at += len;
    return s;
  };
  const limits = () => {
    const flags = bytes[at++];
    const initial = u32();
    const maximum = flags & 1 ? u32() : undefined;
    return { initial, maximum, shared: (flags & 2) !== 0 };
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u32();
    const end = at + size;
    if (id !== 2) {
      at = end;
      continue;
    }
    const count = u32();
    for (let i = 0; i < count; i++) {
      const module = name();
      const field = name();
      const kind = bytes[at++];
      if (kind === 0) u32();
      else if (kind === 1) {
        at++;
        limits();
      } else if (kind === 2) {
        const l = limits();
        return { module, name: field, ...l };
      } else if (kind === 3) at += 2;
      else if (kind === 4) {
        at++;
        u32();
      }
    }
    return undefined;
  }
  return undefined;
}

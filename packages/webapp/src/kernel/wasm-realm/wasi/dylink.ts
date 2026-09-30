const MEM_INFO = 1;
const NEEDED = 2;

export interface DylinkInfo {
  memorySize: number;

  memoryAlign: number;

  tableSize: number;
  tableAlign: number;

  needed: string[];
}

export function dylinkInfo(module: WebAssembly.Module): DylinkInfo | undefined {
  const [section] = WebAssembly.Module.customSections(module, 'dylink.0');
  if (!section) return undefined;
  const bytes = new Uint8Array(section);
  let at = 0;
  const uleb = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[at++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
      shift += 7;
    }
  };
  const string = (): string => {
    const len = uleb();
    const s = new TextDecoder().decode(bytes.subarray(at, at + len));
    at += len;
    return s;
  };
  const info: DylinkInfo = {
    memorySize: 0,
    memoryAlign: 0,
    tableSize: 0,
    tableAlign: 0,
    needed: [],
  };
  while (at < bytes.length) {
    const kind = bytes[at++];
    const len = uleb();
    const end = at + len;
    if (kind === MEM_INFO) {
      info.memorySize = uleb();
      info.memoryAlign = uleb();
      info.tableSize = uleb();
      info.tableAlign = uleb();
    } else if (kind === NEEDED) {
      for (let n = uleb(); n > 0; n--) info.needed.push(string());
    }
    at = end;
  }
  return info;
}

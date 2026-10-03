/**
 * `wasm-names.ts` — names for a trap's wasm frames from a name-section
 * sidecar. A large toolchain module (rustc.wasm: 50 MB of names) can ship
 * without its `name` custom section and keep it beside itself as
 * `<module>.names` (that section's payload). V8 then shows its frames as
 * `wasm-function[N]`; with `SLICC_WASM_BACKTRACE=1` the realm reads the
 * sidecar on the trap and names them as V8 would from the section.
 */

/** The `name` section's function-names subsection (id 1): function index → name. */
export function parseFunctionNames(payload: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  const decoder = new TextDecoder();
  let at = 0;
  const leb = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= payload.length) throw new RangeError('truncated name section');
      byte = payload[at++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (at < payload.length) {
    const id = payload[at++];
    const size = leb();
    const end = at + size;
    if (end > payload.length) throw new RangeError('truncated name section');
    if (id === 1) {
      for (let count = leb(); count > 0; count--) {
        const index = leb();
        const length = leb();
        if (at + length > end) throw new RangeError('truncated name section');
        names.set(index, decoder.decode(payload.subarray(at, at + length)));
        at += length;
      }
    }
    at = end;
  }
  return names;
}

/** A V8 stack line of an unnamed wasm frame: `at wasm://wasm/<id>:wasm-function[N]:0x<offset>`. */
const UNNAMED_FRAME = /^(\s+at )(wasm:\/\/wasm\/[^\s()]*:wasm-function\[(\d+)\]:0x[0-9a-f]+)$/;

/** `line` with its function named (`at <name> (wasm://…)`, as V8 prints a named frame), when `name` knows it. */
export function nameFrame(line: string, name: (index: number) => string | undefined): string {
  const m = UNNAMED_FRAME.exec(line);
  if (!m) return line;
  const found = name(Number(m[3]));
  return found === undefined ? line : `${m[1]}${found} (${m[2]})`;
}

/**
 * A resolver over the sidecar at `path`, read (once) on first use; undefined
 * names when it cannot be read or parsed — a backtrace never fails for it.
 */
export function sidecarNames(
  read: (path: string) => Uint8Array,
  path: string
): (index: number) => string | undefined {
  let names: Map<number, string> | undefined;
  return (index) => {
    if (!names) {
      try {
        names = parseFunctionNames(read(path));
      } catch {
        names = new Map();
      }
    }
    return names.get(index);
  };
}

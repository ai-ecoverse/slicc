import { type DylinkInfo, dylinkInfo } from './dylink.js';
import { normalize } from './wasi-files.js';

const TABLE_BASE = 1;
const PAGE = 65536;

export const STACK_SIZE = 8 * 1024 * 1024;

const LIBRARY_DIRS = ['/lib', '/usr/lib', '/usr/local/lib'];

function expandOrigin(entry: string, dir: string): string {
  return entry.replace(/\$(?:ORIGIN\b|\{ORIGIN\})/g, dir);
}

export type LinkRecord =
  | { kind: 'load'; handle: number; path: string; memoryBase: number; tableBase: number }
  | { kind: 'slot'; index: number; handle: number; name: string };

export interface LinkerHost {
  read(path: string): Uint8Array<ArrayBuffer> | undefined;

  hostImports(module: WebAssembly.Module): WebAssembly.Imports;
}

interface Linked {
  handle: number;
  path: string;
  module: WebAssembly.Module;
  info: DylinkInfo;
  instance: WebAssembly.Instance;
  memoryBase: number;
  tableBase: number;

  needed: number[];
}

export class DlError extends Error {}

export class WasixLinker {
  readonly table: WebAssembly.Table;
  readonly stackPointer: WebAssembly.Global;
  readonly memoryBase: number;
  readonly stackLow: number;
  readonly stackHigh: number;
  private readonly cLongjmp: WebAssembly.Tag;
  private readonly cppException: WebAssembly.Tag;
  private main: WebAssembly.Instance | undefined;
  private readonly modules = new Map<number, Linked>();
  private readonly byPath = new Map<string, Linked>();

  private mainGot: Array<() => void> = [];
  private readonly slots = new Map<unknown, number>();
  private nextHandle = 1;

  publisher: ((record: LinkRecord) => void) | undefined;

  constructor(
    private readonly memory: WebAssembly.Memory,
    mainInfo: DylinkInfo,
    private readonly host: LinkerHost,

    thread = false
  ) {
    this.memoryBase = Math.max(1, 2 ** mainInfo.memoryAlign);
    this.stackLow = align(this.memoryBase + mainInfo.memorySize, 1024);
    this.stackHigh = this.stackLow + STACK_SIZE;
    if (!thread) growTo(memory, this.stackHigh);
    this.table = new WebAssembly.Table({
      element: 'anyfunc',
      initial: TABLE_BASE + mainInfo.tableSize,
    });
    this.stackPointer = new WebAssembly.Global(
      { value: 'i32', mutable: true },
      thread ? 0 : this.stackHigh
    );
    const tag = () =>
      new (
        WebAssembly as unknown as { Tag: new (t: { parameters: string[] }) => WebAssembly.Tag }
      ).Tag({
        parameters: ['i32'],
      });
    this.cLongjmp = tag();
    this.cppException = tag();
  }

  mainImports(module: WebAssembly.Module): Record<string, Record<string, WebAssembly.ImportValue>> {
    const i32 = (v: number) => new WebAssembly.Global({ value: 'i32', mutable: false }, v);
    const got = (v: number) => new WebAssembly.Global({ value: 'i32', mutable: true }, v);
    const env: Record<string, WebAssembly.ImportValue> = {
      memory: this.memory,
      __indirect_function_table: this.table,
      __stack_pointer: this.stackPointer,
      __memory_base: i32(this.memoryBase),
      __table_base: i32(TABLE_BASE),
      __c_longjmp: this.cLongjmp as unknown as WebAssembly.ImportValue,
      __cpp_exception: this.cppException as unknown as WebAssembly.ImportValue,
    };
    const gotMem: Record<string, WebAssembly.Global> = {
      __stack_high: got(this.stackHigh),
      __stack_low: got(this.stackLow),
      __heap_base: got(this.stackHigh),
    };
    const gotFunc: Record<string, WebAssembly.Global> = {};
    this.mainGot = [];

    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === 'env' && imp.kind === 'function' && !(imp.name in env)) {
        env[imp.name] = this.functionImport(imp.name);
      } else if (imp.module === 'GOT.func' || (imp.module === 'GOT.mem' && !(imp.name in gotMem))) {
        const g = got(0);
        (imp.module === 'GOT.func' ? gotFunc : gotMem)[imp.name] = g;
        const kind = imp.module;
        this.mainGot.push(() => {
          g.value = kind === 'GOT.func' ? this.slotOrNull(imp.name) : this.addressOrNull(imp.name);
        });
      }
    }
    return { env, 'GOT.mem': gotMem, 'GOT.func': gotFunc };
  }

  bindMainGot(): void {
    for (const resolve of this.mainGot) resolve();
  }

  bindMain(instance: WebAssembly.Instance, relocate: boolean): void {
    this.main = instance;

    if (relocate) call(instance, '__wasm_apply_data_relocs');
  }

  open(name: string, cwd: string, ldPath: readonly string[]): number {
    return this.load(this.locate(name, cwd, ldPath), cwd, ldPath).handle;
  }

  symbol(handle: number, name: string): number {
    const found =
      handle === 0 ? this.find(name) : this.findIn(this.module(handle), name, new Set());
    if (!found) throw new DlError(`undefined symbol: ${name}`);
    const [owner, value] = found;
    if (typeof value === 'function') return this.slot(value, owner, name);
    if (value instanceof WebAssembly.Global) return this.baseOf(owner) + (value.value as number);
    throw new DlError(`${name} is neither a function nor data`);
  }

  invalid(handle: number): boolean {
    return !this.modules.has(handle);
  }

  cache: Readonly<Record<string, WebAssembly.Module>> | undefined;

  compiled(): Record<string, WebAssembly.Module> {
    const out: Record<string, WebAssembly.Module> = {};
    for (const [path, linked] of this.byPath) out[path] = linked.module;
    return out;
  }

  replay(record: LinkRecord): void {
    if (record.kind === 'load') {
      if (this.modules.has(record.handle)) return;
      this.instantiate(record.path, this.moduleAt(record.path), record, false);
      this.nextHandle = Math.max(this.nextHandle, record.handle + 1);
      return;
    }
    const value =
      record.handle === 0
        ? this.main?.exports[record.name]
        : this.module(record.handle).instance.exports[record.name];
    if (typeof value !== 'function') throw new DlError(`${record.name}: not a function`);
    growTable(this.table, record.index + 1);
    this.table.set(record.index, value);
    this.slots.set(value, record.index);
  }

  private moduleAt(path: string): WebAssembly.Module {
    const cached = this.cache?.[path];
    if (cached) return cached;
    const bytes = this.host.read(path);
    if (!bytes) throw new DlError(`${path}: gone`);
    return new WebAssembly.Module(bytes);
  }

  private module(handle: number): Linked {
    const m = this.modules.get(handle);
    if (!m) throw new DlError(`invalid handle ${handle}`);
    return m;
  }

  private locate(name: string, cwd: string, ldPath: readonly string[]): string {
    if (name.includes('/'))
      return name.startsWith('/') ? normalize(name) : normalize(`${cwd}/${name}`);
    for (const dir of [...ldPath.filter(Boolean), ...LIBRARY_DIRS]) {
      const path = normalize(`${dir.startsWith('/') ? '' : `${cwd}/`}${dir}/${name}`);
      if (this.byPath.has(path) || this.host.read(path)) return path;
    }
    throw new DlError(`${name}: not found`);
  }

  private load(path: string, cwd: string, ldPath: readonly string[]): Linked {
    const loaded = this.byPath.get(path);
    if (loaded) return loaded;
    const bytes = this.host.read(path);
    if (!bytes) throw new DlError(`${path}: no such file`);
    let module: WebAssembly.Module;
    try {
      module = new WebAssembly.Module(bytes);
    } catch (e) {
      throw new DlError(`${path}: not a wasm module (${(e as Error).message})`);
    }
    const info = dylinkInfo(module);
    if (!info) throw new DlError(`${path}: not a side module (no dylink.0)`);

    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const search = [dir, ...ldPath, ...info.runtimePath.map((p) => expandOrigin(p, dir))];
    const needed = info.needed.map(
      (n) => this.load(this.locate(n, cwd, search), cwd, ldPath).handle
    );
    const memoryBase = this.allocate(info.memorySize, 2 ** info.memoryAlign);
    const tableBase = this.table.length;
    const record: LinkRecord = {
      kind: 'load',
      handle: this.nextHandle++,
      path,
      memoryBase,
      tableBase,
    };
    const linked = this.instantiate(path, module, record, true);
    linked.needed.push(...needed);
    this.publisher?.(record);
    return linked;
  }

  private instantiate(
    path: string,
    module: WebAssembly.Module,
    at: { handle: number; memoryBase: number; tableBase: number },
    init: boolean
  ): Linked {
    const info = dylinkInfo(module) as DylinkInfo;
    growTable(this.table, at.tableBase + info.tableSize);
    const pending: Array<() => void> = [];
    const env: Record<string, WebAssembly.ImportValue> = {
      memory: this.memory,
      __indirect_function_table: this.table,
      __stack_pointer: this.stackPointer,
      __memory_base: new WebAssembly.Global({ value: 'i32', mutable: false }, at.memoryBase),
      __table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, at.tableBase),
      __c_longjmp: this.cLongjmp as unknown as WebAssembly.ImportValue,
      __cpp_exception: this.cppException as unknown as WebAssembly.ImportValue,
    };
    const gotMem: Record<string, WebAssembly.Global> = {};
    const gotFunc: Record<string, WebAssembly.Global> = {};
    const linked: Linked = {
      handle: at.handle,
      path,
      module,
      info,
      instance: undefined as never,
      memoryBase: at.memoryBase,
      tableBase: at.tableBase,
      needed: [],
    };
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === 'env' && imp.kind === 'function' && !(imp.name in env)) {
        env[imp.name] = this.functionImport(imp.name);
      } else if (imp.module === 'GOT.mem') {
        const g = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
        gotMem[imp.name] = g;

        pending.push(() => {
          g.value = this.addressOrNull(imp.name);
        });
      } else if (imp.module === 'GOT.func') {
        const g = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
        gotFunc[imp.name] = g;
        pending.push(() => {
          g.value = this.slotOrNull(imp.name);
        });
      }
    }
    const imports: WebAssembly.Imports = {
      ...this.host.hostImports(module),
      env,
      'GOT.mem': gotMem,
      'GOT.func': gotFunc,
    };
    linked.instance = new WebAssembly.Instance(module, imports);
    this.modules.set(at.handle, linked);
    this.byPath.set(path, linked);
    for (const resolve of pending) resolve();
    if (init) {
      call(linked.instance, '__wasm_apply_data_relocs');
      call(linked.instance, '__wasm_call_ctors');
    } else {
      call(linked.instance, '__wasix_init_tls');
    }
    return linked;
  }

  private functionImport(name: string): WebAssembly.ImportValue {
    const now = this.find(name);
    if (now && typeof now[1] === 'function') return now[1] as WebAssembly.ImportValue;
    let resolved: ((...args: unknown[]) => unknown) | undefined;
    return (...args: unknown[]) => {
      if (!resolved) {
        const later = this.find(name);

        if (!later || typeof later[1] !== 'function')
          throw new WebAssembly.RuntimeError(`unresolved symbol ${name}`);
        resolved = later[1] as (...args: unknown[]) => unknown;
      }
      return resolved(...args);
    };
  }

  private addressOrNull(name: string): number {
    const found = this.find(name);
    if (!found || !(found[1] instanceof WebAssembly.Global)) return 0;
    return this.baseOf(found[0]) + (found[1].value as number);
  }

  private slotOrNull(name: string): number {
    const found = this.find(name);
    if (!found || typeof found[1] !== 'function') return 0;
    return this.slot(found[1], found[0], name);
  }

  private find(name: string): [number, unknown] | undefined {
    const inMain = this.main?.exports[name];
    if (inMain !== undefined) return [0, inMain];
    for (const m of this.modules.values()) {
      const v = m.instance?.exports[name];
      if (v !== undefined) return [m.handle, v];
    }
    return undefined;
  }

  private findIn(m: Linked, name: string, seen: Set<number>): [number, unknown] | undefined {
    if (seen.has(m.handle)) return undefined;
    seen.add(m.handle);
    const v = m.instance.exports[name];
    if (v !== undefined) return [m.handle, v];
    for (const h of m.needed) {
      const found = this.findIn(this.module(h), name, seen);
      if (found) return found;
    }
    return undefined;
  }

  private baseOf(handle: number): number {
    return handle === 0 ? this.memoryBase : this.module(handle).memoryBase;
  }

  private slot(fn: unknown, handle: number, name: string): number {
    const known = this.slots.get(fn);
    if (known !== undefined) return known;
    const index = this.table.length;
    this.table.grow(1);
    this.table.set(index, fn as never);
    this.slots.set(fn, index);
    this.publisher?.({ kind: 'slot', index, handle, name });
    return index;
  }

  private allocate(size: number, alignment: number): number {
    if (size === 0) return 0;
    const base = align(this.memory.buffer.byteLength, Math.max(alignment, 16));
    growTo(this.memory, base + size);
    return base;
  }
}

function align(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}

function growTo(memory: WebAssembly.Memory, bytes: number): void {
  const pages = Math.ceil(bytes / PAGE) - memory.buffer.byteLength / PAGE;
  if (pages > 0) memory.grow(pages);
}

function growTable(table: WebAssembly.Table, length: number): void {
  if (table.length < length) table.grow(length - table.length);
}

function call(instance: WebAssembly.Instance, name: string): void {
  const fn = instance.exports[name];
  if (typeof fn === 'function') (fn as () => void)();
}

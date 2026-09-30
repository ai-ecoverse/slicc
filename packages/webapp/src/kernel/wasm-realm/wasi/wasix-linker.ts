/**
 * `wasix-linker.ts` — WASIX dynamic linking in the wasm realm (#3530 phase
 * 5g): a position-independent main module (`-pie`, a `dylink.0` section)
 * and the side modules (`.so`) it `dlopen`s, as Wasmer's linker runs them.
 *
 * The main module carries wasix-libc and exports all of it; a side module
 * imports what it does not define — libc from the main module, symbols of
 * the libraries it needs (loaded first) — plus its place in memory
 * (`__memory_base`) and in the function table (`__table_base`), and `GOT.*`
 * globals for the addresses of data (`GOT.mem`) and functions (`GOT.func`,
 * table slots). Memory layout, as Wasmer's: the main module's data at a
 * non-zero base (its alignment), its stack right after (1 KiB aligned),
 * libc's heap above that; a side module's data in pages grown for it (libc's
 * `sbrk` grows the memory itself, so they never overlap).
 *
 * Every module shares the process's memory. The function table is per
 * instance, so each thread's worker keeps its own, the same slot for slot:
 * a load and a slot handed out are records (`LinkRecord`) the others replay.
 */
import { type DylinkInfo, dylinkInfo } from './dylink.js';
import { normalize } from './wasi-files.js';

/** The main module's first table slot (0 stays null, as a null function pointer). */
const TABLE_BASE = 1;
const PAGE = 65536;
/** The main thread's stack. */
export const STACK_SIZE = 8 * 1024 * 1024;
/** Where a library named without a slash is looked for. */
const LIBRARY_DIRS = ['/lib', '/usr/lib', '/usr/local/lib'];

/** A runtime-path entry with `$ORIGIN` / `${ORIGIN}` as the module's directory. */
function expandOrigin(entry: string, dir: string): string {
  return entry.replace(/\$(?:ORIGIN\b|\{ORIGIN\})/g, dir);
}

/** A change to the linked set, which every instance (thread) of the process must make too. */
export type LinkRecord =
  | { kind: 'load'; handle: number; path: string; memoryBase: number; tableBase: number }
  | { kind: 'slot'; index: number; handle: number; name: string };

export interface LinkerHost {
  /** The file at `path` (a side module), or undefined when there is none. */
  read(path: string): Uint8Array<ArrayBuffer> | undefined;
  /** The WASI / WASIX / thread imports a module links against (the same host as the main module's). */
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
  /** Libraries it needed (their handles), searched after it by dlsym. */
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
  /** The main module's GOT entries to fill once it is bound. */
  private mainGot: Array<() => void> = [];
  private readonly slots = new Map<unknown, number>();
  private nextHandle = 1;
  /** Where records for the process's other instances (threads) go. */
  publisher: ((record: LinkRecord) => void) | undefined;

  constructor(
    private readonly memory: WebAssembly.Memory,
    mainInfo: DylinkInfo,
    private readonly host: LinkerHost,
    /** A thread's instance: the process laid memory out already; the stack is the thread's own. */
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

  /** The main module's imports of its layout (memory, table, stack, bases, exception tags). */
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
    // What the main module leaves undefined (--unresolved-symbols=import-dynamic):
    // a side module may define it; if none does, a GOT entry is 0 (a weak symbol's
    // null) and a function traps when called.
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

  /** The main module's GOT entries, once it (and, in a thread, the process's links) is there. */
  bindMainGot(): void {
    for (const resolve of this.mainGot) resolve();
  }

  /** The main module is instantiated: its exports resolve side modules' imports. */
  bindMain(instance: WebAssembly.Instance, relocate: boolean): void {
    this.main = instance;
    // Its data pointers (once: the memory is the process's, threads share it).
    if (relocate) call(instance, '__wasm_apply_data_relocs');
  }

  /**
   * dlopen: the library at `name` (a path, or a name looked up in `ldPath`
   * and the library directories), its needed libraries first; its handle.
   */
  open(name: string, cwd: string, ldPath: readonly string[]): number {
    return this.load(this.locate(name, cwd, ldPath), cwd, ldPath).handle;
  }

  /** dlsym: a function's table slot, or a datum's address. Handle 0 searches everything. */
  symbol(handle: number, name: string): number {
    const found =
      handle === 0 ? this.find(name) : this.findIn(this.module(handle), name, new Set());
    if (!found) throw new DlError(`undefined symbol: ${name}`);
    const [owner, value] = found;
    if (typeof value === 'function') return this.slot(value, owner, name);
    if (value instanceof WebAssembly.Global) return this.baseOf(owner) + (value.value as number);
    throw new DlError(`${name} is neither a function nor data`);
  }

  /** dl_invalid_handle: whether `handle` names no library loaded. */
  invalid(handle: number): boolean {
    return !this.modules.has(handle);
  }

  /**
   * A thread's modules its spawner compiled already, by path: its replay
   * links them as they are, not re-read and recompiled (numpy's are MBs).
   */
  cache: Readonly<Record<string, WebAssembly.Module>> | undefined;

  /** The side modules compiled so far, by path, for a new thread (`cache`). */
  compiled(): Record<string, WebAssembly.Module> {
    const out: Record<string, WebAssembly.Module> = {};
    for (const [path, linked] of this.byPath) out[path] = linked.module;
    return out;
  }

  /** Make a record another instance of the process made (a thread replays the process's). */
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

  /** The module a replayed load links: handed over compiled, else read and compiled here. */
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
    // What it needs is loaded (and initialized) first, looked for beside it,
    // then where a program's are, then in its runtime path: after
    // LD_LIBRARY_PATH, as ELF's DT_RUNPATH is.
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

  /** Instantiate a side module at its bases; `init`: relocate and construct (the first instance only). */
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
        // Its own data too: resolved once it is instantiated.
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
      // Another thread's instance: only its thread-local storage is new.
      call(linked.instance, '__wasix_init_tls');
    }
    return linked;
  }

  /** An imported function: resolved now, or on its first call (a library loaded later defines it). */
  private functionImport(name: string): WebAssembly.ImportValue {
    const now = this.find(name);
    if (now && typeof now[1] === 'function') return now[1] as WebAssembly.ImportValue;
    let resolved: ((...args: unknown[]) => unknown) | undefined;
    return (...args: unknown[]) => {
      if (!resolved) {
        const later = this.find(name);
        // A trap, as calling through a null pointer would be: the program ends 134.
        if (!later || typeof later[1] !== 'function')
          throw new WebAssembly.RuntimeError(`unresolved symbol ${name}`);
        resolved = later[1] as (...args: unknown[]) => unknown;
      }
      return resolved(...args);
    };
  }

  /** A datum's address (GOT.mem); 0 when nothing defines it (a weak symbol's null). */
  private addressOrNull(name: string): number {
    const found = this.find(name);
    if (!found || !(found[1] instanceof WebAssembly.Global)) return 0;
    return this.baseOf(found[0]) + (found[1].value as number);
  }

  /** A function's table slot (GOT.func); 0 when nothing defines it (a weak symbol's null). */
  private slotOrNull(name: string): number {
    const found = this.find(name);
    if (!found || typeof found[1] !== 'function') return 0;
    return this.slot(found[1], found[0], name);
  }

  /** `name` among the main module's exports, then the libraries' in load order. */
  private find(name: string): [number, unknown] | undefined {
    const inMain = this.main?.exports[name];
    if (inMain !== undefined) return [0, inMain];
    for (const m of this.modules.values()) {
      const v = m.instance?.exports[name];
      if (v !== undefined) return [m.handle, v];
    }
    return undefined;
  }

  /** `name` in `m`, then in what it needs (dlsym with a handle). */
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

  /** A function's table slot, handed out once (and published: every instance's table has it there). */
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

  /** `size` bytes aligned to `alignment`, in pages grown for them. */
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

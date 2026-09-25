type FsFn = (...args: unknown[]) => unknown;

interface FsMethodTable {
  [method: string]: unknown;
}

interface BridgeStat {
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
}

export interface NodeStatsLike {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  size: number;
  mode: number;
  mtimeMs: number;
  mtime: Date;
}

export function toNodeStats(st: BridgeStat): NodeStatsLike {
  const dir = !!st.isDirectory;
  const mtimeMs = st.mtimeMs ?? 0;
  return {
    isFile: () => !!st.isFile,
    isDirectory: () => dir,
    isSymbolicLink: () => !!st.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: st.size ?? 0,
    mode: st.mode ?? (dir ? 0o40755 : 0o100644),
    mtimeMs,
    mtime: new Date(mtimeMs),
  };
}

const STAT_METHODS = new Set(['stat', 'lstat']);

export function nodeReadFileArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  if (args.length === 1 || args[1] === undefined) return [args[0], null];
  const opts = args[1];
  if (opts !== null && typeof opts === 'object' && !ArrayBuffer.isView(opts)) {
    const enc = (opts as { encoding?: string | null }).encoding;
    if (enc === undefined) return [args[0], { ...opts, encoding: null }];
  }
  return args;
}

function withErrnoCode(err: unknown): unknown {
  if (err instanceof Error && (err as { code?: unknown }).code === undefined) {
    const code = /^(E[A-Z]+)\b/.exec(err.message)?.[1];
    if (code) Object.assign(err, { code });
  }
  return err;
}

function nodeResult(name: string, result: unknown): unknown {
  return STAT_METHODS.has(name) ? toNodeStats(result as BridgeStat) : result;
}

function callBridge(name: string, fn: FsFn, thisArg: unknown, args: unknown[]): unknown {
  const callArgs = name === 'readFile' ? nodeReadFileArgs(args) : args;
  return fn.apply(thisArg, callArgs);
}

export function nodeFsPromises<T extends object>(bridge: T): T {
  const api: FsMethodTable = {};
  for (const [name, fn] of Object.entries(bridge)) {
    if (name === 'promises') continue;
    api[name] =
      typeof fn === 'function'
        ? async (...args: unknown[]) => {
            try {
              return nodeResult(name, await callBridge(name, fn as FsFn, bridge, args));
            } catch (err) {
              throw withErrnoCode(err);
            }
          }
        : fn;
  }
  return api as T;
}

export function acceptNodeCallbacks<T extends object>(bridge: T): void {
  const target = bridge as FsMethodTable;
  for (const [name, fn] of Object.entries(target)) {
    if (name === 'promises' || typeof fn !== 'function') continue;
    target[name] = function (this: unknown, ...args: unknown[]): unknown {
      const cb = args[args.length - 1];
      if (typeof cb !== 'function') return (fn as FsFn).apply(this, args);
      args.pop();
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(callBridge(name, fn as FsFn, this, args));
      } catch (err) {
        pending = Promise.reject(err);
      }
      pending.then(
        (result) => (name === 'exists' ? cb(result) : cb(null, nodeResult(name, result))),
        (err) => (name === 'exists' ? cb(false) : cb(withErrnoCode(err)))
      );
      return undefined;
    };
  }
}

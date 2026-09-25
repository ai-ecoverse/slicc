/**
 * Node semantics for the realm's async `fs`, on top of its promise API.
 *
 * The realm's `fs` is documented as a promise API (`fs.readFile(path)` →
 * `Promise<string>`, `fs.stat(path)` → `{ isDirectory, isFile, size }`
 * booleans). But `require('fs')` hands the same object to Node programs,
 * which pass a trailing callback (`fs.readdir(dir, cb)`, and
 * `util.promisify(fs.stat)` does the same). Those callbacks never ran, so
 * such a program ended with exit 0 having done nothing: Magick.Native's
 * wasm-file-creator wrote no files.
 *
 * - With a trailing callback, the call is Node's: `cb(err, result)`, a
 *   `Stats` with methods from `stat` / `lstat`, and `cb(exists)` from the
 *   deprecated `fs.exists`.
 * - Without one, the documented promise API is unchanged.
 * - `fs.promises` is Node's: `stat` / `lstat` resolve to a `Stats`.
 */

type FsFn = (...args: unknown[]) => unknown;

/** The bridge seen as a table of named methods (plus `promises`). */
interface FsMethodTable {
  [method: string]: unknown;
}

/** The bridge's stat result: booleans, as documented for `.jsh`. */
interface BridgeStat {
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
}

/** Node's `fs.Stats` surface, built from a bridge stat. */
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

/** Node code branches on `err.code`; the bridge puts the errno in the message. */
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

/** Node's `fs.promises` over the bridge's promise methods. */
export function nodeFsPromises<T extends object>(bridge: T): T {
  const api: FsMethodTable = {};
  for (const [name, fn] of Object.entries(bridge)) {
    if (name === 'promises') continue;
    api[name] =
      typeof fn === 'function'
        ? async (...args: unknown[]) => {
            try {
              return nodeResult(name, await (fn as FsFn)(...args));
            } catch (err) {
              throw withErrnoCode(err);
            }
          }
        : fn;
  }
  return api as T;
}

/** Let every async method take Node's trailing callback as well. */
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
        pending = Promise.resolve((fn as FsFn).apply(this, args));
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

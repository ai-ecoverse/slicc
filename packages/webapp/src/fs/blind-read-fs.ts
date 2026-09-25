import type { BlindReadLog } from '../base/blind-reads.js';
import { normalizePath } from './path-utils.js';
import type { RestrictedFS } from './restricted-fs.js';
import { MONKEYPATCH_UNSAFE_FS } from './sudo-fs.js';
import type { DirEntry } from './types.js';
import { FsError } from './types.js';
import type { VirtualFS } from './virtual-fs.js';

export const BLIND_READ_MESSAGE =
  "outside this unit's visiblePaths — the path is unknown from here, not absent";

const THROWING_READS = [
  'readFile',
  'readFileRange',
  'readTextFile',
  'stat',
  'lstat',
  'realpath',
  'readlink',
] as const;

const SHELL_LOOKUP_PREFIXES = ['/usr/', '/bin/'];

function isShellLookup(path: string): boolean {
  const normalized = normalizePath(path);
  return SHELL_LOOKUP_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
  );
}

type AnyMethod = (...args: unknown[]) => unknown;

export function createBlindReadFs<T extends VirtualFS>(
  fs: T,
  acl: Pick<RestrictedFS, 'readAccess'>,
  log: BlindReadLog
): T {
  const target = fs as unknown as Record<string, AnyMethod | undefined>;
  const has = (name: string): boolean => typeof target[name] === 'function';

  const readAccess = (path: unknown) =>
    isShellLookup(path as string) ? 'inside' : acl.readAccess(path as string);
  const blind = (path: string): FsError => {
    const normalized = normalizePath(path);
    log.record(normalized, 'outside');
    return new FsError('EACCES', BLIND_READ_MESSAGE, normalized);
  };
  const overrides: Record<string, AnyMethod> = {};

  for (const name of THROWING_READS) {
    if (!has(name)) continue;
    overrides[name] = async (path: unknown, ...rest: unknown[]) => {
      if (readAccess(path) === 'outside') throw blind(path as string);
      return target[name]?.(path, ...rest);
    };
  }
  if (has('exists')) {
    overrides.exists = async (path: unknown) => {
      if (readAccess(path) === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return false;
      }
      return target.exists?.(path);
    };
  }
  if (has('getNativeFile')) {
    overrides.getNativeFile = async (path: unknown) => {
      if (readAccess(path) === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return null;
      }
      return target.getNativeFile?.(path);
    };
  }
  if (has('readDir')) {
    overrides.readDir = async (path: unknown, ...rest: unknown[]): Promise<DirEntry[]> => {
      const access = readAccess(path);
      if (access === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return [];
      }
      if (access === 'parent') log.record(normalizePath(path as string), 'filtered');
      return (await target.readDir?.(path, ...rest)) as DirEntry[];
    };
  }
  if (has('readDirSync')) {
    overrides.readDirSync = (path: unknown) => {
      if (readAccess(path) === 'parent') {
        log.record(normalizePath(path as string), 'filtered');
      }
      return target.readDirSync?.(path);
    };
  }
  if (has('copyFile')) {
    overrides.copyFile = async (src: unknown, dest: unknown) => {
      if (readAccess(src) === 'outside') throw blind(src as string);
      return target.copyFile?.(src, dest);
    };
  }
  if (has('walk')) {
    overrides.walk = async function* (path: unknown, ...rest: unknown[]) {
      const access = readAccess(path);
      if (access === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return;
      }
      if (access === 'parent') log.record(normalizePath(path as string), 'filtered');
      yield* target.walk?.(path, ...rest) as AsyncIterable<string>;
    };
  }

  return new Proxy(fs, {
    get(obj, prop, receiver) {
      if (prop === MONKEYPATCH_UNSAFE_FS) return true;
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

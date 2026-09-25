/**
 * Blind-read FS — "not visible" told apart from "not found" for a memory pass
 * (#3459).
 *
 * `RestrictedFS` answers every read outside its readable prefixes as if the
 * path did not exist (`ENOENT`, `[]`, `false`). That is deliberate for a
 * shell — `$PATH` probes must not error — but fatal for a pass that turns
 * what it reads into durable memory: `cat /etc/llmstxtignore` printing
 * `No such file or directory` was taken as proof the file was gone, and the
 * refutation was written into cone memory as a resolved contradiction.
 *
 * This decorator sits on the memory pass's gated handle (above the sudo
 * gate, below the memory-file write guard) and consults the sandbox's
 * {@link RestrictedFS.readAccess} before forwarding a read:
 *
 *   - a path `outside` every readable prefix is recorded on the
 *     {@link BlindReadLog} and answered with `EACCES … unknown, not absent`
 *     where the sandbox would have raised `ENOENT`, and with the sandbox's
 *     own empty answer (`false`, `null`, `[]`) where it never threw — the
 *     shell's `test`, glob expansion and command lookup keep working, and
 *     the ledger is what reaches the model either way;
 *   - a listing of a `parent` of a readable prefix (`/`, `/cones`) is
 *     recorded as `filtered` and forwarded unchanged — the entries it hides
 *     are the other half of the same false absence;
 *   - everything else passes straight through, symlink escapes included
 *     (those still answer "not found": an escape is not a blind spot).
 *
 * The shell's own commands swallow every fs error and print `No such file or
 * directory` regardless, so the distinct code only reaches the model through
 * the file tools; the `bash` tool appends the ledger's note to each result
 * instead, and `memory_write` refuses to persist a refutation of a recorded
 * path. Same Proxy shape as `createSudoFs`, marker included.
 */

import type { BlindReadLog } from '../base/blind-reads.js';
import { normalizePath } from './path-utils.js';
import type { RestrictedFS } from './restricted-fs.js';
import { MONKEYPATCH_UNSAFE_FS } from './sudo-fs.js';
import type { DirEntry } from './types.js';
import { FsError } from './types.js';
import type { VirtualFS } from './virtual-fs.js';

/** The `EACCES` message a blind read raises where the sandbox would have said `ENOENT`. */
export const BLIND_READ_MESSAGE =
  "outside this unit's visiblePaths — the path is unknown from here, not absent";

/** Read methods that throw on a miss: the blind answer is the distinct error. */
const THROWING_READS = [
  'readFile',
  'readFileRange',
  'readTextFile',
  'stat',
  'lstat',
  'realpath',
] as const;

type AnyMethod = (...args: unknown[]) => unknown;

export function createBlindReadFs<T extends VirtualFS>(
  fs: T,
  acl: Pick<RestrictedFS, 'readAccess'>,
  log: BlindReadLog
): T {
  const target = fs as unknown as Record<string, AnyMethod | undefined>;
  const has = (name: string): boolean => typeof target[name] === 'function';
  const blind = (path: string): FsError => {
    const normalized = normalizePath(path);
    log.record(normalized, 'outside');
    return new FsError('EACCES', BLIND_READ_MESSAGE, normalized);
  };
  const overrides: Record<string, AnyMethod> = {};

  for (const name of THROWING_READS) {
    if (!has(name)) continue;
    overrides[name] = async (path: unknown, ...rest: unknown[]) => {
      if (acl.readAccess(path as string) === 'outside') throw blind(path as string);
      return target[name]?.(path, ...rest);
    };
  }
  if (has('exists')) {
    overrides.exists = async (path: unknown) => {
      if (acl.readAccess(path as string) === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return false;
      }
      return target.exists?.(path);
    };
  }
  if (has('getNativeFile')) {
    // Answers `null` like the sandbox; every caller then falls back to
    // `readFile`, which raises the blind error above.
    overrides.getNativeFile = async (path: unknown) => {
      if (acl.readAccess(path as string) === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return null;
      }
      return target.getNativeFile?.(path);
    };
  }
  if (has('readDir')) {
    overrides.readDir = async (path: unknown, ...rest: unknown[]): Promise<DirEntry[]> => {
      const access = acl.readAccess(path as string);
      if (access === 'outside') {
        log.record(normalizePath(path as string), 'outside');
        return [];
      }
      if (access === 'parent') log.record(normalizePath(path as string), 'filtered');
      return (await target.readDir?.(path, ...rest)) as DirEntry[];
    };
  }
  if (has('walk')) {
    overrides.walk = async function* (path: unknown, ...rest: unknown[]) {
      const access = acl.readAccess(path as string);
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

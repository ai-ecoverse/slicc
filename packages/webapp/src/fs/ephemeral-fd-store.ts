/**
 * EphemeralFdStore — private byte backing for the shell's `/dev/fd/<n>` paths.
 *
 * just-bash models process substitution (`<(cmd)` / `>(cmd)`) on a real file at
 * `/dev/fd/<n>`: the body's stdout is written there during word expansion, the
 * outer command reads the path back, and the entry is `rm`'d when the command
 * finishes. The cone runs that against an unrestricted `VirtualFS`, where it is
 * simply an ordinary file.
 *
 * A sandboxed scoop must NOT resolve those writes against the shared tree. Two
 * things go wrong when it does (#2502): the write lands at `/dev/fd/<n>` OUTSIDE
 * the scoop's grants — visible to the cone and to sibling scoops, and clobbered
 * by whichever scoop reaches fd 63 next — while the consumer's read is filtered
 * back to `ENOENT` by the sandbox ACL, so the shell is told the write succeeded
 * and the payload is then unreachable.
 *
 * This store is the sandbox's answer instead: one instance per `RestrictedFS`,
 * so a descriptor is
 *
 *   - readable and writable without a sudoers match (an fd number varies per
 *     invocation, so no grant could pre-empt an approval prompt anyway);
 *   - private to one sandbox — nothing is addressable across scoops;
 *   - absent from every directory listing, because it lives beside the tree
 *     rather than in it (`/dev` and `/dev/fd` stay non-existent in a scoop's
 *     view, exactly as they were before this store existed);
 *   - bounded — just-bash allocates fds 63 downward to 10 and releases each
 *     one at the end of the command whose expansion opened it, so at most a few
 *     dozen entries can be live, each capped by the interpreter's own
 *     `maxStringLength`.
 *
 * A descriptor that was never written stays absent, so a read of it raises
 * `ENOENT` — the same loud failure the cone gives for an unopened fd.
 */

import { normalizePath } from './path-utils.js';
import type { FileContent, ReadFileOptions, Stats } from './types.js';
import { FsError } from './types.js';
import { isEphemeralFdPath } from './virtual-device-paths.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** One live descriptor's bytes plus the timestamps `stat` has to answer with. */
interface FdEntry {
  bytes: Uint8Array;
  mtime: number;
  ctime: number;
}

export class EphemeralFdStore {
  private entries = new Map<string, FdEntry>();

  /** Whether `path` is an ephemeral descriptor this store answers for. */
  static handles(path: string): boolean {
    return isEphemeralFdPath(normalizePath(path));
  }

  /** Whether a descriptor has been written (and not yet released). */
  has(path: string): boolean {
    return this.entries.has(normalizePath(path));
  }

  /**
   * Replace a descriptor's bytes. Strings are UTF-8 encoded: the shell's own
   * writes arrive as `Uint8Array` from `VfsAdapter` (which has already resolved
   * the latin1-vs-UTF-8 question for binary payloads), so this branch only
   * covers direct callers passing text.
   */
  write(path: string, content: FileContent): void {
    const key = normalizePath(path);
    const bytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
    const now = Date.now();
    const existing = this.entries.get(key);
    this.entries.set(key, { bytes, mtime: now, ctime: existing?.ctime ?? now });
  }

  /** Read a descriptor, honoring the `VirtualFS` default of UTF-8 text. */
  read(path: string, options?: ReadFileOptions): FileContent {
    const entry = this.require(path);
    if ((options?.encoding ?? 'utf-8') === 'utf-8') return decoder.decode(entry.bytes);
    return new Uint8Array(entry.bytes);
  }

  /** Read a descriptor as text. */
  readText(path: string): string {
    return decoder.decode(this.require(path).bytes);
  }

  /** Metadata for a live descriptor. A descriptor is never a directory. */
  stat(path: string): Stats {
    const entry = this.require(path);
    return { type: 'file', size: entry.bytes.length, mtime: entry.mtime, ctime: entry.ctime };
  }

  /**
   * Release a descriptor. Missing entries are reported so the caller can honor
   * `rm`'s `force` semantics itself rather than guessing.
   */
  remove(path: string): boolean {
    return this.entries.delete(normalizePath(path));
  }

  private require(path: string): FdEntry {
    const key = normalizePath(path);
    const entry = this.entries.get(key);
    if (!entry) throw new FsError('ENOENT', 'no such file or directory', key);
    return entry;
  }
}

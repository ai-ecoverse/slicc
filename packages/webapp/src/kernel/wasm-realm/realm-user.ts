/**
 * `realm-user.ts` — who owns what a wasm-realm program sees (#3530).
 *
 * Programs run as one ordinary user: the toolchain's `slicc_libc_gaps.c`
 * answers getuid(), geteuid(), getresuid() and their gid twins with
 * {@link REALM_UID}. Every file the program stats is that user's too — VFS
 * files and directories, its own memory FS, pipes, sockets, terminals,
 * devices and `/dev/fd` — so an ownership check holds: git's `safe.directory`
 * test, `find -user`, bash's `-O`. The VFS has no owners to report and chown
 * changes nothing (Emscripten ignores the ids), so nothing stays root.
 */
import type { ProcessFs } from './kernel-streams.js';

/** The realm user's uid and gid (`slicc_libc_gaps.c`'s `SLICC_UID`). */
export const REALM_UID = 1000;
export const REALM_GID = 1000;

/**
 * Report every stat(2), lstat(2) and fstat(2) of `Fs` as owned by the realm
 * user. Install it after every other stat wrapper (`useDevFd`), so it has the
 * last word; Emscripten's lstat and fstatat go through `Fs.stat` too.
 */
export function ownByRealmUser(Fs: ProcessFs): void {
  const { stat, fstat } = Fs;
  const owned = (attr: object): object => ({ ...attr, uid: REALM_UID, gid: REALM_GID });
  if (typeof stat === 'function') {
    Fs.stat = (path, dontFollow) => owned(stat.call(Fs, path, dontFollow));
  }
  if (typeof fstat === 'function') Fs.fstat = (fd) => owned(fstat.call(Fs, fd));
}

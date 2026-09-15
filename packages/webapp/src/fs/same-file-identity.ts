/**
 * POSIX same-file identity: two stats name one inode on one device, not
 * merely similar strings.
 *
 * Case- and Unicode-normalization-insensitive volumes (APFS via hostfs) resolve
 * `Slicc.md` / `SLICC.md` and NFC / NFD to the same directory entry. Comparing
 * the path strings therefore misses the collision that truncates the only copy
 * when a rename is implemented as open-dest-O_TRUNC-then-copy.
 *
 * A scoped identity takes precedence over the raw inode/device pair: device
 * numbers from unrelated backends or bridges can collide. If only one side
 * supplies a scoped identity, the entries cannot safely be treated as equal.
 *
 * `ino` 0 / absent is not identity: ZenFS pins `/` at 0, and remote mounts have
 * no inode. Inodes are unique per device — a hostfs file and a VFS file can
 * share a number — so `dev` must match when either side reports one. Both
 * missing `dev` means one backing (ZenFS); one missing means different
 * backends. Fail open to a real rename/copy in those cases.
 */
export function sameFileIdentity(
  a: { identity?: string; ino?: number; dev?: number },
  b: { identity?: string; ino?: number; dev?: number }
): boolean {
  if (a.identity !== undefined || b.identity !== undefined) {
    return a.identity !== undefined && a.identity === b.identity;
  }
  if (typeof a.ino !== 'number' || a.ino <= 0 || a.ino !== b.ino) return false;
  if (a.dev === undefined && b.dev === undefined) return true;
  if (typeof a.dev !== 'number' || typeof b.dev !== 'number') return false;
  return a.dev === b.dev;
}

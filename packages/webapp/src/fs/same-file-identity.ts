/**
 * POSIX same-file identity: two stats name one inode, not merely similar strings.
 *
 * Case- and Unicode-normalization-insensitive volumes (APFS via hostfs) resolve
 * `Slicc.md` / `SLICC.md` and NFC / NFD to the same directory entry. Comparing
 * the path strings therefore misses the collision that truncates the only copy
 * when a rename is implemented as open-dest-O_TRUNC-then-copy.
 *
 * `ino` 0 / absent is not identity: ZenFS pins `/` at 0, and remote mounts have
 * no inode. Fail open to a real rename in those cases.
 */
export function sameFileIdentity(a: { ino?: number }, b: { ino?: number }): boolean {
  return typeof a.ino === 'number' && a.ino > 0 && a.ino === b.ino;
}

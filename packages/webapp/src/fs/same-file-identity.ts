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

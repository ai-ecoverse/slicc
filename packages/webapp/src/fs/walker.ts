// Bound `walk()`'s slow-path recursion. Symlink cycles surface as ELOOP via
// realpath, but realpath returns mount paths unchanged ("already real"), so a
// self-referential mount yields ever-distinct paths the visited-set can't
// collapse — cap depth and total entries so it can't loop forever.
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_ENTRIES = 100_000;

/** Structural view of the VirtualFS mount table consumed by the walker. */
export interface WalkMountView {
  readonly size: number;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
}

/** Structural view of the MountIndex readiness check consumed by the walker. */
export interface WalkIndexView {
  isReady(path: string): boolean;
}

/** Check whether the walk fast path (indexed mount, no nested mounts) is available. */
export function canUseWalkFastPath(
  mountPoints: WalkMountView,
  mountIndex: WalkIndexView,
  normalized: string
): boolean {
  if (mountPoints.size === 0 || !mountPoints.has(normalized)) return false;
  if (!mountIndex.isReady(normalized)) return false;
  const hasNestedMounts = Array.from(mountPoints.keys()).some(
    (mp) => mp !== normalized && mp.startsWith(normalized + '/')
  );
  return !hasNestedMounts;
}

/** Resolve realpath, falling back to the input path on any error. */
export async function safeRealpath(
  realpath: (p: string) => Promise<string>,
  normalized: string
): Promise<string> {
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}

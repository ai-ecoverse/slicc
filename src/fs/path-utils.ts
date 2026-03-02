/**
 * Path utilities for the virtual filesystem.
 * All paths are POSIX-style (forward slashes, absolute from root /).
 */

/** Normalize a path: resolve ., .., collapse //, ensure leading /. */
export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';

  // Ensure leading slash
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  const parts = path.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return '/' + resolved.join('/');
}

/** Split a path into its directory and base name. */
export function splitPath(path: string): { dir: string; base: string } {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    return { dir: '/', base: '' };
  }
  const lastSlash = normalized.lastIndexOf('/');
  return {
    dir: lastSlash === 0 ? '/' : normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  };
}

/** Get all path segments (e.g., '/a/b/c' → ['a', 'b', 'c']). */
export function pathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === '/') return [];
  return normalized.slice(1).split('/');
}

/** Join path segments into a normalized path. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

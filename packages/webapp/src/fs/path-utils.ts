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

/** Escape a single literal character for use inside a RegExp. */
function escapeRegExpChar(ch: string): string {
  return '.+^$()[]|\\{}'.includes(ch) ? `\\${ch}` : ch;
}

/**
 * Glob → RegExp for normalized VFS paths. `*` matches within a single path
 * segment (no `/`); `**` matches across segments. A trailing `/**` also
 * matches the directory itself (so `/a/b/**` matches `/a/b`).
 */
export function pathGlobToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (re.endsWith('/')) {
        re = `${re.slice(0, -1)}(?:/.*)?`;
      } else {
        re += '.*';
      }
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
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

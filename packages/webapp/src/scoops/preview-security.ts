/**
 * Phase-1 security gate for leader-side preview.request handling.
 *
 * Returns `true` only when `vfsPath` is strictly inside `servedRoot`.
 * Rejects any path containing `..`, `.`, or URL-encoded variants
 * (anything an attacker could use to escape the served subtree). Fail-closed
 * when `servedRoot` is `/` so an over-broad `serve /` doesn't grant whole-VFS
 * read access.
 */
export function isPathWithinServedRoot(vfsPath: string, servedRoot: string): boolean {
  if (!vfsPath || !servedRoot) return false;
  if (!vfsPath.startsWith('/')) return false;
  if (servedRoot === '/') return false;
  if (/%2[eE]/.test(vfsPath)) return false;
  const segments = vfsPath.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return false;
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  if (vfsPath === root) return true;
  return vfsPath.startsWith(root + '/');
}

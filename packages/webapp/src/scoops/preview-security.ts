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

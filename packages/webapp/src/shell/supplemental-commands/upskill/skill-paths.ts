export function isSafeSkillRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.includes('\0')) return false;
  if (relative.includes('\\')) return false;

  if (/^[A-Za-z]:/.test(relative)) return false;
  return !relative
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

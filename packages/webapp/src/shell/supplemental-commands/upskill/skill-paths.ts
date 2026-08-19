/**
 * upskill — skill-relative path safety.
 *
 * Every path upskill writes comes from a remote archive or API listing, so a
 * `..` segment in an entry name is an attacker-controlled write outside the
 * skill directory ("zip slip"). `installSkillFromZip` has always carried an
 * inline guard; this module is that guard, shared, so the ZIP fast path, the
 * Contents-API path, and the `update` write path cannot drift apart again.
 */

/**
 * True when `relative` is a plain skill-relative path: no absolute form, no
 * `.`/`..` segment, no backslash (which some archives use as a separator and
 * some filesystems treat as one), and no NUL.
 */
export function isSafeSkillRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.includes('\0')) return false;
  if (relative.includes('\\')) return false;
  // Windows-style drive prefix — never a valid skill-relative path.
  if (/^[A-Za-z]:/.test(relative)) return false;
  return !relative
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

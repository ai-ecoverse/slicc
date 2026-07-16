// Pure logic for the packages/*/CLAUDE.md size-budget check.
//
// Every `packages/*/CLAUDE.md` is budgeted at PACKAGE_CLAUDE_MAX_CHARS.
// Four files that already exceeded the cap when the gate was introduced are
// grandfathered with per-file exemptions at current-size-rounded-up. The
// exemption list is FROZEN: values may only be lowered or deleted, never
// added or raised. The nightly ratchet (follow-up issue #1469) will lower
// them mechanically.
//
// The pure functions here (no IO) are unit-tested by the `dev-tools` vitest
// project. The thin IO + CLI wiring lives in `check-doc-sizes.mjs`.

export const PACKAGE_CLAUDE_MAX_CHARS = 20000;

// Frozen grandfathered exemptions for files that exceeded PACKAGE_CLAUDE_MAX_CHARS
// when this gate was introduced (issue #1532, part of #1469 Wave 1).
// FROZEN: never add or raise entries. Lower or remove only.
export const PACKAGE_CLAUDE_EXEMPTIONS = {
  'packages/webapp/CLAUDE.md': 67000, // TODO(#1469) trim to ≤20K
  'packages/cloudflare-worker/CLAUDE.md': 45000, // TODO(#1469) trim to ≤20K
  'packages/chrome-extension/CLAUDE.md': 35000, // TODO(#1469) trim to ≤20K
  'packages/dev-tools/CLAUDE.md': 28000, // TODO(#1469) trim to ≤20K
};

/**
 * Resolve the effective character limit for a given package CLAUDE.md path.
 *
 * @param {string} relPath - Repo-relative path, e.g. 'packages/webapp/CLAUDE.md'
 * @returns {number} The cap in characters (exempted cap or default)
 */
export function resolvePackageClaudeLimit(relPath) {
  return PACKAGE_CLAUDE_EXEMPTIONS[relPath] ?? PACKAGE_CLAUDE_MAX_CHARS;
}

/**
 * Given a list of 'packages/*\/CLAUDE.md' relative paths and a size map,
 * return the check results for each path.
 *
 * @param {string[]} relPaths - Repo-relative paths to check
 * @param {Map<string, number>} sizeMap - Map from path to character count
 * @returns {{ path: string; size: number; limit: number; pass: boolean }[]}
 */
export function checkPackageClaudes(relPaths, sizeMap) {
  return relPaths.map((relPath) => {
    const size = sizeMap.get(relPath) ?? 0;
    const limit = resolvePackageClaudeLimit(relPath);
    return { path: relPath, size, limit, pass: size <= limit };
  });
}

/**
 * Discover 'packages/*\/CLAUDE.md' relative paths from a list of package
 * directory names. Returns repo-relative paths sorted alphabetically.
 *
 * @param {string[]} packageDirs - Names of entries under the 'packages/' dir
 * @returns {string[]} Sorted repo-relative paths like 'packages/webapp/CLAUDE.md'
 */
export function discoverPackageClaudes(packageDirs) {
  return packageDirs
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `packages/${name}/CLAUDE.md`)
    .sort();
}

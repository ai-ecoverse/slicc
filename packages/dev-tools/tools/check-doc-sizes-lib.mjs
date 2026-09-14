export const PACKAGE_CLAUDE_MAX_CHARS = 20000;

export const PACKAGE_CLAUDE_EXEMPTIONS = {};

export function resolvePackageClaudeLimit(relPath) {
  return PACKAGE_CLAUDE_EXEMPTIONS[relPath] ?? PACKAGE_CLAUDE_MAX_CHARS;
}

export function checkPackageClaudes(relPaths, sizeMap) {
  return relPaths.map((relPath) => {
    const size = sizeMap.get(relPath) ?? 0;
    const limit = resolvePackageClaudeLimit(relPath);
    return { path: relPath, size, limit, pass: size <= limit };
  });
}

export function discoverPackageClaudes(packageDirs) {
  return packageDirs
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `packages/${name}/CLAUDE.md`)
    .sort();
}

export function findUnlinkedPackageGuides(rootContent, relPaths) {
  return relPaths.filter((relPath) => !rootContent.includes(`](${relPath})`));
}

export const REPO_PREFIXES = ['packages/', 'docs/', '.github/', '.agents/'];

export const BUILTIN_ALLOWLIST = [
  'packages/playwright-core/**',

  'packages/swift-server/.build/**',

  'packages/cloudflare-worker/src/preview-bridge-assets.ts',

  'packages/shared-swift',

  'packages/webapp/src/shared',

  'packages/webapp/src/kernel/realm/**',
  'packages/webapp/tests/kernel/realm/**',

  'docs/superpowers/**',
];

export function resolveToken(raw) {
  const firstWord = raw.split(/\s/)[0] ?? raw;

  const withoutColon = firstWord.replace(/:([^/]*)$/, '');
  const hadTrailingSlash = withoutColon.endsWith('/');
  const path = withoutColon.replace(/\/$/, '');
  return { path, hadTrailingSlash };
}

export function isAbsolutePath(path) {
  return path.startsWith('/');
}

export function hasKnownPrefix(path) {
  return REPO_PREFIXES.some((pfx) => path.startsWith(pfx));
}

export function isGlobPath(path) {
  return path.includes('*') || path.includes('{');
}

export function hasTemplatePlaceholder(path) {
  return path.includes('<');
}

export function isIllustrativePath(path) {
  return path.split('/').some((seg) => seg.startsWith('my-'));
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isAllowlisted(path, allowlist) {
  return allowlist.some((pattern) => pattern === path || globToRegex(pattern).test(path));
}

export function shouldSkip(path, extraAllowlist = []) {
  if (isAbsolutePath(path)) return true;
  if (!hasKnownPrefix(path)) return true;
  if (isGlobPath(path)) return true;
  if (hasTemplatePlaceholder(path)) return true;
  if (isIllustrativePath(path)) return true;
  const fullAllowlist = [...BUILTIN_ALLOWLIST, ...extraAllowlist];
  if (isAllowlisted(path, fullAllowlist)) return true;
  return false;
}

export function extractCandidates(content, extraAllowlist = []) {
  const backtickRe = /`([^`\n]+)`/g;
  const seen = new Set();
  const results = [];

  for (const match of content.matchAll(backtickRe)) {
    const { path, hadTrailingSlash } = resolveToken(match[1]);
    if (shouldSkip(path, extraAllowlist)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    results.push({ path, hadTrailingSlash });
  }

  return results;
}

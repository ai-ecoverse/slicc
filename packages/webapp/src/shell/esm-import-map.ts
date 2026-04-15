import { SHIMMED_BUILTINS, UNAVAILABLE_BUILTINS } from '../ui/preview-sw-shims.js';

interface ImportMap {
  imports: Record<string, string>;
}

const ALL_SHIMMED = new Set<string>([...SHIMMED_BUILTINS, ...UNAVAILABLE_BUILTINS]);

const BUILTIN_NPM_ALIASES: Record<string, string> = {
  path: 'https://esm.sh/path-browserify',
};

export function buildImportMap(specifiers: string[]): ImportMap {
  const imports: Record<string, string> = {};

  for (const raw of specifiers) {
    // Skip relative/absolute specifiers — browser resolves those
    if (raw.startsWith('.') || raw.startsWith('/')) continue;

    const bare = raw.startsWith('node:') ? raw.slice(5) : raw;

    if (BUILTIN_NPM_ALIASES[bare]) {
      const url = BUILTIN_NPM_ALIASES[bare];
      imports[bare] = url;
      imports[`node:${bare}`] = url;
      continue;
    }

    if (ALL_SHIMMED.has(bare)) {
      const shimUrl = `/preview/__shims/${bare}.js`;
      imports[bare] = shimUrl;
      imports[`node:${bare}`] = shimUrl;
      continue;
    }

    // npm package
    imports[raw] = `https://esm.sh/${raw}`;
  }

  return { imports };
}

/**
 * Resolve a single bare specifier to an absolute URL.
 * Returns null for relative/absolute specifiers (caller handles those).
 */
function resolveSpecifierToUrl(raw: string, origin: string): string | null {
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('http')) return null;

  const bare = raw.startsWith('node:') ? raw.slice(5) : raw;

  if (BUILTIN_NPM_ALIASES[bare]) return BUILTIN_NPM_ALIASES[bare];

  if (ALL_SHIMMED.has(bare)) return `${origin}/preview/__shims/${bare}.js`;

  return `https://esm.sh/${raw}`;
}

/**
 * Rewrite static import specifiers in source code to absolute URLs so the
 * code can execute from a blob URL without relying on import maps or a
 * service worker intercepting the blob's fetches.
 *
 * - Bare specifiers (npm packages, Node built-ins) → absolute URLs
 * - Relative local imports (./foo.js) → absolute preview SW URLs
 * - Already-absolute URLs → untouched
 *
 * `scriptVfsDir` is the VFS directory of the entry script, used to resolve
 * relative imports to their preview SW URL.
 */
export function rewriteImportSpecifiers(
  code: string,
  scriptVfsDir: string,
  origin: string
): string {
  // Regex matches: import ... from 'specifier' | import 'specifier'
  // Captures: (prefix before quote)(quote char)(specifier)(closing quote)
  return code.replace(
    /(\bimport\s+(?:[^'"]*?\s+from\s+)?)(["'])([\w@/.:\-][^"']*)\2/g,
    (match, prefix: string, quote: string, specifier: string) => {
      // Already an absolute URL — leave it
      if (specifier.startsWith('http://') || specifier.startsWith('https://')) return match;

      // Relative local import — rewrite to absolute preview URL
      if (specifier.startsWith('.')) {
        // Normalize path: scriptVfsDir + specifier
        const parts = `${scriptVfsDir}/${specifier}`.split('/');
        const resolved: string[] = [];
        for (const p of parts) {
          if (p === '..') resolved.pop();
          else if (p !== '.' && p !== '') resolved.push(p);
        }
        const vfsPath = '/' + resolved.join('/');
        return `${prefix}${quote}${origin}/preview${vfsPath}${quote}`;
      }

      // Bare specifier — resolve to absolute URL
      const url = resolveSpecifierToUrl(specifier, origin);
      if (url) return `${prefix}${quote}${url}${quote}`;

      return match;
    }
  );
}

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

#!/usr/bin/env node
/**
 * Enforce the layer-stack boundary for `providers/built-in/`: a built-in
 * provider may NOT import from `ui/`.
 *
 * The webapp's documented layer stack is
 *   fs → shell/git → cdp → tools → core → scoops → ui
 * with `providers/` below `ui/`. Built-in providers register during
 * kernel-worker boot — before any UI exists — so a back-edge from
 * `providers/built-in/` into `ui/` drags the (DOM-bound) settings dialog
 * and its transitive imports into the boot-time module graph. The
 * historical instance (issue #1145) was the one statement
 *   import { ... } from '../../ui/provider-settings.js';
 * in `providers/built-in/azure-openai.ts`, which manifested as the TDZ
 * cycle that forces `providers/index.ts`'s lazy-glob workaround and the
 * explicit `await registerProviders()` at every entry point.
 *
 * This scan fails on any `from '<...>ui/...'` import (any depth of `../`)
 * inside `packages/webapp/src/providers/built-in/`. The detection helper
 * is exported so it can be unit-tested directly; the filesystem scan
 * runs only when this file is invoked as the entry script.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src/providers/built-in');

// Match a `<...>ui/<rest>` string-literal in any of the three forms a
// back-edge can take: a static `import ... from '<...>ui/...'` /
// `export ... from '<...>ui/...'` (both end in `from '...'`), a
// string-literal dynamic `import('<...>ui/...')`, or a `require('<...>ui/...')`.
// `<...>` is any chain of `../` (one or more levels up).
const UI_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+ui\/[^'"]+['"]/;

/** A `.ts` source file (built-ins are .ts only; no .tsx in this tree). */
export function isProviderSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

/**
 * Blank out `//` line comments and `/* *\/` block comments (preserving
 * newlines) so prose mentions of the forbidden pattern never trip the
 * gate. Good enough for source scanning; it does not parse string
 * literals.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Find every `<...>ui/...` import in `source` - covers `from '<...>ui/...'`
 * (static import / re-export), `import('<...>ui/...')` (string-literal
 * dynamic import), and `require('<...>ui/...')`. Returns
 * `[{ line, match }]` (1-based line numbers); comments are ignored.
 */
export function findUiImports(source) {
  const hits = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, i) => {
    const m = line.match(UI_IMPORT_RE);
    if (m) hits.push({ line: i + 1, match: m[0] });
  });
  return hits;
}

/** Recursively collect provider source files under `dir`. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isProviderSource(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan `providers/built-in/` and exit non-zero on any `ui/` import. */
function main() {
  const failures = [];
  let scanned = 0;

  for (const abs of collect(SCAN_ROOT)) {
    scanned++;
    const rel = relative(repoRoot, abs);
    for (const { line, match } of findUiImports(readFileSync(abs, 'utf8'))) {
      failures.push(
        `${rel}:${line}: forbidden ui/ import (${match}) — built-in providers run during kernel-worker boot; import from providers/ instead.`
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    process.stderr.write(
      `\n${failures.length} ui/ back-edge(s) found in packages/webapp/src/providers/built-in/. ` +
        'Pure-data accessors used by built-in providers live in providers/account-store.ts; ' +
        'import from there (or another providers/ module) instead of ui/.\n'
    );
    process.exit(1);
  }

  process.stdout.write(
    `ok: no ui/ imports in ${scanned} packages/webapp/src/providers/built-in/ source files\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

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
// `<...>` is any chain of `../` (one or more levels up). `\s` spans newlines,
// so Prettier's multiline `await import(\n  '../ui/...'\n)` form matches when
// the regex runs over the whole source (not line by line).
const UI_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+ui\/[^'"]+['"]/g;

/** A `.ts` source file (built-ins are .ts only; no .tsx in this tree). */
export function isProviderSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

// One source token at a time, left to right: a '…' / "…" / `…` string
// literal (escapes honored, templates may span lines), a `//` line comment,
// or a `/* */` block comment. Scanning strings and comments as alternatives
// of ONE regex means a comment opener inside a string (or a quote inside a
// comment) can never start the other construct.
const COMMENT_OR_STRING_RE =
  /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Blank out `//` line comments and `/* *\/` block comments (preserving
 * newlines) so prose mentions of the forbidden pattern never trip the
 * gate. String-literal-aware: `//` or `/*` inside a '…', "…", or `…`
 * literal (e.g. a URL pattern like `http://host/*` in help text) does NOT
 * open a comment, and string contents are preserved. Good enough for
 * source scanning; regex literals and nested templates are not parsed.
 */
export function stripComments(source) {
  return source.replace(COMMENT_OR_STRING_RE, (m) =>
    m.startsWith('//') || m.startsWith('/*') ? m.replace(/[^\n]/g, ' ') : m
  );
}

/**
 * Find every `<...>ui/...` import in `source` - covers `from '<...>ui/...'`
 * (static import / re-export), `import('<...>ui/...')` (string-literal
 * dynamic import), and `require('<...>ui/...')`, including Prettier's
 * multiline `import(\n'...')` form. Returns `[{ line, match }]` (1-based
 * line number where the match starts, match whitespace collapsed);
 * comments are ignored.
 */
export function findUiImports(source) {
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(UI_IMPORT_RE)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, match: m[0].replace(/\s+/g, ' ') });
  }
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

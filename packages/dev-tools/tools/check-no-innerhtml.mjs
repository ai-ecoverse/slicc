#!/usr/bin/env node
/**
 * Enforce the `@slicc/webcomponents` "no innerHTML" rule as a hard lint gate.
 *
 * The library deliberately builds every component's DOM via createElement /
 * textContent / the `internal/dom.ts` `h()` builder — never by assigning an
 * HTML string. That keeps the shipped components free of any HTML-injection
 * surface (textContent + setAttribute escape by construction) and makes the
 * "migrated off innerHTML" decision self-enforcing instead of tacit knowledge.
 *
 * This scans shipped component source and fails on any `.innerHTML =` /
 * `.outerHTML =` assignment or `insertAdjacentHTML(...)` call.
 *
 * Scope: `packages/webcomponents/src/**\/*.ts`, EXCLUDING:
 *   - `*.stories.ts` — Storybook demo scaffolding, excluded from `dist/`, never
 *     shipped or consumed by the webapp; idiomatic innerHTML demo content is OK.
 *   - `*.test.ts`    — tests may assert against innerHTML strings.
 * Read comparisons (`=== `, `== `) and bare mentions in comments/JSDoc do not
 * trip the gate — only real writes do.
 *
 * The detection helpers are exported so they can be unit-tested directly; the
 * filesystem scan runs only when this file is invoked as the entry script.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webcomponents/src');

/** A `.ts` file that is shipped component source — neither a story nor a test. */
export function isShippedSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.stories.ts') && !name.endsWith('.test.ts');
}

// Real writes only: `.innerHTML =` / `.outerHTML =` (but not `==`/`===`) and any
// `.insertAdjacentHTML(` call. The negative lookahead after `=` skips read
// comparisons so a guard like `if (el.innerHTML === '')` stays legal.
export const PATTERNS = [
  { re: /\.innerHTML\s*=(?!=)/, label: '.innerHTML assignment' },
  { re: /\.outerHTML\s*=(?!=)/, label: '.outerHTML assignment' },
  { re: /\.insertAdjacentHTML\s*\(/, label: 'insertAdjacentHTML() call' },
];

/**
 * Blank out `//` line comments and `/* *\/` block comments (preserving newlines)
 * so mentions in prose (e.g. JSDoc "no component sets .innerHTML") never trip the
 * gate. Good enough for source scanning — it does not parse string literals,
 * which is acceptable because an innerHTML write hidden inside a string is not
 * executable code.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Find every innerHTML/outerHTML write or insertAdjacentHTML call in `source`.
 * Returns `[{ line, label }]` (1-based line numbers); comments and read
 * comparisons are ignored.
 */
export function findInnerHtmlWrites(source) {
  const hits = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, i) => {
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) hits.push({ line: i + 1, label });
    }
  });
  return hits;
}

/** Recursively collect shipped component source files under `dir`. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isShippedSource(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan the webcomponents source tree and exit non-zero on any innerHTML write. */
function main() {
  const failures = [];
  let scanned = 0;

  for (const abs of collect(SCAN_ROOT)) {
    scanned++;
    const rel = relative(repoRoot, abs);
    for (const { line, label } of findInnerHtmlWrites(readFileSync(abs, 'utf8'))) {
      failures.push(
        `${rel}:${line}: ${label} — build DOM via h()/createElement/textContent instead.`
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    process.stderr.write(
      `\n${failures.length} innerHTML write(s) found in @slicc/webcomponents source. ` +
        'See packages/webcomponents/src/internal/dom.ts (h/sheet) and slicc-logo.ts (reference).\n'
    );
    process.exit(1);
  }

  process.stdout.write(`ok: no innerHTML writes in ${scanned} @slicc/webcomponents source files\n`);
}

// Run the scan only when invoked as the entry script (not on import-for-test).
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

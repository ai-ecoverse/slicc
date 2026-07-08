#!/usr/bin/env node
/**
 * Enforce the "no raw chrome.runtime.id sniffs" rule as a hard lint gate.
 *
 * All extension-environment detection in `packages/webapp/src/` MUST go
 * through the helpers in `packages/webapp/src/core/runtime-env.ts`. Raw
 * `chrome.runtime.id` / `chrome?.runtime?.id` boolean checks elsewhere
 * indicate a sniff that bypassed the canonical helpers.
 *
 * This scans `packages/webapp/src/**\/*.ts` (excluding `core/runtime-env.ts`
 * itself and test files) and fails on any `runtime.id` / `runtime?.id`
 * reference that looks like a boolean sniff rather than a value read inside
 * an already-guarded branch.
 *
 * Comments and JSDoc mentions are stripped before scanning so prose
 * references don't trip the gate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
const ALLOWED_FILE = resolve(SCAN_ROOT, 'core/runtime-env.ts');

/** A `.ts` source file (not a test). */
function isSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

/** Strip line and block comments (preserve newlines). */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Detect raw chrome.runtime.id boolean sniffs.
 *
 * Matches `chrome.runtime.id` or `chrome?.runtime?.id` used in a
 * boolean context (typeof, `!!`, `&&`, `if(`, etc.) — not as a plain
 * string-value access like `chrome.runtime.id` on its own line as
 * part of an API call (those are fine when guarded by isExtensionRealm).
 *
 * We cast a wide net: any mention of `runtime?.id` or `runtime.id`
 * (outside comments) in the scan root is flagged. The allowed file
 * (runtime-env.ts) is excluded.
 */
export const PATTERN = /runtime\??\.id\b/;

/**
 * Find raw sniffs in `source`. Returns `[{ line, match }]`.
 */
export function findRawSniffs(source) {
  const hits = [];
  const lines = stripComments(source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = PATTERN.exec(lines[i]);
    if (m) hits.push({ line: i + 1, match: m[0] });
  }
  return hits;
}

/** Recursively collect source files under `dir`. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isSource(entry.name)) out.push(abs);
  }
  return out;
}

function main() {
  const failures = [];
  let scanned = 0;

  for (const abs of collect(SCAN_ROOT)) {
    if (abs === ALLOWED_FILE) continue;
    scanned++;
    const rel = relative(repoRoot, abs);
    for (const { line, match } of findRawSniffs(readFileSync(abs, 'utf8'))) {
      failures.push(
        `${rel}:${line}: raw \`${match}\` sniff — ` +
          'use isExtensionRealm() from core/runtime-env.ts instead.'
      );
    }
  }

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`::error::${f}\n`);
    process.stderr.write(
      `\n${failures.length} raw chrome.runtime.id sniff(s) found. ` +
        'Import { isExtensionRealm } from core/runtime-env.ts.\n'
    );
    process.exit(1);
  }

  process.stdout.write(`ok: no raw chrome.runtime.id sniffs in ${scanned} webapp source files\n`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

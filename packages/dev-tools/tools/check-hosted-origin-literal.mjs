#!/usr/bin/env node
// Enforce a single source of truth for the hosted-origin literal.
//
// Every TS source file in `packages/*/src/` that needs `www.sliccy.ai` must
// import `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts` instead of inlining
// the literal. This gate scans for raw occurrences outside the canonical
// definition and an explicit allowlist.
//
// Comment-only references are ignored (documenting the URL is fine).
// Test files (`packages/*/tests/`) are exempt.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

// Canonical definition — the one file allowed to contain the literal in code.
const CANONICAL_FILE = resolve(repoRoot, 'packages/shared-ts/src/bridge-protocol.ts');

// Files where the literal appears only in comments (documenting the URL).
// These are NOT code occurrences and don't need the constant import.
// If a non-comment occurrence is added to one of these files, the gate
// catches it — the allowlist only skips the file when every occurrence is
// in a comment.
const COMMENT_ONLY_ALLOWLIST = new Set(
  [
    'packages/chrome-extension/src/service-worker.ts',
    'packages/cloudflare-worker/src/handoff-page.ts',
    'packages/node-server/src/electron-controller.ts',
    'packages/node-server/src/index.ts',
    'packages/webapp/src/cdp/navigation-watcher.ts',
    'packages/webapp/src/net/handoff-link.ts',
    'packages/webapp/src/providers/account-store.ts',
    'packages/webapp/src/providers/adobe-oauth-state.ts',
    'packages/webapp/src/shell/proxied-fetch.ts',
    'packages/webapp/src/ui/boot/bridge-launch-params.ts',
    'packages/webapp/src/ui/llm-proxy-sw-config.ts',
    'packages/webapp/src/ui/main.ts',
  ].map((p) => resolve(repoRoot, p))
);

const LITERAL = 'www.sliccy.ai';
const LITERAL_RE = /www\.sliccy\.ai/;

// Strip block comments (preserve line count).
function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Check if a line is entirely a comment (line comment or block-comment
// continuation). Does NOT attempt to parse string-interior `//` — that would
// require a full tokeniser. The false-positive risk (an inline trailing
// comment mentioning the literal after real code on the same line) is near
// zero for this pattern.
function isCommentOnlyLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

// Find non-comment occurrences. Returns [{ line, match }].
export function findCodeOccurrences(source) {
  const hits = [];
  const lines = stripBlockComments(source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (LITERAL_RE.test(lines[i]) && !isCommentOnlyLine(lines[i])) {
      hits.push({ line: i + 1, match: LITERAL });
    }
  }
  return hits;
}

function isSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isSource(entry.name)) out.push(abs);
  }
  return out;
}

function collectPackageSrcFiles() {
  const packagesDir = resolve(repoRoot, 'packages');
  const files = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = resolve(packagesDir, pkg.name, 'src');
    try {
      readdirSync(srcDir);
    } catch {
      continue;
    }
    files.push(...collect(srcDir));
  }
  return files;
}

function scanFile(abs) {
  if (abs === CANONICAL_FILE) return null;
  const source = readFileSync(abs, 'utf8');
  if (!LITERAL_RE.test(source)) return null;
  const hits = findCodeOccurrences(source);
  if (hits.length === 0 && COMMENT_ONLY_ALLOWLIST.has(abs)) return { hits: [], scanned: true };
  return { hits, scanned: true };
}

function main() {
  const failures = [];
  let scanned = 0;

  for (const abs of collectPackageSrcFiles()) {
    const result = scanFile(abs);
    if (!result) continue;
    scanned++;
    const rel = relative(repoRoot, abs);
    for (const { line } of result.hits) {
      failures.push(
        `${rel}:${line}: raw '${LITERAL}' literal — ` +
          'import SLICC_HOSTED_ORIGIN from @slicc/shared-ts instead.'
      );
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      process.stderr.write('::error::' + f + '\n');
    }
    process.stderr.write(
      '\n' +
        failures.length +
        ` raw '${LITERAL}' literal(s) found outside bridge-protocol.ts. ` +
        'Import { SLICC_HOSTED_ORIGIN } from @slicc/shared-ts.\n'
    );
    process.exit(1);
  }

  process.stdout.write(`ok: no raw '${LITERAL}' literals in ${scanned} package source files\n`);
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

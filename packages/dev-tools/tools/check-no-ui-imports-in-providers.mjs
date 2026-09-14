#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src/providers/built-in');

const UI_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+ui\/[^'"]+['"]/g;

export function isProviderSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

const COMMENT_OR_STRING_RE =
  /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

export function stripComments(source) {
  return source.replace(COMMENT_OR_STRING_RE, (m) =>
    m.startsWith('//') || m.startsWith('/*') ? m.replace(/[^\n]/g, ' ') : m
  );
}

export function findUiImports(source) {
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(UI_IMPORT_RE)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, match: m[0].replace(/\s+/g, ' ') });
  }
  return hits;
}

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isProviderSource(entry.name)) out.push(abs);
  }
  return out;
}

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

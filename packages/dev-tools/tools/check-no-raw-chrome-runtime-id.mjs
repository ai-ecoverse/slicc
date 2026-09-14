#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');

function isSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

export const PATTERN = /runtime\??\.id\b/;

export function findRawSniffs(source) {
  const hits = [];
  const lines = stripComments(source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = PATTERN.exec(lines[i]);
    if (m) hits.push({ line: i + 1, match: m[0] });
  }
  return hits;
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

function main() {
  const failures = [];
  let scanned = 0;

  for (const abs of collect(SCAN_ROOT)) {
    scanned++;
    const rel = relative(repoRoot, abs);
    for (const { line, match } of findRawSniffs(readFileSync(abs, 'utf8'))) {
      failures.push(
        [
          rel,
          ':',
          line,
          ": raw '",
          match,
          "' sniff — ",
          'use isChromeExtensionRealm() from @slicc/shared-ts instead.',
        ].join('')
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
        ' raw chrome.runtime.id sniff(s) found. ' +
        'Import { isChromeExtensionRealm } from @slicc/shared-ts.\n'
    );
    process.exit(1);
  }

  process.stdout.write(
    'ok: no raw chrome.runtime.id sniffs in ' + scanned + ' webapp source files\n'
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

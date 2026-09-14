#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webcomponents/src');

export function isShippedSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.stories.ts') && !name.endsWith('.test.ts');
}

export const PATTERNS = [
  { re: /\.innerHTML\s*=(?!=)/, label: '.innerHTML assignment' },
  { re: /\.outerHTML\s*=(?!=)/, label: '.outerHTML assignment' },
  { re: /\.insertAdjacentHTML\s*\(/, label: 'insertAdjacentHTML() call' },
];

export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

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

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isShippedSource(entry.name)) out.push(abs);
  }
  return out;
}

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

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

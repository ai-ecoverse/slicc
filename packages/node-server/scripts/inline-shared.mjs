#!/usr/bin/env node
// Post-build step: copy @slicc/shared compiled output into dist/node-server/_shared/
// and rewrite `from '@slicc/shared'` imports in dist/node-server/**/*.{js,d.ts}
// to relative paths.
//
// Why: the published `sliccy` npm tarball ships dist/node-server/ but does NOT
// include @slicc/shared (it's a private workspace package, not a real npm
// dependency). Inlining it makes the published output self-contained.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');
const sharedDist = resolve(repoRoot, 'packages/shared/dist');
const nodeServerDist = resolve(repoRoot, 'dist/node-server');
const inlinedSharedDir = resolve(nodeServerDist, '_shared');

if (!existsSync(sharedDist)) {
  console.error(
    `[inline-shared] @slicc/shared dist not found at ${sharedDist}. Build @slicc/shared first.`
  );
  process.exit(1);
}

if (!existsSync(nodeServerDist)) {
  console.error(
    `[inline-shared] node-server dist not found at ${nodeServerDist}. Build @slicc/node-server first.`
  );
  process.exit(1);
}

mkdirSync(inlinedSharedDir, { recursive: true });
for (const entry of readdirSync(sharedDist)) {
  copyFileSync(join(sharedDist, entry), join(inlinedSharedDir, entry));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '_shared') continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const importRe = /(from\s+|import\s*\(\s*)(['"])@slicc\/shared\2/g;
let rewrites = 0;
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf-8');
  if (!text.includes('@slicc/shared')) continue;
  const relToShared = relative(dirname(file), join(inlinedSharedDir, 'index.js'))
    .split('\\')
    .join('/');
  const relSpecifier = relToShared.startsWith('.') ? relToShared : './' + relToShared;
  const next = text.replace(importRe, (_m, p1, q) => `${p1}${q}${relSpecifier}${q}`);
  if (next !== text) {
    writeFileSync(file, next);
    rewrites++;
  }
}

console.log(
  `[inline-shared] inlined @slicc/shared into ${inlinedSharedDir}; rewrote imports in ${rewrites} file(s)`
);

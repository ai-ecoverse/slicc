#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);
const repoRoot = resolve(Dirname, '../../..');
const nodeServerDist = resolve(repoRoot, 'dist/node-server');

if (!existsSync(nodeServerDist)) {
  console.error(`[inline-workspaces] node-server dist not found at ${nodeServerDist}`);
  process.exit(1);
}

const WORKSPACES = [
  {
    packageName: '@slicc/shared-ts',
    sourceDist: resolve(repoRoot, 'packages/shared-ts/dist'),
    inlinedDir: '_shared',

    entryRelPath: 'index.js',
  },
  {
    packageName: '@slicc/cloud-core',
    sourceDist: resolve(repoRoot, 'packages/cloud-core/dist'),
    inlinedDir: '_cloud_core',
    entryRelPath: 'src/index.js',
  },
];

for (const ws of WORKSPACES) {
  if (!existsSync(ws.sourceDist)) {
    console.error(
      `[inline-workspaces] ${ws.packageName} dist not found at ${ws.sourceDist}. Build it first.`
    );
    process.exit(1);
  }
  const target = resolve(nodeServerDist, ws.inlinedDir);
  copyRecursive(ws.sourceDist, target);
}

let totalRewrites = 0;
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const original = readFileSync(file, 'utf-8');
  let text = original;
  for (const ws of WORKSPACES) {
    if (!text.includes(ws.packageName)) continue;
    const entryAbs = resolve(nodeServerDist, ws.inlinedDir, ws.entryRelPath);
    const relToEntry = relative(dirname(file), entryAbs).split('\\').join('/');
    const relSpecifier = relToEntry.startsWith('.') ? relToEntry : './' + relToEntry;
    const escaped = ws.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const importRe = new RegExp(`(from\\s+|import\\s*\\(\\s*)(['"])${escaped}\\2`, 'g');

    const bareSideEffectRe = new RegExp(`(^|\\n)(\\s*import\\s+)(['"])${escaped}\\3`, 'g');
    text = text.replace(importRe, (_m, p1, q) => `${p1}${q}${relSpecifier}${q}`);
    text = text.replace(
      bareSideEffectRe,
      (_m, lead, kw, q) => `${lead}${kw}${q}${relSpecifier}${q}`
    );
  }
  if (text !== original) {
    writeFileSync(file, text);
    totalRewrites++;
  }
}

const leftover = [];
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;

  const stripped = readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const ws of WORKSPACES) {
    if (stripped.includes(ws.packageName)) {
      leftover.push({ file, packageName: ws.packageName });
      break;
    }
  }
}
if (leftover.length > 0) {
  console.error(
    `[inline-workspaces] ${leftover.length} file(s) still reference a workspace package after rewrite:`
  );
  for (const { file, packageName } of leftover) console.error(`  - ${packageName} in ${file}`);
  process.exit(1);
}

console.log(
  `[inline-workspaces] inlined ${WORKSPACES.length} workspace(s); rewrote imports in ${totalRewrites} file(s)`
);

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    }
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

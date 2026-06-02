#!/usr/bin/env node
// Post-build step: inline private workspace packages into dist/node-server/
// so the published `sliccy` npm tarball is self-contained.
//
// Why: the published tarball ships dist/node-server/ but does NOT include
// @slicc/shared-ts or @slicc/cloud-core (they're private workspace packages,
// not real npm dependencies). Inlining them makes the published output self-contained.

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
    /** path to the entry .js, relative to inlinedDir */
    entryRelPath: 'index.js',
  },
  {
    packageName: '@slicc/cloud-core',
    sourceDist: resolve(repoRoot, 'packages/cloud-core/dist'),
    inlinedDir: '_cloud_core',
    entryRelPath: 'src/index.js',
  },
];

// Step 1: copy each workspace's dist into dist/node-server/<inlinedDir>
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

// Step 2: walk dist/node-server (now containing the inlined dirs) and rewrite imports for each workspace
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
    // `from '...'` covers `import x from`, `export { y } from`, `export * from`,
    // `import type ... from`. `import('...')` covers dynamic imports.
    const importRe = new RegExp(`(from\\s+|import\\s*\\(\\s*)(['"])${escaped}\\2`, 'g');
    // Bare side-effect imports (`import '@slicc/shared-ts';`)
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

// Step 3: belt + suspenders — fail if any workspace package is still referenced outside comments
const leftover = [];
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  // Strip both JSDoc block comments and single-line comments
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

// --- helpers ---

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

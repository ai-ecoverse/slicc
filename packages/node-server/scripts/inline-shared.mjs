#!/usr/bin/env node
// Post-build step: copy @slicc/shared-ts compiled output into dist/node-server/_shared/
// and rewrite `from '@slicc/shared-ts'` imports in dist/node-server/**/*.{js,d.ts}
// to relative paths.
//
// Why: the published `sliccy` npm tarball ships dist/node-server/ but does NOT
// include @slicc/shared-ts (it's a private workspace package, not a real npm
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
const sharedDist = resolve(repoRoot, 'packages/shared-ts/dist');
const nodeServerDist = resolve(repoRoot, 'dist/node-server');
const inlinedSharedDir = resolve(nodeServerDist, '_shared');

if (!existsSync(sharedDist)) {
  console.error(
    `[inline-shared] @slicc/shared-ts dist not found at ${sharedDist}. Build @slicc/shared-ts first.`
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

// `from '...'` covers `import x from`, `export { y } from`, `export * from`,
// `import type ... from`. `import('...')` covers dynamic imports. Bare
// side-effect imports (`import '@slicc/shared-ts';`) are caught by the
// `bareSideEffectRe` companion below.
const importRe = /(from\s+|import\s*\(\s*)(['"])@slicc\/shared-ts\2/g;
const bareSideEffectRe = /(^|\n)(\s*import\s+)(['"])@slicc\/shared-ts\3/g;
let rewrites = 0;
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf-8');
  if (!text.includes('@slicc/shared-ts')) continue;
  const relToShared = relative(dirname(file), join(inlinedSharedDir, 'index.js'))
    .split('\\')
    .join('/');
  const relSpecifier = relToShared.startsWith('.') ? relToShared : './' + relToShared;
  let next = text.replace(importRe, (_m, p1, q) => `${p1}${q}${relSpecifier}${q}`);
  next = next.replace(bareSideEffectRe, (_m, lead, kw, q) => `${lead}${kw}${q}${relSpecifier}${q}`);
  if (next !== text) {
    writeFileSync(file, next);
    rewrites++;
  }
}

// Belt + suspenders: if any `@slicc/shared-ts` reference survives the
// rewrite (outside of JSDoc comments), the published tarball will fail
// to resolve the module at runtime. Fail the build loudly instead of
// silently shipping a broken package.
const leftover = [];
for (const file of walk(nodeServerDist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf-8');
  // Skip JSDoc comments (`/** ... @slicc/shared-ts ... */`) — they
  // don't affect runtime resolution.
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (stripped.includes('@slicc/shared-ts')) leftover.push(file);
}
if (leftover.length > 0) {
  console.error(
    `[inline-shared] ${leftover.length} file(s) still reference @slicc/shared-ts after rewrite — published package would break:`
  );
  for (const f of leftover) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `[inline-shared] inlined @slicc/shared-ts into ${inlinedSharedDir}; rewrote imports in ${rewrites} file(s)`
);

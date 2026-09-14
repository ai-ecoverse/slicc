#!/usr/bin/env node

import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const sentinels = [
  resolve(repoRoot, 'node_modules', '.package-lock.json'),

  resolve(repoRoot, 'node_modules', 'typescript', 'package.json'),
];

const missing = sentinels.filter((p) => {
  try {
    accessSync(p, constants.F_OK);
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  const list = missing.map((p) => `  - ${p}`).join('\n');
  process.stderr.write(
    [
      '',
      'preflight-deps: this workspace has no local node_modules.',
      '',
      'Missing sentinel(s):',
      list,
      '',
      'Run `npm ci` (or `npm install`) at the repo root before running',
      'typecheck/test. Otherwise tsc may silently resolve packages from a',
      'parent directory and surface fake errors that vanish after install.',
      '',
    ].join('\n')
  );
  process.exit(1);
}

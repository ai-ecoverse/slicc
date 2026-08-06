#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findUnusedLayerSuppressions } from './layer-boundary-suppressions-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(filename), '..', '..', '..');

function runBiomeLint(repoRoot) {
  const executable = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'biome.cmd' : 'biome'
  );
  const result = spawnSync(
    executable,
    ['lint', '--reporter=json', '--max-diagnostics=none', 'packages/webapp/src'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `Biome lint exited with status ${result.status}`);
  }
  return result.stdout;
}

export function runUnusedLayerSuppressionCheck(repoRoot = defaultRepoRoot, options = {}) {
  const report = options.biomeReport ?? runBiomeLint(repoRoot);
  const unused = findUnusedLayerSuppressions(repoRoot, report);
  return { ok: unused.length === 0, unused };
}

function main() {
  const result = runUnusedLayerSuppressionCheck();
  if (result.ok) {
    process.stdout.write('check-unused-layer-suppressions: OK\n');
    return;
  }
  process.stderr.write('check-unused-layer-suppressions: FAIL\n');
  process.stderr.write('Remove these unused generated layer suppressions:\n');
  for (const item of result.unused) process.stderr.write(`  - ${item.path}:${item.line}\n`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

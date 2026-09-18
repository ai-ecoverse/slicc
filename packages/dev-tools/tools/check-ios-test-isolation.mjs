#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkRandomExecutionOrder,
  findSharedDefaultsMutations,
  parseSchemeTestTargets,
} from './check-ios-test-isolation-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const projectPath = resolve(repoRoot, 'packages/ios-app/project.yml');
const testsDir = resolve(repoRoot, 'packages/ios-app/SliccFollower/Tests');
const SCHEME = 'SliccFollower';

function readSwiftTestSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readSwiftTestSources(path));
      continue;
    }
    if (!entry.name.endsWith('.swift')) continue;
    files.push({ path: relative(repoRoot, path), source: readFileSync(path, 'utf8') });
  }
  return files;
}

function main() {
  const targets = parseSchemeTestTargets(readFileSync(projectPath, 'utf8'), SCHEME);
  const files = readSwiftTestSources(testsDir);
  const problems = [
    ...checkRandomExecutionOrder(targets, {
      schemePath: relative(repoRoot, projectPath),
    }),
    ...findSharedDefaultsMutations(files),
  ];

  if (problems.length > 0) {
    console.error('check-ios-test-isolation: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error(
      'Fix: keep `randomExecutionOrder: true` on every test target in the SliccFollower scheme, and seed fixture flags through makeIsolatedDefaults (SliccFollowerTests/IsolatedTestDefaults.swift) instead of UserDefaults.standard.'
    );
    return 1;
  }

  console.log(
    `check-ios-test-isolation: ok (${targets.length} test target(s) in random order, ` +
      `${files.length} test source(s) free of shared-domain writes)`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(main());

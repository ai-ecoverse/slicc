#!/usr/bin/env node
// Registry gate for the iOS UI tests CI does not run.
//
// The `ios-app-tests` job used to name four hand-picked UI classes with
// `-only-testing`. Everything else in `SliccFollowerUITests` — 21 of 25
// classes — therefore ran nowhere but a developer's Mac, and two of them had
// been failing on main for releases before anyone ran the suite locally.
//
// The job now runs the WHOLE bundle and subtracts
// `packages/ios-app/ui-test-exclusions.json`. A new test class is gated the
// day it lands; getting out of CI takes an edit to a reviewed file with a
// written reason. This script is both halves of that contract:
//
//   --check              (default) validate the registry against the sources
//   --print-skip-args    emit the `-skip-testing` specs for the CI step
//
// The validation is what keeps the escape hatch honest: an entry naming a
// class or method that no longer exists is a stale exclusion silently
// suppressing nothing, which is how a list like this rots in the other
// direction.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const registryPath = resolve(repoRoot, 'packages/ios-app/ui-test-exclusions.json');
const uiTestDir = resolve(repoRoot, 'packages/ios-app/SliccFollower/Tests/SliccFollowerUITests');
const BUNDLE = 'SliccFollowerUITests';

/** `{ ClassName: Set<testMethodName> }` for every class in the UI test bundle. */
export function readTestIndex(dir) {
  const index = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;
    const source = readFileSync(resolve(dir, entry.name), 'utf8');
    for (const [, className] of source.matchAll(
      /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*XCTestCase\b/g
    )) {
      index[className] ??= new Set();
    }
    // Method-to-class attribution would need a real parser; one XCTestCase per
    // file is the convention here, so every `func test…` in the file belongs to
    // the class(es) it declares.
    const methods = [...source.matchAll(/\bfunc\s+(test[A-Za-z0-9_]*)\s*\(/g)].map(([, m]) => m);
    for (const className of Object.keys(index)) {
      if (!source.includes(`class ${className}`)) continue;
      for (const m of methods) index[className].add(m);
    }
  }
  return index;
}

/** Problems with the registry, as reviewer-readable strings. Empty means valid. */
export function validate(registry, index) {
  const problems = [];
  const entries = registry?.exclusions;
  if (!Array.isArray(entries)) return ['ui-test-exclusions.json has no `exclusions` array'];

  const seen = new Set();
  for (const entry of entries) {
    const spec = entry?.test;
    if (typeof spec !== 'string' || spec.length === 0) {
      problems.push(`entry ${JSON.stringify(entry)} has no \`test\` spec`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(`${spec}: needs a \`reason\` explaining why CI cannot run it`);
    }
    if (seen.has(spec)) problems.push(`${spec}: listed more than once`);
    seen.add(spec);

    const [className, method, ...rest] = spec.split('/');
    if (rest.length > 0) {
      problems.push(`${spec}: expected "Class" or "Class/testMethod", not a longer path`);
      continue;
    }
    if (!(className in index)) {
      problems.push(
        `${spec}: no XCTestCase named ${className} in ${BUNDLE} — stale exclusion, delete it`
      );
      continue;
    }
    if (method !== undefined && !index[className].has(method)) {
      problems.push(`${spec}: ${className} has no ${method} — stale exclusion, delete it`);
    }
  }
  return problems;
}

/** `-skip-testing` specs, bundle-qualified, in registry order. */
export function skipArgs(registry) {
  return (registry?.exclusions ?? []).map((entry) => `${BUNDLE}/${entry.test}`);
}

function main(args) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

  if (args.includes('--print-skip-args')) {
    // One per line: the CI step reads them into a bash array.
    for (const spec of skipArgs(registry)) console.log(spec);
    return 0;
  }

  const problems = validate(registry, readTestIndex(uiTestDir));
  if (problems.length > 0) {
    console.error('ios-ui-test-exclusions: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error(
      'Fix: correct packages/ios-app/ui-test-exclusions.json — or delete the entry and let CI run the test.'
    );
    return 1;
  }
  const count = registry.exclusions.length;
  console.log(
    `ios-ui-test-exclusions: ok (${count} excluded, everything else in ${BUNDLE} runs in CI)`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(main(argv.slice(2)));

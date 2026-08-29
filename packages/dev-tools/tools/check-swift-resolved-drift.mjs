#!/usr/bin/env node
// SwiftPM lockfile drift gate.
//
// `xcodebuild -resolvePackageDependencies` and `swift build` both REWRITE the
// checked-in `Package.resolved` in place when a manifest's version range admits
// something newer, then build happily against whatever they just wrote. Nothing
// fails, so the committed lockfile stops describing the build: a transitive
// dependency can move under a direct pin bump and never appear in any diff.
// (`lint:swift-pins` only compares the DIRECT pins that appear in project.yml
// and Package.swift, so transitive ones are invisible to it.)
//
// Run this after the resolve step: it reads the committed file back out of git
// and compares its pin set against the working copy. Drift means resolution
// changed something no human reviewed — regenerate and commit the lockfile.
//
// Compares identity/version/revision only. `originHash` is a digest of the
// manifests whose derivation is an Xcode implementation detail, and both the
// key order and the file-format `version` move with the toolchain; gating on
// those would turn an SDK bump into a spurious red.
//
// Usage: check-swift-resolved-drift.mjs <path-to-Package.resolved>...

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * `{ identity: "<version>@<revision>" }` for every pin, order-independent.
 * Branch pins (no version) fall back to the branch name so they still compare.
 */
export function pinMap(source) {
  const parsed = JSON.parse(source);
  const out = {};
  for (const pin of parsed.pins ?? []) {
    const state = pin.state ?? {};
    out[pin.identity] = `${state.version ?? state.branch ?? '?'}@${state.revision ?? '?'}`;
  }
  return out;
}

/** Human-readable descriptions of every pin that differs between two maps. */
export function diffPins(committed, working) {
  const problems = [];
  for (const [identity, was] of Object.entries(committed)) {
    const now = working[identity];
    if (now === undefined) problems.push(`${identity}: ${was} -> removed`);
    else if (now !== was) problems.push(`${identity}: ${was} -> ${now}`);
  }
  for (const identity of Object.keys(working)) {
    if (!(identity in committed)) problems.push(`${identity}: added ${working[identity]}`);
  }
  return problems.sort();
}

/** The path `git show HEAD:<path>` wants: repo-root-relative, forward slashes. */
function trackedPath(file, cwd) {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return relative(top, resolve(cwd, file)).split('\\').join('/');
}

function main(files, cwd = process.cwd()) {
  if (files.length === 0) {
    console.error('usage: check-swift-resolved-drift.mjs <path-to-Package.resolved>...');
    return 2;
  }
  let failed = false;
  for (const file of files) {
    const abs = resolve(cwd, file);
    if (!existsSync(abs)) {
      console.error(`::error::${file} does not exist — the resolve step should have produced it`);
      failed = true;
      continue;
    }
    const tracked = trackedPath(file, cwd);
    let committed;
    try {
      committed = execFileSync('git', ['show', `HEAD:${tracked}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      console.error(
        `::error::${tracked} is not committed; a lockfile that is not tracked pins nothing`
      );
      failed = true;
      continue;
    }
    const problems = diffPins(pinMap(committed), pinMap(readFileSync(abs, 'utf8')));
    if (problems.length === 0) {
      console.log(`ok  ${tracked}`);
      continue;
    }
    failed = true;
    console.error(`::error::${tracked} drifted during dependency resolution:`);
    for (const p of problems) console.error(`  - ${p}`);
  }
  if (!failed) return 0;
  console.error('');
  console.error('Fix: rerun resolution locally and commit the regenerated Package.resolved:');
  console.error('  cd packages/ios-app && xcodegen generate &&');
  console.error(
    '    xcodebuild -resolvePackageDependencies -project SliccFollower.xcodeproj -scheme SliccFollower'
  );
  return 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(main(argv.slice(2)));

#!/usr/bin/env node

import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNoCommentTree } from '../no-comment/marker.mjs';

const Filename = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(Filename), '../../..');

const PACKAGES_DIR = join(repoRoot, 'packages');

export function isSymlink(absPath) {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isValidAgentsSymlink(absPath) {
  if (!isSymlink(absPath)) return false;
  try {
    return readlinkSync(absPath) === 'CLAUDE.md';
  } catch {
    return false;
  }
}

export function findViolations(packagesDir, pkgNames) {
  const violations = [];
  for (const pkg of pkgNames) {
    const claudeMd = join(packagesDir, pkg, 'CLAUDE.md');
    const agentsMd = join(packagesDir, pkg, 'AGENTS.md');

    let hasClaudeMd = false;
    try {
      lstatSync(claudeMd);
      hasClaudeMd = true;
    } catch {}
    if (!hasClaudeMd) continue;

    if (!isSymlink(agentsMd)) {
      violations.push({
        pkg,
        claudeMd,
        agentsMd,
        reason: 'AGENTS.md is missing or is not a symlink',
      });
    } else if (!isValidAgentsSymlink(agentsMd)) {
      violations.push({
        pkg,
        claudeMd,
        agentsMd,
        reason: `AGENTS.md is a symlink but its target is not "CLAUDE.md" (got "${readlinkSync(agentsMd)}")`,
      });
    }
  }
  return violations;
}

export function listPackageNames(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function main() {
  if (isNoCommentTree(repoRoot)) {
    process.stdout.write('ok: skipping AGENTS.md symlink gate on no-comment tree\n');
    return;
  }
  const pkgNames = listPackageNames(PACKAGES_DIR);
  const violations = findViolations(PACKAGES_DIR, pkgNames);

  if (violations.length > 0) {
    for (const { pkg, reason } of violations) {
      process.stderr.write(
        `::error::packages/${pkg}/AGENTS.md: ${reason}\n` +
          `  Fix: cd packages/${pkg} && ln -s CLAUDE.md AGENTS.md\n`
      );
    }
    process.stderr.write(
      `\n${violations.length} package(s) have CLAUDE.md but are missing a valid ` +
        'AGENTS.md -> CLAUDE.md symlink.\n'
    );
    process.exit(1);
  }

  const checked = pkgNames.filter((pkg) => {
    try {
      lstatSync(join(PACKAGES_DIR, pkg, 'CLAUDE.md'));
      return true;
    } catch {
      return false;
    }
  });
  process.stdout.write(
    `ok: all ${checked.length} packages with CLAUDE.md have a valid AGENTS.md symlink\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

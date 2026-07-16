#!/usr/bin/env node
/**
 * Enforce that every `packages/*\/CLAUDE.md` has a sibling `AGENTS.md`
 * symlink that resolves to it.
 *
 * Background: `CLAUDE.md` is the developer-facing convention file read by
 * Claude Code; `AGENTS.md` is the equivalent consumed by AGENTS.md-native
 * tools (Codex, Cursor, Gemini CLI, etc.). Each package should carry both so
 * no tool silently misses the package's conventions. The link is always the
 * same relative target (`CLAUDE.md`) matching the established pattern used
 * by packages that already have both files.
 *
 * What counts as a valid `AGENTS.md` symlink:
 *  - The file exists at `<packageDir>/AGENTS.md`
 *  - It is a symbolic link (not a plain file or directory)
 *  - Its link target (as read by readlinkSync) is exactly `"CLAUDE.md"`
 *
 * The detection helpers are exported for unit testing; the filesystem scan
 * runs only when this file is invoked as the entry script.
 */
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(Filename), '../../..');

const PACKAGES_DIR = join(repoRoot, 'packages');

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Return true if `absPath` exists and is a symbolic link.
 * @param {string} absPath
 * @returns {boolean}
 */
export function isSymlink(absPath) {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Return true if `absPath` is a symlink whose target is exactly `"CLAUDE.md"`.
 * @param {string} absPath
 * @returns {boolean}
 */
export function isValidAgentsSymlink(absPath) {
  if (!isSymlink(absPath)) return false;
  try {
    return readlinkSync(absPath) === 'CLAUDE.md';
  } catch {
    return false;
  }
}

/**
 * Given a list of package names under `packagesDir`, return an array of
 * violation objects for every package that has a `CLAUDE.md` but is missing
 * a valid `AGENTS.md -> CLAUDE.md` symlink.
 *
 * @param {string} packagesDir  Absolute path to the `packages/` directory.
 * @param {string[]} pkgNames   Subdirectory names to inspect.
 * @returns {{ pkg: string, claudeMd: string, agentsMd: string, reason: string }[]}
 */
export function findViolations(packagesDir, pkgNames) {
  const violations = [];
  for (const pkg of pkgNames) {
    const claudeMd = join(packagesDir, pkg, 'CLAUDE.md');
    const agentsMd = join(packagesDir, pkg, 'AGENTS.md');

    // Only enforce the rule for packages that actually have a CLAUDE.md.
    let hasClaudeMd = false;
    try {
      lstatSync(claudeMd);
      hasClaudeMd = true;
    } catch {
      // no CLAUDE.md — nothing to enforce
    }
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

/**
 * Return the list of direct subdirectory names under `packagesDir`.
 * @param {string} packagesDir
 * @returns {string[]}
 */
export function listPackageNames(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Entry-point scan
// ---------------------------------------------------------------------------

function main() {
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

// Run the scan only when invoked as the entry script (not on import-for-test).
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

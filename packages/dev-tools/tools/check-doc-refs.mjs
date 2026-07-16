#!/usr/bin/env node
/**
 * Dead-reference drift gate for CLAUDE.md and docs/*.md files.
 *
 * Extracts backtick-enclosed repo paths (prefixed packages/, docs/,
 * .github/, .agents/) from every CLAUDE.md in the repo and every
 * docs/*.md file, then fails with ::error:: lines on any path that
 * does not exist on disk.
 *
 * Precision rules (see check-doc-refs-lib.mjs for details):
 *   - Only relative paths with known repo prefixes are checked.
 *   - Absolute paths like /workspace/... are VFS runtime paths — skipped.
 *   - Paths with glob chars (* {) are skipped automatically.
 *   - Template placeholders like <name> are skipped.
 *   - Conventional illustrative my-* paths are skipped.
 *   - A small BUILTIN_ALLOWLIST covers build artifacts, external-repo
 *     refs, and spec/plan future files.
 *   - TypeScript ESM convention: foo.js paths also check foo.ts (ESM
 *     imports use .js extensions that resolve to .ts source files).
 *   - Trailing slashes are stripped before the existence check (the
 *     path need only exist; we do not enforce directory-ness).
 *
 * Chained into npm run lint:docs alongside check-doc-sizes.mjs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractCandidates } from './check-doc-refs-lib.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

/** Collect all CLAUDE.md files in the repo, excluding generated/vendor dirs. */
function collectClaudeMds(root) {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.build']);

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(resolve(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'CLAUDE.md') {
        results.push(resolve(dir, entry.name));
      }
    }
  }

  walk(root);
  return results;
}

/** Collect all docs/*.md files recursively under docs/. */
function collectDocsMds(root) {
  const docsDir = resolve(root, 'docs');
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(resolve(dir, entry.name));
      }
    }
  }

  walk(docsDir);
  return results;
}

/**
 * Check whether a resolved repo path exists.
 * TypeScript ESM convention: also accepts foo.js when foo.ts exists.
 */
function pathExists(absPath) {
  if (existsSync(absPath)) return true;
  // TypeScript ESM imports write `.js` but the source file is `.ts`.
  if (absPath.endsWith('.js')) {
    const tsPath = `${absPath.slice(0, -3)}.ts`;
    if (existsSync(tsPath)) return true;
  }
  return false;
}

/** Run the gate and return failures as an array of message strings. */
function checkDocRefs() {
  const docFiles = [...collectClaudeMds(repoRoot), ...collectDocsMds(repoRoot)];

  const failures = [];
  let checked = 0;
  let skipped = 0;

  for (const absFile of docFiles) {
    const relFile = relative(repoRoot, absFile);
    let content;
    try {
      content = readFileSync(absFile, 'utf8');
    } catch (err) {
      failures.push(`${relFile}: unable to read (${err.message})`);
      continue;
    }

    for (const { path } of extractCandidates(content)) {
      checked++;
      const absPath = resolve(repoRoot, path);
      if (!pathExists(absPath)) {
        failures.push(`${relFile}: dead reference \`${path}\` — path does not exist`);
        skipped++;
      }
    }
  }

  return { failures, checked, skipped, fileCount: docFiles.length };
}

/** Entry point — runs the check and exits non-zero on any failure. */
function main() {
  const { failures, checked, fileCount } = checkDocRefs();

  if (failures.length > 0) {
    for (const msg of failures) {
      process.stderr.write(`::error::${msg}\n`);
    }
    process.stderr.write(
      `\n${failures.length} dead reference(s) found across ${fileCount} doc files ` +
        `(${checked} paths checked).\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `ok: no dead references in ${fileCount} doc files (${checked} paths checked)\n`
  );
}

// Run only when invoked as the entry script (not on import-for-test).
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

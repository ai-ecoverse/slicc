#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNoCommentTree } from '../no-comment/marker.mjs';
import { extractCandidates } from './check-doc-refs-lib.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

function collectClaudeMds(root) {
  const results = [];
  const skipDirs = new Set([
    'node_modules',
    '.git',
    'dist',
    '.build',
    '.worktrees',
    'worktrees',

    '.yolo',
  ]);

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

function pathExists(absPath) {
  if (existsSync(absPath)) return true;

  if (absPath.endsWith('.js')) {
    const tsPath = `${absPath.slice(0, -3)}.ts`;
    if (existsSync(tsPath)) return true;
  }
  return false;
}

function checkDocRefs() {
  const docFiles = [...collectClaudeMds(repoRoot), ...collectDocsMds(repoRoot)];

  const failures = [];
  let checked = 0;

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
      }
    }
  }

  return { failures, checked, fileCount: docFiles.length };
}

function main() {
  if (isNoCommentTree(repoRoot)) {
    process.stdout.write('ok: skipping doc-refs gate on no-comment tree\n');
    return;
  }
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

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();

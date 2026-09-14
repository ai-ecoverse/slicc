#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoCommentTree } from '../no-comment/marker.mjs';
import {
  checkPackageClaudes,
  discoverPackageClaudes,
  findUnlinkedPackageGuides,
  PACKAGE_CLAUDE_MAX_CHARS,
  resolvePackageClaudeLimit,
} from './check-doc-sizes-lib.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

if (isNoCommentTree(repoRoot)) {
  process.stdout.write('ok: skipping doc-size gate on no-comment tree\n');
  process.exit(0);
}

const ROOT_CLAUDE_MAX_CHARS = 15000;

const AGENT_CLAUDE_MAX_BYTES = 2048;
const COPILOT_INSTRUCTIONS_MAX_CHARS = 4000;

const measureChars = (text) => text.length;
const measureBytes = (text) => Buffer.byteLength(text, 'utf8');

const COPILOT_HINT =
  'GitHub Copilot code review ignores instruction text past 4,000 chars; trim it.';

const checks = [
  {
    path: 'CLAUDE.md',
    limit: ROOT_CLAUDE_MAX_CHARS,
    unit: 'chars',
    measure: measureChars,
    hint: 'Please condense it.',
  },
  {
    path: 'packages/vfs-root/shared/CLAUDE.md',
    limit: AGENT_CLAUDE_MAX_BYTES,
    unit: 'bytes',
    measure: measureBytes,
    hint: 'Keep agent instructions concise.',
  },
  {
    path: '.github/copilot-instructions.md',
    limit: COPILOT_INSTRUCTIONS_MAX_CHARS,
    unit: 'chars',
    measure: measureChars,
    optional: true,
    hint: COPILOT_HINT,
  },
];

const instructionsDir = '.github/instructions';
try {
  const entries = readdirSync(resolve(repoRoot, instructionsDir))
    .filter((entry) => entry.endsWith('.instructions.md'))
    .sort();
  for (const entry of entries) {
    checks.push({
      path: `${instructionsDir}/${entry}`,
      limit: COPILOT_INSTRUCTIONS_MAX_CHARS,
      unit: 'chars',
      measure: measureChars,
      hint: COPILOT_HINT,
    });
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const packagesDir = resolve(repoRoot, 'packages');
const packageDirs = readdirSync(packagesDir).filter((entry) => {
  try {
    return statSync(resolve(packagesDir, entry)).isDirectory();
  } catch {
    return false;
  }
});
const packageClaudes = discoverPackageClaudes(packageDirs);
const packageClaudeSizes = new Map();
for (const relPath of packageClaudes) {
  const abs = resolve(repoRoot, relPath);
  try {
    packageClaudeSizes.set(relPath, measureChars(readFileSync(abs, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const failures = [];

for (const check of checks) {
  const abs = resolve(repoRoot, check.path);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    if (check.optional && err.code === 'ENOENT') continue;
    failures.push(`${check.path}: unable to read (${err.message})`);
    continue;
  }
  const size = check.measure(text);
  if (size > check.limit) {
    failures.push(
      `${check.path} exceeds ${check.limit} ${check.unit} limit (${size} ${check.unit}). ${check.hint}`
    );
  } else {
    process.stdout.write(`ok: ${check.path} is ${size}/${check.limit} ${check.unit}\n`);
  }
}

const packageClaudeResults = checkPackageClaudes(
  [...packageClaudeSizes.keys()],
  packageClaudeSizes
);
for (const { path, size, limit, pass } of packageClaudeResults) {
  const exempted = resolvePackageClaudeLimit(path) > PACKAGE_CLAUDE_MAX_CHARS;
  const tag = exempted ? ' (grandfathered)' : '';
  if (!pass) {
    failures.push(
      `${path} exceeds ${limit} chars limit (${size} chars)${tag}. Trim it or lower its exemption.`
    );
  } else {
    process.stdout.write(`ok: ${path} is ${size}/${limit} chars${tag}\n`);
  }
}

const rootClaude = readFileSync(resolve(repoRoot, 'CLAUDE.md'), 'utf8');
const missingPackageGuides = findUnlinkedPackageGuides(rootClaude, [...packageClaudeSizes.keys()]);
for (const relPath of missingPackageGuides) {
  failures.push(`CLAUDE.md: missing package guide link \`${relPath}\``);
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`::error::${failure}\n`);
  }
  process.exit(1);
}

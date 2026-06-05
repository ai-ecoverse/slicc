#!/usr/bin/env node
/**
 * Enforce the CLAUDE.md size budgets that used to live as inline `wc -c`
 * steps in .github/workflows/ci.yml. Folding them into a script lets
 * `npm run lint` / `npm run lint:ci` be the single source of truth so the
 * CI gate cannot silently diverge from the local command.
 *
 * Limits are kept in named constants below. The root developer-facing
 * CLAUDE.md is budgeted in characters; the agent-facing runtime
 * CLAUDE.md is budgeted in bytes (it is bundled into the VFS where byte
 * size is what matters and it sits very close to its cap).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const ROOT_CLAUDE_MAX_CHARS = 30000;
const AGENT_CLAUDE_MAX_BYTES = 3000;

const checks = [
  {
    path: 'CLAUDE.md',
    limit: ROOT_CLAUDE_MAX_CHARS,
    unit: 'chars',
    measure: (text) => text.length,
    hint: 'Please condense it.',
  },
  {
    path: 'packages/vfs-root/shared/CLAUDE.md',
    limit: AGENT_CLAUDE_MAX_BYTES,
    unit: 'bytes',
    measure: (text) => Buffer.byteLength(text, 'utf8'),
    hint: 'Keep agent instructions concise.',
  },
];

const failures = [];

for (const check of checks) {
  const abs = resolve(repoRoot, check.path);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
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

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`::error::${failure}\n`);
  }
  process.exit(1);
}

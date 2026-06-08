#!/usr/bin/env node
/**
 * Enforce the size budgets for the repo's machine-read instruction files so the
 * limits are checked automatically instead of living as tacit knowledge.
 * Folding them into a script lets `npm run lint` / `npm run lint:ci` be the
 * single source of truth so the CI gate cannot silently diverge from the local
 * command.
 *
 * Limits are kept in named constants below:
 * - The root developer-facing CLAUDE.md is budgeted in characters; `AGENTS.md`
 *   symlinks to it, so this is also what Codex reads.
 * - The agent-facing runtime CLAUDE.md is budgeted in bytes (it is bundled into
 *   the VFS where byte size is what matters and it sits very close to its cap).
 * - The GitHub Copilot instruction files (`.github/copilot-instructions.md` and
 *   every `.github/instructions/*.instructions.md`) are budgeted in characters:
 *   Copilot code review only reads the first 4,000 characters of any
 *   instruction file and silently ignores the rest.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const ROOT_CLAUDE_MAX_CHARS = 30000;
const AGENT_CLAUDE_MAX_BYTES = 3000;
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

// Path-specific Copilot instructions live in .github/instructions/*.instructions.md
// and are subject to the same 4,000-char truncation. Discover them dynamically so
// new files are budgeted without editing this script.
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
  // No instructions directory yet — nothing path-specific to budget.
  if (err.code !== 'ENOENT') throw err;
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

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`::error::${failure}\n`);
  }
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Sync agent-skill install pins that must stay lockstep with an npm dep.
 *
 * Today: v86 — `packages/webapp/package.json` is the source of truth; the
 * `ipk add -g v86@X` line in `packages/vfs-root/workspace/skills/v86/SKILL.md`
 * is the agent-facing mirror. Renovate bumps package.json (and, with the
 * regex customManager in renovate.json, the skill too); this script is the
 * backstop when only one side moved (PR #2773).
 *
 * Usage:
 *   node packages/dev-tools/skill-pin-reconcile/reconcile.mjs          # dry-run
 *   node packages/dev-tools/skill-pin-reconcile/reconcile.mjs --write  # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WRITE = process.argv.includes('--write');

/** @type {readonly { dep: string; packageJson: string; skill: string; pattern: RegExp; line: (v: string) => string }[]} */
const PINS = [
  {
    dep: 'v86',
    packageJson: 'packages/webapp/package.json',
    skill: 'packages/vfs-root/workspace/skills/v86/SKILL.md',
    pattern: /ipk add -g v86@\d+\.\d+\.\d+/g,
    line: (v) => `ipk add -g v86@${v}`,
  },
];

let changed = false;
for (const pin of PINS) {
  const pkgPath = resolve(ROOT, pin.packageJson);
  const skillPath = resolve(ROOT, pin.skill);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version =
    pkg.dependencies?.[pin.dep] ?? pkg.devDependencies?.[pin.dep] ?? null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      `skill-pin-reconcile: ${pin.packageJson} has no exact ${pin.dep} pin (got ${JSON.stringify(version)})`
    );
    process.exit(1);
  }

  const skill = readFileSync(skillPath, 'utf8');
  const expected = pin.line(version);
  if (!pin.pattern.test(skill)) {
    console.error(
      `skill-pin-reconcile: ${pin.skill} has no \`ipk add -g ${pin.dep}@X.Y.Z\` line to sync`
    );
    process.exit(1);
  }
  // Reset lastIndex after the test() above (global regex).
  pin.pattern.lastIndex = 0;
  const next = skill.replace(pin.pattern, expected);
  if (next === skill) {
    console.log(`ok: ${pin.dep} skill pin already matches ${version}`);
    continue;
  }
  changed = true;
  console.log(`sync: ${pin.skill} → ${expected}`);
  if (WRITE) {
    writeFileSync(skillPath, next);
  }
}

if (changed && !WRITE) {
  console.log('(dry-run; pass --write to apply)');
  process.exit(2);
}

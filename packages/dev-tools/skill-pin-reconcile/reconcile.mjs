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
 *
 * Exit codes: 0 ok / applied, 1 malformed input, 2 dry-run found drift.
 * Tests may set SKILL_PIN_ROOT to point at a fixture tree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, reconcilePin } from './lib.mjs';

const ROOT =
  process.env.SKILL_PIN_ROOT?.trim() ||
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WRITE = process.argv.includes('--write');

let changed = false;
for (const pin of PINS) {
  const pkgPath = resolve(ROOT, pin.packageJson);
  const skillPath = resolve(ROOT, pin.skill);
  const result = reconcilePin({
    packageJsonText: readFileSync(pkgPath, 'utf8'),
    skillText: readFileSync(skillPath, 'utf8'),
    pin,
  });
  if (!result.ok) {
    const path = result.where === 'packageJson' ? pin.packageJson : pin.skill;
    console.error(`skill-pin-reconcile: ${path} ${result.reason}`);
    process.exit(1);
  }
  if (!result.changed) {
    console.log(`ok: ${pin.dep} skill pin already matches ${result.version}`);
    continue;
  }
  changed = true;
  console.log(`sync: ${pin.skill} → ${pin.line(result.version)}`);
  if (WRITE) {
    writeFileSync(skillPath, result.next);
  }
}

if (changed && !WRITE) {
  console.log('(dry-run; pass --write to apply)');
  process.exit(2);
}

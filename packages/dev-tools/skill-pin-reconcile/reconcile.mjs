#!/usr/bin/env node

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

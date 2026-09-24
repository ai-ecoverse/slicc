#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBudgetRaises, planBudgetRaises } from './bundle-budget-reconcile-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGES = ['packages/webapp', 'packages/chrome-extension'];

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: bundle-budget-reconcile.mjs [--write] [--max-growth-kb=N]\n' +
      'Measures built dist/ with size-limit and raises exceeded budgets by at most N kB (default 50).'
  );
  process.exit(0);
}
const write = args.includes('--write');
const maxGrowthKb = Number(args.find((a) => a.startsWith('--max-growth-kb='))?.split('=')[1] ?? 50);
if (!Number.isFinite(maxGrowthKb) || maxGrowthKb < 0) {
  console.error('--max-growth-kb must be a non-negative number');
  process.exit(1);
}

function measure(pkgDir) {
  try {
    return execFileSync('npx', ['--no-install', 'size-limit', '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('[')) {
      return error.stdout;
    }
    throw error;
  }
}

let blockedAny = false;
for (const pkg of PACKAGES) {
  const pkgDir = join(ROOT, pkg);
  const pkgJsonPath = join(pkgDir, 'package.json');
  const text = readFileSync(pkgJsonPath, 'utf8');
  const budgets = JSON.parse(text)['size-limit'] ?? [];
  if (budgets.length === 0) continue;

  const results = JSON.parse(measure(pkgDir));
  const { raises, blocked } = planBudgetRaises(budgets, results, {
    maxGrowthBytes: maxGrowthKb * 1000,
  });

  for (const r of raises) {
    console.log(`${pkg}: "${r.name}" over by ${r.overBy} B — ${r.from} → ${r.to}`);
  }
  for (const b of blocked) {
    blockedAny = true;
    console.log(
      `${pkg}: "${b.name}" over by ${b.overBy} B (> ${maxGrowthKb} kB) — not raising, needs a human`
    );
  }
  if (write && raises.length > 0) {
    writeFileSync(pkgJsonPath, applyBudgetRaises(text, raises));
  }
}

process.exit(blockedAny ? 2 : 0);

#!/usr/bin/env node
// CI quarantine gate: every `continue-on-error: true` step in the workflows
// listed in ci-quarantine.json must be declared there with a reason, an owning
// package/area, and a review date. A quarantined step cannot fail its job, so
// an undeclared one is an invisible hole in CI.
//
// Exit codes:
//   0  every quarantine is declared (warnings may still be printed)
//   1  an undeclared quarantine, or a malformed registry
//   2  the registry or a gated workflow could not be read
//
// Review dates and vanished registry entries only WARN. A gate that starts
// failing unrelated PRs on a calendar date is worse than the debt it flags.
//
// Usage: node packages/dev-tools/tools/check-ci-quarantine.mjs [registry-path]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateQuarantines,
  formatUnregisteredHint,
  parseContinueOnErrorSteps,
} from './ci-quarantine-lib.mjs';
import { repoRoot } from './size-exemption-lib.mjs';

const SCRIPT = 'check-ci-quarantine';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function main(argv) {
  const registryPath = resolve(repoRoot, argv[0] ?? 'ci-quarantine.json');
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    console.error(`${SCRIPT}: cannot read ${registryPath}: ${err.message}`);
    return 2;
  }

  const found = [];
  for (const workflow of registry.workflows ?? []) {
    try {
      found.push(
        ...parseContinueOnErrorSteps(readFileSync(resolve(repoRoot, workflow), 'utf-8'), workflow)
      );
    } catch (err) {
      console.error(`${SCRIPT}: cannot read ${workflow}: ${err.message}`);
      return 2;
    }
  }

  const result = evaluateQuarantines({ registry, found, today: today() });

  for (const entry of result.stale) {
    console.log(
      `${SCRIPT}: notice — registered quarantine no longer exists, delete its entry: ` +
        `${entry.workflow} → ${entry.job} → ${entry.step}`
    );
  }
  for (const entry of result.expired) {
    console.log(
      `${SCRIPT}: WARNING — quarantine past its review date (${entry.reviewBy}, owner ${entry.owner}): ` +
        `${entry.workflow} → ${entry.job} → ${entry.step}`
    );
  }

  if (result.invalid.length === 0 && result.unregistered.length === 0) {
    console.log(`${SCRIPT}: OK (${result.ok} declared quarantine(s))`);
    return 0;
  }

  console.error(`${SCRIPT}: FAIL`);
  for (const problem of result.invalid) {
    console.error(`  ci-quarantine.json: ${problem}`);
  }
  for (const entry of result.unregistered) {
    console.error('');
    console.error(
      `Undeclared \`continue-on-error: true\` at ${entry.workflow}:${entry.line} ` +
        `(job ${entry.job} → step "${entry.step}").`
    );
    console.error('A quarantined step cannot fail its job. Declare it in ci-quarantine.json:');
    console.error('');
    console.error(formatUnregisteredHint(entry));
  }
  return 1;
}

process.exit(main(process.argv.slice(2)));

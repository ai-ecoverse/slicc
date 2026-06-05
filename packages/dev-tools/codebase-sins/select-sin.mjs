#!/usr/bin/env node
/*
 * Codebase "seven sins" rotation — CLI (I/O).
 *
 * Resolves the sin of the day (honouring an optional workflow_dispatch
 * override), reads its per-sin prompt body, composes the final prompt with the
 * shared filing boilerplate, and writes `sin_id`, `sin_name`, `sin_label`, and
 * the multi-line `prompt` to `$GITHUB_OUTPUT`. Pure logic lives in `sins.mjs`
 * (unit-tested); this file only does I/O. Mirrors
 * `packages/dev-tools/rum-error-triage/triage-rum-errors.mjs`.
 *
 * Env:
 *   SIN_OVERRIDE   optional workflow_dispatch override (1-7, or a sin name/id)
 *   GITHUB_OUTPUT  Actions output file (when present)
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { buildPrompt, resolveSin } from './sins.mjs';

/** Append `key=value` to $GITHUB_OUTPUT, using the heredoc form for multi-line values. */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (value.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${value}\n`);
  }
}

function main() {
  const sin = resolveSin(process.env.SIN_OVERRIDE);
  const body = readFileSync(sin.promptFile, 'utf8');
  const prompt = buildPrompt(sin, body);

  setOutput('sin_id', sin.id);
  setOutput('sin_name', sin.name);
  setOutput('sin_label', sin.label);
  setOutput('prompt', prompt);

  console.log(`🎯 Sin of the day: ${sin.name} (${sin.label})`);
  console.log(`   ${sin.summary}`);
}

main();

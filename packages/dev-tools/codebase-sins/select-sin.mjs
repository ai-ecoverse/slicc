#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { buildPrompt, resolveSin } from './sins.mjs';

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

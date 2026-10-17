#!/usr/bin/env node
// Runs a gate and fails unless it printed an explicit verdict line. A gate's
// silence must never read as a pass: a gate that exits 0 without printing
// `<label>: PASS …` (an early return, a skipped main, a script that never
// ran) fails here instead of passing the job.
//
// Usage: node packages/dev-tools/tools/require-verdict.mjs <label> -- <command> [args...]
//
// Deliberately has no main-module guard: this file is only ever run, never
// imported, so it cannot be skipped the way the gates it wraps could be.

import { spawn } from 'node:child_process';

const [label, separator, command, ...args] = process.argv.slice(2);
if (!label || separator !== '--' || !command) {
  console.error('usage: require-verdict.mjs <label> -- <command> [args...]');
  process.exit(2);
}

const verdict = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (PASS|FAIL)\\b`);
let seen;
// One partial-line buffer per stream: stdout and stderr chunks interleave,
// and a shared buffer would glue one stream's unfinished line onto the other's
// verdict line, so the anchored match would miss a real PASS.
const scanner = () => {
  let tail = '';
  return (chunk) => {
    const lines = (tail + chunk.toString()).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      const match = verdict.exec(line);
      if (match) seen = match[1];
    }
  };
};
const scanOut = scanner();
const scanErr = scanner();

const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  scanOut(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  scanErr(chunk);
});
child.on('error', (error) => {
  console.error(`require-verdict: could not start ${command}: ${error.message}`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  scanOut('\n');
  scanErr('\n');
  if (code !== 0) process.exit(code ?? 1);
  if (signal) process.exit(1);
  if (seen !== 'PASS') {
    console.error(
      `require-verdict: ${label} exited 0 without printing "${label}: PASS"; treating its silence as a failure.`
    );
    process.exit(1);
  }
  process.exit(0);
});

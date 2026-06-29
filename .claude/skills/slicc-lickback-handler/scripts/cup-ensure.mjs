#!/usr/bin/env node
// Ensure a SLICC cup is running and print its base URL. If one is already live
// (per ~/.slicc/cup.json + GET /api/status), just print it. Otherwise launch a
// new cup DETACHED (`npm run cup`, overridable via SLICC_CUP_CMD) from the repo
// (SLICC_REPO_DIR or cwd), poll until it comes up — re-reading cup.json each
// time so a cup that binds a different port than 5710 is still found — then print
// the base URL. Exit 0 + URL on success; 1 + a message if it never comes up.
// tva
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  baseUrlForPort,
  ensureCupReady,
  isDirectRun,
  probeCup,
  readCupRecord,
  resolvePort,
  sliccDir,
} from './_lib.mjs';

function launchCup() {
  // `npm run cup` (non-dev → Chrome dials the hosted origin, so no wrangler is
  // needed). Detached + unref'd so the cup outlives this process and the operator
  // keeps the browser after the brain hands back. Override the command with
  // SLICC_CUP_CMD (e.g. `npm run cup-dev` for local-unmerged testing). The cup's
  // stdout/stderr go to ~/.slicc/cup-launch.log so a failed boot is debuggable.
  const [cmd, ...args] = (process.env.SLICC_CUP_CMD || 'npm run cup').split(' ');
  let stdio = 'ignore';
  try {
    mkdirSync(sliccDir(), { recursive: true });
    const fd = openSync(join(sliccDir(), 'cup-launch.log'), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    stdio = 'ignore';
  }
  const child = spawn(cmd, args, {
    cwd: process.env.SLICC_REPO_DIR || process.cwd(),
    detached: true,
    stdio,
  });
  // A detached spawn emits 'error' asynchronously (ENOENT, bad cwd) with no
  // listener → Node escalates it to an uncaught exception that escapes main()'s
  // try/catch. Report it and exit cleanly instead.
  child.on('error', (err) => {
    process.stderr.write(`Failed to launch a SLICC cup: ${err.message}\n`);
    process.exit(1);
  });
  child.unref();
}

async function main() {
  const resolveBase = () => baseUrlForPort(resolvePort(readCupRecord()));
  try {
    const { base, launched } = await ensureCupReady({
      resolveBase,
      probe: probeCup,
      launch: launchCup,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    if (launched) process.stderr.write('Launched a new SLICC cup.\n');
    process.stdout.write(`${base}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();

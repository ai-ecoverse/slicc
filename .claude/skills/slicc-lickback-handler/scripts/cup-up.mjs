#!/usr/bin/env node
// Bring up a DRIVABLE cup in one call, auto-detecting dev vs prod from the repo clone's git
// branch (Ben's rule):
//  - a feature-branch clone (HEAD is NOT `main`) runs UNMERGED code that production
//    www.sliccy.ai doesn't have yet, so the cup must load the LOCAL build → DEV mode:
//    reuse/start a wrangler dev server for `dist/ui` on :8787, then `npm run cup-dev`.
//  - on `main` (deployed), a detached HEAD, or outside a git clone → PROD mode: `npm run cup`
//    (Chrome dials the hosted origin).
// Either way it reuses a live cup and waits for the BRIDGE to be ready (`GET /api/targets`,
// NOT just `/api/status`, which is up before the browser/CDP connects), then prints the cup
// base URL. Exit 0 + URL when drivable; 1 + reason otherwise. Override: SLICC_CUP_MODE=dev|prod.
// Set SLICC_REPO_DIR to the repo root.
// tva
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  baseUrlForPort,
  cupLaunchMode,
  ensureCupReady,
  isDirectRun,
  probeCupBridgeReady,
  probeHttpUp,
  readCupRecord,
  resolvePort,
  sliccDir,
  waitUntil,
} from './_lib.mjs';

const WRANGLER_URL = process.env.SLICC_WRANGLER_URL || 'http://localhost:8787';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repoDir = () => process.env.SLICC_REPO_DIR || process.cwd();

function gitBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveMode() {
  const forced = process.env.SLICC_CUP_MODE;
  if (forced === 'dev' || forced === 'prod') return forced;
  return cupLaunchMode(gitBranch(repoDir()));
}

function detachedStdio(logName) {
  try {
    mkdirSync(sliccDir(), { recursive: true });
    const fd = openSync(join(sliccDir(), logName), 'a');
    return ['ignore', fd, fd];
  } catch {
    return 'ignore';
  }
}

function spawnDetached(cmd, args, logName) {
  const child = spawn(cmd, args, { cwd: repoDir(), detached: true, stdio: detachedStdio(logName) });
  child.on('error', (err) => process.stderr.write(`spawn failed (${cmd}): ${err.message}\n`));
  child.unref();
}

/** DEV only: reuse a live wrangler on :8787, else start one serving dist/ui and wait for it. */
async function ensureWrangler() {
  if (await probeHttpUp(WRANGLER_URL)) return true;
  if (!existsSync(join(repoDir(), 'dist/ui/index.html'))) {
    process.stderr.write('dist/ui not built — run `npm run build -w @slicc/webapp` first.\n');
    return false;
  }
  spawnDetached(
    'npx',
    [
      'wrangler',
      'dev',
      '--config',
      'packages/cloudflare-worker/wrangler.jsonc',
      '--port',
      '8787',
      '--ip',
      '127.0.0.1',
    ],
    'wrangler.log'
  );
  if (!(await waitUntil(() => probeHttpUp(WRANGLER_URL), { sleep, attempts: 60 }))) {
    process.stderr.write('wrangler did not come up on :8787 (see ~/.slicc/wrangler.log).\n');
    return false;
  }
  return true;
}

async function main() {
  const resolveBase = () => baseUrlForPort(resolvePort(readCupRecord()));
  // Already drivable? (bridge ready ⇒ everything it needs is already up)
  if (await probeCupBridgeReady(resolveBase())) {
    process.stdout.write(`${resolveBase()}\n`);
    return;
  }
  const mode = resolveMode();
  process.stderr.write(`cup-up: ${mode} mode\n`);
  let launch;
  if (mode === 'dev') {
    if (!(await ensureWrangler())) process.exit(1);
    launch = () => spawnDetached('npm', ['run', 'cup-dev'], 'cup-launch.log');
  } else {
    launch = () => spawnDetached('npm', ['run', 'cup'], 'cup-launch.log');
  }
  try {
    const { base } = await ensureCupReady({
      resolveBase,
      probe: probeCupBridgeReady, // wait for the BRIDGE, not just /api/status
      launch,
      sleep,
      attempts: 90, // cup + Chrome boot + CDP attach can take a while
    });
    process.stdout.write(`${base}\n`);
  } catch (err) {
    process.stderr.write(`${err.message} (see ~/.slicc/cup-launch.log)\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();

#!/usr/bin/env node
// Lead a tray in ONE call (F18): fire `host lead` on the cup, then poll `host`
// until the tray's join URL is live, and print it. Collapses the fire-turn +
// poll-turn the brain otherwise spends into a single script call.
//
// Worker URL: pass one as the first arg for staging/self-hosted. With none, it
// auto-detects like cup-up — a feature-branch clone (dev) leads against the local
// wrangler (http://localhost:8787, since the unmerged build isn't on production),
// while `main`/detached/non-clone leads against the production hub (bare
// `host lead`). Override with SLICC_CUP_MODE=dev|prod.
//
// Reads CUP_BASE + SLICC_SESSION. Set SLICC_REPO_DIR to the repo root. Prints the
// join URL on stdout (exit 0); exits 1 if the URL never appears.
// tva
import {
  cupExec,
  cupLaunchMode,
  gitBranch,
  isDirectRun,
  leadAndPoll,
  positionals,
  requireEnv,
} from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repoDir = () => process.env.SLICC_REPO_DIR || process.cwd();
const WRANGLER_URL = process.env.SLICC_WRANGLER_URL || 'http://localhost:8787';

function resolveMode() {
  const forced = process.env.SLICC_CUP_MODE;
  if (forced === 'dev' || forced === 'prod') return forced;
  return cupLaunchMode(gitBranch(repoDir()));
}

/** Worker arg for `host lead`: explicit > dev→local wrangler > prod→'' (hub). */
function resolveWorkerArg(explicit) {
  if (explicit) return explicit;
  return resolveMode() === 'dev' ? WRANGLER_URL : '';
}

async function main() {
  let base;
  let session;
  try {
    base = requireEnv('CUP_BASE');
    session = requireEnv('SLICC_SESSION');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const workerArg = resolveWorkerArg(positionals(process.argv.slice(2))[0]);
  process.stderr.write(
    `cup-lead: host lead${workerArg ? ` ${workerArg}` : ' (production hub)'} — waiting for join URL…\n`
  );
  try {
    const url = await leadAndPoll({
      exec: (command) => cupExec(base, session, command),
      sleep,
      workerArg,
    });
    if (!url) {
      process.stderr.write(
        'cup-lead: no join URL appeared — is the cup leading? Try `host` manually.\n'
      );
      process.exit(1);
    }
    process.stdout.write(`${url}\n`);
  } catch (err) {
    process.stderr.write(`cup-lead error: ${err.message}\n`);
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();

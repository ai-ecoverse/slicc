#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, input, isMain, setOutput } from './gh-io.mjs';
import { planPinnedCommitBuild } from './lib.mjs';

export const NPM_CI_MINUTES = 12;
export const NPM_CI_ATTEMPTS = 2;
export const BUILD_MINUTES = 8;

export function bounded(cmd, minutes) {
  return ['timeout', '--kill-after=30s', `${minutes}m`, ...cmd];
}

export function materializePinnedCommit(options) {
  const plan = planPinnedCommitBuild({ ref: options.ref, dest: options.dest });
  if (!plan) return null;
  const exec = options.exec ?? execFileSync;
  const repo = options.repo ?? process.cwd();
  const env = options.env ?? process.env;
  exec(plan.fetch[0], plan.fetch.slice(1), { cwd: repo, stdio: 'inherit', env });
  exec(plan.worktree[0], plan.worktree.slice(1), { cwd: repo, stdio: 'inherit', env });
  const buildEnv = { ...env, HUSKY: '0' };
  const run = (cmd, minutes) => {
    const argv = bounded(cmd, minutes);
    exec(argv[0], argv.slice(1), { cwd: options.dest, stdio: 'inherit', env: buildEnv });
  };
  for (let attempt = 1; ; attempt++) {
    try {
      run(plan.npmCi, NPM_CI_MINUTES);
      break;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (attempt >= NPM_CI_ATTEMPTS) {
        throw new Error(`pin-webapp: npm ci failed ${attempt} times; last: ${why}`);
      }
      console.log(`[pin-webapp] npm ci attempt ${attempt} failed (${why}); retrying`);
    }
  }
  for (const cmd of [plan.buildWebapp, plan.buildServer]) run(cmd, BUILD_MINUTES);
  const index = join(plan.webapp, 'index.html');
  if (!existsSync(plan.nodeServer) || !existsSync(index)) {
    throw new Error(
      `pin-webapp: ${plan.ref} did not produce ${plan.nodeServer} and ${index}. ` +
        'The local node harness builds both from the same checkout.'
    );
  }
  return { nodeServer: plan.nodeServer, webapp: plan.webapp, ref: plan.ref };
}

export function main(options = {}) {
  const ref = options.ref ?? input('pin-webapp');
  const dest = options.dest ?? process.env.PIN_DEST;
  if (!dest) throw new Error('PIN_DEST is required');
  const built = materializePinnedCommit({
    ref,
    dest,
    repo: options.repo,
    exec: options.exec,
    env: options.env,
  });
  if (!built) {
    console.log('[pin-webapp] not a git ref; leaving node-server to the npm pin');
    return null;
  }
  setOutput('node-server', built.nodeServer);
  console.log(`[pin-webapp] ${built.ref} -> ${built.nodeServer}`);
  return built;
}

/* v8 ignore start */
if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
/* v8 ignore stop */

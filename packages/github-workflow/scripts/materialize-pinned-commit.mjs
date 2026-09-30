#!/usr/bin/env node
/**
 * Build one git ref into the layout the local node harness already runs.
 *
 * `dev-standalone-fresh.sh` starts `node dist/node-server/index.js` against
 * that same tree's `dist/ui`, and points the tray at a remote worker. A
 * benchmark pin does the same for an explicit commit: fetch it into a
 * detached worktree (the job's own checkout keeps this workflow's scripts),
 * `npm ci`, then build the webapp and node-server. Flags stay on the
 * production worker because `serve-webapp.mjs` proxies them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, input, isMain, setOutput } from './gh-io.mjs';
import { planPinnedCommitBuild } from './lib.mjs';

/**
 * `npm ci` normally takes a few minutes here, but it sometimes never exits after patch-package
 * has applied every patch, holding the shard for its whole job limit (Benchmark runs
 * 36627096386 and 36663826241). Kill it after this long and start over; `npm ci` removes
 * `node_modules` first, so each attempt is clean.
 */
export const NPM_CI_TIMEOUT_MS = 15 * 60_000;
export const NPM_CI_ATTEMPTS = 3;
/** The webapp and node-server builds get one bounded attempt each. */
export const BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * @param {{
 *   ref: string;
 *   dest: string;
 *   repo?: string;
 *   exec?: typeof execFileSync;
 *   env?: NodeJS.ProcessEnv;
 * }} options
 * @returns {null | { nodeServer: string; webapp: string; ref: string }}
 */
export function materializePinnedCommit(options) {
  const plan = planPinnedCommitBuild({ ref: options.ref, dest: options.dest });
  if (!plan) return null;
  const exec = options.exec ?? execFileSync;
  const repo = options.repo ?? process.cwd();
  const env = options.env ?? process.env;
  exec(plan.fetch[0], plan.fetch.slice(1), { cwd: repo, stdio: 'inherit', env });
  exec(plan.worktree[0], plan.worktree.slice(1), { cwd: repo, stdio: 'inherit', env });
  const buildEnv = { ...env, HUSKY: '0' };
  const run = (cmd, timeout) =>
    exec(cmd[0], cmd.slice(1), {
      cwd: options.dest,
      stdio: 'inherit',
      env: buildEnv,
      timeout,
      killSignal: 'SIGKILL',
    });
  for (let attempt = 1; ; attempt++) {
    try {
      run(plan.npmCi, NPM_CI_TIMEOUT_MS);
      break;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (attempt >= NPM_CI_ATTEMPTS) {
        throw new Error(`pin-webapp: npm ci failed ${attempt} times; last: ${why}`);
      }
      console.log(`[pin-webapp] npm ci attempt ${attempt} failed (${why}); retrying`);
    }
  }
  for (const cmd of [plan.buildWebapp, plan.buildServer]) run(cmd, BUILD_TIMEOUT_MS);
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

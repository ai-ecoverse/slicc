#!/usr/bin/env node
/**
 * Run semantic-release, deferring when the version-commit push loses the race.
 *
 * `@semantic-release/git` pushes `HEAD:main` only after prepare (build, native
 * packaging, TestFlight), which can take most of the job. A merge that lands
 * in that window rejects the push with "fetch first". Rebasing the release
 * commit onto the new tip would tag commits the analyzer never saw, so this
 * wrapper exits 0 instead. The push that moved `main` already started a new
 * Release run; the half-hourly schedule catches a tip that did not (for
 * example a `[skip ci]` commit). A green deferral does not open the
 * red-release tracking issue.
 *
 * Env and extra CLI args are forwarded to `npx --no-install semantic-release`.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFER_MESSAGE =
  '[release-publish] main moved during prepare; the version-commit push was rejected. ' +
  'Deferring — the push that moved main, or the schedule catch-up, publishes from the new tip.';

/**
 * True only for the semantic-release git plugin's non-fast-forward push.
 * A bare "fetch first" elsewhere in the log (or a protected-branch rejection)
 * must still fail the job.
 *
 * @param {string} output Combined stdout and stderr.
 */
export function isStaleReleasePush(output) {
  const text = String(output ?? '');
  const gitPluginFailed =
    text.includes('Failed step "prepare" of plugin "@semantic-release/git"') ||
    /Command failed with exit code 1: git push --tags\b/.test(text);
  const rejected =
    text.includes('(fetch first)') ||
    text.includes('(non-fast-forward)') ||
    text.includes('Updates were rejected because the remote contains work that you do');
  return gitPluginFailed && rejected;
}

/**
 * @param {number | null} code
 * @param {string} output
 * @returns {{ code: number, deferred: boolean }}
 */
export function classifyReleaseExit(code, output) {
  if (code === 0) return { code: 0, deferred: false };
  if (code === 1 && isStaleReleasePush(output)) return { code: 0, deferred: true };
  return { code: code ?? 1, deferred: false };
}

/**
 * @param {object} options
 * @param {typeof spawn} [options.spawn]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 */
export async function publishRelease({
  spawn: spawnFn = spawn,
  command = 'npx',
  args = ['--no-install', 'semantic-release'],
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const child = spawnFn(command, args, {
    cwd,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const chunks = [];
  const forward = (stream, dest) => {
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      dest.write(chunk);
    });
  };
  if (child.stdout) forward(child.stdout, stdout);
  if (child.stderr) forward(child.stderr, stderr);

  const onSignal = (signal) => {
    child.kill(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  let finished;
  try {
    finished = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const output = Buffer.concat(chunks).toString('utf8');
  if (finished.signal) {
    return { code: null, signal: finished.signal, deferred: false, output };
  }
  return { ...classifyReleaseExit(finished.code, output), signal: null, output };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const result = await publishRelease({
    ...options,
    args: ['--no-install', 'semantic-release', ...argv],
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return result;
  }
  if (result.deferred) {
    console.error(DEFER_MESSAGE);
  }
  process.exitCode = result.code;
  return result;
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();

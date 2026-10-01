#!/usr/bin/env node
/**
 * `npm publish` with retries for transient network and sigstore failures.
 *
 * The release used to publish `sliccy` through `@semantic-release/npm`, which
 * runs `npm publish` exactly once. Provenance signing asks Fulcio for a
 * signing certificate, and Rekor for a transparency-log entry, before the
 * tarball reaches the registry. A DNS blip on the macOS runner
 * (`getaddrinfo ENOTFOUND fulcio.sigstore.dev`, run 36819333681, #3719)
 * outlasted sigstore's own short retry and failed the job. By then
 * `@semantic-release/git` had already pushed the version commit and tag, so a
 * re-run found nothing to release and v6.231.1 never shipped to npm, the
 * worker, or GitHub Releases.
 *
 * This wrapper runs from the `@semantic-release/exec` `publishCmd` instead and
 * retries with backoff (about eight minutes in total) when the failure is
 * transient: DNS/socket errors, sigstore CA/TLog/TSA errors, or registry
 * 408/429/5xx. Auth, permission, and validation errors fail on the first
 * attempt. After any failure it asks the registry whether `name@version` is
 * already there; if so, the publish counts as done (a lost response, or a
 * re-run after a partial publish).
 *
 * The npm CLI handles trusted publishing itself: in GitHub Actions it
 * exchanges the job's OIDC token for a publish token and turns on provenance.
 * `--verify` checks that the job can mint that token, so a missing
 * `id-token: write` permission fails in verifyConditions, before the version
 * tag is pushed.
 *
 * Usage:
 *   node packages/dev-tools/tools/npm-publish-retry.mjs <dir> [npm publish args...]
 *   node packages/dev-tools/tools/npm-publish-retry.mjs --verify
 */

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Wait before retry N (1-based); the last entry bounds the attempt count. */
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

const TRANSIENT_PATTERNS = [
  // Sigstore signing: Fulcio certificate, Rekor log entry, timestamp authority.
  /npm error code (CA|TLOG|TSA)_[A-Z_]+_ERROR\b/,
  /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/,
  /socket hang up/i,
  /npm error code E(408|429|5\d\d)\b/,
];

/**
 * True when a failed `npm publish` is worth retrying.
 *
 * @param {string} output Combined stdout and stderr.
 */
export function isTransientPublishFailure(output) {
  const text = String(output ?? '');
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {string[]} args `npm publish` arguments; the first positional one is
 *   the package directory (default: cwd).
 * @param {string} cwd
 */
export function packageDir(args, cwd) {
  const dir = args.find((arg) => !arg.startsWith('-'));
  return resolve(cwd, dir ?? '.');
}

/**
 * Run a command, forward its output, and resolve with exit code and output.
 *
 * @param {typeof spawn} spawnFn
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} options
 * @returns {Promise<{ code: number | null, output: string }>}
 */
export function run(spawnFn, command, args, { cwd, env, stdout, stderr }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const forward = (stream, dest) => {
      stream?.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
        dest?.write(chunk);
      });
    };
    forward(child.stdout, stdout);
    forward(child.stderr, stderr);
    child.on('error', reject);
    child.on('close', (code) =>
      resolvePromise({ code, output: Buffer.concat(chunks).toString('utf8') })
    );
  });
}

/**
 * Ask the registry whether `name@version` exists. Network trouble reads as
 * "not published" so the caller keeps retrying.
 */
async function isPublished({ spawnFn, name, version, cwd, env }) {
  const result = await run(spawnFn, 'npm', ['view', `${name}@${version}`, 'version'], {
    cwd,
    env,
  }).catch(() => ({ code: 1, output: '' }));
  return result.code === 0 && result.output.trim() === version;
}

/**
 * @param {object} options
 * @param {string[]} options.args `npm publish` arguments.
 * @param {typeof spawn} [options.spawn]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number[]} [options.delays]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {(text: string) => void} [options.log]
 * @returns {Promise<{ code: number, attempts: number, alreadyPublished: boolean }>}
 */
export async function publishWithRetry({
  args,
  spawn: spawnFn = spawn,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  delays = RETRY_DELAYS_MS,
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  log = (text) => console.error(text),
}) {
  const pkg = JSON.parse(readFileSync(join(packageDir(args, cwd), 'package.json'), 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;

  for (let attempt = 1; ; attempt++) {
    const result = await run(spawnFn, 'npm', ['publish', ...args], { cwd, env, stdout, stderr });
    if (result.code === 0) return { code: 0, attempts: attempt, alreadyPublished: false };

    if (await isPublished({ spawnFn, name: pkg.name, version: pkg.version, cwd, env })) {
      log(`[npm-publish-retry] ${id} is on the registry despite the error; treating as published.`);
      return { code: 0, attempts: attempt, alreadyPublished: true };
    }

    const delay = delays[attempt - 1];
    if (!isTransientPublishFailure(result.output) || delay === undefined) {
      return { code: result.code || 1, attempts: attempt, alreadyPublished: false };
    }
    log(
      `[npm-publish-retry] ${id}: transient failure on attempt ${attempt}; retrying in ${delay / 1000}s.`
    );
    await sleep(delay);
  }
}

/**
 * Preflight for trusted publishing: in GitHub Actions the job must be able to
 * request an OIDC token. Returns an error message, or null when publishing
 * can authenticate.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function verifyPublishAuth(env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return null;
  return (
    '[npm-publish-retry] GitHub Actions cannot mint an OIDC token for npm trusted publishing. ' +
    'Grant the release job `permissions: id-token: write`.'
  );
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  if (argv[0] === '--verify') {
    const error = verifyPublishAuth(env);
    if (error) console.error(error);
    process.exitCode = error ? 1 : 0;
    return { code: process.exitCode };
  }
  const result = await publishWithRetry({ ...options, args: argv, env });
  process.exitCode = result.code;
  return result;
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();

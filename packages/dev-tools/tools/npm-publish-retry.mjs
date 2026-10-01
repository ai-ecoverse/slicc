#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

export const PUBLISH_TIMEOUT_MS = 5 * 60_000;

export const PROBE_TIMEOUT_MS = 60_000;

export const RETRY_BUDGET_MS = 20 * 60_000;
const KILL_GRACE_MS = 10_000;

const TRANSIENT_PATTERNS = [
  /npm error code (CA|TLOG|TSA)_[A-Z_]+_ERROR\b/,
  /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/,
  /socket hang up/i,
  /npm error code E(408|429|5\d\d)\b/,
];

const PUBLISH_CONFLICT_PATTERN =
  /npm error code EPUBLISHCONFLICT\b|cannot publish over the previously published version/i;

export function isTransientPublishFailure(output) {
  const text = String(output ?? '');
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isPublishConflict(output) {
  return PUBLISH_CONFLICT_PATTERN.test(String(output ?? ''));
}

export function packageDir(args, cwd) {
  const dir = args.find((arg) => !arg.startsWith('-'));
  return resolve(cwd, dir ?? '.');
}

export function run(spawnFn, command, args, { cwd, env, timeoutMs, stdout, stderr }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const outChunks = [];
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const forward = (stream, dest, own) => {
      stream?.on('data', (chunk) => {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        own?.push(buf);
        dest?.write(chunk);
      });
    };
    forward(child.stdout, stdout, outChunks);
    forward(child.stderr, stderr);
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('close', (code) => {
      settle();
      resolvePromise({
        code,
        output: Buffer.concat(chunks).toString('utf8'),
        stdoutText: Buffer.concat(outChunks).toString('utf8'),
        timedOut,
      });
    });
  });
}

export function matchesRegistry({ localIntegrity, dist, requireProvenance }) {
  if (!localIntegrity || dist?.integrity !== localIntegrity) return false;
  return !requireProvenance || Boolean(dist.attestations?.provenance);
}

async function probeJson(spawnFn, args, { cwd, env, timeoutMs }) {
  try {
    const result = await run(spawnFn, 'npm', args, { cwd, env, timeoutMs });
    if (result.code !== 0 || result.timedOut) return undefined;
    return JSON.parse(result.stdoutText);
  } catch {
    return undefined;
  }
}

async function isSameTarballPublished({ spawnFn, args, pkg, cwd, env, timeoutMs }) {
  const dist = await probeJson(spawnFn, ['view', `${pkg.name}@${pkg.version}`, 'dist', '--json'], {
    cwd,
    env,
    timeoutMs,
  });
  if (!dist?.integrity) return false;
  const packed = await probeJson(
    spawnFn,
    ['pack', packageDir(args, cwd), '--dry-run', '--json', '--ignore-scripts'],
    { cwd, env, timeoutMs }
  );
  return matchesRegistry({
    localIntegrity: Array.isArray(packed) ? packed[0]?.integrity : undefined,
    dist,
    requireProvenance: args.includes('--provenance'),
  });
}

export async function publishWithRetry({
  args,
  spawn: spawnFn = spawn,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  delays = RETRY_DELAYS_MS,
  publishTimeoutMs = PUBLISH_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  budgetMs = RETRY_BUDGET_MS,
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  log = (text) => console.error(text),
}) {
  const pkg = JSON.parse(readFileSync(join(packageDir(args, cwd), 'package.json'), 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;
  const startedAt = now();

  for (let attempt = 1; ; attempt++) {
    const result = await run(spawnFn, 'npm', ['publish', ...args], {
      cwd,
      env,
      timeoutMs: publishTimeoutMs,
      stdout,
      stderr,
    });
    if (result.code === 0 && !result.timedOut) {
      return { code: 0, attempts: attempt, alreadyPublished: false };
    }
    if (result.timedOut) {
      log(
        `[npm-publish-retry] ${id}: attempt ${attempt} hung past ${publishTimeoutMs / 1000}s; killed.`
      );
    }

    const transient = result.timedOut || isTransientPublishFailure(result.output);
    if (
      (transient || isPublishConflict(result.output)) &&
      (await isSameTarballPublished({ spawnFn, args, pkg, cwd, env, timeoutMs: probeTimeoutMs }))
    ) {
      log(
        `[npm-publish-retry] ${id}: the registry already holds this exact tarball; treating as published.`
      );
      return { code: 0, attempts: attempt, alreadyPublished: true };
    }

    const delay = delays[attempt - 1];
    const overBudget = delay !== undefined && now() - startedAt + delay > budgetMs;
    if (!transient || delay === undefined || overBudget) {
      return { code: result.code || 1, attempts: attempt, alreadyPublished: false };
    }
    log(
      `[npm-publish-retry] ${id}: transient failure on attempt ${attempt}; retrying in ${delay / 1000}s.`
    );
    await sleep(delay);
  }
}

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

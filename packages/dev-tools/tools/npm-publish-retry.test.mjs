import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPublishConflict,
  isTransientPublishFailure,
  main,
  matchesRegistry,
  packageDir,
  publishWithRetry,
  RETRY_DELAYS_MS,
  run,
  verifyPublishAuth,
} from './npm-publish-retry.mjs';
import { BIOME_JSH_PUBLISH_CMD } from './release-native.mjs';

// Verbatim tail of release run 36819333681 (#3719).
const FULCIO_DNS = `
npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access
npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR
npm error error creating signing certificate
npm error cause request to https://fulcio.sigstore.dev/api/v2/signingCert failed, reason: getaddrinfo ENOTFOUND fulcio.sigstore.dev
`;

const REKOR_DOWN = 'npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry';
const REGISTRY_503 =
  'npm error code E503\nnpm error 503 Service Unavailable - PUT https://registry.npmjs.org/sliccy';
const AUTH_404 =
  'npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/sliccy - Not found';
const PUBLISH_CONFLICT =
  'npm error code E403\nnpm error 403 You cannot publish over the previously published versions: 6.231.1.';

describe('isTransientPublishFailure', () => {
  it.each([
    ['the Fulcio DNS failure from #3719', FULCIO_DNS],
    ['a Rekor tlog failure', REKOR_DOWN],
    ['a registry 503', REGISTRY_503],
    ['a registry 429', 'npm error code E429'],
    ['a reset socket', 'npm error code ECONNRESET\nnpm error network aborted'],
    ['a temporary DNS failure', 'getaddrinfo EAI_AGAIN registry.npmjs.org'],
    ['a socket hang up', 'npm error network socket hang up'],
  ])('retries %s', (_label, output) => {
    expect(isTransientPublishFailure(output)).toBe(true);
  });

  it.each([
    ['a missing trusted publisher / auth 404', AUTH_404],
    ['a version conflict', PUBLISH_CONFLICT],
    ['missing auth', 'npm error code ENEEDAUTH'],
    ['a provenance mismatch', 'npm error code E422\nnpm error 422 Unprocessable Entity'],
    ['empty output', ''],
  ])('does not retry %s', (_label, output) => {
    expect(isTransientPublishFailure(output)).toBe(false);
  });
});

describe('packageDir', () => {
  it('uses the first positional argument', () => {
    expect(packageDir(['--provenance', 'pkg/a', '--tag', 'latest'], '/repo')).toBe('/repo/pkg/a');
  });

  it('defaults to cwd', () => {
    expect(packageDir(['--provenance'], '/repo')).toBe('/repo');
  });
});

function fakeChild(code, { stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

/** A child that only exits once killed, like a wedged `npm publish`. */
function hungChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal) => queueMicrotask(() => child.emit('close', null, signal)));
  return child;
}

const INTEGRITY = 'sha512-local';
const PROVENANCE = { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };

/**
 * Scripted npm: `publish` pops the next entry from `publishes` ('hang' or
 * [code, stderr]); `view` answers with `dist` (null = E404); `pack` reports
 * `localIntegrity`; `probe: 'hang'` wedges both probes.
 */
function scriptedNpm(publishes, { dist = null, localIntegrity = INTEGRITY, probe } = {}) {
  const calls = [];
  const spawn = vi.fn((_cmd, args) => {
    calls.push(args);
    if (args[0] === 'view' || args[0] === 'pack') {
      if (probe === 'hang') return hungChild();
      if (args[0] === 'view') {
        return dist
          ? fakeChild(0, { stdout: JSON.stringify(dist) })
          : fakeChild(1, { stderr: 'npm error code E404' });
      }
      return fakeChild(0, { stdout: JSON.stringify([{ integrity: localIntegrity }]) });
    }
    const next = publishes.shift();
    if (next === 'hang') return hungChild();
    return fakeChild(next[0], { stderr: next[1] });
  });
  return { spawn, calls };
}

describe('isPublishConflict', () => {
  it('matches npm refusing to overwrite a version', () => {
    expect(isPublishConflict(PUBLISH_CONFLICT)).toBe(true);
    expect(isPublishConflict('npm error code EPUBLISHCONFLICT')).toBe(true);
  });

  it('does not match other 403s', () => {
    expect(isPublishConflict('npm error code E403\nnpm error 403 Forbidden')).toBe(false);
  });
});

describe('matchesRegistry', () => {
  it('accepts the same tarball with provenance', () => {
    expect(
      matchesRegistry({
        localIntegrity: INTEGRITY,
        dist: { integrity: INTEGRITY, attestations: PROVENANCE },
        requireProvenance: true,
      })
    ).toBe(true);
  });

  it('rejects different bytes', () => {
    expect(
      matchesRegistry({
        localIntegrity: INTEGRITY,
        dist: { integrity: 'sha512-other', attestations: PROVENANCE },
        requireProvenance: true,
      })
    ).toBe(false);
  });

  it('rejects missing provenance only when it is required', () => {
    const input = { localIntegrity: INTEGRITY, dist: { integrity: INTEGRITY } };
    expect(matchesRegistry({ ...input, requireProvenance: true })).toBe(false);
    expect(matchesRegistry({ ...input, requireProvenance: false })).toBe(true);
  });

  it('rejects an unknown local integrity', () => {
    expect(matchesRegistry({ localIntegrity: undefined, dist: {}, requireProvenance: false })).toBe(
      false
    );
  });
});

describe('run', () => {
  it('kills a child that outlives the timeout and reports timedOut', async () => {
    const child = hungChild();
    const result = await run(() => child, 'npm', ['publish'], {
      cwd: '.',
      env: {},
      timeoutMs: 5,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ code: null, timedOut: true });
  });

  it('keeps stdout separate for JSON probes', async () => {
    const result = await run(
      () => fakeChild(0, { stdout: '{"a":1}', stderr: 'npm warn x' }),
      'npm',
      [],
      { cwd: '.', env: {}, timeoutMs: 1000 }
    );
    expect(result).toMatchObject({ code: 0, stdoutText: '{"a":1}', timedOut: false });
    expect(result.output).toContain('npm warn x');
  });
});

describe('publishWithRetry', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npm-publish-retry-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'sliccy', version: '6.231.1' })
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    cwd: dir,
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
    log: () => {},
    sleep: vi.fn(async () => {}),
    publishTimeoutMs: 5,
    probeTimeoutMs: 5,
  });

  it('publishes on the first try without sleeping', async () => {
    const { spawn, calls } = scriptedNpm([[0, '']]);
    const opts = base();
    const result = await publishWithRetry({
      ...opts,
      args: ['.', '--provenance', '--tag', 'latest'],
      spawn,
    });
    expect(result).toEqual({ code: 0, attempts: 1, alreadyPublished: false });
    expect(calls).toEqual([['publish', '.', '--provenance', '--tag', 'latest']]);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('rides out the #3719 Fulcio DNS failure with backoff', async () => {
    const { spawn, calls } = scriptedNpm([
      [1, FULCIO_DNS],
      [1, FULCIO_DNS],
      [0, ''],
    ]);
    const opts = base();
    const result = await publishWithRetry({ ...opts, args: ['.'], spawn });
    expect(result).toEqual({ code: 0, attempts: 3, alreadyPublished: false });
    expect(opts.sleep.mock.calls.map(([ms]) => ms)).toEqual(RETRY_DELAYS_MS.slice(0, 2));
    expect(calls.filter(([verb]) => verb === 'publish')).toHaveLength(3);
  });

  it('kills a hung publish and retries it', async () => {
    const { spawn } = scriptedNpm(['hang', [0, '']]);
    const log = vi.fn();
    const result = await publishWithRetry({ ...base(), log, args: ['.'], spawn });
    expect(result).toEqual({ code: 0, attempts: 2, alreadyPublished: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hung past'));
  });

  it('treats hung registry probes as not published and keeps retrying', async () => {
    const { spawn } = scriptedNpm(
      [
        [1, FULCIO_DNS],
        [0, ''],
      ],
      { probe: 'hang' }
    );
    const result = await publishWithRetry({ ...base(), args: ['.'], spawn });
    expect(result).toEqual({ code: 0, attempts: 2, alreadyPublished: false });
  });

  it('gives up after the last delay and returns the npm exit code', async () => {
    const { spawn } = scriptedNpm([
      [1, REGISTRY_503],
      [1, REGISTRY_503],
      [1, REGISTRY_503],
    ]);
    const opts = base();
    const result = await publishWithRetry({ ...opts, args: ['.'], spawn, delays: [1, 2] });
    expect(result).toEqual({ code: 1, attempts: 3, alreadyPublished: false });
    expect(opts.sleep).toHaveBeenCalledTimes(2);
  });

  it('stops retrying once the next attempt would exceed the budget', async () => {
    const { spawn } = scriptedNpm([
      [1, REGISTRY_503],
      [1, REGISTRY_503],
    ]);
    let clock = 0;
    const opts = base();
    opts.sleep = vi.fn(async (ms) => {
      clock += ms;
    });
    const result = await publishWithRetry({
      ...opts,
      args: ['.'],
      spawn,
      now: () => clock,
      delays: [10, 10, 10],
      budgetMs: 15,
    });
    expect(result).toEqual({ code: 1, attempts: 2, alreadyPublished: false });
    expect(opts.sleep).toHaveBeenCalledTimes(1);
  });

  it('fails a non-transient error on the first attempt without asking the registry', async () => {
    const dist = { integrity: INTEGRITY, attestations: PROVENANCE };
    const { spawn, calls } = scriptedNpm([[1, AUTH_404]], { dist });
    const opts = base();
    const result = await publishWithRetry({ ...opts, args: ['.', '--provenance'], spawn });
    expect(result).toEqual({ code: 1, attempts: 1, alreadyPublished: false });
    expect(calls.map(([verb]) => verb)).toEqual(['publish']);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('accepts a conflict when the registry holds the same tarball with provenance', async () => {
    const dist = { integrity: INTEGRITY, attestations: PROVENANCE };
    const { spawn, calls } = scriptedNpm([[1, PUBLISH_CONFLICT]], { dist });
    const log = vi.fn();
    const result = await publishWithRetry({ ...base(), log, args: ['.', '--provenance'], spawn });
    expect(result).toEqual({ code: 0, attempts: 1, alreadyPublished: true });
    expect(calls[1]).toEqual(['view', 'sliccy@6.231.1', 'dist', '--json']);
    expect(calls[2]).toEqual(['pack', dir, '--dry-run', '--json', '--ignore-scripts']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('exact tarball'));
  });

  it('keeps the conflict failure when the registry bytes differ', async () => {
    const dist = { integrity: 'sha512-other', attestations: PROVENANCE };
    const { spawn } = scriptedNpm([[1, PUBLISH_CONFLICT]], { dist });
    const result = await publishWithRetry({ ...base(), args: ['.', '--provenance'], spawn });
    expect(result).toEqual({ code: 1, attempts: 1, alreadyPublished: false });
  });

  it('keeps the conflict failure when provenance is missing', async () => {
    const { spawn } = scriptedNpm([[1, PUBLISH_CONFLICT]], { dist: { integrity: INTEGRITY } });
    const result = await publishWithRetry({ ...base(), args: ['.', '--provenance'], spawn });
    expect(result).toEqual({ code: 1, attempts: 1, alreadyPublished: false });
  });

  it('accepts a transient failure whose publish actually landed', async () => {
    const dist = { integrity: INTEGRITY, attestations: PROVENANCE };
    const { spawn } = scriptedNpm([[1, REGISTRY_503]], { dist });
    const result = await publishWithRetry({ ...base(), args: ['.', '--provenance'], spawn });
    expect(result).toEqual({ code: 0, attempts: 1, alreadyPublished: true });
  });

  it('reads name and version from the positional package directory', async () => {
    const nested = mkdtempSync(join(dir, 'nested-'));
    writeFileSync(
      join(nested, 'package.json'),
      JSON.stringify({ name: '@ai-ecoverse/biome-jsh', version: '1.2.3' })
    );
    const { spawn, calls } = scriptedNpm([[1, PUBLISH_CONFLICT]], {
      dist: { integrity: INTEGRITY },
    });
    const result = await publishWithRetry({
      ...base(),
      args: [nested, '--access', 'public'],
      spawn,
    });
    expect(result.alreadyPublished).toBe(true);
    expect(calls[1]).toEqual(['view', '@ai-ecoverse/biome-jsh@1.2.3', 'dist', '--json']);
  });
});

describe('verifyPublishAuth', () => {
  it('passes outside GitHub Actions', () => {
    expect(verifyPublishAuth({})).toBeNull();
  });

  it('passes when the job can request an OIDC token', () => {
    expect(
      verifyPublishAuth({
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
      })
    ).toBeNull();
  });

  it('fails when id-token: write is missing', () => {
    expect(verifyPublishAuth({ GITHUB_ACTIONS: 'true' })).toMatch(/id-token: write/);
  });
});

describe('main --verify', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('sets a failing exit code without OIDC in Actions', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await main(['--verify'], { env: { GITHUB_ACTIONS: 'true' } });
    expect(result.code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('id-token: write'));
    error.mockRestore();
  });

  it('passes locally', async () => {
    expect((await main(['--verify'], { env: {} })).code).toBe(0);
  });
});

describe('release config wiring', () => {
  const releaserc = JSON.parse(
    readFileSync(new URL('../../../.releaserc.json', import.meta.url), 'utf8')
  );
  const plugin = (name) =>
    releaserc.plugins.find((entry) => Array.isArray(entry) && entry[0] === name)?.[1];

  it('keeps @semantic-release/npm for the version bump only', () => {
    expect(plugin('@semantic-release/npm')).toMatchObject({ npmPublish: false });
  });

  it('publishes sliccy through the retry wrapper before anything else ships', () => {
    const exec = plugin('@semantic-release/exec');
    expect(exec.verifyConditionsCmd).toBe(
      'node packages/dev-tools/tools/npm-publish-retry.mjs --verify'
    );
    expect(
      exec.publishCmd.startsWith('node packages/dev-tools/tools/npm-publish-retry.mjs . ')
    ).toBe(true);
    expect(exec.publishCmd).toMatch(/npm-publish-retry\.mjs \. --provenance --tag latest &&/);
  });

  it('publishes biome-jsh through the retry wrapper', () => {
    expect(BIOME_JSH_PUBLISH_CMD).toMatch(
      /^node packages\/dev-tools\/tools\/npm-publish-retry\.mjs packages\/dev-tools\/biome-jsh /
    );
  });
});

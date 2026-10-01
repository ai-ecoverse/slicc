import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTransientPublishFailure,
  main,
  packageDir,
  publishWithRetry,
  RETRY_DELAYS_MS,
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

function fakeChild(code, output = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (output) child.stderr.emit('data', Buffer.from(output));
    child.emit('close', code);
  });
  return child;
}

/**
 * Scripted npm: `publish` pops the next result from `publishes`, `view`
 * answers with `viewVersion` (null = E404).
 */
function scriptedNpm(publishes, viewVersion = null) {
  const calls = [];
  const spawn = vi.fn((_cmd, args) => {
    calls.push(args);
    if (args[0] === 'view') {
      return viewVersion ? fakeChild(0, `${viewVersion}\n`) : fakeChild(1, 'npm error code E404');
    }
    const [code, output] = publishes.shift();
    return fakeChild(code, output);
  });
  return { spawn, calls };
}

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
  });

  it('publishes on the first try without sleeping', async () => {
    const { spawn, calls } = scriptedNpm([[0, '+ sliccy@6.231.1']]);
    const sleep = vi.fn(async () => {});
    const result = await publishWithRetry({
      ...base(),
      args: ['.', '--provenance', '--tag', 'latest'],
      spawn,
      sleep,
    });
    expect(result).toEqual({ code: 0, attempts: 1, alreadyPublished: false });
    expect(calls).toEqual([['publish', '.', '--provenance', '--tag', 'latest']]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rides out the #3719 Fulcio DNS failure with backoff', async () => {
    const { spawn, calls } = scriptedNpm([
      [1, FULCIO_DNS],
      [1, FULCIO_DNS],
      [0, '+ sliccy@6.231.1'],
    ]);
    const sleep = vi.fn(async () => {});
    const result = await publishWithRetry({ ...base(), args: ['.'], spawn, sleep });
    expect(result).toEqual({ code: 0, attempts: 3, alreadyPublished: false });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(RETRY_DELAYS_MS.slice(0, 2));
    expect(calls.filter(([verb]) => verb === 'publish')).toHaveLength(3);
  });

  it('gives up after the last delay and returns the npm exit code', async () => {
    const { spawn } = scriptedNpm([
      [1, REGISTRY_503],
      [1, REGISTRY_503],
      [1, REGISTRY_503],
    ]);
    const sleep = vi.fn(async () => {});
    const result = await publishWithRetry({
      ...base(),
      args: ['.'],
      spawn,
      sleep,
      delays: [1, 2],
    });
    expect(result).toEqual({ code: 1, attempts: 3, alreadyPublished: false });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails a non-transient error on the first attempt', async () => {
    const { spawn } = scriptedNpm([[1, AUTH_404]]);
    const sleep = vi.fn(async () => {});
    const result = await publishWithRetry({ ...base(), args: ['.'], spawn, sleep });
    expect(result).toEqual({ code: 1, attempts: 1, alreadyPublished: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a version already on the registry as published', async () => {
    const { spawn, calls } = scriptedNpm([[1, PUBLISH_CONFLICT]], '6.231.1');
    const log = vi.fn();
    const result = await publishWithRetry({ ...base(), log, args: ['.'], spawn });
    expect(result).toEqual({ code: 0, attempts: 1, alreadyPublished: true });
    expect(calls[1]).toEqual(['view', 'sliccy@6.231.1', 'version']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sliccy@6.231.1 is on the registry'));
  });

  it('reads name and version from the positional package directory', async () => {
    const { spawn, calls } = scriptedNpm([[1, PUBLISH_CONFLICT]], '1.2.3');
    const nested = mkdtempSync(join(dir, 'nested-'));
    writeFileSync(
      join(nested, 'package.json'),
      JSON.stringify({ name: '@ai-ecoverse/biome-jsh', version: '1.2.3' })
    );
    const result = await publishWithRetry({
      ...base(),
      args: [nested, '--access', 'public'],
      spawn,
    });
    expect(result.alreadyPublished).toBe(true);
    expect(calls[1]).toEqual(['view', '@ai-ecoverse/biome-jsh@1.2.3', 'version']);
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

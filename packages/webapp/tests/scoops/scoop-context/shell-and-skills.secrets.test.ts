/**
 * #2276 slice C, secrets domain: `initShellAndSkills` gets masked secrets
 * from the injected `CapabilityBroker`, not `core/secret-env.ts`'s
 * topology-branching `fetchSecretEnvVars()`. `core/secret-env.js` is left
 * UNMOCKED here so the real `buildEnvFromMaskedEntries` (POSIX-name filter +
 * GitHub-token alias) runs, proving the migration reused it rather than
 * reimplementing it.
 *
 * Also covers round-1 review finding 1: a broker that throws, returns
 * `ok: false`, or returns a non-array `entries` must all degrade to `{}`
 * rather than escaping `initShellAndSkills` — this sits on the hot path
 * `ScoopContext.init()` awaits, so an unhandled rejection here would fail
 * the whole unit's init over an optional convenience.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { CapabilityBroker } from '../../../src/work-unit/capability/index.js';
import type { WorkUnitDescriptor } from '../../../src/work-unit/types.js';
import { createFakeCapabilityBroker } from '../../helpers/fake-capability-broker.js';

const captures = vi.hoisted(() => ({
  shellCtorOptions: [] as Array<{ env?: Record<string, string> }>,
}));

vi.mock('../../../src/shell/almost-bash-shell-headless.js', () => ({
  AlmostBashShellHeadless: vi.fn(function (
    this: unknown,
    options: { env?: Record<string, string> }
  ) {
    captures.shellCtorOptions.push(options);
    return this;
  }),
}));

vi.mock('../../../src/scoops/skills.js', () => ({
  createDefaultSkills: async () => {},
  loadSkills: async () => [],
  formatSkillsForPrompt: () => '',
}));

const { initShellAndSkills } = await import(
  '../../../src/scoops/scoop-context/shell-and-skills.js'
);

const unit = {
  policy: { filesystem: { kind: 'scoped' } },
  workspace: { root: '/workspace' },
} as unknown as WorkUnitDescriptor;

const scoop = { folder: 'test-scoop', jid: 'jid-1' } as unknown as RegisteredScoop;

async function initWith(broker: CapabilityBroker): Promise<Record<string, string> | undefined> {
  await initShellAndSkills({
    scoop,
    unit,
    fs: {} as never,
    skillsFs: null,
    getBrowserAPI: () => ({}) as never,
    sudoManager: null,
    capabilityBroker: broker,
    processManager: null,
    processOwner: { kind: 'cone' },
    getTurnPid: () => undefined,
    lickTarget: undefined,
    tmpDir: '/scoops/test-scoop/tmp',
  });
  expect(captures.shellCtorOptions).toHaveLength(1);
  return captures.shellCtorOptions[0]?.env;
}

describe('#2276 slice C — initShellAndSkills sources secrets from the broker', () => {
  beforeEach(() => {
    captures.shellCtorOptions.length = 0;
  });

  it('ok:true — filters + GitHub-aliases the broker entries into the shell env', async () => {
    const broker = createFakeCapabilityBroker({
      listMaskedEnv: {
        ok: true,
        value: {
          entries: [
            { name: 'OPENAI_KEY', maskedValue: 'sk-masked-1' },
            { name: 'oauth.github.token', maskedValue: 'ghp-masked-1' },
            { name: 's3.profile.access_key_id', maskedValue: 'masked-dotted' },
          ],
        },
      },
    });

    const env = (await initWith(broker)) ?? {};
    expect(env.OPENAI_KEY).toBe('sk-masked-1');
    // Dotted internal secret stays out of the shell env (not a POSIX name).
    expect(env['s3.profile.access_key_id']).toBeUndefined();
    // GitHub OAuth alias.
    expect(env.GITHUB_TOKEN).toBe('ghp-masked-1');
    expect(env.GH_TOKEN).toBe('ghp-masked-1');
  });

  it('ok:false — degrades to no secret env vars, same as the old fail-silent fetchSecretEnvVars', async () => {
    const broker = createFakeCapabilityBroker({
      listMaskedEnv: {
        ok: false,
        reason: 'failed',
        capability: 'secrets',
        operation: 'listMaskedEnv',
        message: 'unreachable',
        status: 503,
      },
    });

    const env = await initWith(broker);
    // buildScoopShellEnv only sets isolation pins for a non-cone scoop plus
    // TMPDIR; no secret-derived key should be present.
    expect(env?.OPENAI_KEY).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
  });

  it('entries is not an array — degrades to {} instead of throwing on the malformed reply', async () => {
    const broker = createFakeCapabilityBroker({
      // A broker that satisfies `ok: true` but returns a malformed payload —
      // exactly what a bug in an adapter's own `Array.isArray` guard would
      // let through (round-1 review finding 1).
      listMaskedEnv: { ok: true, value: { entries: 'not-an-array' as never } },
    });

    const env = await initWith(broker);
    expect(env?.OPENAI_KEY).toBeUndefined();
  });

  it('broker throws — degrades to {} instead of failing ScoopContext.init()', async () => {
    const broker = createFakeCapabilityBroker();
    broker.secrets.listMaskedEnv = () => Promise.reject(new Error('boom'));

    const env = await initWith(broker);
    expect(env?.OPENAI_KEY).toBeUndefined();
  });
});

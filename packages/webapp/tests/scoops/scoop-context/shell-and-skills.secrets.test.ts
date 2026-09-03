/**
 * #2276 slice C, secrets domain: `initShellAndSkills` gets masked secrets
 * from the injected `CapabilityBroker`, not `core/secret-env.ts`'s
 * topology-branching `fetchSecretEnvVars()`. `core/secret-env.js` is left
 * UNMOCKED here so the real `buildEnvFromMaskedEntries` (POSIX-name filter +
 * GitHub-token alias) runs, proving the migration reused it rather than
 * reimplementing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type {
  CapabilityBroker,
  CapabilityResult,
} from '../../../src/work-unit/capability/index.js';
import type { WorkUnitDescriptor } from '../../../src/work-unit/types.js';

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

function fakeBroker(
  secretsResult: CapabilityResult<{ entries: readonly unknown[] }>
): CapabilityBroker {
  return {
    secrets: {
      allowlist: ['listMaskedEnv'],
      supports: () => true,
      listMaskedEnv: async () => secretsResult as never,
      getMasked: async () => {
        throw new Error('not used by this test');
      },
      set: async () => {
        throw new Error('not used by this test');
      },
      delete: async () => {
        throw new Error('not used by this test');
      },
    },
    network: {
      allowlist: ['localNodeServer'],
      supports: () => true,
      localNodeServer: async () => ({ ok: true, value: { available: false } }) as never,
      crossOriginFetch: async () => {
        throw new Error('not used by this test');
      },
      websocket: async () => {
        throw new Error('not used by this test');
      },
    },
  } as unknown as CapabilityBroker;
}

const unit = {
  policy: { filesystem: { kind: 'scoped' } },
  workspace: { root: '/workspace' },
} as unknown as WorkUnitDescriptor;

const scoop = { folder: 'test-scoop', jid: 'jid-1' } as unknown as RegisteredScoop;

describe('#2276 slice C — initShellAndSkills sources secrets from the broker', () => {
  beforeEach(() => {
    captures.shellCtorOptions.length = 0;
  });

  it('ok:true — filters + GitHub-aliases the broker entries into the shell env', async () => {
    const broker = fakeBroker({
      ok: true,
      value: {
        entries: [
          { name: 'OPENAI_KEY', maskedValue: 'sk-masked-1' },
          { name: 'oauth.github.token', maskedValue: 'ghp-masked-1' },
          { name: 's3.profile.access_key_id', maskedValue: 'masked-dotted' },
        ],
      },
    });

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
    const env = captures.shellCtorOptions[0]?.env ?? {};
    expect(env.OPENAI_KEY).toBe('sk-masked-1');
    // Dotted internal secret stays out of the shell env (not a POSIX name).
    expect(env['s3.profile.access_key_id']).toBeUndefined();
    // GitHub OAuth alias.
    expect(env.GITHUB_TOKEN).toBe('ghp-masked-1');
    expect(env.GH_TOKEN).toBe('ghp-masked-1');
  });

  it('ok:false — degrades to no secret env vars, same as the old fail-silent fetchSecretEnvVars', async () => {
    const broker = fakeBroker({
      ok: false,
      failure: { capability: 'secrets', operation: 'listMaskedEnv', message: 'unreachable' },
    } as never);

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
    const env = captures.shellCtorOptions[0]?.env;
    // buildScoopShellEnv only sets isolation pins for a non-cone scoop plus
    // TMPDIR; no secret-derived key should be present.
    expect(env?.OPENAI_KEY).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
  });
});

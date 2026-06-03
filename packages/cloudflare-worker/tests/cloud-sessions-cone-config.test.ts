import { describe, expect, it } from 'vitest';
import { buildStartConeArgs, coneConfigToBundle } from '../src/cloud/cone-config-bridge.js';

describe('coneConfigToBundle (worker-side default + validation)', () => {
  it('uses the supplied bundle when present', () => {
    const bundle = coneConfigToBundle(
      {
        model: 'anthropic:claude-opus-4-6',
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
        secrets: [],
      },
      'bearer-x'
    );
    expect(bundle.model).toBe('anthropic:claude-opus-4-6');
  });
  it('synthesizes the Adobe default when no coneConfig is supplied', () => {
    const bundle = coneConfigToBundle(undefined, 'bearer-x');
    expect(bundle.model).toBe('adobe:claude-opus-4-6');
    expect(bundle.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'bearer-x' },
    ]);
  });
  it('rejects a bundle whose model provider has no account (narrow F6)', () => {
    expect(() =>
      coneConfigToBundle(
        {
          model: 'openai:gpt-x',
          accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
          secrets: [],
        },
        'bearer-x'
      )
    ).toThrow(/provider 'openai' has no account/);
  });
});

describe('buildStartConeArgs', () => {
  it('produces envContents (secrets.env) + coneConfigJson ({model,accounts})', () => {
    const args = buildStartConeArgs(
      {
        model: 'm',
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 't' }],
        secrets: [{ name: 'S', value: 'v', domains: ['x.com'] }],
      },
      'bearer'
    );
    expect(args.envContents).toContain('S=v');
    expect(JSON.parse(args.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });
});

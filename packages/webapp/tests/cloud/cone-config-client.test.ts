import { describe, expect, it } from 'vitest';
import {
  assembleBundle,
  assembleDelta,
  assembleResumeDelta,
  bundleDropWarnings,
  modelsForConnected,
  parseModelCatalog,
  providerLabel,
  validateModelHasAccount, // @ts-expect-error plain-JS cloud dashboard module (packages/webapp/cloud/) ships no types
} from '../../cloud/cone-config-client.js';

describe('assembleBundle', () => {
  it('builds {model, accounts, secrets} from selected localStorage accounts + secret rows', () => {
    const accounts = [
      { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      { providerId: 'adobe', apiKey: '', accessToken: 't', tokenExpiresAt: 5 },
    ];
    const bundle = assembleBundle({
      model: 'anthropic:claude-opus-4-6',
      selectedProviderIds: ['anthropic'],
      allAccounts: accounts,
      secretRows: [{ name: 'GITHUB_TOKEN', value: 'g', domains: 'github.com' }],
    });
    expect(bundle.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
    expect(bundle.secrets).toEqual([{ name: 'GITHUB_TOKEN', value: 'g', domains: ['github.com'] }]);
  });

  it('drops a flat secret with no domains (would be unusable by the fetch-proxy)', () => {
    const bundle = assembleBundle({
      model: 'm',
      selectedProviderIds: [],
      allAccounts: [],
      secretRows: [
        { name: 'NO_DOM', value: 'v', domains: '' },
        { name: 'OK', value: 'v', domains: 'x.com' },
      ],
    });
    expect(bundle.secrets).toEqual([{ name: 'OK', value: 'v', domains: ['x.com'] }]);
  });

  it('skips a selected account with no credential (cleared/logged-out token)', () => {
    const bundle = assembleBundle({
      model: 'm',
      selectedProviderIds: ['adobe', 'anthropic'],
      allAccounts: [
        { providerId: 'adobe', apiKey: '', accessToken: '' }, // logged out
        { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      ],
      secretRows: [],
    });
    expect(bundle.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
  });
});

describe('bundleDropWarnings (surface what assembleBundle silently drops)', () => {
  it('returns no warnings when every selected entry is usable', () => {
    expect(
      bundleDropWarnings({
        selectedProviderIds: ['anthropic'],
        allAccounts: [{ providerId: 'anthropic', apiKey: 'k', accessToken: '' }],
        secretRows: [{ name: 'OK', value: 'v', domains: 'x.com' }],
      })
    ).toEqual([]);
  });

  it('warns about a selected account with no credential', () => {
    const w = bundleDropWarnings({
      selectedProviderIds: ['adobe', 'anthropic'],
      allAccounts: [
        { providerId: 'adobe', apiKey: '', accessToken: '' },
        { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      ],
      secretRows: [],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('adobe');
    expect(w[0]).not.toContain('anthropic'); // the usable one isn't flagged
  });

  it('warns about a partially-filled secret row but ignores a fully-blank row', () => {
    const w = bundleDropWarnings({
      selectedProviderIds: [],
      allAccounts: [],
      secretRows: [
        { name: 'NO_DOM', value: 'v', domains: '' }, // incomplete → warn
        { name: '', value: '', domains: '' }, // blank placeholder → ignored
        { name: 'OK', value: 'v', domains: 'x.com' }, // usable → ignored
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('NO_DOM');
  });
});

describe('parseModelCatalog (safe localStorage read)', () => {
  it('returns [] for missing / invalid / non-array input', () => {
    expect(parseModelCatalog(null)).toEqual([]);
    expect(parseModelCatalog('')).toEqual([]);
    expect(parseModelCatalog('{not json')).toEqual([]);
    expect(parseModelCatalog('{"a":1}')).toEqual([]);
  });
  it('keeps well-formed groups and coerces missing names to ids', () => {
    const raw = JSON.stringify([
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [{ id: 'm1', name: 'Model 1' }],
      },
      { providerId: 'openai', models: [{ id: 'gpt-5' }] }, // no providerName / model name
      { models: [] }, // no providerId → dropped
    ]);
    expect(parseModelCatalog(raw)).toEqual([
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [{ id: 'm1', name: 'Model 1' }],
      },
      { providerId: 'openai', providerName: 'openai', models: [{ id: 'gpt-5', name: 'gpt-5' }] },
    ]);
  });
});

describe('providerLabel', () => {
  const catalog = [{ providerId: 'anthropic', providerName: 'Anthropic', models: [] }];
  it('uses the catalog name when known, else the id', () => {
    expect(providerLabel('anthropic', catalog)).toBe('Anthropic');
    expect(providerLabel('mystery', catalog)).toBe('mystery');
  });
});

describe('modelsForConnected', () => {
  const catalog = [
    {
      providerId: 'anthropic',
      providerName: 'Anthropic',
      models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
    },
  ];
  it('returns catalog groups for connected providers', () => {
    const groups = modelsForConnected(catalog, [{ providerId: 'anthropic', apiKey: 'k' }]);
    expect(groups).toEqual(catalog);
  });
  it('falls back to the built-in map for a connected provider absent from the catalog', () => {
    const groups = modelsForConnected([], [{ providerId: 'openai', apiKey: 'k' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].providerId).toBe('openai');
    expect(groups[0].models.length).toBeGreaterThan(0);
  });
  it('omits a connected provider with no catalog entry and no fallback, and dedupes', () => {
    const groups = modelsForConnected(catalog, [
      { providerId: 'anthropic', apiKey: 'k' },
      { providerId: 'anthropic', accessToken: 't' }, // duplicate provider
      { providerId: 'unknown-xyz', apiKey: 'k' }, // no catalog, no fallback
    ]);
    expect(groups).toEqual(catalog); // anthropic once, unknown omitted
  });
});

describe('validateModelHasAccount (F6 strict)', () => {
  it('passes when the model provider has a selected account', () => {
    expect(validateModelHasAccount('anthropic:x', ['anthropic'], [])).toBe(true);
  });
  it('fails when the model provider has no selected account', () => {
    expect(validateModelHasAccount('openai:x', ['anthropic'], [])).toBe(false);
  });
  it('passes for auth-optional providers', () => {
    expect(validateModelHasAccount('local:x', [], ['local'])).toBe(true);
  });
});

describe('assembleDelta', () => {
  it('produces upserts for new/changed and deletes for removed keys', () => {
    const delta = assembleDelta({
      model: 'openai:x',
      upsertAccounts: [{ providerId: 'openai', apiKey: 'k', accessToken: '' }],
      upsertSecretRows: [{ name: 'NEW', value: 'n', domains: 'x.com' }],
      deleteProviderIds: ['adobe'],
      deleteSecretNames: ['OLD'],
    });
    expect(delta).toEqual({
      model: 'openai:x',
      upsert: {
        accounts: [{ providerId: 'openai', kind: 'apikey', apiKey: 'k' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { providerIds: ['adobe'], secretNames: ['OLD'] },
    });
  });
  it('omits empty sections', () => {
    expect(
      assembleDelta({
        model: '',
        upsertAccounts: [],
        upsertSecretRows: [],
        deleteProviderIds: [],
        deleteSecretNames: [],
      })
    ).toEqual({});
  });
});

describe('assembleResumeDelta (plain resume re-ships connected accounts like start)', () => {
  // Bug: a plain resume sent only { sandboxId }, so the worker injected a bare
  // Adobe bearer with no tokenExpiresAt; the cone read "no expiry" as expired and
  // threw "Adobe session expired". Resume must ship the account the same shape as
  // start — including tokenExpiresAt — so the cone trusts the refreshed token.
  it('upserts the connected Adobe account carrying tokenExpiresAt', () => {
    const delta = assembleResumeDelta([
      { providerId: 'adobe', accessToken: 'ims-tok', tokenExpiresAt: 1234567890, apiKey: '' },
    ]);
    expect(delta.upsert.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'ims-tok', tokenExpiresAt: 1234567890 },
    ]);
    // Plain resume must not move the model or touch secrets/deletes.
    expect(delta.model).toBeUndefined();
    expect(delta.upsert.secrets).toBeUndefined();
    expect(delta.delete).toBeUndefined();
  });

  it('re-ships every connected account (oauth + apikey), not just Adobe', () => {
    const delta = assembleResumeDelta([
      { providerId: 'adobe', accessToken: 'ims', tokenExpiresAt: 9, apiKey: '' },
      { providerId: 'anthropic', accessToken: '', apiKey: 'sk-x' },
    ]);
    expect(delta.upsert.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'ims', tokenExpiresAt: 9 },
      { providerId: 'anthropic', kind: 'apikey', apiKey: 'sk-x' },
    ]);
  });

  it('returns an empty delta when no account has a credential', () => {
    expect(assembleResumeDelta([{ providerId: 'adobe', accessToken: '', apiKey: '' }])).toEqual({});
  });
});

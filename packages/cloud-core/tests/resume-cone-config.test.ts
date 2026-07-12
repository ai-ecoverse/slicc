import { describe, expect, it } from 'vitest';
import { applyConeConfigDelta } from '../src/operations/resume.js';

describe('applyConeConfigDelta (read-modify-write of both files)', () => {
  it('merges upserts/deletes, returns new file contents + names index', () => {
    const existingConeConfig = JSON.stringify({
      model: 'adobe:claude-opus-4-6',
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'old' }],
    });
    const existingSecretsEnv = 'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=github.com\n';
    const out = applyConeConfigDelta(existingConeConfig, existingSecretsEnv, {
      upsert: {
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'fresh' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { secretNames: ['GITHUB_TOKEN'] },
    });
    expect(JSON.parse(out.coneConfigJson).accounts[0].accessToken).toBe('fresh');
    expect(out.secretsEnv).toContain('NEW=n');
    expect(out.secretsEnv).not.toContain('GITHUB_TOKEN=gt');
    expect(out.index.secretNames).toEqual(['NEW']);
  });

  it('synthesizes from secrets.env when cone-config.json is missing (pre-feature cone)', () => {
    const out = applyConeConfigDelta(
      null,
      'ADOBE_IMS_TOKEN=abc\nADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy.example\n',
      { upsert: { accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'abc' }] } }
    );
    expect(JSON.parse(out.coneConfigJson).model).toBe('adobe:claude-opus-4-6');
    expect(JSON.parse(out.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });

  it('preserves OTHER flat secrets while refreshing the Adobe bearer (no data loss)', () => {
    const existingConeConfig = JSON.stringify({
      model: 'adobe:claude-opus-4-6',
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'old-bearer' }],
    });
    const existingSecretsEnv =
      'ADOBE_IMS_TOKEN=old-bearer\nADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy\n' +
      'GITHUB_TOKEN=user-pat\nGITHUB_TOKEN_DOMAINS=github.com\n';
    // Mirrors the worker's mergedDelta: refresh Adobe, no user edits.
    const out = applyConeConfigDelta(existingConeConfig, existingSecretsEnv, {
      upsert: {
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'fresh-bearer' }],
        secrets: [{ name: 'ADOBE_IMS_TOKEN', value: 'fresh-bearer', domains: ['adobe-llm-proxy'] }],
      },
    });
    expect(out.secretsEnv).toContain('ADOBE_IMS_TOKEN=fresh-bearer');
    expect(out.secretsEnv).toContain('GITHUB_TOKEN=user-pat'); // PRESERVED
    expect(out.index.secretNames).toContain('GITHUB_TOKEN');
  });

  it('preserves a secret value containing "=" (e.g. base64/JWT) round-trip', () => {
    const out = applyConeConfigDelta(
      JSON.stringify({ model: 'adobe:claude-opus-4-6', accounts: [] }),
      'JWT=aa.bb==.cc\nJWT_DOMAINS=api.example.com\n',
      {}
    );
    expect(out.secretsEnv).toContain('JWT=aa.bb==.cc');
  });

  it('trims domain CSV entries when restoring a pre-feature cone', () => {
    const out = applyConeConfigDelta(
      null,
      'TOKEN=value\nTOKEN_DOMAINS=api.example.com, *.example.com\n',
      {}
    );
    expect(out.secretsEnv).toContain('TOKEN_DOMAINS=api.example.com,*.example.com');
  });

  it('rejects a merged result with a newline-injecting delta secret', () => {
    expect(() =>
      applyConeConfigDelta(null, '', {
        upsert: { secrets: [{ name: 'X', value: 'a\nEVIL=1', domains: ['x.com'] }] },
      })
    ).toThrow(/single-line/);
  });

  it('surfaces a clear error for a corrupt cone-config.json', () => {
    expect(() => applyConeConfigDelta('{not json', '', {})).toThrow(/corrupt/);
  });
});

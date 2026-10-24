import { describe, expect, it } from 'vitest';
import {
  bundleToFiles,
  validateConeConfig,
  validateConeConfigDelta,
} from '../../src/cone-config/index.js';
import {
  ACCOUNT_CASES,
  INVALID_EFFORT_LEVELS,
  SECRET_CASES,
  VALID_EFFORT_LEVELS,
} from '../fixtures/cone-config-cases.mjs';

// The same table runs against github-workflow's buildConeConfigFiles in
// packages/github-workflow/scripts/cone-config-rules.test.mjs (#4129).

const bundle = (extra: object) => ({ model: 'm', accounts: [], secrets: [], ...extra });

describe('shared cone-config cases: secrets', () => {
  for (const c of SECRET_CASES) {
    if (c.reject) {
      it(`rejects ${c.id} (bundle and resume delta)`, () => {
        const re = new RegExp(c.reject!);
        expect(() => validateConeConfig(bundle({ secrets: [c.secret] }))).toThrow(re);
        expect(() => validateConeConfigDelta({ upsert: { secrets: [c.secret] } })).toThrow(re);
      });
    } else {
      it(`accepts ${c.id}`, () => {
        const cfg = validateConeConfig(bundle({ secrets: [c.secret] }));
        const { name, value } = c.secret as { name: string; value: string };
        expect(cfg.secrets).toEqual([{ name, value, domains: c.domains }]);
        expect(bundleToFiles(cfg).secretsEnv).toBe(
          `${name}=${value}\n${name}_DOMAINS=${c.domains!.join(',')}\n`
        );
        expect(
          validateConeConfigDelta({ upsert: { secrets: [c.secret] } }).upsert?.secrets
        ).toEqual(cfg.secrets);
      });
    }
  }
});

describe('shared cone-config cases: accounts', () => {
  for (const c of ACCOUNT_CASES) {
    if (c.reject) {
      it(`rejects ${c.id}`, () => {
        const re = new RegExp(c.reject!);
        expect(() => validateConeConfig(bundle({ accounts: [c.account] }))).toThrow(re);
        expect(() => validateConeConfigDelta({ upsert: { accounts: [c.account] } })).toThrow(re);
      });
    } else {
      it(`accepts ${c.id}`, () => {
        const [account] = validateConeConfig(bundle({ accounts: [c.account] })).accounts;
        const allowed = ['providerId', 'kind', 'baseUrl'].concat(
          account!.kind === 'oauth'
            ? ['accessToken', 'refreshToken', 'tokenExpiresAt', 'userName']
            : ['apiKey', 'deployment', 'apiVersion']
        );
        for (const key of Object.keys(account!)) expect(allowed).toContain(key);
      });
    }
  }
});

describe('shared cone-config cases: effort levels', () => {
  it.each(VALID_EFFORT_LEVELS)('accepts %s', (level) => {
    expect(validateConeConfig(bundle({ effortLevel: level })).effortLevel).toBe(level);
    expect(validateConeConfigDelta({ effortLevel: level }).effortLevel).toBe(level);
  });
  it.each(INVALID_EFFORT_LEVELS)('rejects %s', (level) => {
    expect(() => validateConeConfig(bundle({ effortLevel: level }))).toThrow(/effortLevel/);
    expect(() => validateConeConfigDelta({ effortLevel: level })).toThrow(/effortLevel/);
  });
});

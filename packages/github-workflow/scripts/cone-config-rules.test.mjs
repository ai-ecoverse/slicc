import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundleToFiles, validateConeConfig } from '../../cloud-core/src/cone-config/index.ts';
import {
  ACCOUNT_CASES,
  INVALID_EFFORT_LEVELS,
  SECRET_CASES,
  VALID_EFFORT_LEVELS,
} from '../../cloud-core/tests/fixtures/cone-config-cases.mjs';
import { buildConeConfigFiles, parseSecretsEnv, validateSecretEntry } from './lib.mjs';

const build = (bundle) => buildConeConfigFiles({ coneConfigJson: JSON.stringify(bundle) });
const cloud = (extra) => validateConeConfig({ model: 'm', accounts: [], secrets: [], ...extra });

describe('cone-config-rules.mjs', () => {
  it('is byte-identical to the canonical cloud-core copy', () => {
    const canonical = new URL(
      '../../cloud-core/src/cone-config/cone-config-rules.mjs',
      import.meta.url
    );
    const vendored = new URL('./cone-config-rules.mjs', import.meta.url);
    expect(readFileSync(vendored, 'utf-8')).toBe(readFileSync(canonical, 'utf-8'));
  });
});

describe('shared cone-config cases: secrets', () => {
  for (const c of SECRET_CASES) {
    if (c.reject) {
      it(`rejects ${c.id}`, () => {
        const re = new RegExp(c.reject);
        expect(() => build({ secrets: [c.secret] })).toThrow(re);
        expect(() => validateSecretEntry(c.secret)).toThrow(re);
      });
    } else {
      it(`accepts ${c.id} and writes the same secrets.env as cloud-core`, () => {
        const { secretsEnv } = build({ secrets: [c.secret] });
        expect(secretsEnv).toBe(bundleToFiles(cloud({ secrets: [c.secret] })).secretsEnv);
        expect(parseSecretsEnv(secretsEnv)).toEqual([
          { name: c.secret.name, value: c.secret.value, domains: c.domains },
        ]);
      });
    }
  }
});

describe('shared cone-config cases: accounts', () => {
  for (const c of ACCOUNT_CASES) {
    if (c.reject) {
      it(`rejects ${c.id}`, () => {
        expect(() => build({ accounts: [c.account] })).toThrow(new RegExp(c.reject));
      });
    } else {
      it(`accepts ${c.id} with the same fields as cloud-core`, () => {
        const { coneConfigJson } = build({ accounts: [c.account] });
        expect(JSON.parse(coneConfigJson).accounts).toEqual(
          cloud({ accounts: [c.account] }).accounts
        );
      });
    }
  }
});

describe('shared cone-config cases: effort levels', () => {
  it.each(VALID_EFFORT_LEVELS)('accepts %s', (level) => {
    expect(build({ effortLevel: level }).summary.effortLevel).toBe(level);
  });
  it.each(INVALID_EFFORT_LEVELS)('rejects %s', (level) => {
    expect(() => build({ effortLevel: level })).toThrow(/effort-level/);
  });
});

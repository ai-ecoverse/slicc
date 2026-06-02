import { describe, expect, it } from 'vitest';
import { validateResumeBody, validateStartBody } from '../src/cloud/handlers.js';

describe('validateStartBody (size cap + shape)', () => {
  it('rejects an oversized coneConfig', () => {
    const huge = {
      coneConfig: {
        model: 'm',
        accounts: [],
        secrets: [{ name: 'X', value: 'v'.repeat(300_000), domains: [] }],
      },
    };
    expect(() => validateStartBody(huge)).toThrow(/too large/i);
  });
  it('accepts a normal body', () => {
    expect(() =>
      validateStartBody({ name: 'x', coneConfig: { model: 'm', accounts: [], secrets: [] } })
    ).not.toThrow();
  });
  it('accepts a body with no coneConfig', () => {
    expect(() => validateStartBody({ name: 'x' })).not.toThrow();
  });
});

describe('validateResumeBody (size cap + delta shape)', () => {
  it('accepts a body with no delta', () => {
    expect(() => validateResumeBody({})).not.toThrow();
  });
  it('accepts a well-formed delta', () => {
    expect(() =>
      validateResumeBody({
        coneConfigDelta: { upsert: { secrets: [] }, delete: { providerIds: ['x'] } },
      })
    ).not.toThrow();
  });
  it('rejects an oversized delta', () => {
    expect(() =>
      validateResumeBody({
        coneConfigDelta: {
          upsert: { secrets: [{ name: 'X', value: 'v'.repeat(300_000), domains: ['x.com'] }] },
        },
      })
    ).toThrow(/too large/i);
  });
  it('rejects a malformed/injecting delta (shape validation)', () => {
    expect(() =>
      validateResumeBody({
        coneConfigDelta: {
          upsert: { secrets: [{ name: 'X', value: 'a\nb', domains: ['x.com'] }] },
        },
      })
    ).toThrow(/single-line/);
  });
});

import { describe, it, expect } from 'vitest';
import { validateStartBody } from '../src/cloud/handlers.js';

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

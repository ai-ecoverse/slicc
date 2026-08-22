import { describe, expect, it } from 'vitest';
import { defaultLickTarget, LICK_TARGET_ENV } from '../../src/shell/lick-target-env.js';

describe('defaultLickTarget', () => {
  const env = new Map([[LICK_TARGET_ENV, 'cone-research']]);
  it('prefers the explicit --scoop, then the shell default, else untargeted', () => {
    expect(defaultLickTarget('helper', env)).toBe('helper');
    expect(defaultLickTarget(undefined, env)).toBe('cone-research');
    expect(defaultLickTarget('', env)).toBe('cone-research');
    expect(defaultLickTarget(undefined, new Map())).toBeUndefined();
    expect(defaultLickTarget('', new Map())).toBeUndefined();
  });

  it('reads a plain-record env and tolerates none at all', () => {
    expect(defaultLickTarget(undefined, { [LICK_TARGET_ENV]: 'cone-foo' })).toBe('cone-foo');
    expect(defaultLickTarget(undefined, {})).toBeUndefined();
    expect(defaultLickTarget(undefined, undefined)).toBeUndefined();
  });
});

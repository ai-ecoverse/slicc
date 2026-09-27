import { describe, expect, it } from 'vitest';

import type { ViewportOverride } from '../../src/cdp/tab-handle.js';
import { ViewportOverrideStore } from '../../src/cdp/viewport-override-store.js';

function vp(width: number, height: number): ViewportOverride {
  return { width, height, deviceScaleFactor: 1, mobile: false };
}

describe('ViewportOverrideStore', () => {
  it('stores and retrieves overrides by target id', () => {
    const store = new ViewportOverrideStore();
    store.set('t1', vp(1440, 900));

    expect(store.has('t1')).toBe(true);
    expect(store.get('t1')).toEqual(vp(1440, 900));
    expect(store.get('t2')).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('overwrites an existing override for the same target', () => {
    const store = new ViewportOverrideStore();
    store.set('t1', vp(800, 600));
    store.set('t1', vp(412, 915));

    expect(store.get('t1')?.width).toBe(412);
    expect(store.size).toBe(1);
  });

  it('deletes overrides so a closed tab does not resurrect them', () => {
    const store = new ViewportOverrideStore();
    store.set('t1', vp(1440, 900));
    store.delete('t1');

    expect(store.has('t1')).toBe(false);
    expect(store.get('t1')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

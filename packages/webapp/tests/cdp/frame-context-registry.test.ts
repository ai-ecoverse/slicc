import { describe, expect, it } from 'vitest';

import { FrameContextRegistry } from '../../src/cdp/frame-context-registry.js';

describe('FrameContextRegistry', () => {
  it('get-or-creates per-session worlds independently', () => {
    const reg = new FrameContextRegistry();
    const main = reg.for('sess-1', 'main');
    const isolated = reg.for('sess-1', 'isolated');
    main.set('frame-a', 10);
    isolated.set('frame-a', 20);

    expect(reg.for('sess-1', 'main').get('frame-a')).toBe(10);
    expect(reg.for('sess-1', 'isolated').get('frame-a')).toBe(20);
    expect(reg.size).toBe(2);
  });

  it('peek does not create an empty cache entry', () => {
    const reg = new FrameContextRegistry();
    expect(reg.peek('sess-1', 'main')).toBeUndefined();
    expect(reg.size).toBe(0);

    reg.for('sess-1', 'main').set('f', 1);
    expect(reg.peek('sess-1', 'main')?.get('f')).toBe(1);
  });

  it('isolates sibling sessions so one attach cannot wipe another', () => {
    const reg = new FrameContextRegistry();
    reg.for('sess-a', 'main').set('frame', 1);
    reg.for('sess-b', 'main').set('frame', 2);

    reg.for('sess-a', 'main').clear();
    expect(reg.peek('sess-a', 'main')?.size).toBe(0);
    expect(reg.peek('sess-b', 'main')?.get('frame')).toBe(2);
  });

  it('drop removes both worlds for a gone session', () => {
    const reg = new FrameContextRegistry();
    reg.for('sess-1', 'main').set('f', 1);
    reg.for('sess-1', 'isolated').set('f', 2);
    reg.for('sess-2', 'main').set('f', 3);

    reg.drop('sess-1');
    expect(reg.peek('sess-1', 'main')).toBeUndefined();
    expect(reg.peek('sess-1', 'isolated')).toBeUndefined();
    expect(reg.peek('sess-2', 'main')?.get('f')).toBe(3);
    expect(reg.size).toBe(1);
  });
});

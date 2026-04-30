import { describe, it, expect } from 'vitest';
import { newMountId } from '../../../src/fs/mount/mount-id.js';

describe('newMountId', () => {
  it('returns a UUID v4 string', () => {
    const id = newMountId();
    expect(typeof id).toBe('string');
    // RFC 4122 v4 shape: 8-4-4-4-12 hex with the version nibble = 4
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces a unique id on each call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newMountId());
    expect(ids.size).toBe(100);
  });
});

import { describe, expect, it } from 'vitest';
import { createPointer, rememberPointer, resolvePointer } from '../../src/computers/pointer.js';

describe('computer pointer', () => {
  it('fills omitted coordinates from the last remembered point', () => {
    const pointer = createPointer();
    rememberPointer(pointer, { x: 40, y: 50 });
    expect(resolvePointer(pointer, {})).toEqual({ x: 40, y: 50 });
    expect(resolvePointer(pointer, { x: 8, y: 9 })).toEqual({ x: 8, y: 9 });
    expect(pointer).toEqual({ x: 8, y: 9 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyPointerToEvents,
  createPointer,
  rememberPointer,
  resolvePointer,
} from '../../src/computers/pointer.js';

describe('computer pointer', () => {
  it('fills omitted coordinates from the last remembered point', () => {
    const pointer = createPointer();
    rememberPointer(pointer, { x: 40, y: 50 });
    expect(resolvePointer(pointer, {})).toEqual({ x: 40, y: 50 });
    expect(resolvePointer(pointer, { x: 8, y: 9 })).toEqual({ x: 8, y: 9 });
    expect(pointer).toEqual({ x: 8, y: 9 });
  });

  it('stamps omitted click coordinates from the last mousemove', () => {
    const pointer = createPointer();
    const events = applyPointerToEvents(pointer, [
      { type: 'mousemove', x: 100, y: 80 },
      { type: 'click', button: 1, count: 1 },
    ]);
    expect(events[1]).toMatchObject({ type: 'click', x: 100, y: 80 });
  });
});

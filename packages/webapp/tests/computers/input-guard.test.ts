import type { ComputerCapabilities, ComputerInputEvent } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { unsupportedInputReason } from '../../src/computers/input-guard.js';

const base: ComputerCapabilities = {
  screenshot: true,
  text: false,
  frames: 'poll',
  keyboard: true,
  mouse: 'absolute',
  scroll: true,
  exec: false,
  inputAllowed: true,
};

describe('unsupportedInputReason', () => {
  it('allows wait even when input is forbidden', () => {
    expect(
      unsupportedInputReason({ ...base, inputAllowed: false }, [{ type: 'wait', ms: 10 }])
    ).toBeNull();
  });

  it('rejects every capability branch', () => {
    const click: ComputerInputEvent = { type: 'click', button: 1, count: 1, x: 1, y: 1 };
    expect(unsupportedInputReason({ ...base, inputAllowed: false }, [click])).toBe(
      'input is not allowed'
    );
    expect(
      unsupportedInputReason({ ...base, keyboard: false }, [{ type: 'text', text: 'x' }])
    ).toBe('keyboard input is not supported');
    expect(
      unsupportedInputReason({ ...base, keyboard: false }, [{ type: 'key', keysym: 'a' }])
    ).toBe('keyboard input is not supported');
    expect(unsupportedInputReason({ ...base, mouse: 'none' }, [click])).toBe(
      'mouse input is not supported'
    );
    expect(
      unsupportedInputReason({ ...base, mouse: 'none' }, [
        { type: 'drag', x1: 0, y1: 0, x2: 1, y2: 1 },
      ])
    ).toBe('mouse input is not supported');
    expect(
      unsupportedInputReason({ ...base, scroll: false }, [{ type: 'scroll', dx: 0, dy: 1 }])
    ).toBe('scroll is not supported');
  });
});

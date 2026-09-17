import { describe, expect, it } from 'vitest';
import type {
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
} from '../src/computer-protocol.js';

function descriptor(overrides: Partial<ComputerDescriptor> = {}): ComputerDescriptor {
  return {
    id: 'vm0',
    kind: 'v86',
    title: 'vm0',
    size: { width: 1280, height: 800 },
    state: 'live',
    capabilities: {
      screenshot: true,
      text: true,
      frames: 'poll',
      keyboard: true,
      mouse: 'relative',
      scroll: false,
      exec: false,
      inputAllowed: true,
    },
    pid: 1024,
    ...overrides,
  };
}

describe('computer-protocol shapes', () => {
  it('accepts a v86 descriptor with lastShot scale', () => {
    const d = descriptor({
      lastShot: { width: 768, height: 480, scale: 0.6, at: 1 },
    });
    expect(d.capabilities.mouse).toBe('relative');
    expect(d.lastShot?.scale).toBe(0.6);
  });

  it('accepts every input event variant', () => {
    const events: ComputerInputEvent[] = [
      { type: 'mousemove', x: 10, y: 20 },
      { type: 'mousemove', x: 1, y: -1, relative: true },
      { type: 'button', button: 1, down: true, x: 4, y: 5 },
      { type: 'click', button: 3, count: 2, holdMs: 400, x: 8, y: 9 },
      { type: 'scroll', dx: 0, dy: -40, x: 10, y: 10 },
      { type: 'drag', x1: 10, y1: 20, x2: 200, y2: 80 },
      { type: 'key', keysym: 'ctrl+alt+Delete' },
      { type: 'key', keysym: 'KEYCODE_BACK', down: false },
      { type: 'text', text: 'ls -la\n' },
      { type: 'wait', ms: 500 },
    ];
    expect(events).toHaveLength(10);
  });

  it('accepts a JPEG frame', () => {
    const frame: ComputerFrame = {
      seq: 1,
      mime: 'image/jpeg',
      width: 768,
      height: 480,
      bytes: new Uint8Array([0xff, 0xd8]),
    };
    expect(frame.mime).toBe('image/jpeg');
  });

  it('allows a touch backend with softKeys and no mouse', () => {
    const d = descriptor({
      id: 'phone',
      kind: 'jsh',
      capabilities: {
        screenshot: true,
        text: false,
        frames: 'push',
        keyboard: true,
        mouse: 'touch',
        scroll: true,
        exec: true,
        inputAllowed: true,
      },
      softKeys: [{ label: 'Home', keysym: 'KEYCODE_HOME' }],
    });
    expect(d.capabilities.mouse).toBe('touch');
    expect(d.softKeys?.[0]?.keysym).toBe('KEYCODE_HOME');
  });
});

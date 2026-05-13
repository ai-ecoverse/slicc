/**
 * Tests for enterDetachedActiveState — the three-layer mutual-exclusion
 * enforcer used by the detached popout flow.
 *
 * Order matters: window.close() → setLocked(true) → showDetachedActiveOverlay().
 * Locking before the overlay paints ensures that any queued events racing
 * the document teardown cannot still reach OffscreenClient.send().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let callCounter = 0;
let closeOrder = 0;
let setLockedOrder = 0;
let showOverlayOrder = 0;

beforeEach(() => {
  callCounter = 0;
  closeOrder = 0;
  setLockedOrder = 0;
  showOverlayOrder = 0;
  // @ts-expect-error — overriding global for test
  globalThis.window = {
    close: vi.fn(() => {
      callCounter += 1;
      closeOrder = callCounter;
    }),
  };
});

import { enterDetachedActiveState } from '../../src/ui/detached-active.js';

describe('enterDetachedActiveState — three-layer mutual exclusion', () => {
  it('runs window.close, setLocked, then showDetachedActiveOverlay in that order', () => {
    const client = {
      setLocked: vi.fn(() => {
        callCounter += 1;
        setLockedOrder = callCounter;
      }),
    };
    const layout = {
      showDetachedActiveOverlay: vi.fn(() => {
        callCounter += 1;
        showOverlayOrder = callCounter;
      }),
    };

    enterDetachedActiveState(client as never, layout as never);

    expect(closeOrder).toBe(1);
    expect(setLockedOrder).toBe(2);
    expect(showOverlayOrder).toBe(3);
    expect(client.setLocked).toHaveBeenCalledWith(true);
    expect(layout.showDetachedActiveOverlay).toHaveBeenCalledOnce();
  });

  it('continues past window.close throwing', () => {
    // @ts-expect-error — overriding global for test
    globalThis.window = {
      close: vi.fn(() => {
        throw new Error('window.close not supported');
      }),
    };
    const client = { setLocked: vi.fn() };
    const layout = { showDetachedActiveOverlay: vi.fn() };

    expect(() => enterDetachedActiveState(client as never, layout as never)).not.toThrow();
    expect(client.setLocked).toHaveBeenCalledWith(true);
    expect(layout.showDetachedActiveOverlay).toHaveBeenCalledOnce();
  });
});

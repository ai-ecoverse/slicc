// @vitest-environment jsdom
/**
 * Detached-popout mutual exclusion (WC shell): the detached tab claims the
 * service worker's lock, every other extension surface yields on the
 * `detached-active` broadcast — close, lock the client chokepoint, overlay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import {
  enterWcDetachedActiveState,
  requestDetachedPopout,
  wireWcDetached,
} from '../../../src/ui/wc/wc-detached.js';

type Listener = (msg: unknown) => boolean;

function installChromeStub() {
  const listeners: Listener[] = [];
  const sendMessage = vi.fn(async () => undefined);
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      sendMessage,
    },
  };
  return {
    sendMessage,
    broadcast: (msg: unknown) => {
      for (const fn of listeners) fn(msg);
    },
  };
}

function fakeClient(): OffscreenClient & { setLocked: ReturnType<typeof vi.fn> } {
  return { setLocked: vi.fn() } as unknown as OffscreenClient & {
    setLocked: ReturnType<typeof vi.fn>;
  };
}

const DETACHED_ACTIVE = { source: 'service-worker', payload: { type: 'detached-active' } };

describe('wireWcDetached', () => {
  let chromeStub: ReturnType<typeof installChromeStub>;
  let close: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A real jsdom window.close() tears the document down — stub it.
    close = vi.spyOn(window, 'close').mockImplementation(() => {});
    document.body.replaceChildren();
    chromeStub = installChromeStub();
  });

  afterEach(() => {
    close.mockRestore();
    (globalThis as Record<string, unknown>).chrome = undefined;
  });

  it('a detached tab claims the SW lock on boot', () => {
    wireWcDetached({ client: fakeClient(), isDetachedSelf: true });
    expect(chromeStub.sendMessage).toHaveBeenCalledWith({
      source: 'panel',
      payload: { type: 'detached-claim' },
    });
  });

  it('a side panel does NOT claim the lock', () => {
    wireWcDetached({ client: fakeClient(), isDetachedSelf: false });
    expect(chromeStub.sendMessage).not.toHaveBeenCalled();
  });

  it('the side panel yields on detached-active: lock + overlay', () => {
    const client = fakeClient();
    wireWcDetached({ client, isDetachedSelf: false });
    chromeStub.broadcast(DETACHED_ACTIVE);
    expect(client.setLocked).toHaveBeenCalledWith(true);
    const overlay = document.getElementById('slicc-detached-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain('detached window');
  });

  it('the detached tab itself ignores the broadcast (it holds the lock)', () => {
    const client = fakeClient();
    wireWcDetached({ client, isDetachedSelf: true });
    chromeStub.broadcast(DETACHED_ACTIVE);
    expect(client.setLocked).not.toHaveBeenCalled();
    expect(document.getElementById('slicc-detached-overlay')).toBeNull();
  });

  it('ignores non-SW and non-detached messages', () => {
    const client = fakeClient();
    wireWcDetached({ client, isDetachedSelf: false });
    chromeStub.broadcast({ source: 'panel', payload: { type: 'detached-active' } });
    chromeStub.broadcast({ source: 'service-worker', payload: { type: 'scoops-changed' } });
    chromeStub.broadcast('not even an envelope');
    expect(client.setLocked).not.toHaveBeenCalled();
  });

  it('requestDetachedPopout sends the SW popout request', () => {
    requestDetachedPopout();
    expect(chromeStub.sendMessage).toHaveBeenCalledWith({
      source: 'panel',
      payload: { type: 'detached-popout-request' },
    });
  });

  it('enterWcDetachedActiveState is idempotent and the overlay can close the window', () => {
    const client = fakeClient();
    enterWcDetachedActiveState(client);
    enterWcDetachedActiveState(client);
    expect(document.querySelectorAll('#slicc-detached-overlay')).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(2); // happy-path close attempt each time

    const button = document.querySelector('#slicc-detached-overlay button') as HTMLButtonElement;
    button.click();
    expect(close).toHaveBeenCalledTimes(3);
  });
});

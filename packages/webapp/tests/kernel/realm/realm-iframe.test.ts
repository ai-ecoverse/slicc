/**
 * Tests for the per-task sandbox-iframe realm.
 *
 * Vitest runs in node with no DOM by default. This file is opted
 * into the JSDOM environment via `// @vitest-environment jsdom`.
 *
 * The tests cover the handshake (iframe announces ready → host
 * transfers MessagePort), `terminate()` removing the iframe, and
 * port handoff. They don't run user code through the iframe —
 * `sandbox.html` is a copy-only static asset whose runtime
 * behavior is exercised by manual smoke tests in the extension
 * float.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import type { CommandContext } from 'just-bash';
import { createIframeRealm } from '../../../src/kernel/realm/realm-iframe.js';

const ctx = {} as CommandContext;

/**
 * JSDOM doesn't fire a real window event when an iframe inside
 * the same window posts via `parent.postMessage`. To drive the
 * handshake we synthesize a MessageEvent against the parent
 * window with `source` set to the iframe's contentWindow.
 *
 * Tests provide a fake `MessageChannel` so the host's port-init
 * postMessage doesn't try to transfer a real `MessagePort`
 * (JSDOM lacks one).
 */
class FakePort {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  posted: Array<{ msg: unknown; transfer?: Transferable[] }> = [];
  postMessage(msg: unknown, transfer?: Transferable[]): void {
    this.posted.push({ msg, transfer });
  }
  addEventListener(_type: 'message', handler: (event: MessageEvent) => void): void {
    this.listeners.add(handler);
  }
  removeEventListener(_type: 'message', handler: (event: MessageEvent) => void): void {
    this.listeners.delete(handler);
  }
  start(): void {
    /* noop */
  }
  close(): void {
    /* noop */
  }
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
}

function fireReadyFromIframe(iframe: HTMLIFrameElement): void {
  // JSDOM doesn't auto-fire from inside the iframe. Synthesize a
  // MessageEvent on the parent window with `source` pinned to the
  // iframe's contentWindow.
  const event = new MessageEvent('message', {
    data: { type: 'realm-iframe-ready' },
  });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

describe('createIframeRealm', () => {
  it('appends an iframe with src=sandboxUrl and waits for the ready handshake', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const fakeChannel = new FakeMessageChannel();
    const fakeChannelCtor = function () {
      return fakeChannel;
    } as unknown as typeof MessageChannel;
    let createdIframe: HTMLIFrameElement | null = null;
    const promise = createIframeRealm('js', ctx, {
      sandboxUrl: 'about:blank',
      container,
      messageChannelCtor: fakeChannelCtor,
      onIframeCreated: (iframe) => {
        createdIframe = iframe;
      },
    });
    expect(createdIframe).not.toBeNull();
    expect(container.querySelector('iframe')).toBe(createdIframe);
    expect(createdIframe!.dataset.realm).toBe('js');
    // Fire the handshake.
    fireReadyFromIframe(createdIframe!);
    const realm = await promise;
    expect(realm.controlPort).toBe(fakeChannel.port1);
    realm.terminate();
  });

  it('hands the iframe a MessagePort via realm-port-init after ready', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const fakeChannel = new FakeMessageChannel();
    let createdIframe: HTMLIFrameElement | null = null;
    // Spy on the iframe's contentWindow.postMessage to capture the
    // port handoff. JSDOM gives us a real contentWindow; replace
    // postMessage with a vi.fn after iframe creation.
    const iframePostSpy = vi.fn();
    const promise = createIframeRealm('js', ctx, {
      sandboxUrl: 'about:blank',
      container,
      messageChannelCtor: function () {
        return fakeChannel;
      } as unknown as typeof MessageChannel,
      onIframeCreated: (iframe) => {
        createdIframe = iframe;
        // Stub contentWindow.postMessage as soon as it's available
        // (post-append). JSDOM exposes contentWindow synchronously
        // for `about:blank`, so this just works.
        if (iframe.contentWindow) {
          (iframe.contentWindow as Window & { postMessage: typeof iframePostSpy }).postMessage =
            iframePostSpy;
        }
      },
    });
    fireReadyFromIframe(createdIframe!);
    await promise;
    expect(iframePostSpy).toHaveBeenCalledTimes(1);
    const [msg, _origin, transfer] = iframePostSpy.mock.calls[0] as [
      unknown,
      string,
      Transferable[],
    ];
    expect(msg).toEqual({ type: 'realm-port-init' });
    expect(transfer[0]).toBe(fakeChannel.port2);
  });

  it('terminate() removes the iframe and is idempotent', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const fakeChannel = new FakeMessageChannel();
    let createdIframe: HTMLIFrameElement | null = null;
    const promise = createIframeRealm('js', ctx, {
      sandboxUrl: 'about:blank',
      container,
      messageChannelCtor: function () {
        return fakeChannel;
      } as unknown as typeof MessageChannel,
      onIframeCreated: (iframe) => {
        createdIframe = iframe;
        if (iframe.contentWindow) {
          (iframe.contentWindow as Window & { postMessage: () => void }).postMessage = () => {};
        }
      },
    });
    fireReadyFromIframe(createdIframe!);
    const realm = await promise;
    expect(container.querySelector('iframe')).not.toBeNull();
    realm.terminate();
    expect(container.querySelector('iframe')).toBeNull();
    // Idempotent — second terminate doesn't throw.
    realm.terminate();
  });

  it('uses chrome.runtime.getURL by default when no sandboxUrl is passed', async () => {
    const c = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome: { runtime: { id: string; getURL: (p: string) => string } } }).chrome =
      {
        runtime: { id: 'fake-ext', getURL: (path) => `chrome-extension://fake-ext/${path}` },
      };
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const fakeChannel = new FakeMessageChannel();
      let createdIframe: HTMLIFrameElement | null = null;
      const promise = createIframeRealm('js', ctx, {
        container,
        messageChannelCtor: function () {
          return fakeChannel;
        } as unknown as typeof MessageChannel,
        onIframeCreated: (iframe) => {
          createdIframe = iframe;
          if (iframe.contentWindow) {
            (iframe.contentWindow as Window & { postMessage: () => void }).postMessage = () => {};
          }
        },
      });
      // src reflects the default URL.
      expect(createdIframe!.src).toBe('chrome-extension://fake-ext/sandbox.html');
      fireReadyFromIframe(createdIframe!);
      const realm = await promise;
      realm.terminate();
    } finally {
      if (c === undefined) delete (globalThis as { chrome?: unknown }).chrome;
      else (globalThis as { chrome?: unknown }).chrome = c;
    }
  });

  it('throws when neither sandboxUrl nor chrome.runtime.getURL is available', async () => {
    const c = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      await expect(
        createIframeRealm('js', ctx, {
          container,
          messageChannelCtor: function () {
            return new FakeMessageChannel();
          } as unknown as typeof MessageChannel,
        })
      ).rejects.toThrow(/sandbox URL/);
    } finally {
      if (c !== undefined) (globalThis as { chrome?: unknown }).chrome = c;
    }
  });
});

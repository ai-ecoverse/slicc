import { beforeEach, describe, expect, it, vi } from 'vitest';

type OnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => void | boolean;
type DebuggerEventListener = (
  source: { tabId: number },
  method: string,
  params?: Record<string, unknown>
) => void;
type DebuggerDetachListener = (source: { tabId: number }, reason: string) => void;
type HeadersReceivedListener = (details: {
  url: string;
  tabId: number;
  responseHeaders?: Array<{ name: string; value?: string }>;
}) => void;

const runtimeMessageListeners: OnMessageListener[] = [];
const runtimeExternalMessageListeners: OnMessageListener[] = [];
type StorageChangedListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string
) => void;
const storageChangedListeners: StorageChangedListener[] = [];
const runtimeSentMessages: unknown[] = [];
// Backing state for the chrome.storage.session mock. Lives OUTSIDE the mock
// object so tests can simulate an MV3 SW eviction/respawn: reset modules and
// re-import the SW while this state (like real storage.session) survives.
let sessionStorageState: Record<string, unknown> = {};
// The SW registers TWO onHeadersReceived listeners: the handoff observer first,
// then the silent discovery observer. `headersReceivedListener` keeps the FIRST
// (handoff) one so these handoff tests exercise it; `headersReceivedListeners`
// holds all of them.
const headersReceivedListeners: HeadersReceivedListener[] = [];
let headersReceivedListener: HeadersReceivedListener | null = null;
const debuggerEventListeners: DebuggerEventListener[] = [];
const debuggerDetachListeners: DebuggerDetachListener[] = [];

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event?: { data?: unknown }) => void>>();
  closeArgs: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: { data?: unknown }) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = { code, reason };
  }

  emit(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createChromeMock() {
  return {
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      onClicked: { addListener: vi.fn() },
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (key?: string | string[] | null) => {
          if (typeof key === 'string') {
            return key in sessionStorageState ? { [key]: sessionStorageState[key] } : {};
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(
              key.filter((k) => k in sessionStorageState).map((k) => [k, sessionStorageState[k]])
            );
          }
          return { ...sessionStorageState };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStorageState, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete sessionStorageState[key];
        }),
      },
      onChanged: {
        addListener: vi.fn((listener: StorageChangedListener) => {
          storageChangedListeners.push(listener);
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        runtimeSentMessages.push(message);
      }),
      onMessage: {
        addListener: vi.fn((listener: OnMessageListener) => {
          runtimeMessageListeners.push(listener);
        }),
      },
      getContexts: vi.fn(async () => []),
      onConnect: {
        addListener: vi.fn(),
      },
      onConnectExternal: {
        addListener: vi.fn(),
      },
      onMessageExternal: {
        addListener: vi.fn((listener: OnMessageListener) => {
          runtimeExternalMessageListeners.push(listener);
        }),
      },
      onInstalled: {
        addListener: vi.fn(),
      },
      onStartup: {
        addListener: vi.fn(),
      },
      onUpdateAvailable: {
        addListener: vi.fn(),
      },
      reload: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 123, url })),
      get: vi.fn(async (id: number) => ({ id, windowId: 1 }) as unknown),
      update: vi.fn(async (id: number, _props: unknown) => ({ id }) as unknown),
      reload: vi.fn(async () => {}),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      onCreated: {
        addListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn(),
      },
    },
    tabGroups: {
      update: vi.fn(async () => undefined),
    },
    windows: {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({})),
    },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
      onEvent: {
        addListener: vi.fn((listener: DebuggerEventListener) => {
          debuggerEventListeners.push(listener);
        }),
      },
      onDetach: {
        addListener: vi.fn((listener: DebuggerDetachListener) => {
          debuggerDetachListeners.push(listener);
        }),
      },
    },
    identity: {
      launchWebAuthFlow: vi.fn(),
      getRedirectURL: vi.fn(),
    },
    notifications: {
      create: vi.fn(),
      onClicked: {
        addListener: vi.fn(),
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener: vi.fn((listener: HeadersReceivedListener) => {
          headersReceivedListeners.push(listener);
          headersReceivedListener ??= listener;
        }),
      },
    },
  };
}

function dispatchOffscreenMessage(payload: unknown): void {
  for (const listener of runtimeMessageListeners) {
    listener({ source: 'offscreen', payload }, {}, () => {});
  }
}

/**
 * Send a raw message to the SW listeners and capture the sendResponse
 * call. The mount sign-and-forward listener is async, so this returns a
 * promise that resolves once any listener has called sendResponse.
 */
async function dispatchAndCaptureResponse(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (response?: unknown): void => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    let asyncHandled = false;
    for (const listener of runtimeMessageListeners) {
      const ret = listener(message, {}, sendResponse);
      if (ret === true) asyncHandled = true;
    }
    // If no listener kept the channel open and nothing called sendResponse
    // synchronously, resolve with undefined so tests can assert on it.
    if (!asyncHandled && !resolved) resolve(undefined);
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadServiceWorker(): Promise<void> {
  // Scope the onHeadersReceived captures to THIS load so a mid-test reload
  // re-captures the fresh module's handoff listener (registered first) rather
  // than keeping a stale one from a previous load.
  headersReceivedListeners.length = 0;
  headersReceivedListener = null;
  await import('../src/service-worker.js');
}

describe('extension service worker', () => {
  beforeEach(async () => {
    runtimeMessageListeners.length = 0;
    runtimeExternalMessageListeners.length = 0;
    storageChangedListeners.length = 0;
    runtimeSentMessages.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    MockWebSocket.instances.length = 0;
    headersReceivedListeners.length = 0;
    headersReceivedListener = null;
    sessionStorageState = {};
    vi.clearAllMocks();
    vi.resetModules();

    (globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }).chrome =
      createChromeMock();
    (globalThis as typeof globalThis & { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as never;

    await loadServiceWorker();
  });

  it('oauth-request with interactive:false runs launchWebAuthFlow with the silent (windowless) options', async () => {
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chromeMock.identity.launchWebAuthFlow.mockResolvedValue(undefined);

    await dispatchAndCaptureResponse({
      source: 'panel',
      payload: {
        type: 'oauth-request',
        providerId: 'adobe',
        authorizeUrl: 'https://ims.example.com/authorize',
        interactive: false,
      },
    });
    await flushAsync();

    expect(chromeMock.identity.launchWebAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ims.example.com/authorize',
        interactive: false,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: expect.any(Number),
      })
    );
  });

  it('oauth-request without interactive defaults to a visible (interactive:true) flow', async () => {
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chromeMock.identity.launchWebAuthFlow.mockResolvedValue(undefined);

    await dispatchAndCaptureResponse({
      source: 'panel',
      payload: {
        type: 'oauth-request',
        providerId: 'adobe',
        authorizeUrl: 'https://ims.example.com/authorize',
      },
    });
    await flushAsync();

    expect(chromeMock.identity.launchWebAuthFlow).toHaveBeenCalledWith({
      url: 'https://ims.example.com/authorize',
      interactive: true,
    });
  });

  it('hosts the leader tray socket in the service worker and relays frames', async () => {
    dispatchOffscreenMessage({
      type: 'tray-socket-open',
      id: 7,
      url: 'wss://tray.example.com/controller',
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('wss://tray.example.com/controller');

    socket.emit('open');
    socket.emit('message', { data: '{"type":"leader.connected"}' });
    await Promise.resolve();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: { type: 'tray-socket-opened', id: 7 },
    });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: { type: 'tray-socket-message', id: 7, data: '{"type":"leader.connected"}' },
    });

    dispatchOffscreenMessage({ type: 'tray-socket-send', id: 7, data: '{"type":"ping"}' });
    expect(socket.sent).toEqual(['{"type":"ping"}']);

    dispatchOffscreenMessage({ type: 'tray-socket-close', id: 7, code: 1000, reason: 'done' });
    expect(socket.closeArgs).toEqual({ code: 1000, reason: 'done' });
  });

  it('reports tray socket command failures back to offscreen', async () => {
    dispatchOffscreenMessage({ type: 'tray-socket-send', id: 99, data: '{"type":"ping"}' });
    await flushAsync();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'tray-socket-error',
        id: 99,
        error: 'Tray socket 99 is not open',
      },
    });
  });

  // ----------------- Mount sign-and-forward -----------------
  // Coverage for the mount.s3-sign-and-forward / mount.da-sign-and-forward
  // listener registered by service-worker.ts. These tests verify the type
  // guard, chrome.storage.local credential resolution, and the structured
  // reply envelope. The actual SigV4 signing logic is covered by the
  // shared sigv4 test suite in @slicc/shared-ts.

  it('rejects malformed mount sign-and-forward messages via the type guard', async () => {
    // Message has the right top-level type but no envelope — fails the guard.
    const reply = await dispatchAndCaptureResponse({
      type: 'mount.s3-sign-and-forward',
    });
    // The guard returns false → no listener handles it → undefined response.
    expect(reply).toBeUndefined();
  });

  it('returns profile_not_configured when chrome.storage has no credentials', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chrome.storage.local.get = vi.fn(async () => ({})) as never;

    const reply = (await dispatchAndCaptureResponse({
      type: 'mount.s3-sign-and-forward',
      envelope: {
        profile: 'aws',
        method: 'GET',
        bucket: 'my-bucket',
        key: 'foo.txt',
      },
    })) as { ok: boolean; errorCode: string; error: string };

    expect(reply.ok).toBe(false);
    expect(reply.errorCode).toBe('profile_not_configured');
    expect(reply.error).toContain("missing required field 'access_key_id'");
  });

  it('returns invalid_profile for a malformed profile name', async () => {
    const reply = (await dispatchAndCaptureResponse({
      type: 'mount.s3-sign-and-forward',
      envelope: {
        profile: 'aws/etc/passwd',
        method: 'GET',
        bucket: 'b',
        key: 'k',
      },
    })) as { ok: boolean; errorCode: string };

    expect(reply.ok).toBe(false);
    expect(reply.errorCode).toBe('invalid_profile');
  });

  it('forwards a configured S3 request via fetch using SigV4', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    // Seed chrome.storage.local with valid AWS canonical-vector credentials.
    const stored: Record<string, string> = {
      's3.aws.access_key_id': 'AKIDEXAMPLE',
      's3.aws.secret_access_key': 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      's3.aws.region': 'us-east-1',
    };
    chrome.storage.local.get = vi.fn(async (key?: string | string[] | null) => {
      if (typeof key === 'string') {
        return key in stored ? { [key]: stored[key] } : {};
      }
      return stored;
    }) as never;

    // Mock the upstream fetch (S3) — capture the URL + Authorization header.
    let capturedUrl = '';
    let capturedAuth = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      capturedUrl = String(url);
      capturedAuth = init?.headers?.['Authorization'] ?? '';
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { etag: '"e1"', 'content-type': 'application/octet-stream' },
      });
    }) as unknown as typeof fetch;

    try {
      const reply = (await dispatchAndCaptureResponse({
        type: 'mount.s3-sign-and-forward',
        envelope: {
          profile: 'aws',
          method: 'GET',
          bucket: 'my-bucket',
          key: 'foo.txt',
        },
      })) as { ok: true; status: number; headers: Record<string, string>; bodyBase64: string };

      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(reply.headers.etag).toBe('"e1"');
      // body should be base64-encoded [1, 2, 3]
      expect(atob(reply.bodyBase64)).toBe(String.fromCharCode(1, 2, 3));
      expect(capturedUrl).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt');
      expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows a notification and sets badge when a SLICC handoff Link header is received', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chrome.tabs.get = vi.fn(async () => ({ id: 42, windowId: 1, title: 'Handoff Page' })) as never;

    headersReceivedListener!({
      url: 'https://www.sliccy.ai/handoff',
      tabId: 42,
      responseHeaders: [
        {
          name: 'Link',
          value: '<https://github.com/o/r>; rel="https://www.sliccy.ai/rel/upskill"',
        },
      ],
    });
    await flushAsync();

    expect(chrome.notifications.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'basic', message: expect.any(String) })
    );
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#ff5f72' });
  });

  it('focuses the leader tab and clears badge when handoff notification is clicked', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chrome.tabs.get = vi.fn(async () => ({
      id: 21,
      windowId: 7,
      url: 'https://www.sliccy.ai/?slicc=leader',
      title: 'Slicc',
    })) as never;
    chrome.tabs.update = vi.fn(async () => ({})) as never;
    chrome.storage.session.get = vi.fn(async (key: string) => ({
      [key]: key === 'slicc_leader_tab_id' ? 21 : undefined,
    })) as never;

    // Capture the notifications.onClicked listener
    let notificationClickListener: ((id: string) => void) | null = null;
    chrome.notifications.onClicked.addListener = vi.fn((listener: (id: string) => void) => {
      notificationClickListener = listener;
    }) as never;

    // Re-load the service worker so it picks up our onClicked mock
    vi.resetModules();
    await loadServiceWorker();

    headersReceivedListener!({
      url: 'https://www.sliccy.ai/handoff',
      tabId: 42,
      responseHeaders: [
        {
          name: 'Link',
          value: '<https://github.com/o/r>; rel="https://www.sliccy.ai/rel/upskill"',
        },
      ],
    });
    await flushAsync();

    expect(chrome.notifications.create).toHaveBeenCalled();
    const notificationId = (chrome.notifications.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;

    // Simulate user clicking the notification
    notificationClickListener!(notificationId);
    await flushAsync();
    await flushAsync();

    expect(chrome.tabs.update).toHaveBeenCalledWith(21, { active: true });
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  // --- Handoff notification dedup + content -----------------------------------
  // A site can serve the same SLICC Link rel on EVERY page response (e.g. the
  // site-wide upskill on www.aem.live). The toast dedup must survive MV3 SW
  // eviction (chrome.storage.session), while the lick forward must fire on
  // every sighting regardless.

  const UPSKILL_LINK_VALUE =
    '<https://github.com/adobe/skills>; rel="https://www.sliccy.ai/rel/upskill"; branch=main; path="plugins/aem/edge-delivery-services"';

  function fireHandoffSighting(linkValue: string, url = 'https://www.aem.live/docs/'): void {
    headersReceivedListener!({
      url,
      tabId: 42,
      responseHeaders: [{ name: 'Link', value: linkValue }],
    });
  }

  /**
   * Simulate an MV3 SW eviction + respawn: fresh module (in-memory sets are
   * gone) against the SAME chrome mock, whose storage.session state survives
   * via `sessionStorageState`.
   */
  async function respawnServiceWorker(): Promise<void> {
    vi.resetModules();
    await loadServiceWorker();
  }

  function notificationCreateCalls(): Array<[string, { title: string; message: string }]> {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    return (chrome.notifications.create as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { title: string; message: string }]
    >;
  }

  it('does not re-show the toast when the same fingerprint is sighted after a SW respawn', async () => {
    fireHandoffSighting(UPSKILL_LINK_VALUE, 'https://www.aem.live/docs/');
    await flushAsync();
    expect(notificationCreateCalls()).toHaveLength(1);

    await respawnServiceWorker();
    fireHandoffSighting(UPSKILL_LINK_VALUE, 'https://www.aem.live/tutorial/');
    await flushAsync();
    expect(notificationCreateCalls()).toHaveLength(1);
  });

  it('shows a toast for a different fingerprint after a SW respawn', async () => {
    fireHandoffSighting(UPSKILL_LINK_VALUE);
    await flushAsync();
    expect(notificationCreateCalls()).toHaveLength(1);

    await respawnServiceWorker();
    fireHandoffSighting('<https://github.com/other/repo>; rel="https://www.sliccy.ai/rel/upskill"');
    await flushAsync();
    expect(notificationCreateCalls()).toHaveLength(2);
  });

  it('forwards the navigate lick on every sighting, including deduped ones', async () => {
    fireHandoffSighting(UPSKILL_LINK_VALUE, 'https://www.aem.live/docs/');
    await flushAsync();
    fireHandoffSighting(UPSKILL_LINK_VALUE, 'https://www.aem.live/tutorial/');
    await flushAsync();
    await respawnServiceWorker();
    fireHandoffSighting(UPSKILL_LINK_VALUE, 'https://www.aem.live/blog/');
    await flushAsync();

    const licks = runtimeSentMessages.filter(
      (m) => (m as { payload?: { type?: string } }).payload?.type === 'navigate-lick'
    );
    expect(licks).toHaveLength(3);
    expect(notificationCreateCalls()).toHaveLength(1);
  });

  it('clears the badge and focuses the leader tab for a handoff notification id minted before a SW respawn', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    sessionStorageState['slicc_leader_tab_id'] = 21;
    chrome.tabs.get = vi.fn(async () => ({
      id: 21,
      windowId: 7,
      url: 'https://www.sliccy.ai/?slicc=leader',
      title: 'Slicc',
    })) as never;
    chrome.tabs.update = vi.fn(async () => ({})) as never;

    const clickListener = (chrome.notifications.onClicked.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (id: string) => void;
    // Id minted by a previous SW lifetime — in no in-memory set of this one.
    clickListener('slicc-handoff-1700000000000');
    await flushAsync();
    await flushAsync();

    expect(chrome.tabs.update).toHaveBeenCalledWith(21, { active: true });
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('ignores notification clicks with non-handoff ids', async () => {
    const chrome = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    const clickListener = (chrome.notifications.onClicked.addListener as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as (id: string) => void;
    clickListener('some-other-notification');
    await flushAsync();

    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith({ text: '' });
  });

  it('names the repo and skill path in the upskill toast', async () => {
    fireHandoffSighting(UPSKILL_LINK_VALUE);
    await flushAsync();

    const calls = notificationCreateCalls();
    expect(calls).toHaveLength(1);
    const [, options] = calls[0];
    expect(options.title).toBe('Slicc skill available');
    expect(options.message).toContain('github.com/adobe/skills');
    expect(options.message).toContain('plugins/aem/edge-delivery-services');
  });

  it('includes the instruction in the handoff toast', async () => {
    fireHandoffSighting(
      '</>; rel="https://www.sliccy.ai/rel/handoff"; title="Summarize this page and file an issue"',
      'https://example.com/page'
    );
    await flushAsync();

    const calls = notificationCreateCalls();
    expect(calls).toHaveLength(1);
    const [, options] = calls[0];
    expect(options.title).toBe('Slicc handoff received');
    expect(options.message).toContain('Summarize this page and file an issue');
  });

  it('truncates a long handoff instruction in the toast', async () => {
    const instruction = 'x'.repeat(300);
    fireHandoffSighting(
      `</>; rel="https://www.sliccy.ai/rel/handoff"; title="${instruction}"`,
      'https://example.com/long'
    );
    await flushAsync();

    const [, options] = notificationCreateCalls()[0];
    expect(options.message).toContain('…');
    expect(options.message).not.toContain('x'.repeat(200));
  });

  it('handles DA sign-and-forward by attaching the IMS bearer token', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      capturedUrl = String(url);
      capturedAuth = init?.headers?.['Authorization'] ?? '';
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const reply = (await dispatchAndCaptureResponse({
        type: 'mount.da-sign-and-forward',
        envelope: {
          imsToken: 'ims-token-xyz',
          method: 'GET',
          path: '/source/my-org/my-repo/index.html',
        },
      })) as { ok: true; status: number };

      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(capturedUrl).toBe('https://admin.da.live/source/my-org/my-repo/index.html');
      expect(capturedAuth).toBe('Bearer ims-token-xyz');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- Discovery setting (autodiscover agentic resources) --------------------

  /** Reload the SW module with a specific persisted discovery setting. */
  async function reloadWithDiscoverySetting(value: unknown): Promise<void> {
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    chromeMock.storage.local.get.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'slicc_discovery_enabled' ? { slicc_discovery_enabled: value } : {}
    );
    runtimeExternalMessageListeners.length = 0;
    storageChangedListeners.length = 0;
    vi.resetModules();
    await loadServiceWorker();
    await flushAsync();
  }

  it('skips the discovery probe when the persisted setting is disabled', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await reloadWithDiscoverySetting(false);
      // The discovery observer is the SECOND onHeadersReceived listener.
      const discoveryListener = headersReceivedListeners[1];
      expect(discoveryListener).toBeTruthy();
      discoveryListener?.({ url: 'https://ex.com/', tabId: 1, responseHeaders: [] });
      await flushAsync();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed: no probe on a cold-start navigation before the setting has loaded', async () => {
    // FIX 2 (PR #1457): on MV3 cold boot the onHeadersReceived listener is
    // registered synchronously, so the navigation that woke the worker can fire
    // BEFORE the async chrome.storage.local.get resolves. If the cached flag
    // defaulted to ON in that window, a user who stored OFF would still get a
    // probe on that first navigation. Discovery must be treated as disabled while
    // the stored value is unknown.
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    // Defer the discovery storage read so it resolves only when we choose.
    let resolveGet: (v: Record<string, unknown>) => void = () => {};
    const pending = new Promise<Record<string, unknown>>((r) => {
      resolveGet = r;
    });
    chromeMock.storage.local.get.mockImplementation((...args: unknown[]) =>
      args[0] === 'slicc_discovery_enabled' ? pending : Promise.resolve({})
    );
    runtimeExternalMessageListeners.length = 0;
    storageChangedListeners.length = 0;
    vi.resetModules();
    try {
      await loadServiceWorker();
      // Storage read NOT yet resolved — the cold-boot window.
      const discoveryListener = headersReceivedListeners[1];
      expect(discoveryListener).toBeTruthy();
      discoveryListener?.({ url: 'https://ex.com/', tabId: 1, responseHeaders: [] });
      await flushAsync();
      expect(fetchMock).not.toHaveBeenCalled();
      // Resolve to the stored OFF value; the gate stays closed.
      resolveGet({ slicc_discovery_enabled: false });
      await flushAsync();
      discoveryListener?.({ url: 'https://ex2.com/', tabId: 1, responseHeaders: [] });
      await flushAsync();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs the discovery probe when the setting is enabled (default)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await reloadWithDiscoverySetting(undefined);
      const discoveryListener = headersReceivedListeners[1];
      discoveryListener?.({ url: 'https://ex.com/', tabId: 1, responseHeaders: [] });
      await flushAsync();
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('persists discovery.set-enabled from an allowed leader origin', async () => {
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    const listener = runtimeExternalMessageListeners[0];
    expect(listener).toBeTruthy();
    listener?.(
      { type: 'discovery.set-enabled', enabled: false },
      { origin: 'https://www.sliccy.ai' },
      () => {}
    );
    await flushAsync();
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({ slicc_discovery_enabled: false });
  });

  it('ignores discovery.set-enabled from a non-allowlisted origin', async () => {
    const chromeMock = (
      globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }
    ).chrome;
    const listener = runtimeExternalMessageListeners[0];
    listener?.(
      { type: 'discovery.set-enabled', enabled: false },
      { origin: 'https://evil.example' },
      () => {}
    );
    await flushAsync();
    expect(chromeMock.storage.local.set).not.toHaveBeenCalledWith({
      slicc_discovery_enabled: false,
    });
  });
});

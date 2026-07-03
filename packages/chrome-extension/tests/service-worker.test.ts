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
const runtimeSentMessages: unknown[] = [];
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
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
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
      onInstalled: {
        addListener: vi.fn(),
      },
      onStartup: {
        addListener: vi.fn(),
      },
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
          headersReceivedListener = listener;
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
  await import('../src/service-worker.js');
}

describe('extension service worker', () => {
  beforeEach(async () => {
    runtimeMessageListeners.length = 0;
    runtimeSentMessages.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    MockWebSocket.instances.length = 0;
    headersReceivedListener = null;
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
});

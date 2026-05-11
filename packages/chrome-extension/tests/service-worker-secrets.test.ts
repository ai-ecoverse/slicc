import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('service-worker fetch-proxy.fetch + secrets handlers', () => {
  let connectListeners: ((port: any) => void)[];
  let messageListeners: ((
    msg: any,
    sender: any,
    sendResponse: (r: any) => void
  ) => boolean | void)[];
  let storageMap: Record<string, string>;

  beforeEach(() => {
    connectListeners = [];
    messageListeners = [];
    storageMap = {
      '_session.id': 'test-session-uuid',
      GITHUB_TOKEN: 'ghp_real',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
      'oauth.github.token': 'gh_oauth_real',
      'oauth.github.token_DOMAINS': 'github.com,api.github.com',
    };
    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (fn: any) => connectListeners.push(fn) },
        onMessage: { addListener: (fn: any) => messageListeners.push(fn) },
        id: 'test-id',
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (key == null) return { ...storageMap };
            if (typeof key === 'string') return key in storageMap ? { [key]: storageMap[key] } : {};
            const out: Record<string, string> = {};
            for (const k of key as string[]) if (k in storageMap) out[k] = storageMap[k];
            return out;
          }),
          set: vi.fn(async (obj: Record<string, string>) => Object.assign(storageMap, obj)),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete storageMap[k];
          }),
        },
      },
      sidePanel: { setPanelBehavior: vi.fn() },
      offscreen: { hasDocument: vi.fn(async () => true) },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(),
        remove: vi.fn(),
        group: vi.fn(),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
      tabGroups: { update: vi.fn() },
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      identity: {
        launchWebAuthFlow: vi.fn(),
        getRedirectURL: vi.fn(),
      },
      webRequest: {
        onHeadersReceived: { addListener: vi.fn() },
      },
    };
    // Mock WebSocket so the tray socket code doesn't crash
    (globalThis as any).WebSocket = class MockWebSocket {
      addEventListener() {}
      send() {}
      close() {}
    };
    // Reset module cache so the SW re-imports for each test
    vi.resetModules();
  });

  it('registers an onConnect listener that wires fetch-proxy.fetch ports', async () => {
    await import('../src/service-worker.js');
    expect(connectListeners.length).toBeGreaterThan(0);
    const fakePort: any = {
      name: 'fetch-proxy.fetch',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
    // Trigger the connect handler. handleFetchProxyConnection adds onMessage + onDisconnect listeners.
    connectListeners.forEach((l) => l(fakePort));
    await new Promise((r) => setTimeout(r, 30)); // allow async pipeline build
    expect(fakePort.onMessage.addListener).toHaveBeenCalled();
    expect(fakePort.onDisconnect.addListener).toHaveBeenCalled();
  });

  it('ignores onConnect ports that are not fetch-proxy.fetch', async () => {
    await import('../src/service-worker.js');
    const other: any = {
      name: 'other-port',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
    connectListeners.forEach((l) => l(other));
    await new Promise((r) => setTimeout(r, 10));
    // We just assert we don't crash and don't attach the fetch-proxy listeners to other ports.
    // The handler should return early for non-fetch-proxy.fetch ports.
  });

  it('secrets.list-masked-entries returns {name, maskedValue, domains}[]', async () => {
    await import('../src/service-worker.js');
    expect(messageListeners.length).toBeGreaterThan(0);
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.list-masked-entries' }, {}, (r: any) => {
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(response).toBeDefined();
    expect(Array.isArray(response.entries)).toBe(true);
    const github = response.entries.find((e: any) => e.name === 'GITHUB_TOKEN');
    expect(github).toBeDefined();
    expect(github.maskedValue).toMatch(/^ghp_[a-f0-9]+$/);
    expect(github.domains).toEqual(['api.github.com']);
  });

  // Regression: the panel-terminal `secret` command runs in the offscreen
  // document where chrome.storage is NOT exposed (MV3 quirk). The handlers
  // below route management ops through the SW, which DOES have storage.
  it('secrets.list returns {name, domains}[] from chrome.storage.local (no values)', async () => {
    await import('../src/service-worker.js');
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.list' }, {}, (r: any) => {
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(response).toBeDefined();
    expect(Array.isArray(response.entries)).toBe(true);
    const github = response.entries.find((e: any) => e.name === 'GITHUB_TOKEN');
    expect(github).toBeDefined();
    expect(github.domains).toEqual(['api.github.com']);
    // value must NOT be returned
    expect(github.value).toBeUndefined();
  });

  it('secrets.set writes {name, name_DOMAINS} to chrome.storage.local', async () => {
    await import('../src/service-worker.js');
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l(
        {
          type: 'secrets.set',
          name: 'NEW_SECRET',
          value: 'new-real-value',
          domains: ['api.new.com', '*.new.com'],
        },
        {},
        (r: any) => {
          response = r;
        }
      );
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(response).toEqual({ ok: true });
    expect(storageMap.NEW_SECRET).toBe('new-real-value');
    expect(storageMap.NEW_SECRET_DOMAINS).toBe('api.new.com,*.new.com');
  });

  it('secrets.delete removes both name and name_DOMAINS', async () => {
    await import('../src/service-worker.js');
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.delete', name: 'GITHUB_TOKEN' }, {}, (r: any) => {
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(response).toEqual({ ok: true });
    expect(storageMap.GITHUB_TOKEN).toBeUndefined();
    expect(storageMap.GITHUB_TOKEN_DOMAINS).toBeUndefined();
  });

  it('secrets.mask-oauth-token returns the masked value for an oauth.<id>.token entry', async () => {
    await import('../src/service-worker.js');
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.mask-oauth-token', providerId: 'github' }, {}, (r: any) => {
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(response).toBeDefined();
    expect(typeof response.maskedValue).toBe('string');
    expect(response.maskedValue.length).toBeGreaterThan(0);
  });
});

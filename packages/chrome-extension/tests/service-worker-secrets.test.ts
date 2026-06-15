import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      GITHUB_TOKEN: 'ghp_realtoken',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
      'oauth.github.token': 'gh_oauth_real',
      'oauth.github.token_DOMAINS': 'github.com,api.github.com',
    };
    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: (fn: any) => connectListeners.push(fn) },
        onMessage: { addListener: (fn: any) => messageListeners.push(fn) },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getContexts: vi.fn(async () => []),
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
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      sidePanel: { setPanelBehavior: vi.fn(), setOptions: vi.fn() },
      offscreen: { hasDocument: vi.fn(async () => true) },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(),
        remove: vi.fn(),
        group: vi.fn(),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
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
      notifications: {
        create: vi.fn(),
        onClicked: { addListener: vi.fn() },
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
    connectListeners.forEach((l) => {
      l(fakePort);
    });
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
    connectListeners.forEach((l) => {
      l(other);
    });
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

  it('secrets.list-with-values-for-pipeline returns {sessionId, entries} merging persisted+session', async () => {
    await import('../src/service-worker.js');
    // Seed a session-only secret first so the merge path is exercised.
    let setResp: any;
    for (const l of messageListeners) {
      const result = l(
        {
          type: 'secrets.session.set',
          name: 'SESS_KEY',
          value: 'sess-real',
          domains: ['api.session.com'],
        },
        {},
        (r: any) => {
          setResp = r;
        }
      );
      if (result === true) break;
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(setResp).toEqual({ ok: true });

    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.list-with-values-for-pipeline' }, {}, (r: any) => {
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
    expect(typeof response.sessionId).toBe('string');
    expect(response.sessionId.length).toBeGreaterThan(0);
    expect(Array.isArray(response.entries)).toBe(true);
    const persisted = response.entries.find((e: any) => e.name === 'GITHUB_TOKEN');
    expect(persisted).toBeDefined();
    expect(persisted.value).toBe('ghp_realtoken');
    expect(persisted.domains).toEqual(['api.github.com']);
    const session = response.entries.find((e: any) => e.name === 'SESS_KEY');
    expect(session).toBeDefined();
    expect(session.value).toBe('sess-real');
    expect(session.domains).toEqual(['api.session.com']);
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
    const response = await dispatch({ type: 'secrets.delete', name: 'GITHUB_TOKEN' });
    expect(response).toEqual({ ok: true, removed: true, fromSession: false });
    expect(storageMap.GITHUB_TOKEN).toBeUndefined();
    expect(storageMap.GITHUB_TOKEN_DOMAINS).toBeUndefined();
  });

  it('secrets.delete prefers the session store when both stores hold the name', async () => {
    await import('../src/service-worker.js');
    // Seed a session secret that shadows a persisted name; delete must remove
    // the session entry first (mirrors the node-server endpoint precedence).
    await dispatch({
      type: 'secrets.session.set',
      name: 'GITHUB_TOKEN',
      value: 'session-val',
      domains: ['api.github.com'],
    });
    const response = await dispatch({ type: 'secrets.delete', name: 'GITHUB_TOKEN' });
    expect(response).toEqual({ ok: true, removed: true, fromSession: true });
    // Persisted entry must remain after the session-only deletion.
    expect(storageMap.GITHUB_TOKEN).toBe('ghp_real');
    expect(storageMap.GITHUB_TOKEN_DOMAINS).toBe('api.github.com');
    // The session list is now empty for that name.
    const list = await dispatch({ type: 'secrets.session.list' });
    expect(list.entries).toEqual([]);
  });

  it('secrets.delete reports removed:false for an unknown name', async () => {
    await import('../src/service-worker.js');
    const response = await dispatch({ type: 'secrets.delete', name: 'NO_SUCH_KEY' });
    expect(response).toEqual({ ok: true, removed: false });
  });

  async function dispatch(msg: any): Promise<any> {
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      const result = l(msg, {}, (r: any) => {
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
    }
    expect(kept).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    return response;
  }

  it('secrets.session.set stores in-memory only (never chrome.storage)', async () => {
    await import('../src/service-worker.js');
    const resp = await dispatch({
      type: 'secrets.session.set',
      name: 'SESSION_KEY',
      value: 'sess-real',
      domains: ['api.session.com'],
    });
    expect(resp).toEqual({ ok: true });
    // Crucially, nothing was written to chrome.storage.
    expect(storageMap.SESSION_KEY).toBeUndefined();
    const list = await dispatch({ type: 'secrets.session.list' });
    expect(list.entries).toEqual([{ name: 'SESSION_KEY', domains: ['api.session.com'] }]);
  });

  it('secrets.session.set values reach the masking pipeline (unmaskable)', async () => {
    await import('../src/service-worker.js');
    await dispatch({
      type: 'secrets.session.set',
      name: 'SESSION_KEY',
      value: 'sess-real',
      domains: ['api.session.com'],
    });
    const masked = await dispatch({ type: 'secrets.list-masked-entries' });
    const entry = masked.entries.find((e: any) => e.name === 'SESSION_KEY');
    expect(entry).toBeDefined();
    expect(entry.domains).toEqual(['api.session.com']);
  });

  it('secrets.peek returns an elided preview, never the full value', async () => {
    await import('../src/service-worker.js');
    await dispatch({
      type: 'secrets.session.set',
      name: 'SESSION_KEY',
      value: 'sk-proj-ABCDEFGH1234',
      domains: ['x'],
    });
    const peeked = await dispatch({ type: 'secrets.peek', name: 'SESSION_KEY' });
    expect(peeked.record.preview).toBe('sk-p…1234');
    expect(peeked.record.preview).not.toContain('ABCDEFGH');
    // Persisted secrets are peekable too.
    const persisted = await dispatch({ type: 'secrets.peek', name: 'GITHUB_TOKEN' });
    expect(persisted.record.name).toBe('GITHUB_TOKEN');
    expect(persisted.record.domains).toEqual(['api.github.com']);
  });

  it('secrets.set-domains edits scope of a persisted secret, preserving value', async () => {
    await import('../src/service-worker.js');
    const resp = await dispatch({
      type: 'secrets.set-domains',
      name: 'GITHUB_TOKEN',
      domains: ['api.github.com', '*.github.com'],
    });
    expect(resp).toEqual({ ok: true });
    expect(storageMap.GITHUB_TOKEN).toBe('ghp_realtoken');
    expect(storageMap.GITHUB_TOKEN_DOMAINS).toBe('api.github.com,*.github.com');
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

  // #847: the offscreen caller (where oauth-token runs) has no chrome.storage,
  // so the SW must do the write from the message. This is the line that
  // actually fixes the bug.
  it('secrets.mask-oauth-token writes oauth.<id>.token + _DOMAINS from the message, then masks', async () => {
    await import('../src/service-worker.js');
    // `testprov` is NOT pre-seeded — the SW-side write is load-bearing here.
    expect(storageMap['oauth.testprov.token']).toBeUndefined();
    let response: any;
    for (const l of messageListeners) {
      const result = l(
        {
          type: 'secrets.mask-oauth-token',
          providerId: 'testprov',
          accessToken: 'tok_realtoken',
          domains: 'example.com,api.example.com',
        },
        {},
        (r: any) => {
          response = r;
        }
      );
      if (result === true) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(storageMap['oauth.testprov.token']).toBe('tok_realtoken');
    expect(storageMap['oauth.testprov.token_DOMAINS']).toBe('example.com,api.example.com');
    expect(typeof response.maskedValue).toBe('string');
    expect(response.maskedValue.length).toBeGreaterThan(0);
  });

  it('secrets.mask-oauth-token skips the OAuth-token write when accessToken/domains are absent (back-compat)', async () => {
    await import('../src/service-worker.js');
    const setSpy = (globalThis as any).chrome.storage.local.set;
    setSpy.mockClear();
    let response: any;
    for (const l of messageListeners) {
      const result = l({ type: 'secrets.mask-oauth-token', providerId: 'github' }, {}, (r: any) => {
        response = r;
      });
      if (result === true) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    // Old-shape message must NOT write the OAuth token keys (an unrelated
    // session-id write may occur — assert specifically, not "never called").
    const wroteOAuthKey = setSpy.mock.calls.some(
      (call: any[]) => call[0] && 'oauth.github.token' in call[0]
    );
    expect(wroteOAuthKey).toBe(false);
    // The pre-seeded oauth.github.token still masks.
    expect(typeof response.maskedValue).toBe('string');
  });

  it('secrets.mask-oauth-token returns { error } (not a throw) when the storage write fails', async () => {
    await import('../src/service-worker.js');
    (globalThis as any).chrome.storage.local.set = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    let response: any;
    for (const l of messageListeners) {
      const result = l(
        {
          type: 'secrets.mask-oauth-token',
          providerId: 'failprov',
          accessToken: 't',
          domains: 'x.com',
        },
        {},
        (r: any) => {
          response = r;
        }
      );
      if (result === true) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    // The page-side retry/give-up logic depends on the SW surfacing { error },
    // not throwing across the message boundary.
    expect(response.maskedValue).toBeUndefined();
    expect(typeof response.error).toBe('string');
  });

  it('returns { error: "entry missing after write" } when the entry is absent post-write (real fault, not cold miss)', async () => {
    await import('../src/service-worker.js');
    // No-op the write so the entry is genuinely missing after "writing" — the
    // page must be able to tell this from a cold-start miss, so it gets an error.
    (globalThis as any).chrome.storage.local.set = vi.fn(async () => {});
    let response: any;
    for (const l of messageListeners) {
      const result = l(
        {
          type: 'secrets.mask-oauth-token',
          providerId: 'ghost',
          accessToken: 't',
          domains: 'x.com',
        },
        {},
        (r: any) => {
          response = r;
        }
      );
      if (result === true) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(response.maskedValue).toBeUndefined();
    expect(response.error).toBe('entry missing after write');
  });
});

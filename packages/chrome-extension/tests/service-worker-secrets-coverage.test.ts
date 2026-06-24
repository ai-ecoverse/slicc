// Branch-coverage tests targeting the refactored type-narrowing helpers
// (`getMsgType` / `getStringField` / `getStringArrayField`), the
// dispatcher fallthroughs (no `type`, `type` non-string, unknown
// `type`), per-handler missing-field early returns, and the error
// catch paths in the SECRETS_HANDLERS registry — the new branches
// introduced by the boy-scout refactor in PR #1012 that the
// pre-existing service-worker-secrets suite did not exercise.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MsgListener = (msg: any, sender: any, sendResponse: (r: any) => void) => boolean | void;

describe('service-worker secrets handlers — branch coverage', () => {
  let messageListeners: MsgListener[];
  let storageMap: Record<string, string>;

  function buildChromeMock(overrides?: { localGet?: any; localSet?: any; localRemove?: any }) {
    const localGet =
      overrides?.localGet ??
      vi.fn(async (key?: string | string[] | null) => {
        if (key == null) return { ...storageMap };
        if (typeof key === 'string') return key in storageMap ? { [key]: storageMap[key] } : {};
        const out: Record<string, string> = {};
        for (const k of key as string[]) if (k in storageMap) out[k] = storageMap[k];
        return out;
      });
    const localSet =
      overrides?.localSet ??
      vi.fn(async (obj: Record<string, string>) => Object.assign(storageMap, obj));
    const localRemove =
      overrides?.localRemove ??
      vi.fn(async (keys: string | string[]) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete storageMap[k];
      });
    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: vi.fn() },
        onConnectExternal: { addListener: vi.fn() },
        onMessage: { addListener: (fn: MsgListener) => messageListeners.push(fn) },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getContexts: vi.fn(async () => []),
        id: 'test-id',
      },
      storage: {
        local: { get: localGet, set: localSet, remove: localRemove },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
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
      identity: { launchWebAuthFlow: vi.fn(), getRedirectURL: vi.fn() },
      notifications: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
      webRequest: { onHeadersReceived: { addListener: vi.fn() } },
    };
  }

  beforeEach(() => {
    messageListeners = [];
    storageMap = {
      '_session.id': 'test-session-uuid',
      GITHUB_TOKEN: 'ghp_real',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
    };
    buildChromeMock();
    (globalThis as any).WebSocket = class MockWebSocket {
      addEventListener() {}
      send() {}
      close() {}
    };
    vi.resetModules();
    // Silence the expected console.error noise from the negative paths so
    // the suite output stays clean. Each test still asserts response shape.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /**
   * Drives the SW's `onMessage` listener exactly like the production
   * runtime: each registered listener is invoked in order until one
   * returns `true` (kept-port for async response) or all return falsy
   * (no handler claimed the message). Returns the listener's boolean
   * return and the response (if `sendResponse` was called).
   */
  async function dispatch(msg: any): Promise<{ kept: boolean; response: any }> {
    await import('../src/service-worker.js');
    let response: any;
    let kept = false;
    for (const l of messageListeners) {
      let captured = false;
      const result = l(msg, {}, (r: any) => {
        captured = true;
        response = r;
      });
      if (result === true) {
        kept = true;
        break;
      }
      if (captured) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    return { kept, response };
  }

  // --- getMsgType branches ----------------------------------------------

  it('listener returns false when msg is undefined (getMsgType: not an object)', async () => {
    const { kept, response } = await dispatch(undefined);
    expect(kept).toBe(false);
    expect(response).toBeUndefined();
  });

  it('listener returns false when msg is null (getMsgType: msg === null branch)', async () => {
    const { kept, response } = await dispatch(null);
    expect(kept).toBe(false);
    expect(response).toBeUndefined();
  });

  it('listener returns false when msg has no "type" field (getMsgType: !("type" in msg))', async () => {
    const { kept, response } = await dispatch({ name: 'X' });
    expect(kept).toBe(false);
    expect(response).toBeUndefined();
  });

  it('listener returns false when msg.type is not a string (getMsgType: typeof t !== "string")', async () => {
    const { kept, response } = await dispatch({ type: 42 });
    expect(kept).toBe(false);
    expect(response).toBeUndefined();
  });

  it('listener returns false for an unknown message type (dispatcher: no handler)', async () => {
    const { kept, response } = await dispatch({ type: 'secrets.nope.unknown' });
    expect(kept).toBe(false);
    expect(response).toBeUndefined();
  });

  // --- per-handler missing-field early returns --------------------------

  it('secrets.scrub-tool-result returns false when text field is missing (getStringField undefined)', async () => {
    const { kept } = await dispatch({ type: 'secrets.scrub-tool-result' });
    expect(kept).toBe(false);
  });

  it('secrets.scrub-tool-result returns false when text is the wrong type (number, not string)', async () => {
    const { kept } = await dispatch({ type: 'secrets.scrub-tool-result', text: 123 });
    expect(kept).toBe(false);
  });

  it('secrets.scrub-tool-result success path runs the pipeline against the text', async () => {
    const { kept, response } = await dispatch({
      type: 'secrets.scrub-tool-result',
      text: 'hello no secrets here',
    });
    expect(kept).toBe(true);
    expect(typeof response.text).toBe('string');
  });

  it('secrets.set returns false when name is missing', async () => {
    const { kept } = await dispatch({
      type: 'secrets.set',
      value: 'v',
      domains: ['x'],
    });
    expect(kept).toBe(false);
  });

  it('secrets.set returns false when value is missing', async () => {
    const { kept } = await dispatch({
      type: 'secrets.set',
      name: 'N',
      domains: ['x'],
    });
    expect(kept).toBe(false);
  });

  it('secrets.set returns false when domains is missing entirely (not an array on the wire)', async () => {
    const { kept } = await dispatch({ type: 'secrets.set', name: 'N', value: 'v' });
    expect(kept).toBe(false);
  });

  it('secrets.set returns false when domains is the wrong type (getStringArrayField: !Array.isArray)', async () => {
    const { kept } = await dispatch({
      type: 'secrets.set',
      name: 'N',
      value: 'v',
      domains: 'not-an-array',
    });
    expect(kept).toBe(false);
  });

  it('secrets.set filters non-string entries from a heterogeneous domains array', async () => {
    // getStringArrayField uses `.filter((d): d is string => typeof d === 'string')`
    // — the branch that drops non-string elements. The handler must still
    // accept the call (kept=true) and the persisted _DOMAINS must contain
    // only the string entries.
    const { kept, response } = await dispatch({
      type: 'secrets.set',
      name: 'MIXED_KEY',
      value: 'v',
      domains: ['api.ok.com', 42, null, 'api.also.com'],
    });
    expect(kept).toBe(true);
    expect(response).toEqual({ ok: true });
    expect(storageMap.MIXED_KEY_DOMAINS).toBe('api.ok.com,api.also.com');
  });

  it('secrets.delete returns false when name is missing', async () => {
    const { kept } = await dispatch({ type: 'secrets.delete' });
    expect(kept).toBe(false);
  });

  it('secrets.session.set returns false when any required field is missing', async () => {
    const { kept } = await dispatch({
      type: 'secrets.session.set',
      name: 'N',
      // value + domains missing
    });
    expect(kept).toBe(false);
  });

  it('secrets.peek returns false when name is missing', async () => {
    const { kept } = await dispatch({ type: 'secrets.peek' });
    expect(kept).toBe(false);
  });

  it('secrets.peek returns { record: undefined } for an unknown name (neither session nor persisted)', async () => {
    const { kept, response } = await dispatch({
      type: 'secrets.peek',
      name: 'NO_SUCH_SECRET',
    });
    expect(kept).toBe(true);
    expect(response).toEqual({ record: undefined });
  });

  it('secrets.set-domains returns false when name is missing', async () => {
    const { kept } = await dispatch({
      type: 'secrets.set-domains',
      domains: ['x'],
    });
    expect(kept).toBe(false);
  });

  it('secrets.set-domains returns false when domains is missing', async () => {
    const { kept } = await dispatch({
      type: 'secrets.set-domains',
      name: 'GITHUB_TOKEN',
    });
    expect(kept).toBe(false);
  });

  it('secrets.set-domains takes the session-shadow branch when a session entry exists', async () => {
    await dispatch({
      type: 'secrets.session.set',
      name: 'SESS_SCOPE',
      value: 'v',
      domains: ['api.old.com'],
    });
    const { kept, response } = await dispatch({
      type: 'secrets.set-domains',
      name: 'SESS_SCOPE',
      domains: ['api.new.com', '*.new.com'],
    });
    expect(kept).toBe(true);
    expect(response).toEqual({ ok: true });
    // Session-secret scope edit must NOT touch chrome.storage.
    expect(storageMap.SESS_SCOPE).toBeUndefined();
    expect(storageMap.SESS_SCOPE_DOMAINS).toBeUndefined();
    const list = await dispatch({ type: 'secrets.session.list' });
    expect(list.response.entries).toEqual([
      { name: 'SESS_SCOPE', domains: ['api.new.com', '*.new.com'] },
    ]);
  });

  it('secrets.set-domains reports { ok: false, error } when no such secret exists (line 1390 branch)', async () => {
    const { kept, response } = await dispatch({
      type: 'secrets.set-domains',
      name: 'NEVER_EXISTED',
      domains: ['x.com'],
    });
    expect(kept).toBe(true);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('no secret named "NEVER_EXISTED"');
  });

  it('secrets.mask-oauth-token returns false when providerId is missing', async () => {
    const { kept } = await dispatch({ type: 'secrets.mask-oauth-token' });
    expect(kept).toBe(false);
  });

  // --- error catch paths (storage throws) -------------------------------

  it('secrets.list surfaces { error } when chrome.storage.local.get rejects (catch branch)', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { kept, response } = await dispatch({ type: 'secrets.list' });
    expect(kept).toBe(true);
    expect(response.entries).toEqual([]);
    expect(response.error).toBe('boom');
  });

  it('secrets.set surfaces { ok: false, error } when chrome.storage.local.set rejects', async () => {
    buildChromeMock({
      localSet: vi.fn(async () => {
        throw new Error('quota');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.set',
      name: 'X',
      value: 'v',
      domains: ['api.x.com'],
    });
    expect(kept).toBe(true);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('quota');
  });

  it('secrets.delete surfaces { ok: false, error } when chrome.storage.local rejects', async () => {
    buildChromeMock({
      localRemove: vi.fn(async () => {
        throw new Error('disk-full');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.delete',
      name: 'GITHUB_TOKEN',
    });
    expect(kept).toBe(true);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('disk-full');
  });

  it('secrets.peek surfaces { error } when chrome.storage.local.get rejects', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('peek-fail');
      }),
    });
    const { kept, response } = await dispatch({ type: 'secrets.peek', name: 'GITHUB_TOKEN' });
    expect(kept).toBe(true);
    expect(response.record).toBeUndefined();
    expect(response.error).toBe('peek-fail');
  });

  it('secrets.set-domains surfaces { ok: false, error } when chrome.storage.local.get rejects', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('lookup-fail');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.set-domains',
      name: 'GITHUB_TOKEN',
      domains: ['api.x.com'],
    });
    expect(kept).toBe(true);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('lookup-fail');
  });

  it('secrets.scrub-tool-result degrades to { text, error } when the pipeline build throws (catch branch)', async () => {
    // Force the pipeline to fail on this call by making the SW-session-id
    // read reject. The handler MUST return the input text plus the error
    // — agents must never lose tool output to a transient SW issue.
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('pipeline-fail');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.scrub-tool-result',
      text: 'some tool output',
    });
    expect(kept).toBe(true);
    expect(response.text).toBe('some tool output');
    expect(typeof response.error).toBe('string');
  });

  it('secrets.list-with-values-for-pipeline surfaces { entries: [], error } on a chrome.storage failure', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('pipeline-list-fail');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.list-with-values-for-pipeline',
    });
    expect(kept).toBe(true);
    expect(response.entries).toEqual([]);
    expect(typeof response.error).toBe('string');
  });

  it('secrets.list-masked-entries surfaces { entries: [], error } on a chrome.storage failure', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        throw new Error('masked-fail');
      }),
    });
    const { kept, response } = await dispatch({
      type: 'secrets.list-masked-entries',
    });
    expect(kept).toBe(true);
    expect(response.entries).toEqual([]);
    expect(typeof response.error).toBe('string');
  });

  // --- errMsg(err) non-Error branch --------------------------------------

  it('non-Error rejections are stringified by errMsg in the response error', async () => {
    buildChromeMock({
      localGet: vi.fn(async () => {
        // Reject with a plain string (not an Error instance) to hit
        // the `String(err)` branch of `errMsg`.
        throw 'plain-string-reject';
      }),
    });
    const { kept, response } = await dispatch({ type: 'secrets.list' });
    expect(kept).toBe(true);
    expect(response.error).toBe('plain-string-reject');
  });
});

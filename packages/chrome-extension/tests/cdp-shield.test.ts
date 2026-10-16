import { describe, expect, it, vi } from 'vitest';
import {
  cookieRefused,
  dropProtectedCookies,
  GUARD_FETCH_PATTERN,
  initScriptGuard,
  mentions,
  namesProtectedStorage,
  patternMatches,
  redacted,
  TabShield,
  webSocketAsHttp,
} from '../src/cdp-shield.js';

const PLAIN = 'https://example.com/page';
const VAULT = 'https://vault.sliccy.ai/unlock?k=secret';
const SEVEN = 'https://seven.sliccy.ai/os/';

function makeShield() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: 1,
        entries: [
          { id: 1, url: PLAIN },
          { id: 2, url: VAULT },
        ],
      };
    }
    return {};
  });
  const onBlocked = vi.fn();
  const shield = new TabShield(send, onBlocked);
  const forward = vi.fn(async (_method: string, params?: Record<string, unknown>) => ({
    echoed: params,
  }));
  return { shield, sent, send, onBlocked, forward };
}

function paused(url: string, resourceType = 'Document', extra: Record<string, unknown> = {}) {
  return {
    requestId: `interception-${Math.random()}`,
    request: { url, method: 'GET', headers: {} },
    frameId: 'F1',
    resourceType,
    networkId: `net-${Math.random()}`,
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TabShield.install', () => {
  it('arms a backend-owned Document/Request Fetch pattern and bypasses service workers', async () => {
    const { shield, sent } = makeShield();
    await shield.install();
    expect(sent[0]).toEqual({
      method: 'Fetch.enable',
      params: { patterns: [GUARD_FETCH_PATTERN], handleAuthRequests: false },
    });
    expect(sent[1]).toEqual({ method: 'Network.setBypassServiceWorker', params: { bypass: true } });
  });

  it('propagates a failed install so the bridge can detach (fail closed)', async () => {
    const shield = new TabShield(async () => {
      throw new Error('nope');
    }, vi.fn());
    await expect(shield.install()).rejects.toThrow('nope');
  });
});

describe('C1/C2/C4: pre-commit Fetch block (init script + self-navigation, redirects, iframes)', () => {
  it('continues a plain document unseen, but fails a protected one before it commits', async () => {
    const { shield, sent } = makeShield();

    const plain = paused(PLAIN);
    expect(shield.onEvent('Fetch.requestPaused', plain)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: plain.requestId },
    });

    const vault = paused(VAULT);
    expect(shield.onEvent('Fetch.requestPaused', vault)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: vault.requestId, errorReason: 'BlockedByClient' },
    });
    expect(
      sent.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.['requestId'] === vault.requestId
      )
    ).toBe(false);
  });

  it('fails each redirect hop that lands on a protected origin', async () => {
    const { shield, sent } = makeShield();

    const hop1 = paused('https://example.com/redirect?to=example.org', 'Document', {
      redirectedRequestId: 'r0',
    });
    shield.onEvent('Fetch.requestPaused', hop1);

    const hop2 = paused(SEVEN, 'Document', { redirectedRequestId: hop1.requestId });
    shield.onEvent('Fetch.requestPaused', hop2);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: hop1.requestId },
    });
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: hop2.requestId, errorReason: 'BlockedByClient' },
    });
  });

  it('fails a protected subframe document the same way as a main frame', async () => {
    const { shield, sent } = makeShield();
    const plainFrame = paused('https://example.org/embed', 'Document', { frameId: 'CHILD' });
    shield.onEvent('Fetch.requestPaused', plainFrame);
    const vaultFrame = paused('https://vault.sliccy.ai/embed', 'Document', { frameId: 'CHILD2' });
    shield.onEvent('Fetch.requestPaused', vaultFrame);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: plainFrame.requestId },
    });
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: vaultFrame.requestId, errorReason: 'BlockedByClient' },
    });
    expect(shield.failedBeforeCommit('https://vault.sliccy.ai/embed')).toBe(true);
    expect(shield.failedBeforeCommit('https://example.org/embed')).toBe(false);
  });

  it('prefixes init scripts with a guard that throws on a protected origin only', async () => {
    const { shield, forward } = makeShield();
    await shield.command(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: 'self.__ran = true;' },
      forward
    );
    const source = String(forward.mock.calls[0]?.[1]?.['source']);
    expect(source.startsWith(initScriptGuard())).toBe(true);
    const runIn = (origin: string) => {
      const self: { origin: string; __ran?: boolean } = { origin };
      new Function('self', source)(self);
      return self.__ran === true;
    };

    expect(runIn('https://example.com')).toBe(true);
    expect(runIn('null')).toBe(true);

    expect(() => runIn('https://vault.sliccy.ai')).toThrow(/refused/);
    expect(() => runIn('https://main--seven.sliccy.ai')).toThrow(/refused/);
    expect(() => runIn('http://sliccy.ai.')).toThrow(/refused/);
  });

  it('also guards the legacy addScriptToEvaluateOnLoad', async () => {
    const { shield, forward } = makeShield();
    await shield.command('Page.addScriptToEvaluateOnLoad', { scriptSource: 'x()' }, forward);
    expect(String(forward.mock.calls[0]?.[1]?.['scriptSource'])).toBe(`${initScriptGuard()}x()`);
  });

  it('blocks the tab when a protected document commits anyway (post-commit backstop)', () => {
    const { shield, onBlocked } = makeShield();

    shield.onEvent('Page.frameNavigated', {
      frame: { id: 'F1', url: PLAIN, securityOrigin: 'https://example.com' },
    });
    shield.onEvent('Runtime.executionContextCreated', {
      context: {
        id: 1,
        origin: 'https://example.com',
        auxData: { frameId: 'F1', isDefault: true },
      },
    });

    shield.onEvent('Runtime.executionContextCreated', {
      context: {
        id: 2,
        origin: 'https://seven.sliccy.ai',
        auxData: { frameId: 'F1', isDefault: false },
      },
    });
    expect(onBlocked).not.toHaveBeenCalled();
    shield.onEvent('Page.frameNavigated', {
      frame: { id: 'F1', url: VAULT, securityOrigin: 'https://vault.sliccy.ai' },
    });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(shield.blocked).toBe(true);
  });

  it('blocks on a default context created on a protected origin', () => {
    const { shield, onBlocked } = makeShield();
    shield.onEvent('Runtime.executionContextCreated', {
      context: { id: 3, origin: 'https://sliccy.ai', auxData: { frameId: 'F9', isDefault: true } },
    });
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('refuses every command once blocked', async () => {
    const { shield, forward } = makeShield();
    await expect(
      shield.command('Runtime.evaluate', { expression: '1' }, forward)
    ).resolves.toBeDefined();
    shield.block();
    shield.block();
    await expect(shield.command('Runtime.evaluate', { expression: '1' }, forward)).rejects.toThrow(
      /refused/
    );
  });

  it('refuses a result that arrives after the tab was blocked mid-command', async () => {
    const { shield } = makeShield();
    const forward = vi.fn(async () => {
      shield.block();
      return { result: { value: 'secret' } };
    });
    await expect(shield.command('Runtime.evaluate', { expression: '1' }, forward)).rejects.toThrow(
      /refused/
    );
  });
});

describe('C5: client Fetch interception', () => {
  it('merges client patterns with the guard pattern and forwards only wanted, plain pauses', async () => {
    const { shield, forward, sent } = makeShield();
    const clientPatterns = [{ urlPattern: '*', resourceType: 'Document' }];
    await shield.command('Fetch.enable', { patterns: clientPatterns }, forward);
    expect(forward).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [GUARD_FETCH_PATTERN, ...clientPatterns],
      handleAuthRequests: false,
    });

    const plain = paused(PLAIN);
    expect(shield.onEvent('Fetch.requestPaused', plain)).toEqual([
      { method: 'Fetch.requestPaused', params: plain },
    ]);
    await expect(
      shield.command(
        'Fetch.fulfillRequest',
        { requestId: plain.requestId, responseCode: 200, body: '' },
        forward
      )
    ).resolves.toBeDefined();

    const vault = paused(VAULT);
    expect(shield.onEvent('Fetch.requestPaused', vault)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: vault.requestId, errorReason: 'BlockedByClient' },
    });

    await expect(
      shield.command(
        'Fetch.fulfillRequest',
        { requestId: vault.requestId, responseCode: 200, body: '' },
        forward
      )
    ).rejects.toThrow(/not paused toward this client/);
  });

  it('continues protected sub-resources and requests initiated by a protected page without forwarding', async () => {
    const { shield, forward, sent } = makeShield();
    await shield.command('Fetch.enable', {}, forward);

    const plainXhr = paused('https://example.com/api', 'XHR');
    expect(shield.onEvent('Fetch.requestPaused', plainXhr)).toHaveLength(1);
    const vaultXhr = paused('wss://vault.sliccy.ai/socket', 'WebSocket');
    expect(shield.onEvent('Fetch.requestPaused', vaultXhr)).toEqual([]);
    const fromSeven = paused('https://cdn.example/lib.js', 'Script', {
      request: {
        url: 'https://cdn.example/lib.js',
        headers: { Referer: 'https://seven.sliccy.ai/' },
      },
    });
    expect(shield.onEvent('Fetch.requestPaused', fromSeven)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: vaultXhr.requestId },
    });
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: fromSeven.requestId },
    });

    await expect(
      shield.command('Network.getResponseBody', { requestId: plainXhr.networkId }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Network.getResponseBody', { requestId: vaultXhr.networkId }, forward)
    ).rejects.toThrow(/refused/);
  });

  it('refuses a continueRequest that rewrites the URL into the vault', async () => {
    const { shield, forward } = makeShield();
    await shield.command('Fetch.enable', {}, forward);
    const plain = paused(PLAIN);
    shield.onEvent('Fetch.requestPaused', plain);
    await expect(
      shield.command(
        'Fetch.continueRequest',
        { requestId: plain.requestId, url: 'https://example.org/' },
        forward
      )
    ).resolves.toBeDefined();
    const plain2 = paused(PLAIN);
    shield.onEvent('Fetch.requestPaused', plain2);
    await expect(
      shield.command('Fetch.continueRequest', { requestId: plain2.requestId, url: VAULT }, forward)
    ).rejects.toThrow(/refused/);
  });

  it('keeps the guard armed across Fetch.disable and stops forwarding', async () => {
    const { shield, forward, sent } = makeShield();
    await shield.command(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*' }], handleAuthRequests: true },
      forward
    );
    const before = paused(PLAIN);
    expect(shield.onEvent('Fetch.requestPaused', before)).toHaveLength(1);
    await expect(shield.command('Fetch.disable', {}, forward)).resolves.toEqual({});
    await flush();
    expect(forward).not.toHaveBeenCalledWith('Fetch.disable', expect.anything());
    expect(sent).toContainEqual({
      method: 'Fetch.enable',
      params: { patterns: [GUARD_FETCH_PATTERN], handleAuthRequests: false },
    });
    expect(shield.onEvent('Fetch.requestPaused', paused(PLAIN))).toEqual([]);
  });

  it('blocks the tab if re-arming the guard on Fetch.disable fails', async () => {
    const onBlocked = vi.fn();
    const shield = new TabShield(async () => {
      throw new Error('gone');
    }, onBlocked);
    await shield.command('Fetch.disable', {}, vi.fn());
    await flush();
    expect(onBlocked).toHaveBeenCalled();
  });

  it('forwards auth challenges only for plain URLs the client asked about', async () => {
    const { shield, forward, sent } = makeShield();

    const early = { requestId: 'a0', request: { url: PLAIN } };
    expect(shield.onEvent('Fetch.authRequired', early)).toEqual([]);
    await shield.command('Fetch.enable', { handleAuthRequests: true }, forward);
    const plain = {
      requestId: 'a1',
      request: { url: PLAIN },
      authChallenge: { origin: 'https://example.com' },
    };
    expect(shield.onEvent('Fetch.authRequired', plain)).toEqual([
      { method: 'Fetch.authRequired', params: plain },
    ]);
    const vault = { requestId: 'a2', request: { url: VAULT } };
    expect(shield.onEvent('Fetch.authRequired', vault)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueWithAuth',
      params: { requestId: 'a0', authChallengeResponse: { response: 'Default' } },
    });
    expect(sent).toContainEqual({
      method: 'Fetch.continueWithAuth',
      params: { requestId: 'a2', authChallengeResponse: { response: 'Default' } },
    });
  });

  it('matches CDP request patterns (wildcards, escapes, resource type, stage)', () => {
    const req = { request: { url: 'https://example.com/a?b' }, resourceType: 'Document' };
    expect(patternMatches({ urlPattern: '*example.com*' }, req)).toBe(true);
    expect(patternMatches({ urlPattern: 'https://example.com/?\\?b' }, req)).toBe(true);
    expect(patternMatches({ urlPattern: '*example.org*' }, req)).toBe(false);
    expect(patternMatches({ resourceType: 'Script' }, req)).toBe(false);
    expect(patternMatches({ requestStage: 'Response' }, req)).toBe(false);
    expect(patternMatches({ requestStage: 'Response' }, { ...req, responseStatusCode: 200 })).toBe(
      true
    );
    expect(patternMatches(null, req)).toBe(false);
  });
});

describe('C6: cookies and storage', () => {
  it('filters cookie readers and refuses setters for seven, after a plain control', async () => {
    const { shield } = makeShield();
    const jar = {
      cookies: [
        { name: 'ok', domain: 'example.com' },
        { name: 'vault', domain: 'vault.sliccy.ai' },
        { name: 'apex', domain: '.sliccy.ai' },
        {
          name: 'chips',
          domain: 'example.com',
          partitionKey: { topLevelSite: 'https://sliccy.ai' },
        },
      ],
    };
    const reader = vi.fn(async () => structuredClone(jar));
    for (const method of ['Network.getCookies', 'Network.getAllCookies', 'Storage.getCookies']) {
      const result = await shield.command(method, { urls: [VAULT, PLAIN] }, reader);

      expect(result['cookies']).toEqual([{ name: 'ok', domain: 'example.com' }]);
    }
    const setter = vi.fn(async () => ({}));
    await expect(
      shield.command('Network.setCookie', { name: 'a', value: '1', url: PLAIN }, setter)
    ).resolves.toEqual({});
    await expect(
      shield.command('Network.setCookie', { name: 'a', value: '1', url: VAULT }, setter)
    ).rejects.toThrow(/cookie is on seven/);
    await expect(
      shield.command(
        'Network.setCookies',
        { cookies: [{ name: 'a', domain: 'example.com' }] },
        setter
      )
    ).resolves.toEqual({});
    await expect(
      shield.command(
        'Storage.setCookies',
        {
          cookies: [
            { name: 'a', domain: 'example.com' },
            { name: 'b', domain: '.sliccy.ai' },
          ],
        },
        setter
      )
    ).rejects.toThrow(/cookie is on seven/);
    await expect(
      shield.command('Network.deleteCookies', { name: 'x', url: PLAIN }, setter)
    ).resolves.toEqual({});
    await expect(
      shield.command('Network.deleteCookies', { name: 'x', domain: 'sliccy.ai' }, setter)
    ).rejects.toThrow(/cookie is on seven/);
    expect(setter).toHaveBeenCalledTimes(3);
  });

  it('refuses storage / origin-keyed params for seven, after a plain control', async () => {
    const { shield, forward } = makeShield();
    await expect(
      shield.command('Storage.getStorageKeyForFrame', { frameId: 'F1' }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command(
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: 'https://example.com', isLocalStorage: true } },
        forward
      )
    ).resolves.toBeDefined();
    await expect(
      shield.command(
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: 'https://vault.sliccy.ai', isLocalStorage: true } },
        forward
      )
    ).rejects.toThrow(/refused/);
    await expect(
      shield.command(
        'IndexedDB.requestDatabaseNames',
        { storageKey: 'https://seven.sliccy.ai/' },
        forward
      )
    ).rejects.toThrow(/refused/);
    await expect(
      shield.command(
        'CacheStorage.requestEntries',
        { cacheId: 'https://seven.sliccy.ai/|c1' },
        forward
      )
    ).rejects.toThrow(/refused/);

    await expect(
      shield.command('Runtime.evaluate', { expression: "'https://vault.sliccy.ai'" }, forward)
    ).resolves.toBeDefined();
  });
});

describe('outright refusals and URL / history / frame checks', () => {
  it('refuses browser-reaching methods but runs ordinary ones', async () => {
    const { shield, forward } = makeShield();
    await expect(shield.command('Page.reload', {}, forward)).resolves.toBeDefined();
    for (const method of [
      'Security.setIgnoreCertificateErrors',
      'Target.exposeDevToolsProtocol',
      'Target.sendMessageToTarget',
      'Target.attachToBrowserTarget',
      'Tracing.start',
      'Extensions.loadUnpacked',
      'Network.clearBrowserCookies',
      'Storage.clearCookies',
      'Browser.resetPermissions',
    ]) {
      await expect(shield.command(method, {}, forward)).rejects.toThrow(/^slicc: refused: /);
    }
    await expect(
      shield.command(
        'Browser.grantPermissions',
        { origin: 'https://example.com', permissions: [] },
        forward
      )
    ).resolves.toBeDefined();
    await expect(
      shield.command('Browser.grantPermissions', { permissions: ['geolocation'] }, forward)
    ).rejects.toThrow(/refused/);
    await expect(
      shield.command('Target.setAutoAttach', { autoAttach: false }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Target.setAutoAttach', { autoAttach: true, flatten: true }, forward)
    ).rejects.toThrow(/auto-attach/);
    await expect(
      shield.command('Network.setBypassServiceWorker', { bypass: true }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Network.setBypassServiceWorker', { bypass: false }, forward)
    ).rejects.toThrow(/service workers/);
  });

  it('refuses protected url params (incl. ws) after a plain control', async () => {
    const { shield, forward } = makeShield();
    await expect(shield.command('Page.navigate', { url: PLAIN }, forward)).resolves.toBeDefined();
    await expect(shield.command('Page.navigate', { url: SEVEN }, forward)).rejects.toThrow(
      /refused/
    );
    await expect(
      shield.command('Network.loadNetworkResource', { url: 'wss://vault.sliccy.ai/x' }, forward)
    ).rejects.toThrow(/refused/);
  });

  it('checks history entries before navigating to them', async () => {
    const { shield, forward } = makeShield();
    await expect(
      shield.command('Page.navigateToHistoryEntry', { entryId: 1 }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Page.navigateToHistoryEntry', { entryId: 2 }, forward)
    ).rejects.toThrow(/refused/);
  });

  it('refuses commands addressed to a frame known to be protected', async () => {
    const { shield, forward } = makeShield();
    shield.onEvent('Page.frameNavigated', {
      frame: { id: 'PLAIN', parentId: 'F1', url: PLAIN, securityOrigin: 'https://example.com' },
    });
    shield.onEvent('Page.frameNavigated', {
      frame: { id: 'VAULT', parentId: 'F1', url: VAULT, securityOrigin: 'https://vault.sliccy.ai' },
    });
    await expect(
      shield.command('Page.createIsolatedWorld', { frameId: 'PLAIN' }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Page.createIsolatedWorld', { frameId: 'VAULT' }, forward)
    ).rejects.toThrow(/refused/);
  });

  it('refuses body reads for unseen or protected requests', async () => {
    const { shield, forward } = makeShield();
    shield.onEvent('Network.requestWillBeSent', {
      requestId: 'n1',
      request: { url: PLAIN },
      documentURL: PLAIN,
    });
    shield.onEvent('Network.requestWillBeSent', {
      requestId: 'n2',
      request: { url: 'https://cdn.example/x' },
      documentURL: VAULT,
    });
    await expect(
      shield.command('Network.getResponseBody', { requestId: 'n1' }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command('Network.getResponseBody', { requestId: 'n2' }, forward)
    ).rejects.toThrow(/refused/);
    await expect(
      shield.command('Network.getResponseBody', { requestId: 'never' }, forward)
    ).rejects.toThrow(/not seen/);
    await expect(shield.command('Network.getResponseBody', {}, forward)).rejects.toThrow(
      /not seen/
    );
  });

  it('allows IO.read only on streams the shield saw opened', async () => {
    const { shield } = makeShield();
    const opener = vi.fn(async () => ({ stream: 'h1', resource: { stream: 'h2' } }));
    await shield.command('Fetch.enable', {}, opener);
    await shield.command('IO.read', { handle: 'h1' }, opener);
    await shield.command('IO.read', { handle: 'h2' }, opener);
    await expect(shield.command('IO.read', { handle: 'h3' }, opener)).rejects.toThrow(
      /stream handle/
    );
  });

  it('redacts a protected Target.getTargetInfo result but not a plain one', async () => {
    const { shield } = makeShield();
    const plain = await shield.command('Target.getTargetInfo', {}, async () => ({
      targetInfo: { url: PLAIN, title: 'p' },
    }));
    expect(plain['targetInfo']).toEqual({ url: PLAIN, title: 'p' });
    const vault = await shield.command('Target.getTargetInfo', {}, async () => ({
      targetInfo: { url: VAULT, title: 'secret' },
    }));
    expect(vault['targetInfo']).toEqual({
      url: 'https://vault.sliccy.ai',
      title: 'https://vault.sliccy.ai',
    });
  });
});

describe('event redaction', () => {
  it('delivers plain network events and drops protected ones', () => {
    const { shield } = makeShield();
    const plain = { requestId: 'n1', request: { url: PLAIN } };
    expect(shield.onEvent('Network.requestWillBeSent', plain)).toEqual([
      { method: 'Network.requestWillBeSent', params: plain },
    ]);
    expect(shield.onEvent('Network.loadingFinished', { requestId: 'n1' })).toHaveLength(1);
    expect(
      shield.onEvent('Network.requestWillBeSent', { requestId: 'n2', request: { url: VAULT } })
    ).toEqual([]);
    expect(shield.onEvent('Network.loadingFinished', { requestId: 'n2' })).toEqual([]);
    expect(
      shield.onEvent('Network.webSocketCreated', {
        requestId: 'n3',
        url: 'wss://seven.sliccy.ai/ws',
      })
    ).toEqual([]);
    expect(
      shield.onEvent('Runtime.consoleAPICalled', {
        args: [{ value: 'see https://vault.sliccy.ai/' }],
      })
    ).toHaveLength(1);
    expect(
      shield.onEvent('Runtime.consoleAPICalled', { args: [{ value: 'https://vault.sliccy.ai/' }] })
    ).toEqual([]);
  });

  it('holds ExtraInfo until its request is known, then releases or drops it', () => {
    const { shield } = makeShield();
    const plainExtra = {
      requestId: 'e1',
      headers: { cookie: 'a=1' },
      associatedCookies: [
        { cookie: { name: 'a', domain: 'example.com' } },
        { cookie: { name: 'v', domain: 'vault.sliccy.ai' } },
      ],
    };
    expect(shield.onEvent('Network.requestWillBeSentExtraInfo', plainExtra)).toEqual([]);
    const released = shield.onEvent('Network.requestWillBeSent', {
      requestId: 'e1',
      request: { url: PLAIN },
    });
    expect(released.map((e) => e.method)).toEqual([
      'Network.requestWillBeSent',
      'Network.requestWillBeSentExtraInfo',
    ]);
    expect(released[1]?.params?.['associatedCookies']).toEqual([
      { cookie: { name: 'a', domain: 'example.com' } },
    ]);

    expect(
      shield.onEvent('Network.responseReceivedExtraInfo', { requestId: 'e1', headers: {} })
    ).toHaveLength(1);

    expect(
      shield.onEvent('Network.requestWillBeSentExtraInfo', {
        requestId: 'e2',
        headers: { cookie: 'v=1' },
      })
    ).toEqual([]);
    expect(
      shield.onEvent('Network.requestWillBeSent', { requestId: 'e2', request: { url: VAULT } })
    ).toEqual([]);
    expect(
      shield.onEvent('Network.responseReceivedExtraInfo', { requestId: 'e2', headers: {} })
    ).toEqual([]);
  });

  it('redacts protected Target events to the origin, leaves plain ones alone', () => {
    const { shield } = makeShield();
    const plain = { targetInfo: { targetId: 'T1', url: PLAIN, title: 'p' } };
    expect(shield.onEvent('Target.targetCreated', plain)).toEqual([
      { method: 'Target.targetCreated', params: plain },
    ]);
    expect(
      shield.onEvent('Target.targetInfoChanged', {
        targetInfo: { targetId: 'T2', url: VAULT, title: 'secret' },
      })
    ).toEqual([
      {
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: 'T2',
            url: 'https://vault.sliccy.ai',
            title: 'https://vault.sliccy.ai',
          },
        },
      },
    ]);

    const blank = shield.onEvent('Target.targetCreated', {
      targetInfo: { targetId: 'T3', url: 'about:blank', openerId: 'T2', title: 'x' },
    });
    expect(blank[0]?.params?.['targetInfo']).toMatchObject({
      url: 'about:blank',
      title: 'about:blank',
    });
    expect(shield.onEvent('Target.detachedFromTarget', { sessionId: 'S' })).toHaveLength(1);
  });
});

describe('pure helpers', () => {
  it('mirror shield.rs semantics', () => {
    expect(webSocketAsHttp('WSS://seven.sliccy.ai/ws')).toBe('https://seven.sliccy.ai/ws');
    expect(webSocketAsHttp('ws://a/')).toBe('http://a/');
    expect(webSocketAsHttp('https://a/')).toBe('https://a/');
    expect(mentions({ request: { url: 'wss://seven.sliccy.ai/ws' } })).toBe(true);
    expect(mentions({ url: 'https://example.com/?next=https://seven.sliccy.ai/' })).toBe(false);
    expect(mentions([1, null, 'plain'])).toBe(false);
    expect(
      namesProtectedStorage({
        bucketFileSystemLocator: { storageKey: 'https://sliccy.ai/', pathComponents: [] },
      })
    ).toBe(true);
    expect(
      namesProtectedStorage({ storageKey: 'https://example.com/^0https://seven.sliccy.ai' })
    ).toBe(true);
    expect(namesProtectedStorage({ value: { origin: 'https://seven.sliccy.ai' } })).toBe(false);
    expect(namesProtectedStorage({ origin: 42 })).toBe(false);
    expect(
      cookieRefused({ name: 'x', url: 'https://example.com/', partitionKey: 'https://sliccy.ai' })
    ).toBe(true);
    expect(cookieRefused({ name: 'x', domain: '.' })).toBe(false);
    expect(cookieRefused({ name: 'x', domain: 'ai' })).toBe(true);
    const result: Record<string, unknown> = { cookies: [{ domain: 'x.sliccy.ai' }, 'junk'] };
    dropProtectedCookies(result);
    expect(result['cookies']).toEqual(['junk']);
    expect(redacted({ url: 'not a url', title: 't' })).toEqual({
      url: 'about:blank',
      title: 'about:blank',
    });
  });
});

describe('C5 protectVectors (slicc-cli@2d5d981)', () => {
  const ORDINARY = 'https://example.com';
  const PROTECTED = 'https://vault.sliccy.ai';
  const bothStages = {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  };

  async function vector(dest: string, resourceType: string) {
    const { shield, forward, sent } = makeShield();
    await shield.command('Fetch.enable', bothStages, forward);
    const request = paused(`${dest}/x?n=1`, resourceType);
    const seenRequest = shield.onEvent('Fetch.requestPaused', request).length > 0;
    const response = { ...paused(`${dest}/x?n=1`, resourceType), responseStatusCode: 200 };
    const seenResponse = shield.onEvent('Fetch.requestPaused', response).length > 0;
    const fulfilled = await shield
      .command(
        'Fetch.fulfillRequest',
        { requestId: request.requestId, responseCode: 200, body: '' },
        forward
      )
      .then(
        () => true,
        () => false
      );
    await flush();
    const answeredByBackend = sent.some((c) => c.params?.['requestId'] === request.requestId);
    return { seen: seenRequest || seenResponse, fulfilled, answeredByBackend };
  }

  it.each([
    ['C5.document', 'Document'],
    ['C5.fetch', 'Fetch'],
    ['C5.xhr', 'XHR'],
    ['C5.image', 'Image'],
  ])(
    '%s: control is paused + fulfillable; protected is never seen and answered by the backend',
    async (_id, type) => {
      expect(await vector(ORDINARY, type)).toEqual({
        seen: true,
        fulfilled: true,
        answeredByBackend: false,
      });
      expect(await vector(PROTECTED, type)).toEqual({
        seen: false,
        fulfilled: false,
        answeredByBackend: true,
      });
    }
  );

  it('C5.auth: control challenge reaches the client; protected one is answered Default, untouched', async () => {
    const { shield, forward, sent } = makeShield();
    await shield.command(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*' }], handleAuthRequests: true },
      forward
    );
    const control = { requestId: 'c1', request: { url: `${ORDINARY}/auth` } };
    expect(shield.onEvent('Fetch.authRequired', control)).toHaveLength(1);
    await expect(
      shield.command(
        'Fetch.continueWithAuth',
        {
          requestId: 'c1',
          authChallengeResponse: { response: 'ProvideCredentials', username: 'u', password: 'p' },
        },
        forward
      )
    ).resolves.toBeDefined();
    const vault = { requestId: 'v1', request: { url: `${PROTECTED}/auth` } };
    expect(shield.onEvent('Fetch.authRequired', vault)).toEqual([]);
    await expect(
      shield.command(
        'Fetch.continueWithAuth',
        {
          requestId: 'v1',
          authChallengeResponse: { response: 'ProvideCredentials', username: 'u', password: 'p' },
        },
        forward
      )
    ).rejects.toThrow(/not paused toward this client/);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueWithAuth',
      params: { requestId: 'v1', authChallengeResponse: { response: 'Default' } },
    });
  });

  it('C5.guessed-id: ids the client was given work; every guessed id in between is refused', async () => {
    const { shield, forward } = makeShield();
    await shield.command(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      forward
    );
    const before = {
      ...paused(`${ORDINARY}/data?n=a`, 'Fetch'),
      requestId: 'interception-job-10.0',
    };
    const probe = {
      ...paused(`${PROTECTED}/data?n=p`, 'Fetch'),
      requestId: 'interception-job-11.0',
    };
    const after = {
      ...paused(`${ORDINARY}/data?n=b`, 'Fetch'),
      requestId: 'interception-job-12.0',
    };
    for (const e of [before, probe, after]) shield.onEvent('Fetch.requestPaused', e);
    for (const method of [
      'Fetch.fulfillRequest',
      'Fetch.continueRequest',
      'Fetch.failRequest',
      'Fetch.continueResponse',
      'Fetch.getResponseBody',
      'Fetch.takeResponseBodyAsStream',
      'Fetch.continueWithAuth',
    ]) {
      await expect(shield.command(method, { requestId: probe.requestId }, forward)).rejects.toThrow(
        /not paused toward this client/
      );
    }
    await expect(
      shield.command(
        'Fetch.fulfillRequest',
        { requestId: before.requestId, responseCode: 200, body: '' },
        forward
      )
    ).resolves.toBeDefined();
    await expect(
      shield.command('Fetch.continueRequest', { requestId: after.requestId }, forward)
    ).resolves.toBeDefined();
  });
});

describe('Codex round on #3986', () => {
  const tree = (child: { id: string; url: string; securityOrigin?: string }) => ({
    frameTree: {
      frame: { id: 'TOP', url: PLAIN, securityOrigin: 'https://example.com' },
      childFrames: [{ frame: child, childFrames: [] }],
    },
  });

  it('inventories existing frames: a plain subframe arms; a protected one refuses the session', async () => {
    const arm = (frameTree: unknown) => {
      const shield = new TabShield(
        async (method) =>
          method === 'Page.getFrameTree' ? (frameTree as Record<string, unknown>) : {},
        vi.fn()
      );
      return { shield, done: shield.install() };
    };

    const plain = arm(
      tree({ id: 'KID', url: 'https://example.org/embed', securityOrigin: 'https://example.org' })
    );
    await expect(plain.done).resolves.toBeUndefined();
    await expect(
      plain.shield.command(
        'Page.createIsolatedWorld',
        { frameId: 'KID' },
        vi.fn(async () => ({}))
      )
    ).resolves.toBeDefined();

    const vault = arm(
      tree({
        id: 'VKID',
        url: 'https://vault.sliccy.ai/embed',
        securityOrigin: 'https://vault.sliccy.ai',
      })
    );
    await expect(vault.done).rejects.toThrow(/refused/);

    const blank = arm(
      tree({ id: 'B', url: 'about:blank', securityOrigin: 'https://seven.sliccy.ai' })
    );
    await expect(blank.done).rejects.toThrow(/refused/);
  });

  it('shares one arming promise between concurrent installs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const send = vi.fn(async (method: string) => {
      if (method === 'Fetch.enable') await gate;
      return {};
    });
    const shield = new TabShield(send, vi.fn());
    const first = shield.install();
    const second = shield.install();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    release();
    await second;
    expect(send.mock.calls.filter(([m]) => m === 'Fetch.enable')).toHaveLength(1);
  });

  it('redacts protected Page.getNavigationHistory entries, leaves plain ones', async () => {
    const { shield } = makeShield();
    const history = {
      currentIndex: 2,
      entries: [
        { id: 1, url: PLAIN, userTypedURL: PLAIN, title: 'plain' },
        { id: 2, url: VAULT, userTypedURL: VAULT, title: 'Vault secret' },
        {
          id: 3,
          url: 'https://example.org/',
          userTypedURL: 'https://seven.sliccy.ai/os/?k=1',
          title: 't',
        },
        'junk',
      ],
    };
    const result = await shield.command('Page.getNavigationHistory', {}, async () =>
      structuredClone(history)
    );
    const entries = result['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual(history.entries[0]);
    expect(entries[1]).toEqual({
      id: 2,
      url: 'https://vault.sliccy.ai',
      userTypedURL: 'https://vault.sliccy.ai',
      title: 'https://vault.sliccy.ai',
    });
    expect(entries[2]).toMatchObject({
      url: 'https://seven.sliccy.ai',
      title: 'https://seven.sliccy.ai',
    });
    expect(entries[3]).toBe('junk');
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});

describe('settled pauses (guard vectors C5.guessed-id / C5.auth)', () => {
  it('an answered pause id cannot be answered again; an unanswered one still can', async () => {
    const { shield, forward } = makeShield();
    await shield.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, forward);
    const a = paused(PLAIN, 'Fetch');
    const b = paused(PLAIN, 'Fetch');
    shield.onEvent('Fetch.requestPaused', a);
    shield.onEvent('Fetch.requestPaused', b);

    await expect(
      shield.command('Fetch.continueRequest', { requestId: a.requestId }, forward)
    ).resolves.toBeDefined();
    await expect(
      shield.command(
        'Fetch.fulfillRequest',
        { requestId: b.requestId, responseCode: 200, body: '' },
        forward
      )
    ).resolves.toBeDefined();

    for (const method of [
      'Fetch.fulfillRequest',
      'Fetch.continueRequest',
      'Fetch.failRequest',
      'Fetch.continueWithAuth',
    ]) {
      await expect(shield.command(method, { requestId: a.requestId }, forward)).rejects.toThrow(
        /not paused toward this client/
      );
    }
  });

  it('keeps an id answerable after a failed answer, but drops it when Chrome no longer knows it', async () => {
    const { shield } = makeShield();
    await shield.command(
      'Fetch.enable',
      {},
      vi.fn(async () => ({}))
    );
    const a = paused(PLAIN, 'Fetch');
    shield.onEvent('Fetch.requestPaused', a);
    const bad = vi.fn(async () => {
      throw new Error('Invalid parameters');
    });
    await expect(
      shield.command('Fetch.fulfillRequest', { requestId: a.requestId }, bad)
    ).rejects.toThrow('Invalid parameters');
    const ok = vi.fn(async () => ({}));
    await expect(
      shield.command('Fetch.fulfillRequest', { requestId: a.requestId, responseCode: 200 }, ok)
    ).resolves.toBeDefined();
    const c = paused(PLAIN, 'Fetch');
    shield.onEvent('Fetch.requestPaused', c);
    const gone = vi.fn(async () => {
      throw new Error('{"code":-32602,"message":"Invalid InterceptionId."}');
    });
    await expect(
      shield.command('Fetch.continueRequest', { requestId: c.requestId }, gone)
    ).rejects.toThrow(/Invalid InterceptionId/);
    await expect(
      shield.command('Fetch.continueRequest', { requestId: c.requestId }, ok)
    ).rejects.toThrow(/not paused toward this client/);
  });
});

describe('concurrent settling answers (Codex #4014)', () => {
  it('a duplicate answer sent while the first is in flight is refused by the shield', async () => {
    const { shield } = makeShield();
    await shield.command(
      'Fetch.enable',
      {},
      vi.fn(async () => ({}))
    );
    const a = paused(PLAIN, 'Fetch');
    shield.onEvent('Fetch.requestPaused', a);
    let release: () => void = () => {};
    const slow = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          release = () => resolve({});
        })
    );

    const first = shield.command('Fetch.continueRequest', { requestId: a.requestId }, slow);

    await expect(
      shield.command('Fetch.fulfillRequest', { requestId: a.requestId, responseCode: 200 }, slow)
    ).rejects.toThrow(/not paused toward this client/);
    release();
    await expect(first).resolves.toBeDefined();
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

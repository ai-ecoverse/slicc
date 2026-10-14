/**
 * B24-4: unit tests for the CDP shield (cdp-shield.ts).
 *
 * Every refusal / redaction case runs its POSITIVE CONTROL first: the same
 * setup and trigger against a plain origin must succeed (forwarded, sent,
 * delivered), and only then is the protected variant asserted to fail. The
 * real-browser counterpart is packages/dev-tools/tools/extension-cdp-shield-check.ts.
 */
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
    // Control: a plain self-navigation the client did not ask to intercept is
    // continued by the shield and never shown to the client.
    const plain = paused(PLAIN);
    expect(shield.onEvent('Fetch.requestPaused', plain)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: plain.requestId },
    });
    // Protected: location.href = vault → failed with BlockedByClient, never forwarded.
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
    // Control: hop 1 (plain → plain) continues.
    const hop1 = paused('https://example.com/redirect?to=example.org', 'Document', {
      redirectedRequestId: 'r0',
    });
    shield.onEvent('Fetch.requestPaused', hop1);
    // Protected: hop 2 lands on seven → failed.
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
    // Control: the client's script runs on a plain origin.
    expect(runIn('https://example.com')).toBe(true);
    expect(runIn('null')).toBe(true);
    // Protected: it throws before the client's code on seven / the vault.
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
    // Control: plain main-frame commits and plain contexts leave the tab alone.
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
    // An isolated world on seven (e.g. an extension's) is not the page's own.
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
    // Control: a plain document pause reaches the client and may be fulfilled.
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
    // Protected: a vault document pause is never shown and is failed instead.
    const vault = paused(VAULT);
    expect(shield.onEvent('Fetch.requestPaused', vault)).toEqual([]);
    await flush();
    expect(sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: vault.requestId, errorReason: 'BlockedByClient' },
    });
    // …and the client cannot answer (fulfill) a pause it was never shown.
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
    // Control: a plain XHR reaches the client (default pattern = everything at Request).
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
    // A Network body read for the protected request is refused; the plain one is allowed.
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
    // Without handleAuthRequests, even a plain challenge is answered Default.
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
      params: { requestId: 'a2', authChallengeResponse: { response: 'CancelAuth' } },
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
      // Control: the plain cookie survives; protected ones are dropped.
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
    // Free-form text that merely names seven is not an origin parameter.
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
    // Once known plain, later ExtraInfo flows straight through.
    expect(
      shield.onEvent('Network.responseReceivedExtraInfo', { requestId: 'e1', headers: {} })
    ).toHaveLength(1);
    // Protected: the held ExtraInfo is dropped with its request.
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
    // A blank popup with an opener may have inherited seven's origin.
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

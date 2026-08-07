import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import { teleportTabOneWay } from '../../../src/scoops/tray-leader/tab-teleport.js';

interface FakeBrowserOptions {
  sourceUrl?: string;
  cookies?: Array<Record<string, unknown>>;
  storage?: { origin: string; localStorage: Record<string, string> };
  failGetCookies?: boolean;
  failStorageCapture?: boolean;
  failSetCookies?: boolean;
  hangNavigate?: boolean;
}

function createFakeBrowser(options: FakeBrowserOptions = {}) {
  const sourceUrl = options.sourceUrl ?? 'https://app.example.com/dash';
  const cookies = options.cookies ?? [{ name: 'session', value: 's3cret', domain: '.example.com' }];
  const storage = options.storage ?? {
    origin: 'https://app.example.com',
    localStorage: { k: 'v' },
  };
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let attached = '';
  const browser = {
    attachToPage: vi.fn(async (targetId: string) => {
      attached = targetId;
    }),
    evaluate: vi.fn(async (script: string) => {
      if (script === 'window.location.href') return sourceUrl;
      if (options.failStorageCapture) throw new Error('no storage access');
      return JSON.stringify({
        origin: storage.origin,
        localStorage: storage.localStorage,
        sessionStorage: {},
      });
    }),
    sendCDP: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Network.getCookies') {
        if (options.failGetCookies) throw new Error('Network domain unavailable');
        return { cookies };
      }
      if (method === 'Network.setCookies' && options.failSetCookies) {
        throw new Error('cookie injection refused');
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Page.navigate') {
        if (options.hangNavigate) return new Promise<never>(() => {});
        return {};
      }
      return {};
    }),
    createPage: vi.fn(async () => 'local-new-tab'),
    createRemotePage: vi.fn(async (_runtimeId: string) => 'remote-new-tab'),
    closePage: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    get attachedTarget() {
      return attached;
    },
  };
  return { browser: browser as unknown as BrowserAPI, fake: browser, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('teleportTabOneWay', () => {
  it('captures state, opens a foreground copy at the leader, and leaves both tabs open', async () => {
    const { browser, fake, calls } = createFakeBrowser();
    const result = await teleportTabOneWay(browser, {
      sourceTargetId: 'runtime-1:tab-9',
      destination: { kind: 'leader' },
    });

    expect(result).toEqual({
      targetId: 'local-new-tab',
      url: 'https://app.example.com/dash',
      cookieCount: 1,
      storageEntryCount: 1,
      degraded: 'none',
    });
    // Cookies were planted BEFORE navigation.
    const methods = calls.map((c) => c.method);
    expect(methods.indexOf('Network.setCookies')).toBeGreaterThan(-1);
    expect(methods.indexOf('Network.setCookies')).toBeLessThan(methods.indexOf('Page.navigate'));
    expect(fake.bringToFront).toHaveBeenCalled();
    expect(fake.closePage).not.toHaveBeenCalled();
  });

  it('opens the copy on a remote runtime with a composite target id', async () => {
    const { browser, fake } = createFakeBrowser();
    const result = await teleportTabOneWay(browser, {
      sourceTargetId: 'leader-tab',
      destination: { kind: 'runtime', runtimeId: 'runtime-2' },
    });
    expect(fake.createRemotePage).toHaveBeenCalledWith('runtime-2', 'about:blank');
    expect(result.targetId).toBe('runtime-2:remote-new-tab');
  });

  it('degrades to a bare URL open when no source state can be captured', async () => {
    const { browser, calls } = createFakeBrowser({
      failGetCookies: true,
      failStorageCapture: true,
    });
    const result = await teleportTabOneWay(browser, {
      sourceTargetId: 'runtime-1:tab-9',
      destination: { kind: 'leader' },
    });
    expect(result.degraded).toBe('no-source-state');
    expect(result.cookieCount).toBe(0);
    expect(calls.map((c) => c.method)).toContain('Page.navigate');
    expect(calls.map((c) => c.method)).not.toContain('Network.setCookies');
  });

  it('reports no-source-cookies when only the cookies could not be captured', async () => {
    // Storage travelled, so this is not `no-source-state` — but a
    // cookie-authenticated site still lands logged out, which the caller
    // must be able to see rather than reading `none`.
    const { browser, calls } = createFakeBrowser({ failGetCookies: true });
    const result = await teleportTabOneWay(browser, {
      sourceTargetId: 'runtime-1:tab-9',
      destination: { kind: 'leader' },
    });
    expect(result.degraded).toBe('no-source-cookies');
    expect(result.storageEntryCount).toBe(1);
    expect(calls.map((c) => c.method)).toContain('Page.addScriptToEvaluateOnNewDocument');
  });

  it('reports no-dest-cookies when the destination rejects cookie injection', async () => {
    const { browser, calls } = createFakeBrowser({ failSetCookies: true });
    const result = await teleportTabOneWay(browser, {
      sourceTargetId: 'runtime-1:tab-9',
      destination: { kind: 'leader' },
    });
    expect(result.degraded).toBe('no-dest-cookies');
    // Storage replay still installs and navigation still happens.
    expect(calls.map((c) => c.method)).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(calls.map((c) => c.method)).toContain('Page.navigate');
  });

  it("refuses to teleport SLICC's own app tab (it carries a bridge capability)", async () => {
    // The float's URL carries `bridgeToken`; copying that tab would hand the
    // capability to another machine. Enforced in the primitive so every path
    // — both rails and the tray router — is covered.
    const { browser, fake } = createFakeBrowser({
      sourceUrl:
        'https://www.sliccy.ai/?bridge=ws%3A%2F%2Flocalhost%3A5715%2Fcdp&bridgeToken=s3cret',
    });
    await expect(
      teleportTabOneWay(browser, { sourceTargetId: 't1', destination: { kind: 'leader' } })
    ).rejects.toThrow(/refusing to teleport/i);
    expect(fake.createPage).not.toHaveBeenCalled();
    expect(fake.createRemotePage).not.toHaveBeenCalled();
  });

  it('rejects a source without a usable URL before creating any tab', async () => {
    const { browser, fake } = createFakeBrowser({ sourceUrl: 'about:blank' });
    await expect(
      teleportTabOneWay(browser, { sourceTargetId: 't1', destination: { kind: 'leader' } })
    ).rejects.toThrow('no usable URL');
    expect(fake.createPage).not.toHaveBeenCalled();
    expect(fake.closePage).not.toHaveBeenCalled();
  });

  it('times out and closes the half-created destination tab', async () => {
    vi.useFakeTimers();
    const { browser, fake } = createFakeBrowser({ hangNavigate: true });
    const promise = teleportTabOneWay(browser, {
      sourceTargetId: 'runtime-1:tab-9',
      destination: { kind: 'leader' },
    });
    const expectation = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(31_000);
    await expectation;
    expect(fake.closePage).toHaveBeenCalledWith('local-new-tab');
  });
});

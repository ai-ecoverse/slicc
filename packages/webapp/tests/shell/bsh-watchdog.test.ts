import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { BshWatchdog } from '../../src/shell/bsh-watchdog.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { PageInfo } from '../../src/cdp/types.js';

let dbCounter = 0;

/** Create a minimal mock CDPTransport with event subscription support. */
function createMockTransport(): CDPTransport & {
  emit(event: string, params: Record<string, unknown>): void;
} {
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn().mockResolvedValue({}),
    on(event: string, listener: (params: Record<string, unknown>) => void): void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: (params: Record<string, unknown>) => void): void {
      listeners.get(event)?.delete(listener);
    },
    once: vi.fn().mockResolvedValue({}),
    state: 'connected' as const,
    emit(event: string, params: Record<string, unknown>): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(params);
      }
    },
  };
}

/** Create a mock BrowserAPI with listPages, withTab, and evaluate. */
function createMockBrowserAPI(pages: PageInfo[] = []): {
  mock: Pick<BrowserAPI, 'listPages' | 'withTab' | 'evaluate'> & BrowserAPI;
  evaluatedExpressions: string[];
} {
  const evaluatedExpressions: string[] = [];

  const mock = {
    listPages: vi.fn(async () => pages),
    withTab: vi.fn(async <T>(_targetId: string, fn: (sessionId: string) => Promise<T>) => {
      return fn('mock-session');
    }),
    evaluate: vi.fn(async (expression: string) => {
      evaluatedExpressions.push(expression);
      return undefined;
    }),
  } as unknown as Pick<BrowserAPI, 'listPages' | 'withTab' | 'evaluate'> & BrowserAPI;

  return { mock, evaluatedExpressions };
}

describe('BshWatchdog', () => {
  let vfs: VirtualFS;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-bsh-watchdog-${dbCounter++}`,
      wipe: true,
    });
    transport = createMockTransport();
  });

  it('discovers .bsh files on start', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock } = createMockBrowserAPI();

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    expect(watchdog.getEntries()).toHaveLength(1);
    watchdog.stop();
  });

  it('executes matching script on main frame navigation', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock, evaluatedExpressions } = createMockBrowserAPI([
      { targetId: 'target-1', title: 'Okta', url: 'https://login.okta.com/home' },
    ]);

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate main frame navigation
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    // Wait for async execution
    await vi.waitFor(() => {
      expect(evaluatedExpressions).toHaveLength(1);
      expect(evaluatedExpressions[0]).toContain('console.log("ok")');
    });

    expect(mock.withTab).toHaveBeenCalledWith('target-1', expect.any(Function));
    watchdog.stop();
  });

  it('ignores sub-frame navigations', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock, evaluatedExpressions } = createMockBrowserAPI([
      { targetId: 'target-1', title: 'Okta', url: 'https://login.okta.com/iframe' },
    ]);

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate sub-frame navigation (has parentId)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/iframe', parentId: 'parent-123' },
    });

    // Give time for potential execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluatedExpressions).toHaveLength(0);

    watchdog.stop();
  });

  it('ignores non-HTTP URLs', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock, evaluatedExpressions } = createMockBrowserAPI();

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'about:blank' },
    });
    transport.emit('Page.frameNavigated', {
      frame: { url: 'chrome://extensions' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluatedExpressions).toHaveLength(0);

    watchdog.stop();
  });

  it('does not execute when no scripts match', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock, evaluatedExpressions } = createMockBrowserAPI([
      { targetId: 'target-1', title: 'Unrelated', url: 'https://unrelated.com/page' },
    ]);

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://unrelated.com/page' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluatedExpressions).toHaveLength(0);

    watchdog.stop();
  });

  it('respects @match directives', async () => {
    await vfs.writeFile(
      '/workspace/-.okta.com.bsh',
      '// @match *://login.okta.com/*\nconsole.log("ok");'
    );
    const { mock, evaluatedExpressions } = createMockBrowserAPI([
      { targetId: 'target-1', title: 'Okta Login', url: 'https://login.okta.com/home' },
      { targetId: 'target-2', title: 'Okta Admin', url: 'https://admin.okta.com/dashboard' },
    ]);

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // This should NOT match (admin.okta.com doesn't match @match pattern)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://admin.okta.com/dashboard' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluatedExpressions).toHaveLength(0);

    // This SHOULD match
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(evaluatedExpressions).toHaveLength(1);
      expect(evaluatedExpressions[0]).toContain('console.log("ok")');
    });

    watchdog.stop();
  });

  it('prevents re-entrant execution for same script+URL', async () => {
    let resolveExec: (() => void) | null = null;
    const slowMockBrowserAPI = {
      listPages: vi.fn(async () => [
        { targetId: 'target-1', title: 'Okta', url: 'https://login.okta.com/home' },
      ]),
      withTab: vi.fn(async <T>(_targetId: string, fn: (sessionId: string) => Promise<T>) => {
        return fn('mock-session');
      }),
      evaluate: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveExec = resolve;
        });
        return undefined;
      }),
    } as unknown as BrowserAPI;

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: slowMockBrowserAPI,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // First navigation — starts execution
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    // Wait for evaluate to be called
    await vi.waitFor(() => {
      expect(slowMockBrowserAPI.evaluate).toHaveBeenCalledTimes(1);
    });

    // Second navigation to same URL — should be skipped (still executing)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slowMockBrowserAPI.evaluate).toHaveBeenCalledTimes(1);

    // Resolve the first execution
    resolveExec!();

    // Now a third navigation should work
    await new Promise((resolve) => setTimeout(resolve, 50));
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(slowMockBrowserAPI.evaluate).toHaveBeenCalledTimes(2);
    });

    // Resolve second execution and stop
    resolveExec!();
    watchdog.stop();
  });

  it('stops listening after stop()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    const { mock, evaluatedExpressions } = createMockBrowserAPI([
      { targetId: 'target-1', title: 'Okta', url: 'https://login.okta.com/home' },
    ]);

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: mock,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluatedExpressions).toHaveLength(0);
  });

  it('handles evaluation errors gracefully', async () => {
    const failingMockBrowserAPI = {
      listPages: vi.fn(async () => [
        { targetId: 'target-1', title: 'Okta', url: 'https://login.okta.com/home' },
      ]),
      withTab: vi.fn(async <T>(_targetId: string, fn: (sessionId: string) => Promise<T>) => {
        return fn('mock-session');
      }),
      evaluate: vi.fn(async () => {
        throw new Error('evaluation failed');
      }),
    } as unknown as BrowserAPI;

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      browserAPI: failingMockBrowserAPI,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Should not throw
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(failingMockBrowserAPI.evaluate).toHaveBeenCalledTimes(1);
    });

    watchdog.stop();
  });
});

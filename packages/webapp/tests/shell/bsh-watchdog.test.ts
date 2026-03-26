import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { BshWatchdog } from '../../src/shell/bsh-watchdog.js';
import type { CDPTransport } from '../../src/cdp/transport.js';

let dbCounter = 0;

/** Create a minimal mock CDPTransport with event subscription and send tracking. */
function createMockTransport(): CDPTransport & {
  emit(event: string, params: Record<string, unknown>): void;
  sendCalls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
} {
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  const sendCalls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> =
    [];

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      sendCalls.push({ method, params, sessionId });
      return {};
    }),
    on(event: string, listener: (params: Record<string, unknown>) => void): void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: (params: Record<string, unknown>) => void): void {
      listeners.get(event)?.delete(listener);
    },
    once: vi.fn().mockResolvedValue({}),
    state: 'connected' as const,
    sendCalls,
    emit(event: string, params: Record<string, unknown>): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(params);
      }
    },
  };
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

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    expect(watchdog.getEntries()).toHaveLength(1);
    watchdog.stop();
  });

  it('executes matching script on main frame navigation', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate main frame navigation with sessionId
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    // Wait for async execution
    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
      expect(evaluateCalls[0].params['expression']).toContain('console.log("ok")');
      expect(evaluateCalls[0].sessionId).toBe('test-session');
    });

    // Verify Runtime.enable was called with the correct sessionId
    const enableCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.enable');
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0].sessionId).toBe('test-session');

    watchdog.stop();
  });

  it('ignores sub-frame navigations', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate sub-frame navigation (has parentId)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/iframe', parentId: 'parent-123' },
      sessionId: 'test-session',
    });

    // Give time for potential execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });

  it('ignores non-HTTP URLs', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'about:blank' },
      sessionId: 'test-session',
    });
    transport.emit('Page.frameNavigated', {
      frame: { url: 'chrome://extensions' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });

  it('does not execute when no scripts match', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://unrelated.com/page' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });

  it('respects @match directives', async () => {
    await vfs.writeFile(
      '/workspace/-.okta.com.bsh',
      '// @match *://login.okta.com/*\nconsole.log("ok");'
    );

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // This should NOT match (admin.okta.com doesn't match @match pattern)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://admin.okta.com/dashboard' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    // This SHOULD match
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
      expect(evaluateCalls[0].params['expression']).toContain('console.log("ok")');
    });

    watchdog.stop();
  });

  it('prevents re-entrant execution for same script+URL', async () => {
    let resolveExec: (() => void) | null = null;
    const slowTransport = createMockTransport();
    // Override send to block on Runtime.evaluate
    slowTransport.send = vi.fn(
      async (method: string, params: Record<string, unknown>, sessionId?: string) => {
        slowTransport.sendCalls.push({ method, params, sessionId });
        if (method === 'Runtime.evaluate') {
          await new Promise<void>((resolve) => {
            resolveExec = resolve;
          });
        }
        return {};
      }
    ) as CDPTransport['send'];

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport: slowTransport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // First navigation — starts execution
    slowTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    // Wait for evaluate to be called
    await vi.waitFor(() => {
      expect(slowTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(
        1
      );
    });

    // Second navigation to same URL — should be skipped (still executing)
    slowTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slowTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);

    // Resolve the first execution
    resolveExec!();

    // Now a third navigation should work
    await new Promise((resolve) => setTimeout(resolve, 50));
    slowTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      expect(slowTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(
        2
      );
    });

    // Resolve second execution and stop
    resolveExec!();
    watchdog.stop();
  });

  it('stops listening after stop()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);
  });

  it('accepts browserAPI option and subscribes via getTransport()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const mockBrowserAPI = {
      getTransport: vi.fn(() => transport),
      setSessionChangeCallback: vi.fn(),
    } as unknown as import('../../src/cdp/browser-api.js').BrowserAPI;

    const watchdog = new BshWatchdog({
      browserAPI: mockBrowserAPI,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Should have called setSessionChangeCallback
    expect(mockBrowserAPI.setSessionChangeCallback).toHaveBeenCalledTimes(1);
    expect(
      typeof (mockBrowserAPI.setSessionChangeCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toBe('function');

    // Should still respond to navigation events on the transport from getTransport()
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
    });

    watchdog.stop();
  });

  it('swaps transport via setTransport()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const transportA = transport;
    const transportB = createMockTransport();

    const watchdog = new BshWatchdog({
      transport: transportA,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Swap to transport B
    watchdog.setTransport(transportB);

    // Navigation on old transport A should NOT trigger execution
    transportA.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transportA.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    // Navigation on new transport B SHOULD trigger execution
    transportB.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transportB.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
    });

    watchdog.stop();
  });

  it('session-change callback triggers transport swap', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    let capturedCallback: ((sessionId: string, transport: CDPTransport) => void) | null = null;
    const mockBrowserAPI = {
      getTransport: vi.fn(() => transport),
      setSessionChangeCallback: vi.fn(
        (cb: (sessionId: string, transport: CDPTransport) => void) => {
          capturedCallback = cb;
        }
      ),
    } as unknown as import('../../src/cdp/browser-api.js').BrowserAPI;

    const watchdog = new BshWatchdog({
      browserAPI: mockBrowserAPI,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    expect(capturedCallback).not.toBeNull();

    // Simulate a session change with a new transport
    const newTransport = createMockTransport();
    capturedCallback!('new-session-id', newTransport);

    // Old transport should no longer trigger execution
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    // New transport should trigger execution
    newTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = newTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
    });

    watchdog.stop();
  });

  it('re-discovery picks up new scripts', async () => {
    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // No scripts initially
    expect(watchdog.getEntries()).toHaveLength(0);

    // Navigation should do nothing
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    // Write a new .bsh file and force re-discovery
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    await watchdog.discover();

    expect(watchdog.getEntries()).toHaveLength(1);

    // Now navigation should execute the script
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
    });

    watchdog.stop();
  });

  it('throws when constructed with neither transport nor browserAPI', () => {
    expect(
      () =>
        new BshWatchdog({
          fs: vfs,
        })
    ).toThrow('BshWatchdog requires either transport or browserAPI');
  });

  it('handles evaluation errors gracefully', async () => {
    const errorTransport = createMockTransport();
    // Return exceptionDetails for Runtime.evaluate
    errorTransport.send = vi.fn(
      async (method: string, params: Record<string, unknown>, sessionId?: string) => {
        errorTransport.sendCalls.push({ method, params, sessionId });
        if (method === 'Runtime.evaluate') {
          return {
            exceptionDetails: {
              text: 'evaluation failed',
              exception: { description: 'Error: evaluation failed' },
            },
          };
        }
        return {};
      }
    ) as CDPTransport['send'];

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport: errorTransport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Should not throw
    errorTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      expect(errorTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(
        1
      );
    });

    watchdog.stop();
  });

  it('skips execution when sessionId is missing', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Emit without sessionId
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });
});

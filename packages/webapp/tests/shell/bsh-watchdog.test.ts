import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CDPTransport } from '../../src/cdp/transport.js';
import { FsWatcher } from '../../src/fs/index.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { BshWatchdog } from '../../src/shell/bsh-watchdog.js';
import { ScriptCatalog } from '../../src/shell/script-catalog.js';
import { ESBUILD_VERSION } from '../../src/shell/supplemental-commands/esbuild-wasm.js';

let dbCounter = 0;

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

  function createScriptCatalog(): ScriptCatalog {
    return new ScriptCatalog({
      jshFs: vfs,
      bshFs: vfs,
      watcher: vfs.getWatcher(),
    });
  }

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-bsh-watchdog-${dbCounter++}`,
      wipe: true,
    });
    vfs.setWatcher(new FsWatcher());
    transport = createMockTransport();
  });

  it('discovers .bsh files on start', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();
    expect(await watchdog.getEntries()).toHaveLength(1);
    watchdog.stop();
  });

  it('contains initial discovery failures during startup', async () => {
    const failingCatalog = {
      getBshEntries: vi.fn().mockRejectedValue(new Error('boom')),
      findMatchingBshScripts: vi.fn().mockResolvedValue([]),
      invalidateBsh: vi.fn(),
    } as unknown as ScriptCatalog;

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: failingCatalog,
      fs: vfs,
    });

    await expect(watchdog.start()).resolves.toBeUndefined();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      expect(
        (failingCatalog.findMatchingBshScripts as ReturnType<typeof vi.fn>).mock.calls
      ).toEqual([['https://login.okta.com/home']]);
    });

    watchdog.stop();
  });

  it('executes matching script on main frame navigation', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
      expect(evaluateCalls[0].params['expression']).toContain('console.log("ok")');
      expect(evaluateCalls[0].sessionId).toBe('test-session');
    });

    const enableCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.enable');
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0].sessionId).toBe('test-session');

    watchdog.stop();
  });

  it('ignores sub-frame navigations', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/iframe', parentId: 'parent-123' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });

  it('ignores non-HTTP URLs', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://admin.okta.com/dashboard' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    slowTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      expect(slowTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(
        1
      );
    });

    slowTransport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slowTransport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);

    resolveExec!();

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

    resolveExec!();
    watchdog.stop();
  });

  it('stops listening after stop()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    expect(mockBrowserAPI.setSessionChangeCallback).toHaveBeenCalledTimes(1);
    expect(
      typeof (mockBrowserAPI.setSessionChangeCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toBe('function');

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
    });

    watchdog.stop();

    expect(mockBrowserAPI.setSessionChangeCallback).toHaveBeenCalledWith(undefined);
  });

  it('swaps transport via setTransport()', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const transportA = transport;
    const transportB = createMockTransport();

    const watchdog = new BshWatchdog({
      transport: transportA,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    watchdog.setTransport(transportB);

    transportA.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transportA.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();
    expect(capturedCallback).not.toBeNull();

    const newTransport = createMockTransport();
    capturedCallback!('new-session-id', newTransport);

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    expect(await watchdog.getEntries()).toHaveLength(0);

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    await watchdog.discover();

    expect(await watchdog.getEntries()).toHaveLength(1);

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

  it('picks up watcher-invalidated catalog updates without polling', async () => {
    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();
    expect(await watchdog.getEntries()).toHaveLength(0);

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);
    });

    expect(await watchdog.getEntries()).toHaveLength(1);

    watchdog.stop();
  });

  it('throws when constructed with neither transport nor browserAPI', () => {
    expect(
      () =>
        new BshWatchdog({
          scriptCatalog: createScriptCatalog(),
          fs: vfs,
        })
    ).toThrow('BshWatchdog requires either transport or browserAPI');
  });

  it('handles evaluation errors gracefully', async () => {
    const errorTransport = createMockTransport();

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
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

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

  it('injected wrapper points unbundled require() at the bundle-first workflow', async () => {
    await vfs.writeFile(
      '/workspace/-.okta.com.bsh',
      "const lodash = require('lodash');\nconsole.log(lodash);"
    );

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
      sessionId: 'test-session',
    });

    await vi.waitFor(() => {
      const evaluateCalls = transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate');
      expect(evaluateCalls).toHaveLength(1);
      const expression = String(evaluateCalls[0].params['expression']);

      expect(expression).toContain(`ipk add esbuild-wasm@${ESBUILD_VERSION}`);
      expect(expression).toContain('esbuild --bundle');
      expect(expression).not.toContain('ipx esbuild');
      expect(expression).toContain('unbundled require() specifiers');

      expect(expression).not.toContain('esm.sh');
      expect(expression).not.toContain('__esmShBase');
    });

    watchdog.stop();
  });

  it('skips execution when sessionId is missing', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      scriptCatalog: createScriptCatalog(),
      fs: vfs,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.sendCalls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0);

    watchdog.stop();
  });
});

describe('BshWatchdog mirror of require-guards', () => {
  let watchdogSource: string;

  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    watchdogSource = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'shell', 'bsh-watchdog.ts'),
      'utf-8'
    );
  });

  it('hand-mirrors the native-package set', () => {
    expect(watchdogSource).toContain('__NODE_NATIVE_PACKAGES');
    expect(watchdogSource).toMatch(/'sharp'/);
    expect(watchdogSource).toMatch(/'sqlite3'/);
    expect(watchdogSource).toMatch(/'bcrypt'/);
  });

  it('includes the same hint text as the canonical module so the agent gets the same UX', () => {
    expect(watchdogSource).toContain("Use the built-in 'convert' shell command");
    expect(watchdogSource).toContain('is a Node native module');
  });

  it('emits a clear bundle-first error when require() specifiers survive bundling', () => {
    expect(watchdogSource).toContain('ipk add esbuild-wasm@${ESBUILD_VERSION}');
    expect(watchdogSource).toContain('esbuild --bundle');
    expect(watchdogSource).not.toContain('ipx esbuild');
    expect(watchdogSource).toContain('unbundled require() specifiers');
    expect(watchdogSource).toContain('[bsh]');
  });

  it('has dropped the esm.sh runtime CDN fetch path', () => {
    expect(watchdogSource).not.toMatch(/esmShUrl/);
    expect(watchdogSource).not.toContain('__esmShBase');
    expect(watchdogSource).not.toContain('__withTimeout');
    expect(watchdogSource).not.toMatch(/failed to pre-load/);
  });
});

describe('NODE_NATIVE_PACKAGES mirror parity (canonical → bsh-watchdog.ts)', () => {
  it('every entry in require-guards.NODE_NATIVE_PACKAGES is present in the bsh-watchdog mirror', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const { NODE_NATIVE_PACKAGES } = await import('../../src/kernel/realm/require-guards.js');
    const watchdogSrc = readFileSync(
      resolve(repoRoot, 'packages/webapp/src/shell/bsh-watchdog.ts'),
      'utf-8'
    );

    const missingFromWatchdog: string[] = [];
    for (const pkg of NODE_NATIVE_PACKAGES) {
      const needle = new RegExp(`['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
      if (!needle.test(watchdogSrc)) missingFromWatchdog.push(pkg);
    }
    expect(missingFromWatchdog, 'bsh-watchdog.ts drifted from require-guards.ts').toEqual([]);
  });
});

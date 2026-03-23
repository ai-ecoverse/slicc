import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { BshWatchdog, type BshExecutor } from './bsh-watchdog.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { JshResult } from './jsh-executor.js';

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

function successResult(): JshResult {
  return { stdout: 'ok\n', stderr: '', exitCode: 0 };
}

describe('BshWatchdog', () => {
  let vfs: VirtualFS;
  let transport: ReturnType<typeof createMockTransport>;
  let executor: BshExecutor;
  let executedPaths: string[];

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-bsh-watchdog-${dbCounter++}`,
      wipe: true,
    });
    transport = createMockTransport();
    executedPaths = [];
    executor = vi.fn(async (path: string): Promise<JshResult> => {
      executedPaths.push(path);
      return successResult();
    });
  });

  it('discovers .bsh files on start', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: executor,
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
      execute: executor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate main frame navigation
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    // Wait for async execution
    await vi.waitFor(() => {
      expect(executedPaths).toContain('/workspace/-.okta.com.bsh');
    });

    watchdog.stop();
  });

  it('ignores sub-frame navigations', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: executor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Simulate sub-frame navigation (has parentId)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/iframe', parentId: 'parent-123' },
    });

    // Give time for potential execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executedPaths).toHaveLength(0);

    watchdog.stop();
  });

  it('ignores non-HTTP URLs', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: executor,
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
    expect(executedPaths).toHaveLength(0);

    watchdog.stop();
  });

  it('does not execute when no scripts match', async () => {
    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: executor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://unrelated.com/page' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executedPaths).toHaveLength(0);

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
      execute: executor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // This should NOT match (admin.okta.com doesn't match @match pattern)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://admin.okta.com/dashboard' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executedPaths).toHaveLength(0);

    // This SHOULD match
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(executedPaths).toContain('/workspace/-.okta.com.bsh');
    });

    watchdog.stop();
  });

  it('prevents re-entrant execution for same script+URL', async () => {
    let resolveExec: (() => void) | null = null;
    const slowExecutor = vi.fn(async (): Promise<JshResult> => {
      await new Promise<void>((resolve) => {
        resolveExec = resolve;
      });
      return successResult();
    });

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: slowExecutor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // First navigation — starts execution
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    // Wait for executor to be called
    await vi.waitFor(() => {
      expect(slowExecutor).toHaveBeenCalledTimes(1);
    });

    // Second navigation to same URL — should be skipped (still executing)
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slowExecutor).toHaveBeenCalledTimes(1);

    // Resolve the first execution
    resolveExec!();

    // Now a third navigation should work
    await new Promise((resolve) => setTimeout(resolve, 50));
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(slowExecutor).toHaveBeenCalledTimes(2);
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
      execute: executor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();

    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executedPaths).toHaveLength(0);
  });

  it('handles executor errors gracefully', async () => {
    const failingExecutor = vi.fn(async (): Promise<JshResult> => {
      throw new Error('execution failed');
    });

    await vfs.writeFile('/workspace/-.okta.com.bsh', 'console.log("ok");');

    const watchdog = new BshWatchdog({
      transport,
      fs: vfs,
      execute: failingExecutor,
      discoveryIntervalMs: 60_000,
    });

    await watchdog.start();

    // Should not throw
    transport.emit('Page.frameNavigated', {
      frame: { url: 'https://login.okta.com/home' },
    });

    await vi.waitFor(() => {
      expect(failingExecutor).toHaveBeenCalledTimes(1);
    });

    watchdog.stop();
  });
});
